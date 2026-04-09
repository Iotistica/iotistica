import logger from '../utils/logger';
import { testConnection } from '../db/connection';

async function waitForDatabase(maxAttempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await testConnection()) {
      return;
    }

    if (attempt === maxAttempts) {
      break;
    }

    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    logger.warn('PostgreSQL not ready, retrying...', { attempt, maxAttempts, retryInMs: delayMs });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`PostgreSQL did not become ready after ${maxAttempts} attempts`);
}

export async function bootstrapDatabaseConnection(): Promise<void> {
  logger.info('Attempting PostgreSQL connection:', {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'iotistic',
    user: process.env.DB_USER || 'postgres',
  });

  await waitForDatabase();
  logger.info('Database connection verified');
}