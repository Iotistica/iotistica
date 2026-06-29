import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT    NOT NULL,
			password_hash TEXT    NOT NULL,
			is_superuser  INTEGER NOT NULL DEFAULT 0,
			is_active     INTEGER NOT NULL DEFAULT 1,
			created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);`);

	// Seed default admin user
	const hash = bcrypt.hashSync('admin', 10);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO users (username, password_hash, is_superuser, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`
	).run('admin', hash, now, now);
}

export const migration: NativeSqliteMigration = {
	name: '20260620010000_add_admin_users.js',
	up,
};
