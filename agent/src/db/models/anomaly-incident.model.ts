import { getDatabase } from '../sqlite.js';

export interface AnomalyIncidentRow {
	id?: number;
	incident_id: string;
	fingerprint: string;
	metric: string;
	severity: 'info' | 'warning' | 'critical';
	device_name: string;
	device_type?: string | null;
	first_seen: number;
	last_seen: number;
	max_anomaly_score: number;
	max_confidence: number;
	event_count: number;
	status: 'open' | 'active' | 'resolved';
	last_alert_at?: number | null;
	acknowledged_at?: number | null;
	acknowledged_by?: string | null;
	resolution_notes?: string | null;
	created_at?: number;
	updated_at?: number;
}

export class AnomalyIncidentModel {
	static create(row: Omit<AnomalyIncidentRow, 'id' | 'created_at' | 'updated_at'>): AnomalyIncidentRow {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO anomaly_incidents
				(incident_id, fingerprint, metric, severity, device_name, device_type,
				 first_seen, last_seen, max_anomaly_score, max_confidence, event_count, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			row.incident_id,
			row.fingerprint,
			row.metric,
			row.severity,
			row.device_name,
			row.device_type ?? null,
			row.first_seen,
			row.last_seen,
			row.max_anomaly_score,
			row.max_confidence,
			row.event_count,
			row.status,
		);
		return db.prepare(`SELECT * FROM anomaly_incidents WHERE incident_id = ?`).get(row.incident_id) as unknown as AnomalyIncidentRow;
	}

	static findActiveByFingerprint(fingerprint: string): AnomalyIncidentRow | null {
		return (getDatabase().prepare(`
			SELECT * FROM anomaly_incidents
			WHERE fingerprint = ? AND status IN ('open', 'active')
			ORDER BY created_at DESC LIMIT 1
		`).get(fingerprint) as unknown as AnomalyIncidentRow) ?? null;
	}

	static updateByEvent(incidentId: string, params: {
		last_seen: number;
		event_count: number;
		max_anomaly_score: number;
		max_confidence: number;
		severity: 'info' | 'warning' | 'critical';
		status: 'open' | 'active' | 'resolved';
	}): void {
		getDatabase().prepare(`
			UPDATE anomaly_incidents
			SET last_seen = ?, event_count = ?, max_anomaly_score = ?,
			    max_confidence = ?, severity = ?, status = ?, updated_at = ?
			WHERE incident_id = ?
		`).run(
			params.last_seen,
			params.event_count,
			params.max_anomaly_score,
			params.max_confidence,
			params.severity,
			params.status,
			Date.now(),
			incidentId,
		);
	}

	static setLastAlertAt(incidentId: string, ts: number): void {
		getDatabase().prepare(`
			UPDATE anomaly_incidents SET last_alert_at = ?, updated_at = ? WHERE incident_id = ?
		`).run(ts, Date.now(), incidentId);
	}

	static resolve(incidentId: string, resolvedBy: string, notes?: string): boolean {
		const info = getDatabase().prepare(`
			UPDATE anomaly_incidents
			SET status = 'resolved', acknowledged_at = ?, acknowledged_by = ?,
			    resolution_notes = ?, updated_at = ?
			WHERE incident_id = ? AND status != 'resolved'
		`).run(Date.now(), resolvedBy, notes ?? null, Date.now(), incidentId);
		return Number(info.changes) > 0;
	}

	static autoResolveStale(cutoffMs: number): number {
		const info = getDatabase().prepare(`
			UPDATE anomaly_incidents
			SET status = 'resolved', updated_at = ?
			WHERE status IN ('open', 'active') AND last_seen < ?
		`).run(Date.now(), cutoffMs);
		return Number(info.changes);
	}

	static getById(incidentId: string): AnomalyIncidentRow | null {
		return (getDatabase().prepare(`SELECT * FROM anomaly_incidents WHERE incident_id = ?`)
			.get(incidentId) as unknown as AnomalyIncidentRow) ?? null;
	}

	static list(filters: {
		status?: string;
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { incidents: AnomalyIncidentRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.status)      { where.push('status = ?');        args.push(filters.status); }
		if (filters.severity)    { where.push('severity = ?');       args.push(filters.severity); }
		if (filters.from != null){ where.push('first_seen >= ?');    args.push(filters.from); }
		if (filters.to   != null){ where.push('first_seen <= ?');    args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM anomaly_incidents ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const incidents = db.prepare(
			`SELECT * FROM anomaly_incidents ${clause} ORDER BY first_seen DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AnomalyIncidentRow[];

		return { incidents, total };
	}

	static stats(windowMs: number): {
		open: number; active: number; resolved: number;
		critical: number; warning: number; info: number;
	} {
		const db = getDatabase();
		const cutoff = Date.now() - windowMs;
		const rows = db.prepare(`
			SELECT status, severity, COUNT(*) as n
			FROM anomaly_incidents
			WHERE first_seen >= ?
			GROUP BY status, severity
		`).all(cutoff) as { status: string; severity: string; n: number }[];

		const result = { open: 0, active: 0, resolved: 0, critical: 0, warning: 0, info: 0 };
		for (const r of rows) {
			if (r.status in result) (result as any)[r.status] += r.n;
			if (r.severity in result) (result as any)[r.severity] += r.n;
		}
		return result;
	}
}
