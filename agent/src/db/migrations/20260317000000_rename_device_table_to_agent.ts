import type { DatabaseSync } from 'node:sqlite';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'device')) {
		return;
	}

	db.exec('ALTER TABLE device RENAME TO agent');
	db.exec('DROP INDEX IF EXISTS device_uuid_unique');
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_uuid_unique ON agent (uuid)');
}

export const migration: NativeSqliteMigration = {
	name: '20260317000000_rename_device_table_to_agent.js',
	up,
};