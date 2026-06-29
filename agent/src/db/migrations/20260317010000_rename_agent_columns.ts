import type { DatabaseSync } from 'node:sqlite';
import { columnExists, tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'agent')) {
		return;
	}

	if (columnExists(db, 'agent', 'deviceId')) {
		db.exec('ALTER TABLE agent RENAME COLUMN deviceId TO cloudId');
	}

	if (columnExists(db, 'agent', 'deviceName')) {
		db.exec('ALTER TABLE agent RENAME COLUMN deviceName TO name');
	}

	if (columnExists(db, 'agent', 'deviceType')) {
		db.exec('ALTER TABLE agent RENAME COLUMN deviceType TO type');
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260317010000_rename_agent_columns.js',
	up,
};