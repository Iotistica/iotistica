import { DatabaseSync } from 'node:sqlite';
import { getDatabasePath } from './db-path';

let directDb: DatabaseSync | undefined;

export function getDatabase(): DatabaseSync {
	if (!directDb) {
		const db = new DatabaseSync(getDatabasePath());
		const busyTimeoutMs = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '15000', 10);
		const safeBusyTimeoutMs = Number.isFinite(busyTimeoutMs) && busyTimeoutMs > 0 ? busyTimeoutMs : 15000;

		db.exec(`PRAGMA journal_mode = WAL`);
		db.exec(`PRAGMA busy_timeout = ${safeBusyTimeoutMs}`);

		if (process.env.SQLITE_READONLY_MODE === 'true') {
			db.exec('PRAGMA query_only = ON');
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

/** Run fn inside a transaction, committing on success and rolling back on error. */
export function transact<T>(db: DatabaseSync, fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' = 'DEFERRED'): T {
	db.exec(`BEGIN ${mode}`);
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		try { db.exec('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
		throw err;
	}
}
