import { randomUUID } from 'crypto';

/**
 * Add devices table.
 *
 * Introduces a first-class "device" concept distinct from "endpoint":
 *   endpoint = the connection point  (Modbus bus, OPC-UA server URL)
 *   device   = the physical/logical device reachable through that endpoint
 *              (Modbus slave, OPC-UA device group, BACnet device instance)
 *
 * Relationship:
 *   - One endpoint can have many devices  (OPC-UA server with multiple PLCs)
 *   - One endpoint can have one device    (Modbus slave, BACnet device — 1:1)
 *
 * The `identifier` column holds the protocol-specific sub-address:
 *   Modbus  → slaveId cast to string, e.g. "3"
 *   OPC-UA  → device_uuid read from the DeviceUUID node in the server tree
 *   BACnet  → device instance number as string
 *   others  → NULL  (1:1 with endpoint)
 *
 * The `uuid` column is the stable identity used in metric payloads
 * (SensorDataPoint.device_uuid).  For Modbus slaves this matches
 * endpoints.uuid so the metric pipeline needs no changes.
 *
 * Data migration:
 *   Existing Modbus per-slave endpoint rows (those with connection.slaveId
 *   but no slaveRange) are seeded as device rows so historical deployments
 *   gain the new model without data loss.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('devices')) return;

  await knex.schema.createTable('devices', (table) => {
    table.increments('id').primary();
    table.string('uuid', 255).notNullable().unique();
    table.integer('endpoint_id')
      .notNullable()
      .references('id')
      .inTable('endpoints')
      .onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.string('protocol', 50).notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.string('identifier', 255).nullable();
    table.text('metadata').nullable();
    table.datetime('lastSeenAt').nullable();
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_devices_endpoint_id ON devices (endpoint_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_devices_protocol ON devices (protocol)');

  // Seed device rows for existing Modbus per-slave endpoints.
  // A per-slave endpoint has connection.slaveId set but no slaveRange.
  const modbusEndpoints = await knex('endpoints').where('protocol', 'modbus');

  for (const endpoint of modbusEndpoints) {
    let connection = {};
    try {
      connection = typeof endpoint.connection === 'string'
        ? JSON.parse(endpoint.connection)
        : (endpoint.connection ?? {});
    } catch (_) {}

    const hasSlaveId = connection.slaveId !== undefined;
    const hasSlaveRange = connection.slaveRange !== undefined;

    if (!hasSlaveId || hasSlaveRange) continue;

    // Reuse the endpoint's own UUID as the device UUID so the metric pipeline
    // (which uses endpoint.uuid as the fallback device_uuid) stays aligned.
    const deviceUuid = endpoint.uuid || randomUUID();

    if (!endpoint.uuid) {
      await knex('endpoints').where('id', endpoint.id).update({ uuid: deviceUuid });
    }

    await knex('devices').insert({
      uuid: deviceUuid,
      endpoint_id: endpoint.id,
      name: endpoint.name,
      protocol: 'modbus',
      enabled: endpoint.enabled ? 1 : 0,
      identifier: String(connection.slaveId),
      metadata: JSON.stringify({ slaveId: connection.slaveId }),
      lastSeenAt: endpoint.lastSeenAt ?? null,
      created_at: endpoint.created_at ?? new Date().toISOString(),
      updated_at: endpoint.updated_at ?? new Date().toISOString(),
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('devices');
}
