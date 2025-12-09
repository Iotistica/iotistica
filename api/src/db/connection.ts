/**
 * Database connection and query interface
 * PostgreSQL connection pool management (K8s-safe)
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import logger from '../utils/logger';

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'iotistic',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: parseInt(process.env.DB_POOL_SIZE || '50'), // conservative pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000, // fail fast if pool exhausted
  statementTimeout: 60000, // max 60s per query
  allowExitOnIdle: false,
};

// Create the pool
export const pool = new Pool(dbConfig);

// Handle pool errors without crashing
pool.on('error', (err, client) => {
  logger.error('Unexpected error on idle database client', err);
  // Do NOT exit process; log only
});

/**
 * Execute a query with retries (safe under high load)
 */
export async function query<T = any>(
  text: string,
  params?: any[],
  retries = 3
): Promise<QueryResult<T>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const start = Date.now();
      const result = await pool.query<T>(text, params);
      const duration = Date.now() - start;
      if (duration > 500) {
        logger.warn(`Slow query detected (${duration}ms): ${text}`);
      }
      return result;
    } catch (err: any) {
      logger.warn(`Query attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) {
        logger.error('Query failed after retries', { text, err });
        throw err;
      }
      // Backoff before retry
      await new Promise((res) => setTimeout(res, 50 * attempt));
    }
  }
  throw new Error('Query failed after retries');
}

/**
 * Get a client safely for transactions
 */
export async function getClient(): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err: any) {
    logger.warn('Failed to acquire DB client from pool', err.message);
    throw new Error('DB connection temporarily unavailable');
  }
}

/**
 * Execute a callback inside a transaction
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
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.warn('Failed to rollback transaction', rollbackErr);
    }
    throw err;
  } finally {
    try {
      client.release();
    } catch (releaseErr) {
      logger.warn('Failed to release DB client', releaseErr);
    }
  }
}

/**
 * Test DB connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await query('SELECT NOW() as now');
    logger.info('Database connected successfully at', result.rows[0].now);
    return true;
  } catch (err) {
    logger.error('Database connection failed', err);
    return false;
  }
}

/**
 * Close all connections
 */
export async function close(): Promise<void> {
  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (err) {
    logger.warn('Error closing DB pool', err);
  }
}

export default {
  query,
  getClient,
  transaction,
  testConnection,
  close,
  pool,
};
