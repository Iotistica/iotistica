/**
 * Lightweight SQLite persistence for schema drift detection.
 *
 * Why persistence matters:
 * - Baseline learning takes 20+ batches; without persistence, each restart discards learning.
 * - Drift occurrences help operators understand what changed and when.
 * - On edge devices with intermittent connectivity, preserving detector state improves reliability.
 * - Small JSON payloads keep storage overhead minimal.
 *
 * Implementation intentionally stays minimal: synchronous APIs, no ORM, no repositories.
 * Edge devices benefit from simplicity and predictable performance.
 */

import type Database from "better-sqlite3";

export type DriftType = "new-field" | "missing-field" | "type-drift" | "rename-candidate";
export type DriftSeverity = "warning" | "critical";

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
	timestamp?: Date;
	details?: Record<string, unknown>;
}

/**
 * Persisted baseline state: enough data to restore detector learning after restart.
 * Stored as JSON to keep schema simple and flexible.
 */
export interface PersistedBaselineState {
	baselineFields: string[];
	baselineTypeFreq: Record<
		string,
		{
			counts: Record<string, number>;
			total: number;
		}
	>;
	missingStreakByField: Record<string, number>;
	newFieldCounts: Record<string, number>;
	newFieldFirstSeen: Record<string, number>;
	newFieldTypeFreq: Record<
		string,
		{
			counts: Record<string, number>;
			total: number;
		}
	>;
	tombstones: Record<string, number>;
	totalBatches: number;
	warmupSeen: number;
	learnedAt: Date;
}

export interface SchemaDriftStore {
	/**
	 * Create tables if they don't exist.
	 * Safe to call multiple times.
	 */
	initialize(): void;

	/**
	 * Persist a single drift event.
	 */
	saveDrift(event: SchemaDriftEvent): void;

	/**
	 * Persist baseline state snapshot.
	 * Overwrites previous baseline for the endpoint.
	 */
	saveBaseline(endpointName: string, state: PersistedBaselineState): void;

	/**
	 * Load persisted baseline state.
	 * Returns undefined if no persisted state exists.
	 */
	loadBaseline(endpointName: string): PersistedBaselineState | undefined;

	/**
	 * Query recent drift events for an endpoint.
	 * Useful for debugging and observability.
	 */
	recentDrifts(
		endpointName: string,
		limit?: number,
	): Array<SchemaDriftEvent & { detectedAt: Date }>;
}

export class SqliteSchemaDriftStore implements SchemaDriftStore {
	constructor(private db: Database.Database) {}

	initialize(): void {
		// Drift log: append-only record of detected schema changes.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_drift_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				endpoint_name TEXT NOT NULL,
				drift_type TEXT NOT NULL,
				field_name TEXT,
				severity TEXT NOT NULL,
				expected_type TEXT,
				observed_types TEXT,
				rename_candidate_from TEXT,
				rename_candidate_to TEXT,
				rename_similarity REAL,
				detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				details_json TEXT
			)
		`);

		// Baseline state: one row per endpoint, overwritten on each save.
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_baseline (
				endpoint_name TEXT PRIMARY KEY,
				baseline_json TEXT NOT NULL,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// Index for efficient querying by endpoint and time.
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_drift_log_endpoint_time
			ON schema_drift_log(endpoint_name, detected_at DESC)
		`);
	}

	saveDrift(event: SchemaDriftEvent): void {
		const stmt = this.db.prepare(`
			INSERT INTO schema_drift_log (
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
		`);

		stmt.run(
			event.endpointName,
			event.driftType,
			event.fieldName ?? null,
			event.severity,
			event.expectedType ?? null,
			event.observedTypes ? JSON.stringify(event.observedTypes) : null,
			event.renameCandidateFrom ?? null,
			event.renameCandidateTo ?? null,
			event.renameSimilarity ?? null,
			event.timestamp ?? new Date(),
			event.details ? JSON.stringify(event.details) : null,
		);
	}

	saveBaseline(endpointName: string, state: PersistedBaselineState): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO schema_baseline (
				endpoint_name,
				baseline_json,
				updated_at
			) VALUES (?, ?, ?)
		`);

		stmt.run(
			endpointName,
			JSON.stringify(state),
			new Date(),
		);
	}

	loadBaseline(endpointName: string): PersistedBaselineState | undefined {
		const stmt = this.db.prepare(`
			SELECT baseline_json FROM schema_baseline WHERE endpoint_name = ?
		`);

		const row = stmt.get(endpointName) as { baseline_json: string } | undefined;
		if (!row) {
			return undefined;
		}

		try {
			return JSON.parse(row.baseline_json) as PersistedBaselineState;
		} catch {
			return undefined;
		}
	}

	recentDrifts(
		endpointName: string,
		limit: number = 100,
	): Array<SchemaDriftEvent & { detectedAt: Date }> {
		const stmt = this.db.prepare(`
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
			FROM schema_drift_log
			WHERE endpoint_name = ?
			ORDER BY detected_at DESC
			LIMIT ?
		`);

		const rows = stmt.all(
			endpointName,
			limit,
		) as Array<{
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
		}>;

		return rows.map((row) => ({
			endpointName: row.endpoint_name,
			driftType: row.drift_type,
			fieldName: row.field_name ?? undefined,
			severity: row.severity,
			expectedType: row.expected_type ?? undefined,
			observedTypes: row.observed_types ? JSON.parse(row.observed_types) : undefined,
			renameCandidateFrom: row.rename_candidate_from ?? undefined,
			renameCandidateTo: row.rename_candidate_to ?? undefined,
			renameSimilarity: row.rename_similarity ?? undefined,
			detectedAt: new Date(row.detected_at),
			details: row.details_json ? JSON.parse(row.details_json) : undefined,
		}));
	}
}
