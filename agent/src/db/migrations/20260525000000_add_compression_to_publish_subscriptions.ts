import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const cols = (db.prepare(`PRAGMA table_info(publish_subscriptions)`).all() as unknown as Array<{ name: string }>).map((r) => r.name);
	if (!cols.includes('compression')) {
		db.exec(`ALTER TABLE publish_subscriptions ADD COLUMN compression VARCHAR(50)`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260525000000_add_compression_to_publish_subscriptions.js',
	up,
};
