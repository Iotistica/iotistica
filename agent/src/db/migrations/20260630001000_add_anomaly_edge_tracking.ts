import type { DatabaseSync } from 'node:sqlite';
import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS anomaly_events (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			msg_id            TEXT    NOT NULL,
			metric            TEXT    NOT NULL,
			fingerprint       TEXT    NOT NULL,
			timestamp_ms      INTEGER NOT NULL,
			observed_value    REAL    NOT NULL,
			anomaly_score     REAL    NOT NULL,
			confidence        REAL    NOT NULL,
			severity          TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			severity_reason   TEXT,
			consecutive_count INTEGER NOT NULL DEFAULT 1,
			triggered_by      TEXT,
			baseline          TEXT,
			expected_range    TEXT,
			deviation         REAL    NOT NULL DEFAULT 0,
			device_name       TEXT    NOT NULL DEFAULT 'Unknown',
			device_type       TEXT,
			device_uuid       TEXT,
			created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
			UNIQUE (msg_id)
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_events_fingerprint ON anomaly_events (fingerprint);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_events_timestamp   ON anomaly_events (timestamp_ms DESC);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity    ON anomaly_events (severity);`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS anomaly_incidents (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id       TEXT    NOT NULL UNIQUE,
			fingerprint       TEXT    NOT NULL,
			metric            TEXT    NOT NULL,
			severity          TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			device_name       TEXT    NOT NULL DEFAULT 'Unknown',
			device_type       TEXT,
			first_seen        INTEGER NOT NULL,
			last_seen         INTEGER NOT NULL,
			max_anomaly_score REAL    NOT NULL DEFAULT 0,
			max_confidence    REAL    NOT NULL DEFAULT 0,
			event_count       INTEGER NOT NULL DEFAULT 0,
			status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','resolved')),
			last_alert_at     INTEGER,
			acknowledged_at   INTEGER,
			acknowledged_by   TEXT,
			resolution_notes  TEXT,
			created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
			updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_fingerprint ON anomaly_incidents (fingerprint);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_status      ON anomaly_incidents (status);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_first_seen  ON anomaly_incidents (first_seen DESC);`);

	// anomaly_alerts exists in the squashed initial schema with a different schema (no incident_id).
	// Drop and recreate so our incident-correlation columns are present.
	if (!columnExists(db, 'anomaly_alerts', 'incident_id')) {
		db.exec(`DROP TABLE IF EXISTS anomaly_alerts;`);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS anomaly_alerts (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			alert_id          TEXT    NOT NULL UNIQUE,
			incident_id       TEXT    NOT NULL,
			severity          TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			metric            TEXT    NOT NULL,
			device_name       TEXT    NOT NULL DEFAULT 'Unknown',
			max_anomaly_score REAL    NOT NULL,
			message           TEXT    NOT NULL,
			created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_incident ON anomaly_alerts (incident_id);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_created  ON anomaly_alerts (created_at DESC);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260630001000_add_anomaly_edge_tracking.js',
	up,
};
