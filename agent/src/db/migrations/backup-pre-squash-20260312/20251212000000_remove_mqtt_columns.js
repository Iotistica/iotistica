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

  await knex.schema.alterTable('device', (table) => {
    table.dropColumn('mqttUsername');
    table.dropColumn('mqttPassword');
    table.dropColumn('mqttBrokerUrl');
  });

  console.log('✓ Removed deprecated MQTT credential columns');

}

export async function down(knex) {

  await knex.schema.alterTable('device', (table) => {
    table.string('mqttUsername', 255).nullable();
    table.string('mqttPassword', 255).nullable();
    table.string('mqttBrokerUrl', 255).nullable();
  });

}
