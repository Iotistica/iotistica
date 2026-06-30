import { getDatabase } from '../sqlite.js';
import crypto from 'node:crypto';

export interface AnomalyEventRow {
	id?: number;
	msg_id: string;
	metric: string;
	fingerprint: string;
	timestamp_ms: number;
	observed_value: number;
	anomaly_score: number;
	confidence: number;
	severity: 'info' | 'warning' | 'critical';
	severity_reason?: string | null;
	consecutive_count: number;
	triggered_by?: string | null;
	baseline?: string | null;
	expected_range?: string | null;
	deviation: number;
	device_name: string;
	device_type?: string | null;
	device_uuid?: string | null;
	created_at?: number;
}

export interface AnomalyEventPayload {
	msg_id?: string;
	metric: string;
	fingerprint: string;
	timestamp_ms: number;
	observed_value: number;
	anomaly_score: number;
	confidence: number;
	severity: 'info' | 'warning' | 'critical';
	severity_reason?: string;
	consecutive_count?: number;
	triggered_by?: unknown;
	baseline?: unknown;
	expected_range?: unknown;
	deviation?: number;
	device_name?: string;
	device_type?: string;
	device_uuid?: string;
}

export class AnomalyEventModel {
	static insert(payload: AnomalyEventPayload): void {
		const db = getDatabase();
		const msg_id = payload.msg_id ?? crypto.randomUUID();
		db.prepare(`
			INSERT OR IGNORE INTO anomaly_events
				(msg_id, metric, fingerprint, timestamp_ms, observed_value, anomaly_score,
				 confidence, severity, severity_reason, consecutive_count,
				 triggered_by, baseline, expected_range, deviation,
				 device_name, device_type, device_uuid)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			msg_id,
			payload.metric,
			payload.fingerprint,
			payload.timestamp_ms,
			payload.observed_value,
			payload.anomaly_score,
			payload.confidence,
			payload.severity,
			payload.severity_reason ?? null,
			payload.consecutive_count ?? 1,
			payload.triggered_by != null ? JSON.stringify(payload.triggered_by) : null,
			payload.baseline != null ? JSON.stringify(payload.baseline) : null,
			payload.expected_range != null ? JSON.stringify(payload.expected_range) : null,
			payload.deviation ?? 0,
			payload.device_name ?? 'Unknown',
			payload.device_type ?? null,
			payload.device_uuid ?? null,
		);
	}

	static list(filters: {
		fingerprint?: string;
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { events: AnomalyEventRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.fingerprint) { where.push('fingerprint = ?'); args.push(filters.fingerprint); }
		if (filters.severity)    { where.push('severity = ?');    args.push(filters.severity); }
		if (filters.from != null){ where.push('timestamp_ms >= ?'); args.push(filters.from); }
		if (filters.to   != null){ where.push('timestamp_ms <= ?'); args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM anomaly_events ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const events = db.prepare(
			`SELECT * FROM anomaly_events ${clause} ORDER BY timestamp_ms DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AnomalyEventRow[];

		return { events, total };
	}

	static getById(id: number): AnomalyEventRow | null {
		return (getDatabase().prepare(`SELECT * FROM anomaly_events WHERE id = ?`).get(id) as unknown as AnomalyEventRow) ?? null;
	}
}
