/**
 * Migration: Add domain column to dictionary tables
 * 
 * Purpose: Support domain-partitioned dictionaries for semantic field classification.
 * Prevents collisions and enables type-safe cloud expansion.
 * 
 * Domain Types:
 * - key: Structural JSON paths ("temperature", "alarms[].code")
 * - metric: Semantic metrics ("engine_rpm", "pressure_bar") - default
 * - unit: Engineering units ("RPM", "bar", "°C", "mA", "V")
 * - quality: OPC UA quality codes ("GOOD", "UNCERTAIN", "BAD")
 * - device: Device references ("modbus_slave_3", "gateway_main")
 * 
 * Backward Compatibility:
 * - domain column defaults to 'key' for existing entries
 * - No existing data is deleted or modified
 * - Queries without domain filtering still work (backward compatible)
 */

export async function up(knex) {
  // Add domain column to dictionary_entries
  await knex.schema.table('dictionary_entries', (table) => {
    // Default 'key' for backward compatibility with existing entries
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('key');
  });

  // Add domain column to dictionary_deltas
  await knex.schema.table('dictionary_deltas', (table) => {
    // Default 'metric' for backward compatibility with existing deltas
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('metric');
  });

  // Add index for domain lookups
  await knex.schema.table('dictionary_entries', (table) => {
    table.index('domain');
    table.index(['domain', 'field_name']); // Lookup by domain + name
  });

  await knex.schema.table('dictionary_deltas', (table) => {
    table.index('domain');
    table.index(['domain', 'synced_to_cloud']); // Find unsynced deltas by domain
  });
}

export async function down(knex) {
  // For SQLite, we need to drop indexes by name, not by column reference
  // Knex auto-generates index names based on table and column names
  
  try {
    // Try to drop with explicit names (Knex style)
    await knex.raw('DROP INDEX IF EXISTS dictionary_entries_domain_index');
    await knex.raw('DROP INDEX IF EXISTS dictionary_entries_domain_field_name_index');
    await knex.raw('DROP INDEX IF EXISTS dictionary_deltas_domain_index');
    await knex.raw('DROP INDEX IF EXISTS dictionary_deltas_domain_synced_to_cloud_index');
  } catch (err) {
    // Index might not exist (already dropped or different naming) - ignore
    console.log('Index drop errors (expected if indexes were not created):', err.message);
  }

  // Remove domain columns
  await knex.schema.table('dictionary_entries', (table) => {
    table.dropColumn('domain');
  });

  await knex.schema.table('dictionary_deltas', (table) => {
    table.dropColumn('domain');
  });
}
