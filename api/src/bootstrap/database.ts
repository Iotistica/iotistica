/**
 * Database bootstrap: connect, run migrations, seed MQTT credentials.
 */

import logger from '../utils/logger';
import { testConnection } from '../db/connection';
import { getMigrationStatus, runMigrations } from '../db/migrations';
import { initializeMqttAdmin, initializeNodeRedMqttCredentials } from '../mqtt/bootstrap';

/**
 * Poll testConnection() with exponential backoff until the database is ready.
 * Delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s (capped at 30s).
 * Throws after all attempts are exhausted so the caller can exit(1).
 */
async function waitForDatabase(maxAttempts = 10): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await testConnection()) return;
    if (attempt === maxAttempts) break;
    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    logger.warn('PostgreSQL not ready, retrying...', { attempt, maxAttempts, retryInMs: delayMs });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`PostgreSQL did not become ready after ${maxAttempts} attempts`);
}

export async function bootstrapDatabase(): Promise<void> {
  logger.info('Attempting PostgreSQL connection:', {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'iotistic',
    user: process.env.DB_USER || 'postgres',
  });

  await waitForDatabase();

  if (process.env.DB_SKIP_MIGRATIONS !== 'true') {
    const migrationStatus = await getMigrationStatus();

    if (migrationStatus.pending.length > 0) {
      logger.warn('Database schema is outdated - running migrations before startup', {
        appliedMigrations: migrationStatus.applied.length,
        pendingMigrations: migrationStatus.pending.length,
        totalMigrations: migrationStatus.total,
      });
      await runMigrations();
      logger.info('Database migrations completed successfully');
    } else {
      logger.info('Database schema is up to date (no pending migrations)');
    }
  } else {
    logger.info('Skipping database migrations (DB_SKIP_MIGRATIONS=true)');
  }

  // Seed MQTT admin user and Node-RED credentials (replaces K8s postgres-init-job)
  await initializeMqttAdmin();

  const nodeRedCreds = await initializeNodeRedMqttCredentials();
  if (nodeRedCreds) {
    logger.info('Node-RED MQTT credentials generated (first-time setup)');
  }
}
