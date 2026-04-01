import Database from 'better-sqlite3';
import { getDatabasePath } from './db-path';

let directDb: Database.Database | undefined;

export function getDatabase(): Database.Database {
	if (!directDb) {
		const db = new Database(getDatabasePath());
		const busyTimeoutMs = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '15000', 10);
		const safeBusyTimeoutMs = Number.isFinite(busyTimeoutMs) && busyTimeoutMs > 0 ? busyTimeoutMs : 15000;

		db.pragma('journal_mode = WAL');
		db.pragma(`busy_timeout = ${safeBusyTimeoutMs}`);

		if (process.env.SQLITE_READONLY_MODE === 'true') {
			db.pragma('query_only = ON');
		}

		directDb = db;
	}

	return directDb;
}

export function closeDatabase(): void {
	if (!directDb) {
		return;
	}

	directDb.close();
	directDb = undefined;
}