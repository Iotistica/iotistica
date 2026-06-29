import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS admin_sessions (
			token       TEXT    PRIMARY KEY,
			username    TEXT    NOT NULL,
			expires_at  INTEGER NOT NULL,
			created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260620000000_add_admin_sessions.js',
	up,
};
