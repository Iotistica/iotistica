import type { DatabaseSync } from 'node:sqlite';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!tableExists(db, 'publish_destinations')) {
		db.exec(`
			CREATE TABLE publish_destinations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name VARCHAR(255) NOT NULL,
				type VARCHAR(50) NOT NULL,
				config_json TEXT,
				enabled BOOLEAN NOT NULL DEFAULT 1,
				last_error TEXT,
				last_error_at DATETIME,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_destinations_name_unique ON publish_destinations(name)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_publish_destinations_type_enabled ON publish_destinations(type, enabled)');
	}

	if (!tableExists(db, 'publish_subscriptions')) {
		db.exec(`
			CREATE TABLE publish_subscriptions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				publish_destination_id INTEGER NOT NULL REFERENCES publish_destinations(id) ON DELETE CASCADE,
				topics TEXT NOT NULL DEFAULT '[]',
				route_json TEXT,
				payload_format VARCHAR(20) NOT NULL DEFAULT 'custom',
				enabled BOOLEAN NOT NULL DEFAULT 1,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_publish_subscriptions_publish_destination_id ON publish_subscriptions(publish_destination_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_publish_subscriptions_enabled ON publish_subscriptions(enabled)');
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260523010000_add_publish_control_tables.js',
	up,
};
