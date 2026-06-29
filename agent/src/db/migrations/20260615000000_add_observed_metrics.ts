import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS observed_metrics (
			name               TEXT    PRIMARY KEY,
			source             TEXT    NOT NULL DEFAULT 'unknown',
			protocol           TEXT,
			unit               TEXT,
			last_seen_at       INTEGER NOT NULL,
			observation_count  INTEGER NOT NULL DEFAULT 1,
			created_at         INTEGER NOT NULL
		)
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_observed_metrics_last_seen ON observed_metrics(last_seen_at DESC)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_observed_metrics_source ON observed_metrics(source)`);
}

export const migration: NativeSqliteMigration = {
	name: '20260615000000_add_observed_metrics.js',
	up,
};
