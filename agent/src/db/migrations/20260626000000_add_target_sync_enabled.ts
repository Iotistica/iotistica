import type { DatabaseSync } from 'node:sqlite';
import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (columnExists(db, 'agent', 'target_sync_enabled')) return;
	// Default 1 so existing provisioned agents keep full sync behaviour unchanged.
	db.exec(`ALTER TABLE agent ADD COLUMN target_sync_enabled INTEGER NOT NULL DEFAULT 1`);
}

export const migration: NativeSqliteMigration = {
	name: '20260626000000_add_target_sync_enabled.js',
	up,
};
