/**
 * Schema Drift Model
 * Stores lightweight schema drift state in the agent SQLite database.
 *
 * Why baseline persistence matters:
 * - Baseline learning spans multiple batches, so restarts would otherwise force relearning.
 * - Persisting the learned state preserves adaptive behavior on intermittently connected edge devices.
 *
 * Why drift occurrences are persisted:
 * - Operators need a compact audit trail of what changed and when.
 * - Persisting drift events supports debugging without storing every payload.
 *
 * Why this stays intentionally lightweight:
 * - Uses the existing agent SQLite database.
 * - Stores complex state as JSON blobs.
 * - Avoids ORM, repository layers, and lifecycle complexity.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type DriftType = 'new-field' | 'missing-field' | 'type-drift' | 'rename-candidate';
export type DriftSeverity = 'warning' | 'critical';

export interface SchemaDriftEvent {
	endpointName: string;
	driftType: DriftType;
	fieldName?: string;
	severity: DriftSeverity;
	expectedType?: string;
	observedTypes?: string[];
	renameCandidateFrom?: string;
	renameCandidateTo?: string;
	renameSimilarity?: number;
	timestamp?: string | Date;
	details?: Record<string, unknown>;
}

export interface PersistedTypeFrequency {
	counts: Record<string, number>;
	total: number;
}

export interface PersistedBaselineState {
	endpointName: string;
	baselineFields: string[];
	baselineTypeFreq: Record<string, PersistedTypeFrequency>;
	missingStreakByField: Record<string, number>;
	totalBatches: number;
	warmupSeen: number;
	tombstones?: Record<string, number>;
	newFieldCounts?: Record<string, number>;
	newFieldFirstSeen?: Record<string, number>;
	newFieldTypeFreq?: Record<string, PersistedTypeFrequency>;
}

export interface SchemaDriftStore {
	saveDrift(event: SchemaDriftEvent): void;
	saveBaseline(state: PersistedBaselineState): void;
	loadBaseline(endpointName: string): PersistedBaselineState | undefined;
}

type SchemaDriftLogRow = {
	endpoint_name: string;
	drift_type: DriftType;
	field_name: string | null;
	severity: DriftSeverity;
	expected_type: string | null;
	observed_types: string | null;
	rename_candidate_from: string | null;
	rename_candidate_to: string | null;
	rename_similarity: number | null;
	detected_at: string;
	details_json: string | null;
};

export class SchemaDriftModel {
	private static readonly driftTable = 'message_schema_drift_log';
	private static readonly baselineTable = 'message_schema_baseline';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static saveDrift(event: SchemaDriftEvent): void {
		this.getDb()
			.prepare(`
				INSERT INTO ${this.driftTable} (
					endpoint_name,
					drift_type,
					field_name,
					severity,
					expected_type,
					observed_types,
					rename_candidate_from,
					rename_candidate_to,
					rename_similarity,
					detected_at,
					details_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				event.endpointName,
				event.driftType,
				event.fieldName ?? null,
				event.severity,
				event.expectedType ?? null,
				event.observedTypes ? JSON.stringify(event.observedTypes) : null,
				event.renameCandidateFrom ?? null,
				event.renameCandidateTo ?? null,
				event.renameSimilarity ?? null,
				event.timestamp instanceof Date ? event.timestamp.toISOString() : (event.timestamp ?? new Date().toISOString()),
				event.details ? JSON.stringify(event.details) : null,
			);
	}

	static saveBaseline(state: PersistedBaselineState): void {
		this.getDb()
			.prepare(`
				INSERT INTO ${this.baselineTable} (
					endpoint_name,
					baseline_json,
					updated_at
				) VALUES (?, ?, ?)
				ON CONFLICT(endpoint_name) DO UPDATE SET
					baseline_json = excluded.baseline_json,
					updated_at = excluded.updated_at
			`)
			.run(
				state.endpointName,
				JSON.stringify(state),
				new Date().toISOString(),
			);
	}

	static loadBaseline(endpointName: string): PersistedBaselineState | undefined {
		const row = this.getDb()
			.prepare(`
				SELECT baseline_json
				FROM ${this.baselineTable}
				WHERE endpoint_name = ?
				LIMIT 1
			`)
			.get(endpointName) as { baseline_json: string } | undefined;

		if (!row) {
			return undefined;
		}

		try {
			return JSON.parse(row.baseline_json) as PersistedBaselineState;
		} catch {
			return undefined;
		}
	}

	static recentDrifts(endpointName: string, limit = 100): Array<SchemaDriftEvent & { detectedAt: Date }> {
		const rows = this.getDb()
			.prepare(`
				SELECT
					endpoint_name,
					drift_type,
					field_name,
					severity,
					expected_type,
					observed_types,
					rename_candidate_from,
					rename_candidate_to,
					rename_similarity,
					detected_at,
					details_json
				FROM ${this.driftTable}
				WHERE endpoint_name = ?
				ORDER BY detected_at DESC
				LIMIT ?
			`)
			.all(endpointName, limit) as unknown as SchemaDriftLogRow[];

		return rows.map((row) => ({
			endpointName: row.endpoint_name,
			driftType: row.drift_type,
			fieldName: row.field_name ?? undefined,
			severity: row.severity,
			expectedType: row.expected_type ?? undefined,
			observedTypes: row.observed_types ? JSON.parse(row.observed_types) as string[] : undefined,
			renameCandidateFrom: row.rename_candidate_from ?? undefined,
			renameCandidateTo: row.rename_candidate_to ?? undefined,
			renameSimilarity: row.rename_similarity ?? undefined,
			detectedAt: new Date(row.detected_at),
			details: row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : undefined,
		}));
	}
}
