import { getDatabase } from '../sqlite.js';

export interface AnomalyAlertRow {
	id?: number;
	alert_id: string;
	incident_id: string;
	severity: 'info' | 'warning' | 'critical';
	metric: string;
	device_name: string;
	max_anomaly_score: number;
	message: string;
	created_at?: number;
}

export class AnomalyAlertModel {
	static insert(row: Omit<AnomalyAlertRow, 'id' | 'created_at'>): AnomalyAlertRow {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO anomaly_alerts
				(alert_id, incident_id, severity, metric, device_name, max_anomaly_score, message)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			row.alert_id,
			row.incident_id,
			row.severity,
			row.metric,
			row.device_name,
			row.max_anomaly_score,
			row.message,
		);
		return db.prepare(`SELECT * FROM anomaly_alerts WHERE alert_id = ?`).get(row.alert_id) as unknown as AnomalyAlertRow;
	}

	static getById(alertId: string): AnomalyAlertRow | null {
		return (getDatabase().prepare(`SELECT * FROM anomaly_alerts WHERE alert_id = ?`)
			.get(alertId) as unknown as AnomalyAlertRow) ?? null;
	}

	static getByIncidentId(incidentId: string): AnomalyAlertRow[] {
		return getDatabase().prepare(
			`SELECT * FROM anomaly_alerts WHERE incident_id = ? ORDER BY created_at DESC`
		).all(incidentId) as unknown as AnomalyAlertRow[];
	}

	static list(filters: {
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { alerts: AnomalyAlertRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.severity)    { where.push('severity = ?');    args.push(filters.severity); }
		if (filters.from != null){ where.push('created_at >= ?'); args.push(filters.from); }
		if (filters.to   != null){ where.push('created_at <= ?'); args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM anomaly_alerts ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const alerts = db.prepare(
			`SELECT * FROM anomaly_alerts ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AnomalyAlertRow[];

		return { alerts, total };
	}
}
