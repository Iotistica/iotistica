/**
 * Database Migration System
 * 
 * Automatically applies pending migrations on API startup
 * Tracks which migrations have been applied in a migrations table
 */

import { getClient, query, transaction } from './connection';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

interface Migration {
  id: number;
  name: string;
  filename: string;
  sql: string;
}

interface AppliedMigration {
  id: number;
  name: string;
  filename: string;
  checksum: string | null;
  applied_at: Date;
}

interface SanitizedMigrationSql {
  sql: string;
  removedStatementCount: number;
}

interface MigrationExecutionOptions {
  useTransaction: boolean;
}

function isAppRoleMigrationContext(): boolean {
  const dbUser = process.env.DB_USER || '';
  return dbUser.endsWith('-app');
}

/**
 * App-role migrations must not execute privileged platform SQL.
 * Extension lifecycle and Timescale internal schemas are managed by provisioning/admin context.
 */
function sanitizeMigrationSqlForAppRole(sql: string): SanitizedMigrationSql {
  let sanitizedSql = sql;
  let removedStatementCount = 0;

  const removalPatterns: RegExp[] = [
    /(^|\n)\s*CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(?:timescaledb|pgcrypto)\b[^;]*;/gim,
    /(^|\n)\s*COMMENT\s+ON\s+EXTENSION\s+(?:timescaledb|pgcrypto)\b[^;]*;/gim,
    /(^|\n)\s*(?:CREATE|ALTER|COMMENT\s+ON|GRANT|REVOKE|DROP)\s+[\s\S]*?_timescaledb_(?:internal|catalog|config)\.[\s\S]*?;/gim,
  ];

  for (const pattern of removalPatterns) {
    const matches = sanitizedSql.match(pattern);
    if (matches) {
      removedStatementCount += matches.length;
      sanitizedSql = sanitizedSql.replace(pattern, '\n');
    }
  }

  return {
    sql: sanitizedSql,
    removedStatementCount,
  };
}

function getExecutableMigrationSql(migration: Migration): SanitizedMigrationSql {
  const appSafeModeEnabled = process.env.DB_APP_SAFE_MIGRATIONS !== 'false';

  if (!appSafeModeEnabled || !isAppRoleMigrationContext()) {
    return {
      sql: migration.sql,
      removedStatementCount: 0,
    };
  }

  const sanitized = sanitizeMigrationSqlForAppRole(migration.sql);
  if (sanitized.removedStatementCount > 0) {
    logger.warn('App-safe migration mode removed privileged statements', {
      migration: migration.filename,
      removedStatements: sanitized.removedStatementCount,
      dbUser: process.env.DB_USER,
    });
  }

  return sanitized;
}

function getMigrationExecutionOptions(sql: string): MigrationExecutionOptions {
  const noTransactionMarker = /^\s*--\s*NO\s+TRANSACTION\s*$/im;
  return {
    useTransaction: !noTransactionMarker.test(sql),
  };
}

function getDuplicateMigrationIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter((value, index, all) => all.indexOf(value) !== index)));
}

function isTransientMigrationError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  const code = err?.code || '';
  const message = (err?.message || '').toLowerCase();

  const transientPgCodes = new Set([
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '53300', // too_many_connections
    '57P01', // admin_shutdown
    '57P03', // cannot_connect_now
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08P01',
  ]);

  if (transientPgCodes.has(code)) {
    return true;
  }

  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection reset') ||
    message.includes('connection terminated') ||
    message.includes('temporarily unavailable')
  );
}

/**
 * Ensure migrations tracking table exists
 */
async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_number INTEGER NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW(),
      checksum VARCHAR(64),
      execution_time_ms INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_number 
    ON schema_migrations(migration_number);
  `);
}

/**
 * Get list of applied migrations
 */
async function getAppliedMigrations(): Promise<AppliedMigration[]> {
  const result = await query<AppliedMigration>(`
    SELECT migration_number as id, name, filename, checksum, applied_at
    FROM schema_migrations 
    ORDER BY migration_number ASC
  `);
  return result.rows;
}

/**
 * Get all migration files from migrations directory
 *
 * Path Resolution:
 * - Default: Resolves to `database/migrations/` from project root
 * - Development (ts-node): __dirname = src/db/ → ../../database/migrations
 * - Production (compiled): __dirname = dist/db/ → ../../database/migrations
 * - Override: Set MIGRATIONS_DIR env var to use a custom absolute path
 *
 * @throws Returns empty array if directory not found (logs warning)
 */
function getMigrationFiles(): Migration[] {
  // Allow override via environment variable for custom deployments
  const migrationsDir = process.env.MIGRATIONS_DIR
    ? path.resolve(process.env.MIGRATIONS_DIR)
    : path.resolve(__dirname, '../../database/migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Migrations directory not found', {
      path: migrationsDir,
      __dirname,
      env_override: process.env.MIGRATIONS_DIR || 'not set',
    });
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Sort by filename (001_, 002_, etc.)

  const migrations: Migration[] = [];

  for (const filename of files) {
    // Extract migration number from filename (e.g., "001_add_security_tables.sql" -> 1)
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      logger.warn('Skipping invalid migration filename', { filename });
      continue;
    }

    const id = parseInt(match[1], 10);
    const name = match[2].replace(/_/g, ' ');
    const filepath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filepath, 'utf8');

    migrations.push({ id, name, filename, sql });
  }

  const ids = migrations.map(m => m.id);
  const duplicates = getDuplicateMigrationIds(ids);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate migration IDs detected: ${duplicates.join(', ')}`);
  }

  return migrations;
}

/**
 * Calculate simple checksum for migration file
 */
function calculateChecksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function isMigrationAlreadyRecorded(migrationNumber: number): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_number = $1) as exists',
    [migrationNumber]
  );
  return Boolean(result.rows[0]?.exists);
}

function verifyAppliedMigrationChecksums(
  appliedMigrations: AppliedMigration[],
  allMigrations: Migration[]
): void {
  const migrationById = new Map(allMigrations.map(m => [m.id, m]));
  const mismatches: Array<{ id: number; filename: string }> = [];

  for (const applied of appliedMigrations) {
    if (!applied.checksum) {
      continue;
    }

    const migrationFile = migrationById.get(applied.id);
    if (!migrationFile) {
      continue;
    }

    const currentChecksum = calculateChecksum(migrationFile.sql);
    if (currentChecksum !== applied.checksum) {
      mismatches.push({ id: applied.id, filename: migrationFile.filename });
    }
  }

  if (mismatches.length > 0) {
    logger.warn('Checksum drift detected in applied migration files', {
      count: mismatches.length,
      migrations: mismatches,
    });
  }
}

/**
 * Apply a single migration with retry logic
 */
async function applyMigration(migration: Migration): Promise<void> {
  const startTime = Date.now();
  const { sql: executableSql } = getExecutableMigrationSql(migration);
  const executionOptions = getMigrationExecutionOptions(executableSql);

  logger.info(`Applying migration ${migration.id}: ${migration.name}`);

  const maxAttempts = 3;
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const checksum = calculateChecksum(migration.sql);

      if (executionOptions.useTransaction) {
        await transaction(async (client) => {
          // Increase statement timeout for migrations (some take longer, e.g., extension setup)
          await client.query('SET statement_timeout = 600000');

          // Execute migration SQL
          await client.query(executableSql);

          // Reset search_path — migration SQL (e.g. pg_dump output) may have cleared it
          await client.query("SET search_path = public");

          // Record migration as applied
          const executionTime = Date.now() - startTime;
          await client.query(
            `INSERT INTO schema_migrations
             (migration_number, name, filename, checksum, execution_time_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [migration.id, migration.name, migration.filename, checksum, executionTime]
          );

          // Reset timeout to default
          await client.query('RESET statement_timeout');
        });
      } else {
        const client = await getClient();
        let clientError: Error | undefined;
        try {
          logger.info('Running migration without transaction (-- NO TRANSACTION marker found)', {
            migration: migration.filename,
          });

          await client.query('SET statement_timeout = 600000');
          await client.query(executableSql);

          // Reset search_path — migration SQL (e.g. pg_dump output) may have cleared it
          await client.query("SET search_path = public");

          const executionTime = Date.now() - startTime;
          await client.query(
            `INSERT INTO schema_migrations
             (migration_number, name, filename, checksum, execution_time_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [migration.id, migration.name, migration.filename, checksum, executionTime]
          );
        } catch (err) {
          clientError = err as Error;
          throw err;
        } finally {
          try {
            await client.query('RESET statement_timeout');
          } catch {
            // Best effort reset; client release still occurs.
          }
          // Pass error to release() so pg-pool destroys this connection rather than
          // recycling it. Without this, the pool may return the broken connection
          // (still in aborted-transaction state) to the next caller, causing 25P02.
          client.release(clientError);
        }
      }

      const executionTime = Date.now() - startTime;
      logger.info(`Applied in ${executionTime}ms`);
      return;
    } catch (error) {
      lastError = error as Error;

      // For non-transaction migrations, SQL might have completed even if recording failed.
      if (!executionOptions.useTransaction) {
        const alreadyRecorded = await isMigrationAlreadyRecorded(migration.id);
        if (alreadyRecorded) {
          logger.warn('Migration was already recorded after error; treating as successful', {
            migrationId: migration.id,
            filename: migration.filename,
          });
          return;
        }
      }

      const transient = isTransientMigrationError(error);
      const attemptsLeft = maxAttempts - attempt;

      if (attemptsLeft > 0 && transient) {
        logger.warn('Migration failed with transient error, retrying', {
          migrationId: migration.id,
          attemptsLeft,
          errorCode: (error as { code?: string })?.code,
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else if (attemptsLeft > 0 && !transient) {
        logger.error('Migration failed with non-transient error; skipping retries', {
          migrationId: migration.id,
          errorCode: (error as { code?: string })?.code,
          message: (error as Error).message,
        });
        break;
      }
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Apply all pending migrations in order
 */
async function applyPendingMigrations(pendingMigrations: Migration[]): Promise<void> {
  logger.info(`Found ${pendingMigrations.length} pending migration(s)`);

  for (const migration of pendingMigrations) {
    try {
      await applyMigration(migration);
    } catch (error) {
      logger.error(`Migration ${migration.id} failed`, {
        error: (error as Error).message,
        stack: (error as Error).stack,
        filename: migration.filename,
        migrationId: migration.id,
      });
      throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`);
    }
  }

  logger.info(`Successfully applied ${pendingMigrations.length} migration(s)`);
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<void> {
  logger.info('Checking for database migrations...');
  
  try {
    // Ensure migrations tracking table exists
    await ensureMigrationsTable();
    
    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations();
    const appliedIds = new Set(appliedMigrations.map(m => m.id));
    
    logger.info(`Applied migrations: ${appliedMigrations.length}`);
    
    // Get all migration files
    const allMigrations = getMigrationFiles();
    logger.info(`Total migrations available: ${allMigrations.length}`);

    verifyAppliedMigrationChecksums(appliedMigrations, allMigrations);
    
    if (allMigrations.length === 0) {
      logger.warn('No migration files found');
      logger.warn('This might indicate a path issue');
      return;
    }
    
    // Find pending migrations
    const pendingMigrations = allMigrations.filter(m => !appliedIds.has(m.id));
    
    if (pendingMigrations.length === 0) {
      logger.info('Database is up to date (no pending migrations)');
      return;
    }
    
    // Apply pending migrations
    await applyPendingMigrations(pendingMigrations);
    
  } catch (error) {
    logger.error('Migration system error', { error: (error as Error).message, stack: (error as Error).stack });
    throw error;
  }
}

/**
 * Get migration status (for CLI or admin endpoints)
 */
export async function getMigrationStatus(): Promise<{
  applied: AppliedMigration[];
  pending: Migration[];
  total: number;
}> {
  await ensureMigrationsTable();
  
  const appliedMigrations = await getAppliedMigrations();
  const appliedIds = new Set(appliedMigrations.map(m => m.id));
  
  const allMigrations = getMigrationFiles();
  const pendingMigrations = allMigrations.filter(m => !appliedIds.has(m.id));
  
  return {
    applied: appliedMigrations,
    pending: pendingMigrations,
    total: allMigrations.length
  };
}

/**
 * Rollback last migration (use with caution!)
 */
export async function rollbackLastMigration(): Promise<void> {
  logger.warn('  Rollback functionality not implemented');
  logger.warn('  Rollbacks should be done manually or with dedicated down migrations');
  throw new Error('Rollback not supported - create a new forward migration instead');
}

export default {
  runMigrations,
  getMigrationStatus,
  rollbackLastMigration
};
