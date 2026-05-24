import type Database from 'better-sqlite3';
import { getDatabase } from '../sqlite';

export type PublishPayloadFormat = 'custom' | 'tags' | 'ecp';

export interface PublishSubscriptionRoute {
	includeMetrics?: string[];
	excludeMetrics?: string[];
	includeDevices?: string[];
	excludeDevices?: string[];
	qualities?: Array<'GOOD' | 'BAD' | 'UNCERTAIN'>;
	minIntervalMs?: number;
	maxPointsPerMessage?: number;
	topic?: string;
}

export interface PublishSubscriptionRecord {
	id?: number;
	publisher_id: number;
	topics: string[];
	route_json?: PublishSubscriptionRoute | null;
	payload_format: PublishPayloadFormat;
	enabled: boolean;
	created_at?: Date;
	updated_at?: Date;
}

type PublishSubscriptionRow = Omit<PublishSubscriptionRecord, 'topics' | 'route_json' | 'enabled' | 'created_at' | 'updated_at'> & {
	topics: string;
	route_json?: string | null;
	enabled: number;
	created_at?: string | Date;
	updated_at?: string | Date;
};

export class PublishSubscriptionsModel {
	private static readonly table = 'publish_subscriptions';

	private static getDb(): Database.Database {
		return getDatabase();
	}

	private static parseJsonArray(value: string): string[] {
		try {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
		} catch {
			return [];
		}
	}

	private static mapRow(row: PublishSubscriptionRow | undefined): PublishSubscriptionRecord | null {
		if (!row) {
			return null;
		}

		let route: PublishSubscriptionRoute | null = null;
		if (typeof row.route_json === 'string' && row.route_json.trim().length > 0) {
			try {
				route = JSON.parse(row.route_json) as PublishSubscriptionRoute;
			} catch {
				route = null;
			}
		}

		return {
			...row,
			topics: this.parseJsonArray(row.topics),
			route_json: route,
			enabled: !!row.enabled,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
		};
	}

	static getAll(includeDisabled: boolean = true): PublishSubscriptionRecord[] {
		const db = this.getDb();
		const rows = includeDisabled
			? (db.prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as PublishSubscriptionRow[])
			: (db.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 ORDER BY id ASC`).all() as PublishSubscriptionRow[]);

		return rows
			.map((row) => this.mapRow(row))
			.filter((row): row is PublishSubscriptionRecord => row !== null);
	}

	static getByPublisherId(publisherId: number, includeDisabled: boolean = true): PublishSubscriptionRecord[] {
		const db = this.getDb();
		const rows = includeDisabled
			? (db.prepare(`SELECT * FROM ${this.table} WHERE publisher_id = ? ORDER BY id ASC`).all(publisherId) as PublishSubscriptionRow[])
			: (db.prepare(`SELECT * FROM ${this.table} WHERE publisher_id = ? AND enabled = 1 ORDER BY id ASC`).all(publisherId) as PublishSubscriptionRow[]);

		return rows
			.map((row) => this.mapRow(row))
			.filter((row): row is PublishSubscriptionRecord => row !== null);
	}

	static getById(id: number): PublishSubscriptionRecord | null {
		const row = this.getDb().prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`).get(id) as PublishSubscriptionRow | undefined;
		return this.mapRow(row);
	}

	static create(input: Omit<PublishSubscriptionRecord, 'id' | 'created_at' | 'updated_at'>): PublishSubscriptionRecord | null {
		const now = new Date().toISOString();
		const result = this.getDb().prepare(`
			INSERT INTO ${this.table} (
				publisher_id,
				topics,
				route_json,
				payload_format,
				enabled,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.publisher_id,
			JSON.stringify(input.topics || []),
			input.route_json ? JSON.stringify(input.route_json) : null,
			input.payload_format,
			input.enabled ? 1 : 0,
			now,
			now,
		);

		return this.getById(Number(result.lastInsertRowid));
	}

	static update(id: number, updates: Partial<Omit<PublishSubscriptionRecord, 'id' | 'created_at'>>): PublishSubscriptionRecord | null {
		const payload: Record<string, unknown> = {
			updated_at: new Date().toISOString(),
		};

		if (updates.publisher_id !== undefined) payload.publisher_id = updates.publisher_id;
		if (updates.topics !== undefined) payload.topics = JSON.stringify(updates.topics || []);
		if (updates.route_json !== undefined) payload.route_json = updates.route_json ? JSON.stringify(updates.route_json) : null;
		if (updates.payload_format !== undefined) payload.payload_format = updates.payload_format;
		if (updates.enabled !== undefined) payload.enabled = updates.enabled ? 1 : 0;

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

	static deleteByPublisherId(publisherId: number): number {
		const result = this.getDb().prepare(`DELETE FROM ${this.table} WHERE publisher_id = ?`).run(publisherId);
		return result.changes;
	}
}
