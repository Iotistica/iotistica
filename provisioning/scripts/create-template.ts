#!/usr/bin/env ts-node
/**
 * Create PostgreSQL Template Database
 * 
 * This script:
 * 1. Reads all migration files from api/database/migrations
 * 2. Concatenates them into a single schema
 * 3. Creates a template database with the full schema
 * 4. Locks the template for fast cloning
 * 
 * Usage:
 *   npx ts-node scripts/create-template.ts
 * 
 * Or with npm script:
 *   npm run create-template
 * 
 * Environment variables required:
 *   PROVISIONING_PG_HOST
 *   PROVISIONING_PG_PORT
 *   PROVISIONING_PG_ADMIN_USER
 *   PROVISIONING_PG_ADMIN_PASSWORD
 *   PROVISIONING_PG_TEMPLATE_DB (e.g., "template_iotistica")
 */

// Load environment variables from .env file
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load .env from the provisioning directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { PostgresProvisioningService } from '../src/services/postgres-provisioning-service';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../api/database/migrations');

async function main() {
  console.log('======================================');
  console.log('PostgreSQL Template Database Creator');
  console.log('======================================\n');

  // Validate environment
  const templateName = process.env.PROVISIONING_PG_TEMPLATE_DB;
  if (!templateName) {
    console.error('❌ Error: PROVISIONING_PG_TEMPLATE_DB environment variable is required');
    console.error('   Set it to the desired template database name (e.g., "template_iotistica")');
    process.exit(1);
  }

  console.log(`📦 Template database name: ${templateName}`);
  console.log(`📁 Migrations directory: ${MIGRATIONS_DIR}\n`);

  // Check migrations directory exists
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ Error: Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  // Read all migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort(); // Ensure alphabetical order (001_, 002_, etc.)

  if (files.length === 0) {
    console.error('❌ Error: No migration files found in migrations directory');
    process.exit(1);
  }

  console.log(`📄 Found ${files.length} migration file(s):`);
  files.forEach(file => console.log(`   - ${file}`));
  console.log();

  // Concatenate all migration files
  let fullSchemaSQL = '';
  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    
    fullSchemaSQL += `-- ============================================\n`;
    fullSchemaSQL += `-- Migration: ${file}\n`;
    fullSchemaSQL += `-- ============================================\n\n`;
    fullSchemaSQL += content;
    fullSchemaSQL += '\n\n';
    
    console.log(`✅ Loaded migration: ${file}`);
  }

  console.log(`\n📊 Total schema size: ${fullSchemaSQL.length} characters\n`);

  // Create the provisioning service
  const service = new PostgresProvisioningService();

  try {
    console.log('� Checking for TimescaleDB extension availability...\n');
    
    // Check if TimescaleDB is available on the server
    const { Client } = await import('pg');
    const adminClient = new Client({
      host: process.env.PROVISIONING_PG_HOST,
      port: parseInt(process.env.PROVISIONING_PG_PORT || '5432'),
      user: process.env.PROVISIONING_PG_ADMIN_USER,
      password: process.env.PROVISIONING_PG_ADMIN_PASSWORD,
      database: process.env.PROVISIONING_PG_ADMIN_DB || 'postgres',
    });
    
    await adminClient.connect();
    const result = await adminClient.query(
      "SELECT COUNT(*) as count FROM pg_available_extensions WHERE name = 'timescaledb'"
    );
    await adminClient.end();
    
    const timescaleAvailable = result.rows[0].count > 0;
    
    if (!timescaleAvailable) {
      console.log('⚠️  TimescaleDB extension not available on server - removing from schema\n');
      
      // Remove TimescaleDB extension, internal tables, schemas, and comments
      fullSchemaSQL = fullSchemaSQL
        // Remove extension creation
        .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb[^;]*;/gi, '-- TimescaleDB not available, skipped')
        // Remove extension comments
        .replace(/COMMENT ON EXTENSION timescaledb[^;]*;/gi, '-- TimescaleDB comment skipped')
        // Remove _timescaledb_internal tables
        .replace(/CREATE TABLE _timescaledb_internal\.[^;]+;/gi, '-- TimescaleDB internal table skipped')
        // Remove _timescaledb_internal views
        .replace(/CREATE VIEW _timescaledb_internal\.[^;]+;/gi, '-- TimescaleDB internal view skipped')
        // Remove comments on TimescaleDB objects
        .replace(/COMMENT ON [^;]*_timescaledb_[^;]+;/gi, '-- TimescaleDB object comment skipped');
        
      console.log('✅ Schema cleaned (TimescaleDB references removed)\n');
    } else {
      console.log('✅ TimescaleDB extension is available\n');
    }
    
    console.log('�🚀 Creating template database with full schema...\n');
    
    // This will:
    // 1. CREATE DATABASE template_iotistica TEMPLATE template0
    // 2. Execute all migrations against it
    // 3. Lock it with IS_TEMPLATE=TRUE, ALLOW_CONNECTIONS=FALSE
    await service.provisionTemplateDatabase(fullSchemaSQL);
    
    console.log('\n✅ SUCCESS! Template database created and ready for use');
    console.log(`\n📌 Next steps:`);
    console.log(`   1. Ensure PROVISIONING_PG_TEMPLATE_DB=${templateName} is set in your .env`);
    console.log(`   2. All new client databases will be cloned from this template`);
    console.log(`   3. Provisioning time reduced from ~30-60 seconds to ~200ms per client`);
    console.log();
  } catch (error) {
    console.error('\n❌ Error creating template database:', error);
    process.exit(1);
  }
}

// Handle errors gracefully
main().catch(error => {
  console.error('\n❌ Unhandled error:', error);
  process.exit(1);
});
