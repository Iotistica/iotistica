/**
 * Database connection and query interface
 * PostgreSQL connection pool management
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import logger from '../utils/logger';

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readClampedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const requestedValue = parseIntEnv(name, fallback);
  const boundedValue = clamp(requestedValue, min, max);

  if (requestedValue !== boundedValue) {
    logger.warn(`${name} out of safe bounds; clamping value`, {
      requestedValue,
      boundedValue,
      minAllowed: min,
      maxAllowed: max,
    });
  }

  return boundedValue;
}

const boundedPoolSize = readClampedIntEnv('DB_POOL_SIZE', 50, 5, 100);
const idleTimeoutMillis = readClampedIntEnv('DB_IDLE_TIMEOUT_MS', 30000, 1000, 300000);
const connectionTimeoutMillis = readClampedIntEnv('DB_CONNECTION_TIMEOUT_MS', 30000, 1000, 120000);
const statementTimeout = readClampedIntEnv('DB_STATEMENT_TIMEOUT_MS', 60000, 1000, 600000);
const dbApplicationName = process.env.DB_APPLICATION_NAME || 'iotistic-api';

// Database configuration from environment variables
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'iotistic',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: boundedPoolSize,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  statementTimeout,
  application_name: dbApplicationName,
  // Queue incoming requests when all connections busy
  allowExitOnIdle: false,
  // TCP keepalive to prevent Azure from closing idle connections during long operations
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000, // Start keepalive after 10 seconds
  // SSL configuration for cloud-hosted PostgreSQL (Azure, AWS RDS, etc.)
  // Azure PostgreSQL requires SSL by default
  ssl: process.env.DB_SSL === 'false' ? false : {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? false : true,
  },
};

// Create connection pool
export const pool = new Pool(dbConfig);

export interface DbPoolStats {
  total: number;
  idle: number;
  active: number;
  waiting: number;
  saturationPct: number;
  configuredMax: number;
}

export function getPoolStats(): DbPoolStats {
  const totalClients = pool.totalCount;
  const idleClients = pool.idleCount;
  const waitingClients = pool.waitingCount;
  const activeClients = Math.max(0, totalClients - idleClients);
  const configuredMax = boundedPoolSize;
  const denom = configuredMax > 0 ? configuredMax : Math.max(1, totalClients);
  const saturationPct = Number(((activeClients / denom) * 100).toFixed(1));

  return {
    total: totalClients,
    idle: idleClients,
    active: activeClients,
    waiting: waitingClients,
    saturationPct,
    configuredMax,
  };
}

// Handle pool errors
pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
  // process.exit(-1);
});

/**
 * Transient network/server errors that are safe to retry.
 * These indicate the connection was lost, not a SQL logic error.
 */
const TRANSIENT_PG_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (PostgreSQL starting up)
  '08000', // connection_exception
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as any).code as string | undefined;
  if (!code) return false;
  return TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code);
}

/** True for INSERT / UPDATE / DELETE / MERGE — writes that must not be silently dropped. */
function isWriteQuery(text: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(text);
}

/** Extract the most useful fields from a pg DatabaseError for structured logging. */
function pgErrorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return {};
  const e = error as any;
  return {
    pgCode: e.code,
    pgSeverity: e.severity,
    pgDetail: e.detail,       // e.g. "Key (id)=(5) already exists."
    pgHint: e.hint,
    pgTable: e.table,
    pgConstraint: e.constraint,
    pgColumn: e.column,
    message: e.message,
  };
}

/**
 * Execute a query with parameterized values.
 * Automatically retries up to 3 times on transient connection errors
 * (e.g. PostgreSQL pod restart, brief network blip).
 *
 * Logging strategy:
 *   - Transient error mid-retry  → WARN  (expected, being recovered)
 *   - Write (INSERT/UPDATE/DELETE) fails after all retries → ERROR  (data may be lost)
 *   - Read fails after all retries                        → WARN   (degraded, not data loss)
 *   - Non-transient SQL error (constraint, syntax, etc.)  → ERROR  (programming or data issue)
 */
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const maxAttempts = 3;
  let lastError: unknown;
  const isWrite = isWriteQuery(text);

  const maxQueryPreview = 1000;
  const textPreview = text.length > maxQueryPreview
    ? `${text.slice(0, maxQueryPreview)}... [truncated ${text.length - maxQueryPreview} chars]`
    : text;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const result = await pool.query<T>(text, params);
      return result;
    } catch (error) {
      lastError = error;

      if (isTransientError(error) && attempt < maxAttempts) {
        const delayMs = attempt * 500;
        logger.warn('Transient DB error, retrying query...', {
          attempt,
          maxAttempts,
          retryInMs: delayMs,
          isWrite,
          ...pgErrorContext(error),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const poolStats = getPoolStats();
      const transientExhausted = isTransientError(error);

      if (isWrite || !transientExhausted) {
        // Writes that failed (data may be lost) or non-transient SQL errors → ERROR
        logger.error(
          transientExhausted
            ? 'Write query failed after all retries — data may not have been persisted'
            : 'Query failed with non-transient error',
          {
            isWrite,
            attemptsUsed: attempt,
            text: textPreview,
            paramsCount: Array.isArray(params) ? params.length : 0,
            dbPool: poolStats,
            ...pgErrorContext(error),
          }
        );
      } else {
        // Read exhausted retries → WARN (degraded experience, no data loss)
        logger.warn('Read query failed after all retries', {
          attemptsUsed: attempt,
          text: textPreview,
          paramsCount: Array.isArray(params) ? params.length : 0,
          dbPool: poolStats,
          ...pgErrorContext(error),
        });
      }

      throw error;
    }
  }

  throw lastError;
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  try {
    const client = await pool.connect();
    return client;
  } catch (err) {
    logger.warn('Failed to acquire database client from pool', err);
    // Optionally: throw a custom error to handle backpressure gracefully
    throw new Error('DB connection temporarily unavailable');
  }
}


/**
 * Execute a function within a transaction
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Connection might be closed, log but don't throw
      logger.warn('Failed to rollback transaction (connection may be closed)', rollbackError);
    }
    throw error;
  } finally {
    try {
      client.release();
    } catch (releaseError) {
      // Client might already be released or connection closed
      logger.warn('Failed to release client', releaseError);
    }
  }
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    logger.info('Testing database connection with config:', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
      applicationName: dbApplicationName,
      poolMax: boundedPoolSize,
      idleTimeoutMillis,
      connectionTimeoutMillis,
      statementTimeout,
    });
    
    const result = await query('SELECT NOW() as now');
    logger.info(` Database connected successfully at ${String(result.rows[0].now)}`);
    return true;
  } catch (error) {
    logger.error(' Database connection failed:', error);
    if (error instanceof Error) {
      logger.error('Connection error details:', {
        message: error.message,
        code: (error as any).code,
        host: dbConfig.host,
        port: dbConfig.port,
      });
    }
    return false;
  }
}

/**
 * Initialize database schema
 * @deprecated Use runMigrations() from migrations.ts instead
 */
export async function initializeSchema(): Promise<void> {
  logger.warn('  initializeSchema() is deprecated, using migration system instead');
  
  // Import and run migrations
  const { runMigrations } = await import('./migrations');
  await runMigrations();
}

/**
 * Close all database connections
 */
export async function close(): Promise<void> {
  await pool.end();
  logger.info('Database connections closed');
}

export default {
  query,
  getClient,
  transaction,
  testConnection,
  initializeSchema,
  close,
  pool,
};
