import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const isWindows = process.platform === 'win32';
	const hasProtocol = db
		.prepare('SELECT 1 FROM endpoint_outputs WHERE protocol = ? LIMIT 1');
	const insert = db.prepare(`
		INSERT INTO endpoint_outputs (
			protocol,
			socket_path,
			data_format,
			delimiter,
			include_timestamp,
			include_device_name,
			buffer_capacity,
			logging
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const defaults = [
		{
			protocol: 'modbus',
			socketPath: isWindows ? '\\\\.\\pipe\\modbus' : '/tmp/modbus.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'opcua',
			socketPath: isWindows ? '\\\\.\\pipe\\opcua' : '/tmp/opcua.sock',
			bufferCapacity: 1024 * 1024,
		},
		{
			protocol: 'snmp',
			socketPath: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'mqtt',
			socketPath: isWindows ? '\\\\.\\pipe\\mqtt' : '/tmp/mqtt.sock',
			bufferCapacity: 128 * 1024,
		},
		{
			protocol: 'bacnet',
			socketPath: isWindows ? '\\\\.\\pipe\\bacnet' : '/tmp/bacnet.sock',
			bufferCapacity: 128 * 1024,
		},
	];

	for (const row of defaults) {
		if (hasProtocol.get(row.protocol)) {
			continue;
		}

		insert.run(
			row.protocol,
			row.socketPath,
			'json',
			'\n',
			1,
			1,
			row.bufferCapacity,
			JSON.stringify({ level: 'info' })
		);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260313000000_seed_endpoint_outputs.js',
	up,
};