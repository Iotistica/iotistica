import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface RetryStateRecord {
	key: string;
	count: number;
	next_retry: string;
	last_error: string;
	terminal: number;
	retryable: number;
	updated_at: string;
}

export class RetryStateModel {
	private static table = 'retry_state';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): RetryStateRecord[] {
		return this.getDb()
			.prepare(`
				SELECT key, count, next_retry, last_error, terminal, retryable, updated_at
				FROM ${this.table}
			`)
			.all() as unknown as RetryStateRecord[];
	}

	static upsert(record: RetryStateRecord): void {
		this.getDb()
			.prepare(`
				INSERT INTO ${this.table} (
					key,
					count,
					next_retry,
					last_error,
					terminal,
					retryable,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET
					count = excluded.count,
					next_retry = excluded.next_retry,
					last_error = excluded.last_error,
					terminal = excluded.terminal,
					retryable = excluded.retryable,
					updated_at = excluded.updated_at
			`)
			.run(
				record.key,
				record.count,
				record.next_retry,
				record.last_error,
				record.terminal,
				record.retryable,
				record.updated_at,
			);
	}

	static delete(key: string): void {
		this.getDb().prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key);
	}

	static clearAll(): void {
		this.getDb().prepare(`DELETE FROM ${this.table}`).run();
	}
}