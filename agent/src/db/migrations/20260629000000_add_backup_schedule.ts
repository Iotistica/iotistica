import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS backup_schedule (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			enabled INTEGER NOT NULL DEFAULT 0,
			interval_hours INTEGER NOT NULL DEFAULT 24,
			keep_count INTEGER NOT NULL DEFAULT 7,
			last_run_at TEXT,
			next_run_at TEXT,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
	// Seed the single config row so reads never return null
	db.exec(`INSERT OR IGNORE INTO backup_schedule (id) VALUES (1)`);
}

export const migration: NativeSqliteMigration = {
	name: '20260629000000_add_backup_schedule.js',
	up,
};
