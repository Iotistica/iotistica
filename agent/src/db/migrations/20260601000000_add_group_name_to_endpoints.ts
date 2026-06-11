import type Database from 'better-sqlite3';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: Database.Database): void {
	// Add group_name column to endpoints table to support custom adapter group names
	// Allows multiple instances of the same protocol with different configurations
	// Example: "warehouse-modbus", "factory-opcua", "backup-opcua"
	db.exec(`
		ALTER TABLE endpoints ADD COLUMN group_name VARCHAR(255);
		
		-- Create index for efficient group-based lookups
		CREATE INDEX IF NOT EXISTS idx_endpoints_group_name ON endpoints(group_name);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260601000000_add_group_name_to_endpoints.js',
	up,
};
