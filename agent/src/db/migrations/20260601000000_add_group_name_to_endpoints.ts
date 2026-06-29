import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const hasColumn = db
		.prepare("SELECT 1 FROM pragma_table_info('endpoints') WHERE name = 'group_name'")
		.get();

	if (!hasColumn) {
		db.exec(`ALTER TABLE endpoints ADD COLUMN group_name VARCHAR(255);`);
	}

	db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_group_name ON endpoints(group_name);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260601000000_add_group_name_to_endpoints.js',
	up,
};
