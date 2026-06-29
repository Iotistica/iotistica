import type { DatabaseSync } from 'node:sqlite';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function indexExists(db: DatabaseSync, indexName: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
		.get(indexName);

	return Boolean(row);
}

function up(db: DatabaseSync): void {
	const oldDriftTable = 'schema_drift_log';
	const newDriftTable = 'message_schema_drift_log';
	const oldBaselineTable = 'schema_baseline';
	const newBaselineTable = 'message_schema_baseline';

	if (tableExists(db, oldDriftTable) && !tableExists(db, newDriftTable)) {
		db.exec(`ALTER TABLE ${oldDriftTable} RENAME TO ${newDriftTable}`);
	}

	if (tableExists(db, oldBaselineTable) && !tableExists(db, newBaselineTable)) {
		db.exec(`ALTER TABLE ${oldBaselineTable} RENAME TO ${newBaselineTable}`);
	}

	if (!tableExists(db, newDriftTable)) {
		db.exec(`
			CREATE TABLE ${newDriftTable} (
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

	if (!tableExists(db, newBaselineTable)) {
		db.exec(`
			CREATE TABLE ${newBaselineTable} (
				endpoint_name TEXT PRIMARY KEY,
				baseline_json TEXT NOT NULL,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);
	}

	if (indexExists(db, 'idx_drift_log_endpoint_time')) {
		db.exec('DROP INDEX idx_drift_log_endpoint_time');
	}

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_message_schema_drift_log_endpoint_time
		ON ${newDriftTable}(endpoint_name, detected_at DESC)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260515000000_add_schema_drift_tables.js',
	up,
};
