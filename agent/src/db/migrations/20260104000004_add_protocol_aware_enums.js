/**
 * Migration: Add protocol-aware enum tables for metrics and devices
 * 
 * Strategy: Additive migration - keep existing dictionary tables, add new specialized tables
 * 
 * New tables:
 * - enum_observations: Track value frequency for promotion
 * - enum_metrics: Protocol-namespaced metric enums (modbus, snmp, opcua)
 * - enum_devices: Protocol-namespaced device enums
 * - enum_quality_codes: QualityCode enum (frequency-based learning)
 * 
 * Backward compat: Old dictionary_entries domain='metric'/'device' stays until migration complete
 */

export async function up(knex) {
  // 1. Create enum_observations table for frequency tracking
  await knex.schema.createTable('enum_observations', (table) => {
    table.increments('id').primary();
    table.string('category', 32).notNullable();  // 'metric', 'device', 'qualityCode', 'unit'
    table.string('namespace', 32).nullable();     // Protocol name for metrics/devices (null for qualityCode/unit)
    table.string('value', 255).notNullable();     // The actual value being tracked
    table.integer('observation_count').defaultTo(1).notNullable();
    table.integer('unique_value_count').nullable();  // Track cardinality
    table.datetime('first_seen').notNullable().defaultTo(knex.fn.now());
    table.datetime('last_seen').notNullable().defaultTo(knex.fn.now());
    table.datetime('promoted_at').nullable();     // When promoted to enum
    table.boolean('is_promoted').defaultTo(false).notNullable();
    
    // Composite unique: category + namespace + value
    table.unique(['category', 'namespace', 'value']);
    
    // Indexes for fast lookups
    table.index(['category', 'is_promoted']);
    table.index('namespace');
  });

  // 2. Create enum_metrics table (protocol-aware)
  await knex.schema.createTable('enum_metrics', (table) => {
    table.increments('id').primary();
    table.string('protocol', 32).notNullable();   // modbus, snmp, opcua, mqtt, bacnet
    table.string('metric_name', 255).notNullable();
    table.integer('enum_index').notNullable();    // Immutable index (never reused)
    table.integer('observation_count').defaultTo(0).notNullable();
    table.datetime('promoted_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('inactive').defaultTo(false).notNullable();  // Soft delete (keep for historical decoding)
    
    // Composite unique: protocol + metric_name AND protocol + enum_index
    table.unique(['protocol', 'metric_name']);
    table.unique(['protocol', 'enum_index']);
    
    // Indexes
    table.index('protocol');
    table.index(['protocol', 'inactive']);
  });

  // 3. Create enum_devices table (protocol-aware)
  await knex.schema.createTable('enum_devices', (table) => {
    table.increments('id').primary();
    table.string('protocol', 32).notNullable();
    table.string('device_name', 255).notNullable();
    table.integer('enum_index').notNullable();    // Immutable index
    table.integer('observation_count').defaultTo(0).notNullable();
    table.datetime('promoted_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('inactive').defaultTo(false).notNullable();
    
    // Composite unique
    table.unique(['protocol', 'device_name']);
    table.unique(['protocol', 'enum_index']);
    
    // Indexes
    table.index('protocol');
    table.index(['protocol', 'inactive']);
  });

  // 4. Create enum_quality_codes table (frequency-based learning, no protocol namespace)
  await knex.schema.createTable('enum_quality_codes', (table) => {
    table.increments('id').primary();
    table.string('code_value', 64).notNullable().unique();  // 'OK', 'TIMEOUT', 'DEVICE_OFFLINE'
    table.integer('enum_index').notNullable().unique();     // Immutable index
    table.integer('observation_count').defaultTo(0).notNullable();
    table.datetime('promoted_at').notNullable().defaultTo(knex.fn.now());
    table.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('inactive').defaultTo(false).notNullable();
    
    // Index
    table.index('inactive');
  });

  // 5. Add protocol column to sensor_publish_buffer (optional - for protocol context tracking)
  if (await knex.schema.hasTable('sensor_publish_buffer')) {
    const hasProtocol = await knex.schema.hasColumn('sensor_publish_buffer', 'protocol');
    if (!hasProtocol) {
      await knex.schema.alterTable('sensor_publish_buffer', (table) => {
        table.string('protocol', 32).nullable();  // Nullable for backward compat
        table.index('protocol');
      });
    }
  }

  console.log('✅ Protocol-aware enum tables created successfully');
}

export async function down(knex) {
  // Drop in reverse order
  await knex.schema.dropTableIfExists('enum_quality_codes');
  await knex.schema.dropTableIfExists('enum_devices');
  await knex.schema.dropTableIfExists('enum_metrics');
  await knex.schema.dropTableIfExists('enum_observations');

  // Remove protocol column from sensor_publish_buffer
  if (await knex.schema.hasTable('sensor_publish_buffer')) {
    const hasProtocol = await knex.schema.hasColumn('sensor_publish_buffer', 'protocol');
    if (hasProtocol) {
      await knex.schema.alterTable('sensor_publish_buffer', (table) => {
        table.dropColumn('protocol');
      });
    }
  }

  console.log('✅ Protocol-aware enum tables dropped');
}
