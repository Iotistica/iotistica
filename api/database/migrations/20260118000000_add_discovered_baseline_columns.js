exports.up = function(knex) {
  return knex.schema.table('device_sensors', function(table) {
    // Add discovered baseline columns to track original discovery values
    table.jsonb('discovered_connection');
    table.jsonb('discovered_data_points');
    table.boolean('discovered_enabled');
    table.integer('discovered_poll_interval');
  }).then(() => {
    // For existing records, copy current values to discovered_* columns
    // (assumes current values are the baseline if no modification yet)
    return knex.raw(`
      UPDATE device_sensors
      SET 
        discovered_connection = connection,
        discovered_data_points = data_points,
        discovered_enabled = enabled,
        discovered_poll_interval = poll_interval
      WHERE 
        discovered_connection IS NULL
        AND synced_to_config = FALSE
    `);
  });
};

exports.down = function(knex) {
  return knex.schema.table('device_sensors', function(table) {
    table.dropColumn('discovered_connection');
    table.dropColumn('discovered_data_points');
    table.dropColumn('discovered_enabled');
    table.dropColumn('discovered_poll_interval');
  });
};
