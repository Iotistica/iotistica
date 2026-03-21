/**
 * Database bootstrap: connect, run migrations, seed MQTT credentials.
 */

import logger from '../utils/logger';

export async function bootstrapDatabase(): Promise<void> {
  const db = await import('../db/connection');

  logger.info('Attempting PostgreSQL connection:', {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'iotistic',
    user: process.env.DB_USER || 'postgres',
  });

  const connected = await db.testConnection();
  if (!connected) {
    throw new Error('Failed to connect to PostgreSQL database - check connection settings above');
  }

  if (process.env.DB_SKIP_MIGRATIONS !== 'true') {
    const { getMigrationStatus, runMigrations } = await import('../db/migrations');
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
  const { initializeMqttAdmin, initializeNodeRedMqttCredentials } =
    await import('../mqtt/bootstrap');
  await initializeMqttAdmin();

  const nodeRedCreds = await initializeNodeRedMqttCredentials();
  if (nodeRedCreds) {
    logger.info('Node-RED MQTT credentials generated (first-time setup)');
  }
}
