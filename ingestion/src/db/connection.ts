import { Pool, type PoolClient, type QueryResult } from 'pg';
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
const dbApplicationName = process.env.DB_APPLICATION_NAME || 'iotistic-ingestion';

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'iotistic',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: boundedPoolSize,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  statementTimeout,
  application_name: dbApplicationName,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: process.env.DB_SSL === 'false' ? false : {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ? false : true,
  },
};

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

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

// Attach an error handler to every new client the pool creates so that a
// server-side TCP reset on an idle connection emits a logged warning instead
// of an unhandled 'error' event that crashes the process.
pool.on('connect', (client) => {
  client.on('error', (err) => {
    logger.warn('Database client connection error (pool will replace)', {
      error: err.message,
      code: (err as any).code,
    });
  });
});

const TRANSIENT_PG_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08006', '08001', '08004']);
const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (!code) return false;
  return TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code);
}

function isWriteQuery(text: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(text);
}

function pgErrorContext(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return {};
  const e = error as Error & Record<string, unknown>;
  return {
    pgCode: e.code,
    pgSeverity: e.severity,
    pgDetail: e.detail,
    pgHint: e.hint,
    pgTable: e.table,
    pgConstraint: e.constraint,
    pgColumn: e.column,
    message: e.message,
  };
}

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  const maxAttempts = 3;
  const isWrite = isWriteQuery(text);
  const maxQueryPreview = 1000;
  const textPreview = text.length > maxQueryPreview ? `${text.slice(0, maxQueryPreview)}... [truncated ${text.length - maxQueryPreview} chars]` : text;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await pool.query<T>(text, params);
    } catch (error) {
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
        logger.error(
          transientExhausted ? 'Write query failed after all retries — data may not have been persisted' : 'Query failed with non-transient error',
          {
            isWrite,
            attemptsUsed: attempt,
            text: textPreview,
            paramsCount: Array.isArray(params) ? params.length : 0,
            dbPool: poolStats,
            ...pgErrorContext(error),
          },
        );
      } else {
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

  throw new Error('Unexpected unreachable query retry state');
}

export async function getClient(): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    logger.warn('Failed to acquire database client from pool', err);
    throw new Error('DB connection temporarily unavailable');
  }
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
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
      logger.warn('Failed to rollback transaction (connection may be closed)', rollbackError);
    }
    throw error;
  } finally {
    try {
      client.release();
    } catch (releaseError) {
      logger.warn('Failed to release client', releaseError);
    }
  }
}

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

    const result = await query<{ now: string }>('SELECT NOW() as now');
    logger.info(`Database connected successfully at ${String(result.rows[0].now)}`);
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    if (error instanceof Error) {
      logger.error('Connection error details:', {
        message: error.message,
        code: (error as Error & { code?: string }).code,
        host: dbConfig.host,
        port: dbConfig.port,
      });
    }
    return false;
  }
}

export async function close(): Promise<void> {
  await pool.end();
  logger.info('Database connections closed');
}