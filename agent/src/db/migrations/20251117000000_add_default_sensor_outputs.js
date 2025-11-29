/**
 * Migration: Add default sensor output configurations
 * Inserts default output configs for Modbus, CAN, and OPC-UA protocols
 * This allows protocol adapters to start without manual configuration
 */

exports.up = async function(knex) {
  // Detect platform for socket paths
  const isWindows = process.platform === 'win32';
  
  // Insert default output configurations for each protocol
  await knex('endpoint_outputs').insert([
    {
      protocol: 'modbus',
      socket_path: isWindows ? '\\\\.\\pipe\\modbus' : '/tmp/modbus.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    },
    {
      protocol: 'can',
      socket_path: isWindows ? '\\\\.\\pipe\\canbus' : '/tmp/canbus.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    },
    {
      protocol: 'opcua',
      socket_path: isWindows ? '\\\\.\\pipe\\opcua' : '/tmp/opcua.sock',
      data_format: 'json',
      delimiter: '\n',
      include_timestamp: true,
      include_device_name: true,
      logging: JSON.stringify({ level: 'info' })
    }
  ]);
};

exports.down = async function(knex) {
  // Remove default configurations
  await knex('endpoint_outputs').whereIn('protocol', ['modbus', 'can', 'opcua']).del();
};
