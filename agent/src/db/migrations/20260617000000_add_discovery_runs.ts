import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS discovery_runs (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			rule_uuid    TEXT    NOT NULL,
			rule_name    TEXT    NOT NULL,
			protocol     TEXT    NOT NULL,
			trigger      TEXT    NOT NULL DEFAULT 'scheduled',
			started_at   TEXT    NOT NULL,
			finished_at  TEXT,
			duration_ms  INTEGER,
			status       TEXT    NOT NULL DEFAULT 'running',
			found        INTEGER NOT NULL DEFAULT 0,
			saved        INTEGER NOT NULL DEFAULT 0,
			skipped      INTEGER NOT NULL DEFAULT 0,
			error        TEXT,
			created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_runs_rule_uuid ON discovery_runs(rule_uuid);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_runs_started_at ON discovery_runs(started_at DESC);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260617000000_add_discovery_runs.js',
	up,
};
