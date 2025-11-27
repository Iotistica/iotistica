/**
 * Migration: Add SNMP sensor output configuration
 * Inserts default output config for SNMP protocol
 * This allows the SNMP adapter to start without manual configuration
 */

exports.up = async function(knex) {
  // Detect platform for socket paths
  const isWindows = process.platform === 'win32';
  
  // Insert default output configuration for SNMP
  await knex('sensor_outputs').insert({
    protocol: 'snmp',
    socket_path: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
    data_format: 'json',
    delimiter: '\n',
    include_timestamp: true,
    include_device_name: true,
    logging: JSON.stringify({ level: 'info' })
  });
};

exports.down = async function(knex) {
  // Remove SNMP configuration
  await knex('sensor_outputs').where('protocol', 'snmp').del();
};
