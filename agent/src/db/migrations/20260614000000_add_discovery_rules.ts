import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS discovery_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			protocol TEXT NOT NULL,
			interval_seconds INTEGER NOT NULL DEFAULT 3600,
			target_json TEXT,
			params_json TEXT,
			auto_enable INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'idle',
			last_run_at TEXT,
			next_run_at TEXT,
			last_result_json TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_rules_enabled ON discovery_rules(enabled);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_rules_next_run ON discovery_rules(next_run_at);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260614000000_add_discovery_rules.js',
	up,
};
