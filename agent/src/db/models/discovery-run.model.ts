import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface DiscoveryRun {
	id: number;
	rule_uuid: string;
	rule_name: string;
	protocol: string;
	trigger: 'scheduled' | 'manual';
	started_at: string;
	finished_at: string | null;
	duration_ms: number | null;
	status: 'running' | 'ok' | 'error';
	found: number;
	saved: number;
	skipped: number;
	error: string | null;
	created_at: string;
}

const MAX_RUNS_PER_RULE = 100;

export class DiscoveryRunModel {
	private static table = 'discovery_runs';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static create(data: {
		rule_uuid: string;
		rule_name: string;
		protocol: string;
		trigger: 'scheduled' | 'manual';
		started_at: string;
	}): number {
		const result = this.getDb()
			.prepare(`
				INSERT INTO ${this.table} (rule_uuid, rule_name, protocol, trigger, started_at, status)
				VALUES (@rule_uuid, @rule_name, @protocol, @trigger, @started_at, 'running')
			`)
			.run(data);
		return result.lastInsertRowid as number;
	}

	static finish(
		id: number,
		data: {
			finished_at: string;
			duration_ms: number;
			status: 'ok' | 'error';
			found: number;
			saved: number;
			skipped: number;
			error?: string;
		},
	): void {
		this.getDb()
			.prepare(`
				UPDATE ${this.table}
				SET finished_at = @finished_at,
				    duration_ms = @duration_ms,
				    status      = @status,
				    found       = @found,
				    saved       = @saved,
				    skipped     = @skipped,
				    error       = @error
				WHERE id = @id
			`)
			.run({ ...data, error: data.error ?? null, id });

		// Trim old runs — keep only the newest MAX_RUNS_PER_RULE per rule
		const ruleUuidRow = this.getDb()
			.prepare(`SELECT rule_uuid FROM ${this.table} WHERE id = ?`)
			.get(id) as { rule_uuid: string } | undefined;
		if (ruleUuidRow) {
			this.getDb()
				.prepare(`
					DELETE FROM ${this.table}
					WHERE rule_uuid = ?
					  AND id NOT IN (
					    SELECT id FROM ${this.table}
					    WHERE rule_uuid = ?
					    ORDER BY id DESC
					    LIMIT ${MAX_RUNS_PER_RULE}
					  )
				`)
				.run(ruleUuidRow.rule_uuid, ruleUuidRow.rule_uuid);
		}
	}

	static getByRule(ruleUuid: string, limit = 50): DiscoveryRun[] {
		return this.getDb()
			.prepare(
				`SELECT * FROM ${this.table} WHERE rule_uuid = ? ORDER BY id DESC LIMIT ?`,
			)
			.all(ruleUuid, limit) as unknown as DiscoveryRun[];
	}

	static getRecent(limit = 20): DiscoveryRun[] {
		return this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY id DESC LIMIT ?`)
			.all(limit) as unknown as DiscoveryRun[];
	}

	static deleteByRule(ruleUuid: string): void {
		this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE rule_uuid = ?`)
			.run(ruleUuid);
	}
}
