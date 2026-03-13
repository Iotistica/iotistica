/**
 * Migration: Add dictionary persistence tables
 * 
 * Purpose: Store MQTT message dictionary field mappings in local SQLite
 * to persist across agent restarts and track delta sync state.
 * 
 * Key features:
 * - Field-to-index mapping storage
 * - Delta tracking for cloud sync
 * - Metadata for version and configuration
 * - Audit trail with timestamps
 */

export async function up(knex) {
  // ===== Dictionary Entries Table =====
  // Stores field-to-index mappings (e.g., "temperature" -> 0)
  await knex.schema.createTable('dictionary_entries', (table) => {
    table.increments('id').primary();
    
    // Field mapping
    table.string('field_name', 500).notNullable().unique(); // Dot-notation path (e.g., "messages[].sensor_id")
    table.integer('field_index').notNullable().unique(); // Numeric index assigned
    table.integer('version_added').notNullable(); // Dictionary version when field was added
    
    // Timestamps
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    // Indexes for efficient lookups
    table.index('field_name'); // Lookup by field name
    table.index('field_index'); // Lookup by index
    table.index('version_added'); // Query fields by version
  });

  // ===== Dictionary Metadata Table =====
  // Store dictionary configuration and state
  await knex.schema.createTable('dictionary_metadata', (table) => {
    table.string('key', 100).primary(); // Metadata key (e.g., "current_version")
    table.text('value').notNullable(); // Metadata value
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // ===== Dictionary Deltas Table =====
  // Track field additions for cloud sync
  await knex.schema.createTable('dictionary_deltas', (table) => {
    table.increments('id').primary();
    
    // Delta information
    table.integer('version').notNullable(); // Dictionary version
    table.string('field_name', 500).notNullable(); // New field added
    table.integer('field_index').notNullable(); // Index assigned
    
    // Sync tracking
    table.boolean('synced_to_cloud').notNullable().defaultTo(false);
    table.timestamp('synced_at').nullable(); // When delta was published to MQTT
    
    // Timestamps
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    // Indexes
    table.index('version'); // Query deltas by version
    table.index('synced_to_cloud'); // Find unsynced deltas
    table.index(['version', 'synced_to_cloud']); // Efficient delta queries
  });

  // Initialize metadata with default values
  await knex('dictionary_metadata').insert([
    { key: 'current_version', value: '1', updated_at: knex.fn.now() },
    { key: 'last_full_sync', value: '0', updated_at: knex.fn.now() },
    { key: 'last_delta_sync', value: '0', updated_at: knex.fn.now() },
  ]);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('dictionary_deltas');
  await knex.schema.dropTableIfExists('dictionary_metadata');
  await knex.schema.dropTableIfExists('dictionary_entries');
}
