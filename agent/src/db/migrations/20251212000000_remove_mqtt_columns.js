/**
 * Remove deprecated MQTT credential columns
 * 
 * mqttUsername, mqttPassword, and mqttBrokerUrl are now consolidated
 * into the mqttBrokerConfig JSON field.
 * 
 * Before running this migration, ensure all devices have been migrated
 * to use mqttBrokerConfig with credentials included.
 */

export async function up(knex) {
  console.log('🔄 Removing deprecated MQTT credential columns...');

  await knex.schema.alterTable('device', (table) => {
    table.dropColumn('mqttUsername');
    table.dropColumn('mqttPassword');
    table.dropColumn('mqttBrokerUrl');
  });

  console.log('✅ Removed mqttUsername, mqttPassword, mqttBrokerUrl columns');
  console.log('ℹ️  All MQTT configuration now in mqttBrokerConfig JSON field');
}

export async function down(knex) {
  console.log('🔄 Restoring MQTT credential columns...');

  await knex.schema.alterTable('device', (table) => {
    table.string('mqttUsername', 255).nullable();
    table.string('mqttPassword', 255).nullable();
    table.string('mqttBrokerUrl', 255).nullable();
  });

  console.log('✅ Restored mqttUsername, mqttPassword, mqttBrokerUrl columns');
  console.log('⚠️  Note: Data will be empty - you will need to re-provision devices');
}
