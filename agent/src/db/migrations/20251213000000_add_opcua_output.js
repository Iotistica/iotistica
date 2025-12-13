/**
 * Migration: Add OPC UA output configuration
 * 
 * Adds OPC UA entry to endpoint_outputs table for protocol adapter support
 */

export async function up(knex) {
  const isWindows = process.platform === 'win32';
  
  // Check if opcua output already exists
  const existing = await knex('endpoint_outputs')
    .where('protocol', 'opcua')
    .first();
  
  if (!existing) {
    await knex('endpoint_outputs').insert({
      protocol: 'opcua',
      socket_path: isWindows ? '\\\\.\\pipe\\opcua' : '/tmp/opcua.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    });
    
    console.log('✓ Added OPC UA output configuration');
  } else {
    console.log('✓ OPC UA output configuration already exists');
  }
}

export async function down(knex) {
  await knex('endpoint_outputs')
    .where('protocol', 'opcua')
    .delete();
  
  console.log('✓ Removed OPC UA output configuration');
}
