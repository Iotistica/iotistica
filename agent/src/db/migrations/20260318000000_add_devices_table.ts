import { randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tableExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (tableExists(db, 'devices')) {
		return;
	}

	db.exec(`
		CREATE TABLE devices (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid VARCHAR(255) NOT NULL UNIQUE,
			endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			protocol VARCHAR(50) NOT NULL,
			enabled BOOLEAN NOT NULL DEFAULT 1,
			identifier VARCHAR(255),
			metadata TEXT,
			lastSeenAt DATETIME,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_devices_endpoint_id ON devices (endpoint_id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_devices_protocol ON devices (protocol)');

	const selectEndpoints = db.prepare(`
		SELECT id, uuid, name, enabled, connection, lastSeenAt, created_at, updated_at
		FROM endpoints
		WHERE protocol = ?
	`);
	const updateEndpointUuid = db.prepare('UPDATE endpoints SET uuid = ? WHERE id = ?');
	const insertDevice = db.prepare(`
		INSERT INTO devices (
			uuid,
			endpoint_id,
			name,
			protocol,
			enabled,
			identifier,
			metadata,
			lastSeenAt,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const endpoints = selectEndpoints.all('modbus') as unknown as Array<{
		id: number;
		uuid: string | null;
		name: string;
		enabled: number | boolean;
		connection: string | null;
		lastSeenAt: string | null;
		created_at: string | null;
		updated_at: string | null;
	}>;

	for (const endpoint of endpoints) {
		let connection: Record<string, unknown> = {};

		try {
			connection = endpoint.connection ? JSON.parse(endpoint.connection) : {};
		} catch {
			connection = {};
		}

		const slaveId = connection.slaveId;
		const hasSlaveId = slaveId !== undefined;
		const hasSlaveRange = connection.slaveRange !== undefined;

		if (!hasSlaveId || hasSlaveRange) {
			continue;
		}

		const deviceUuid = endpoint.uuid || randomUUID();
		if (!endpoint.uuid) {
			updateEndpointUuid.run(deviceUuid, endpoint.id);
		}

		insertDevice.run(
			deviceUuid,
			endpoint.id,
			endpoint.name,
			'modbus',
			endpoint.enabled ? 1 : 0,
			String(slaveId),
			JSON.stringify({ slaveId }),
			endpoint.lastSeenAt,
			endpoint.created_at || new Date().toISOString(),
			endpoint.updated_at || new Date().toISOString()
		);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260318000000_add_devices_table.js',
	up,
};