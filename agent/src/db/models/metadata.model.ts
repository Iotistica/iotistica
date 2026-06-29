/**
 * Agent Metadata Model
 * Stores key-value metadata for agent operations (discovery, etc.)
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

type MetadataRow = {
  key: string;
  value: string;
};

export class MetadataModel {
	private static table = 'agent_metadata';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	/**
   * Get metadata value by key
   */
	static async get(key: string): Promise<string | null> {
		const row = this.getDb()
			.prepare(`SELECT value FROM ${this.table} WHERE key = ? LIMIT 1`)
			.get(key) as unknown as Pick<MetadataRow, 'value'> | undefined;
    
		return row?.value ?? null;
	}

	/**
   * Set metadata value (upsert)
   */
	static async set(key: string, value: string): Promise<void> {
		const now = new Date().toISOString();

		this.getDb()
			.prepare(`
        INSERT INTO ${this.table} (key, value, createdAt, updatedAt)
        VALUES (@key, @value, @createdAt, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updatedAt = excluded.updatedAt
      `)
			.run({
				key,
				value,
				createdAt: now,
				updatedAt: now,
			});
	}

	/**
   * Delete metadata key
   */
	static async delete(key: string): Promise<void> {
		this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE key = ?`)
			.run(key);
	}

	/**
   * Get all metadata keys with prefix
   */
	static async getByPrefix(prefix: string): Promise<Record<string, string>> {
		const rows = this.getDb()
			.prepare(`SELECT key, value FROM ${this.table} WHERE key LIKE ? ORDER BY key ASC`)
			.all(`${prefix}%`) as unknown as MetadataRow[];

		return Object.fromEntries(rows.map((row) => [row.key, row.value]));
	}

	/**
   * Get object from JSON-encoded metadata
   */
	static async getObject<T>(key: string): Promise<T | null> {
		const value = await this.get(key);
		if (!value) return null;
    
		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}

	/**
   * Set object as JSON-encoded metadata
   */
	static async setObject<T>(key: string, obj: T): Promise<void> {
		await this.set(key, JSON.stringify(obj));
	}
}
