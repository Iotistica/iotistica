import type Database from 'better-sqlite3';
import { columnExists, tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: Database.Database): void {
	if (!tableExists(db, 'agent') || !columnExists(db, 'agent', 'cloudId')) {
		return;
	}

	db.exec('ALTER TABLE agent DROP COLUMN cloudId');
}

export const migration: NativeSqliteMigration = {
	name: '20260317020000_drop_agent_cloudid.js',
	up,
};