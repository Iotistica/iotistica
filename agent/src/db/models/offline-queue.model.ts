import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface OfflineQueueRecord {
	id: number;
	queueName: string;
	payload: string;
	createdAt: number;
	attempts: number;
}

export class OfflineQueueModel {
	private static table = 'offline_queue';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static ensureTable(): boolean {
		const db = this.getDb();
		const existingTable = db
			.prepare(`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table' AND name = ?
				LIMIT 1
			`)
			.get(this.table) as { name?: string } | undefined;

		db.exec(`
			CREATE TABLE IF NOT EXISTS ${this.table} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				queueName VARCHAR(255) NOT NULL,
				payload TEXT NOT NULL,
				createdAt BIGINT NOT NULL,
				attempts INTEGER DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS offline_queue_queuename_createdat_index
			ON ${this.table} (queueName, createdAt);
		`);

		return !existingTable?.name;
	}

	static getRowsOrdered(queueName: string): OfflineQueueRecord[] {
		return this.getDb()
			.prepare(`
				SELECT id, queueName, payload, createdAt, attempts
				FROM ${this.table}
				WHERE queueName = ?
				ORDER BY createdAt ASC
			`)
			.all(queueName) as unknown as OfflineQueueRecord[];
	}

	static getPayloads(queueName: string): Array<{ payload: string }> {
		return this.getDb()
			.prepare(`
				SELECT payload
				FROM ${this.table}
				WHERE queueName = ?
				ORDER BY createdAt ASC
			`)
			.all(queueName) as unknown as Array<{ payload: string }>;
	}

	static insert(queueName: string, payload: string, createdAt: number, attempts: number = 0): void {
		this.getDb()
			.prepare(`
				INSERT INTO ${this.table} (queueName, payload, createdAt, attempts)
				VALUES (?, ?, ?, ?)
			`)
			.run(queueName, payload, createdAt, attempts);
	}

	static getOldest(queueName: string): Pick<OfflineQueueRecord, 'id'> | null {
		const row = this.getDb()
			.prepare(`
				SELECT id
				FROM ${this.table}
				WHERE queueName = ?
				ORDER BY createdAt ASC
				LIMIT 1
			`)
			.get(queueName) as unknown as Pick<OfflineQueueRecord, 'id'> | undefined;

		return row ?? null;
	}

	static deleteById(id: number): void {
		this.getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
	}

	static getCount(queueName: string): number {
		const row = this.getDb()
			.prepare(`SELECT COUNT(*) AS count FROM ${this.table} WHERE queueName = ?`)
			.get(queueName) as { count?: number | string } | undefined;

		return parseInt(String(row?.count ?? '0'), 10);
	}

	static getOldestCreatedAt(queueName: string): number | undefined {
		const row = this.getDb()
			.prepare(`
				SELECT createdAt
				FROM ${this.table}
				WHERE queueName = ?
				ORDER BY createdAt ASC
				LIMIT 1
			`)
			.get(queueName) as { createdAt?: number | string } | undefined;

		if (row?.createdAt === undefined || row.createdAt === null) {
			return undefined;
		}

		const createdAtMs = Number(row.createdAt);
		return Number.isNaN(createdAtMs) ? undefined : createdAtMs;
	}

	static deleteByQueueName(queueName: string): void {
		this.getDb().prepare(`DELETE FROM ${this.table} WHERE queueName = ?`).run(queueName);
	}

	static updateAttempts(id: number, attempts: number): void {
		this.getDb().prepare(`UPDATE ${this.table} SET attempts = ? WHERE id = ?`).run(attempts, id);
	}

	/**
	* Delete all items older than the given cutoff timestamp (ms).
	* Returns the number of rows deleted.
	* Mirrors EdgeHub CleanupProcessor TTL eviction logic.
	*/
	static deleteOlderThan(queueName: string, cutoffMs: number): number {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE queueName = ? AND createdAt < ?`)
			.run(queueName, cutoffMs);
		return Number(result.changes);
	}
}