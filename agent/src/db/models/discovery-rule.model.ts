import { randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface DiscoveryRule {
	id?: number;
	uuid: string;
	name: string;
	enabled: boolean;
	protocol: string;
	interval_seconds: number;
	target_json: Record<string, any> | null;
	params_json: Record<string, any> | null;
	auto_enable: boolean;
	status: 'idle' | 'running' | 'ok' | 'error';
	last_run_at: string | null;
	next_run_at: string | null;
	last_result_json: { found: number; saved: number; skipped: number; error?: string } | null;
	created_at?: string;
	updated_at?: string;
}

export type DiscoveryRuleCreateData = Omit<DiscoveryRule, 'id' | 'uuid' | 'status' | 'last_run_at' | 'next_run_at' | 'last_result_json' | 'created_at' | 'updated_at'>;

type DiscoveryRuleRow = Omit<DiscoveryRule, 'enabled' | 'auto_enable' | 'target_json' | 'params_json' | 'last_result_json'> & {
	enabled: number;
	auto_enable: number;
	target_json: string | null;
	params_json: string | null;
	last_result_json: string | null;
};

export class DiscoveryRuleModel {
	private static table = 'discovery_rules';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: DiscoveryRuleRow | undefined): DiscoveryRule | null {
		if (!row) return null;
		return {
			id: row.id,
			uuid: row.uuid,
			name: row.name,
			enabled: !!row.enabled,
			protocol: row.protocol,
			interval_seconds: row.interval_seconds,
			target_json: row.target_json ? JSON.parse(row.target_json) : null,
			params_json: row.params_json ? JSON.parse(row.params_json) : null,
			auto_enable: !!row.auto_enable,
			status: row.status,
			last_run_at: row.last_run_at,
			next_run_at: row.next_run_at,
			last_result_json: row.last_result_json ? JSON.parse(row.last_result_json) : null,
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	}

	static getAll(): DiscoveryRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`)
			.all() as unknown as DiscoveryRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is DiscoveryRule => r !== null);
	}

	static getByUuid(uuid: string): DiscoveryRule | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as DiscoveryRuleRow | undefined;
		return this.parseRow(row);
	}

	static getDue(): DiscoveryRule[] {
		const now = new Date().toISOString();
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 AND status != 'running' AND (next_run_at IS NULL OR next_run_at <= ?)`)
			.all(now) as unknown as DiscoveryRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is DiscoveryRule => r !== null);
	}

	static create(data: DiscoveryRuleCreateData): DiscoveryRule {
		const uuid = randomUUID();
		const now = new Date().toISOString();
		this.getDb().prepare(`
			INSERT INTO ${this.table}
				(uuid, name, enabled, protocol, interval_seconds, target_json, params_json, auto_enable, status, last_run_at, next_run_at, last_result_json, created_at, updated_at)
			VALUES
				(@uuid, @name, @enabled, @protocol, @interval_seconds, @target_json, @params_json, @auto_enable, 'idle', NULL, NULL, NULL, @created_at, @updated_at)
		`).run({
			uuid,
			name: data.name,
			enabled: data.enabled ? 1 : 0,
			protocol: data.protocol,
			interval_seconds: data.interval_seconds,
			target_json: data.target_json ? JSON.stringify(data.target_json) : null,
			params_json: data.params_json ? JSON.stringify(data.params_json) : null,
			auto_enable: data.auto_enable ? 1 : 0,
			created_at: now,
			updated_at: now,
		});
		return this.getByUuid(uuid)!;
	}

	static update(uuid: string, patch: Partial<Omit<DiscoveryRule, 'id' | 'uuid' | 'created_at'>>): DiscoveryRule | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.name !== undefined) fields.name = patch.name;
		if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0;
		if (patch.protocol !== undefined) fields.protocol = patch.protocol;
		if (patch.interval_seconds !== undefined) fields.interval_seconds = patch.interval_seconds;
		if (patch.target_json !== undefined) fields.target_json = patch.target_json ? JSON.stringify(patch.target_json) : null;
		if (patch.params_json !== undefined) fields.params_json = patch.params_json ? JSON.stringify(patch.params_json) : null;
		if (patch.auto_enable !== undefined) fields.auto_enable = patch.auto_enable ? 1 : 0;
		if (patch.status !== undefined) fields.status = patch.status;
		if (patch.last_run_at !== undefined) fields.last_run_at = patch.last_run_at;
		if (patch.next_run_at !== undefined) fields.next_run_at = patch.next_run_at;
		if (patch.last_result_json !== undefined) fields.last_result_json = patch.last_result_json ? JSON.stringify(patch.last_result_json) : null;

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE uuid = @lookup_uuid`).run({ ...fields, lookup_uuid: uuid });
		return this.getByUuid(uuid);
	}

	static delete(uuid: string): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE uuid = ?`).run(uuid).changes > 0;
	}
}
