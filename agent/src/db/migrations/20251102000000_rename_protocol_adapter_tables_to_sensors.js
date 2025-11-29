/**
 * Migration: Rename protocol_adapter tables to sensors
 * Renames:
 *   - protocol_adapter_devices -> sensors
 *   - protocol_adapter_outputs -> endpoint_outputs
 */

exports.up = async function(knex) {
  // Rename protocol_adapter_devices to sensors
  await knex.schema.renameTable('protocol_adapter_devices', 'sensors');
  
  // Rename protocol_adapter_outputs to endpoint_outputs
  await knex.schema.renameTable('protocol_adapter_outputs', 'endpoint_outputs');
};

exports.down = async function(knex) {
  // Revert: Rename back to original names
  await knex.schema.renameTable('endpoint_outputs', 'protocol_adapter_outputs');
  await knex.schema.renameTable('sensors', 'protocol_adapter_devices');
};
