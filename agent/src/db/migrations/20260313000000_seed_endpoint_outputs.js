/**
 * Migration: Seed default endpoint_outputs rows
 *
 * The squashed initial schema migration creates the endpoint_outputs table
 * but does not insert any rows (the pre-squash migrations that seeded them
 * were omitted during consolidation). This migration restores those defaults.
 *
 * Protocols seeded: modbus, opcua, snmp, mqtt, bacnet
 * Buffer capacities match pre-squash values where applicable.
 *
 * Idempotent: skips protocols that already have a row.
 */

export async function up(knex) {
  const isWindows = process.platform === 'win32';

  const defaults = [
    {
      protocol: 'modbus',
      socket_path: isWindows ? '\\\\.\\pipe\\modbus' : '/tmp/modbus.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      buffer_capacity: 128 * 1024,
      logging: JSON.stringify({ level: 'info' }),
    },
    {
      protocol: 'opcua',
      socket_path: isWindows ? '\\\\.\\pipe\\opcua' : '/tmp/opcua.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      buffer_capacity: 1024 * 1024,
      logging: JSON.stringify({ level: 'info' }),
    },
    {
      protocol: 'snmp',
      socket_path: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      buffer_capacity: 128 * 1024,
      logging: JSON.stringify({ level: 'info' }),
    },
    {
      protocol: 'mqtt',
      socket_path: isWindows ? '\\\\.\\pipe\\mqtt' : '/tmp/mqtt.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      buffer_capacity: 128 * 1024,
      logging: JSON.stringify({ level: 'info' }),
    },
    {
      protocol: 'bacnet',
      socket_path: isWindows ? '\\\\.\\pipe\\bacnet' : '/tmp/bacnet.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      buffer_capacity: 128 * 1024,
      logging: JSON.stringify({ level: 'info' }),
    },
  ];

  let inserted = 0;
  for (const row of defaults) {
    const existing = await knex('endpoint_outputs')
      .where('protocol', row.protocol)
      .first();

    if (!existing) {
      await knex('endpoint_outputs').insert(row);
      inserted++;
    }
  }

  console.log(`Seeded endpoint_outputs: ${inserted} row(s) inserted`);
}

export async function down(knex) {
  await knex('endpoint_outputs')
    .whereIn('protocol', ['modbus', 'opcua', 'snmp', 'mqtt', 'bacnet'])
    .delete();
}
