/**
 * Create Template Database Script
 *
 * Builds (or refreshes) a PostgreSQL template database that contains the full
 * API schema so that new customer databases can be cloned from it instantly via
 * CREATE DATABASE … TEMPLATE instead of replaying every migration script on
 * first API startup.
 *
 * Usage
 * -----
 *   # Development (ts-node):
 *   npx ts-node src/scripts/create-template-db.ts
 *
 *   # Production (compiled):
 *   node dist/scripts/create-template-db.js
 *
 * Required environment variables
 * --------------------------------
 *   PROVISIONING_PG_TEMPLATE_DB     Name of the template database (e.g. template_iotistica)
 *   PROVISIONING_PG_ADMIN_USER      PostgreSQL admin username
 *   PROVISIONING_PG_ADMIN_PASSWORD  PostgreSQL admin password
 *   PROVISIONING_PG_HOST            PostgreSQL host (default: localhost)
 *   PROVISIONING_PG_PORT            PostgreSQL port (default: 5432)
 *
 * Optional environment variables
 * --------------------------------
 *   API_MIGRATIONS_PATH             Directory containing the API migration SQL files.
 *                                   Defaults to /app/api-migrations inside Docker or
 *                                   ../../api/database/migrations relative to this script.
 *   FORCE_RECREATE                  Set to 'true' to drop and rebuild the template from
 *                                   scratch even if it already exists.
 *   SIMULATE_POSTGRES_PROVISIONING  Set to 'true' to run in dry-run mode (no DB changes).
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { PostgresProvisioningService } from '../services/postgres-provisioning-service';

// Load environment variables
dotenv.config();

/** Candidate directories searched in order when API_MIGRATIONS_PATH is not set */
const DEFAULT_MIGRATIONS_DIRS = [
  '/app/api-migrations',                                      // Docker image path
  path.join(__dirname, '..', '..', 'api-migrations'),        // repo: provisioning/api-migrations
  path.join(__dirname, '..', '..', '..', 'api', 'database', 'migrations'), // repo root sibling
];

/**
 * Resolve the directory that contains API migration SQL files.
 * Checks API_MIGRATIONS_PATH first, then falls back through DEFAULT_MIGRATIONS_DIRS.
 */
function resolveMigrationsDir(): string {
  const envPath = process.env.API_MIGRATIONS_PATH;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(
        `API_MIGRATIONS_PATH is set to "${envPath}" but the directory does not exist.`
      );
    }
    return envPath;
  }

  for (const candidate of DEFAULT_MIGRATIONS_DIRS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not locate API migration files. ' +
    'Set the API_MIGRATIONS_PATH environment variable to the directory containing the SQL files.\n' +
    'Searched:\n' +
    DEFAULT_MIGRATIONS_DIRS.map((d) => `  ${d}`).join('\n')
  );
}

/**
 * Read and concatenate all *.sql files from the given directory in
 * lexicographic (numbered) order so that migrations are applied sequentially.
 */
function loadMigrationSql(migrationsDir: string): string {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `No SQL migration files found in directory: ${migrationsDir}`
    );
  }

  console.log(`[create-template-db] Loading ${files.length} migration file(s) from ${migrationsDir}:`);

  const parts: string[] = [];
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`[create-template-db]   - ${file}`);
    parts.push(fs.readFileSync(filePath, 'utf8'));
  }

  return parts.join('\n\n');
}

async function main(): Promise<void> {
  console.log('[create-template-db] Starting template database setup...');

  const templateDb = process.env.PROVISIONING_PG_TEMPLATE_DB;
  if (!templateDb) {
    console.error(
      '[create-template-db] PROVISIONING_PG_TEMPLATE_DB is not set. ' +
      'Set this environment variable to the desired template database name (e.g. template_iotistica).'
    );
    process.exit(1);
  }

  console.log(`[create-template-db] Target template database: ${templateDb}`);

  const forceRecreate = process.env.FORCE_RECREATE === 'true';
  if (forceRecreate) {
    console.log('[create-template-db] FORCE_RECREATE=true – will drop and recreate the template.');
  }

  // Instantiate the provisioning service (reads remaining env vars automatically)
  const service = new PostgresProvisioningService();

  if (forceRecreate) {
    console.log('[create-template-db] Dropping existing template database...');
    await service.dropTemplateDatabase();
  }

  // Locate and load migration SQL
  const migrationsDir = resolveMigrationsDir();
  const schemaSql = loadMigrationSql(migrationsDir);

  // Create (or reuse) the template database and apply schema
  console.log('[create-template-db] Provisioning template database...');
  await service.provisionTemplateDatabase(schemaSql);

  console.log(
    `[create-template-db] Template database "${templateDb}" is ready. ` +
    'New client databases can now be created with: ' +
    `CREATE DATABASE <client-id> TEMPLATE ${templateDb}`
  );
}

main().catch((err) => {
  console.error('[create-template-db] Fatal error:', err.message ?? err);
  process.exit(1);
});
