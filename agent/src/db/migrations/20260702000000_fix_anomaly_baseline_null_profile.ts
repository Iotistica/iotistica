import type { DatabaseSync } from 'node:sqlite';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'anomaly_baselines')) {
		return;
	}

	// SQLite treats NULL != NULL in UNIQUE indexes, so rows with profile=NULL never
	// triggered ON CONFLICT and accumulated as duplicates instead of upserting.
	// Coerce all NULL profiles to '' to match the new storage behaviour.
	db.exec(`UPDATE anomaly_baselines SET profile = '' WHERE profile IS NULL`);
}

export const migration: NativeSqliteMigration = {
	name: '20260702000000_fix_anomaly_baseline_null_profile.js',
	up,
};
