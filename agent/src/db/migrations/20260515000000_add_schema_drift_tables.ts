import type Database from 'better-sqlite3';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: Database.Database): void {
	if (!tableExists(db, 'schema_drift_log')) {
		db.exec(`
			CREATE TABLE schema_drift_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				endpoint_name TEXT NOT NULL,
				drift_type TEXT NOT NULL,
				field_name TEXT,
				severity TEXT NOT NULL,
				expected_type TEXT,
				observed_types TEXT,
				rename_candidate_from TEXT,
				rename_candidate_to TEXT,
				rename_similarity REAL,
				detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				details_json TEXT
			)
		`);
	}

	if (!tableExists(db, 'schema_baseline')) {
		db.exec(`
			CREATE TABLE schema_baseline (
				endpoint_name TEXT PRIMARY KEY,
				baseline_json TEXT NOT NULL,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);
	}

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_drift_log_endpoint_time
		ON schema_drift_log(endpoint_name, detected_at DESC)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260515000000_add_schema_drift_tables.js',
	up,
};
