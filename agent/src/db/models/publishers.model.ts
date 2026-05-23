import type Database from 'better-sqlite3';
import { getDatabase } from '../sqlite';

export type PublisherType = 'iotistica' | 'azure' | 'aws' | 'gcp' | 'mqtt' | string;

export interface PublisherRecord {
	id?: number;
	name: string;
	type: PublisherType;
	config_json?: Record<string, unknown> | null;
	enabled: boolean;
	last_error?: string | null;
	last_error_at?: Date | null;
	created_at?: Date;
	updated_at?: Date;
}

type PublisherRow = Omit<PublisherRecord, 'enabled' | 'config_json' | 'last_error_at' | 'created_at' | 'updated_at'> & {
	enabled: number;
	config_json?: string | null;
	last_error_at?: string | Date | null;
	created_at?: string | Date;
	updated_at?: string | Date;
};

export class PublishersModel {
	private static readonly table = 'publishers';

	private static getDb(): Database.Database {
		return getDatabase();
	}

	private static mapRow(row: PublisherRow | undefined): PublisherRecord | null {
		if (!row) {
			return null;
		}

		let parsedConfig: Record<string, unknown> | null = null;
		if (typeof row.config_json === 'string' && row.config_json.trim().length > 0) {
			try {
				parsedConfig = JSON.parse(row.config_json) as Record<string, unknown>;
			} catch {
				parsedConfig = null;
			}
		}

		return {
			...row,
			enabled: !!row.enabled,
			config_json: parsedConfig,
			last_error_at: row.last_error_at ? new Date(row.last_error_at) : null,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
		};
	}

	static getAll(includeDisabled: boolean = true): PublisherRecord[] {
		const db = this.getDb();
		const rows = includeDisabled
			? (db.prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as PublisherRow[])
			: (db.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 ORDER BY id ASC`).all() as PublisherRow[]);

		return rows
			.map((row) => this.mapRow(row))
			.filter((row): row is PublisherRecord => row !== null);
	}

	static getById(id: number): PublisherRecord | null {
		const row = this.getDb().prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`).get(id) as PublisherRow | undefined;
		return this.mapRow(row);
	}

	static create(input: Omit<PublisherRecord, 'id' | 'created_at' | 'updated_at' | 'last_error' | 'last_error_at'>): PublisherRecord | null {
		const now = new Date().toISOString();
		const result = this.getDb().prepare(`
			INSERT INTO ${this.table} (
				name,
				type,
				config_json,
				enabled,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
		`).run(
			input.name,
			input.type,
			input.config_json ? JSON.stringify(input.config_json) : null,
			input.enabled ? 1 : 0,
			now,
			now,
		);

		return this.getById(Number(result.lastInsertRowid));
	}

	static update(id: number, updates: Partial<Omit<PublisherRecord, 'id' | 'created_at'>>): PublisherRecord | null {
		const payload: Record<string, unknown> = {
			updated_at: new Date().toISOString(),
		};

		if (updates.name !== undefined) payload.name = updates.name;
		if (updates.type !== undefined) payload.type = updates.type;
		if (updates.config_json !== undefined) {
			payload.config_json = updates.config_json ? JSON.stringify(updates.config_json) : null;
		}
		if (updates.enabled !== undefined) payload.enabled = updates.enabled ? 1 : 0;
		if (updates.last_error !== undefined) payload.last_error = updates.last_error;
		if (updates.last_error_at !== undefined) {
			payload.last_error_at = updates.last_error_at ? updates.last_error_at.toISOString() : null;
		}

		const columns = Object.keys(payload);
		if (columns.length === 0) {
			return this.getById(id);
		}

		const sql = `UPDATE ${this.table} SET ${columns.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`;
		this.getDb().prepare(sql).run({ ...payload, id });
		return this.getById(id);
	}

	static delete(id: number): boolean {
		const result = this.getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
		return result.changes > 0;
	}
}
