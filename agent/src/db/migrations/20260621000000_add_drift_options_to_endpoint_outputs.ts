import type { NativeSqliteMigration } from '../migration-types.js';

export const migration: NativeSqliteMigration = {
	name: '20260621000000_add_drift_options_to_endpoint_outputs.js',
	up: (db) => {
		db.exec(`
      ALTER TABLE endpoint_outputs ADD COLUMN drift_options_json TEXT DEFAULT NULL;
    `);
	},
};
