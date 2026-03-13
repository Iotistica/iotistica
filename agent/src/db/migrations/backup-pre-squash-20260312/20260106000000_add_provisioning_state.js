/**
 * Add provisioningState column to device table
 * Supports explicit provisioning state machine:
 * 'new' | 'registering' | 'registered' | 'key-exchanging' | 'provisioned'
 */

exports.up = async function(knex) {
  await knex.schema.table('device', function(table) {
    table.string('provisioningState').nullable();
  });
  
  // Set existing devices to 'provisioned' if they are provisioned
  await knex('device')
    .where('provisioned', true)
    .update({ provisioningState: 'provisioned' });
  
  // Set new devices to 'new' state
  await knex('device')
    .where('provisioned', false)
    .update({ provisioningState: 'new' });
};

exports.down = async function(knex) {
  await knex.schema.table('device', function(table) {
    table.dropColumn('provisioningState');
  });
};
