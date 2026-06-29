import type { DatabaseSync } from 'node:sqlite';
import { columnExists, tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'anomaly_baselines')) {
		return;
	}

	if (!columnExists(db, 'anomaly_baselines', 'device_state')) {
		db.exec(`
			ALTER TABLE anomaly_baselines
			ADD COLUMN device_state TEXT NOT NULL DEFAULT 'unknown'
		`);
	}

	db.exec('DROP INDEX IF EXISTS anomaly_baselines_new_metric_profile_time_slot_unique');
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_new_metric_profile_time_slot_unique
		ON anomaly_baselines (metric, profile, time_slot, device_state)
	`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_lookup
		ON anomaly_baselines (metric, time_slot, device_state, calculated_at)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260316000000_add_anomaly_baseline_device_state.js',
	up,
};