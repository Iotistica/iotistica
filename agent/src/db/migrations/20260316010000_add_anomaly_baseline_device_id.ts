import type { DatabaseSync } from 'node:sqlite';
import { columnExists, tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'anomaly_baselines')) {
		return;
	}

	if (!columnExists(db, 'anomaly_baselines', 'device_id')) {
		db.exec(`
			ALTER TABLE anomaly_baselines
			ADD COLUMN device_id TEXT NOT NULL DEFAULT 'unknown-device'
		`);
	}

	db.exec('DROP INDEX IF EXISTS anomaly_baselines_new_metric_profile_time_slot_unique');
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_new_metric_profile_time_slot_unique
		ON anomaly_baselines (metric, profile, time_slot, device_state, device_id)
	`);
	db.exec('DROP INDEX IF EXISTS idx_anomaly_baselines_lookup');
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_lookup
		ON anomaly_baselines (metric, time_slot, device_state, device_id, calculated_at)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260316010000_add_anomaly_baseline_device_id.js',
	up,
};