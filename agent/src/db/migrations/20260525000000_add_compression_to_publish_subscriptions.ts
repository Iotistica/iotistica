import type Database from 'better-sqlite3';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: Database.Database): void {
	const cols = (db.pragma(`table_info(publish_subscriptions)`) as Array<{ name: string }>).map((r) => r.name);
	if (!cols.includes('compression')) {
		db.exec(`ALTER TABLE publish_subscriptions ADD COLUMN compression VARCHAR(50)`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260525000000_add_compression_to_publish_subscriptions.js',
	up,
};
