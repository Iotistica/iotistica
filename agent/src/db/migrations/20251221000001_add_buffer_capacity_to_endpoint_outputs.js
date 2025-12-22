/**
 * Migration: Add buffer_capacity column to endpoint_outputs
 * 
 * Allows per-protocol configuration of buffer capacity for sensor publish.
 * OPC UA needs larger buffers (1MB) for large discovery messages.
 * Other protocols can use smaller buffers (4KB-128KB).
 */

export async function up(knex) {
  // Add buffer_capacity column
  await knex.schema.table('endpoint_outputs', (table) => {
    table.integer('buffer_capacity').nullable();
  });

  // Set default buffer capacities per protocol
  const bufferSizes = {
    'opcua': 1024 * 1024,    // 1MB - Large OPC UA discovery messages
    'modbus': 128 * 1024,    // 128KB - Standard Modbus responses
    'can': 64 * 1024,        // 64KB - CAN bus messages
    'snmp': 128 * 1024,      // 128KB - SNMP trap messages
  };

  for (const [protocol, size] of Object.entries(bufferSizes)) {
    await knex('endpoint_outputs')
      .where('protocol', protocol)
      .update({ buffer_capacity: size });
  }

  console.log('✓ Added buffer_capacity column to endpoint_outputs');
  console.log('  - OPC UA: 1MB (large discovery messages)');
  console.log('  - Modbus: 128KB');
  console.log('  - CAN: 64KB');
  console.log('  - SNMP: 128KB');
}

export async function down(knex) {
  await knex.schema.table('endpoint_outputs', (table) => {
    table.dropColumn('buffer_capacity');
  });
}
