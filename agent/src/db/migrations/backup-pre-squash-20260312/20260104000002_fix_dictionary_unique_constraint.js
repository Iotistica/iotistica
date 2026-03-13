/**
 * Migration: Fix dictionary unique constraint for domain-partitioned dictionaries
 * 
 * Problem: Original schema has UNIQUE(field_index) globally
 * Solution: Change to UNIQUE(domain, field_index) so each domain has own index space
 * 
 * This allows:
 * - domain='key', field_index=1 (key domain)
 * - domain='metric', field_index=1 (metric domain) <- Previously would fail!
 * 
 * Implementation:
 * SQLite doesn't support ALTER CONSTRAINT, so we:
 * 1. Create new tables with correct constraints
 * 2. Copy data from old tables
 * 3. Drop old tables
 * 4. Rename new tables to original names
 */

export async function up(knex) {
  // ===== Rebuild dictionary_entries with correct constraint =====
  // Create new table with compound unique constraint
  await knex.schema.createTable('dictionary_entries_new', (table) => {
    table.increments('id').primary();
    
    // Field mapping
    table.string('field_name', 500).notNullable();
    table.integer('field_index').notNullable();
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('key');
    table.integer('version_added').notNullable();
    
    // Timestamps
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    // Unique constraint per domain (allows same index in different domains)
    table.unique(['domain', 'field_index']);  // ✅ FIX: Compound unique constraint
    table.unique('field_name'); // Field name still globally unique for semantic reasons
    
    // Indexes for efficient lookups
    table.index('field_name');
    table.index(['domain', 'field_index']);
    table.index('domain');
    table.index('version_added');
  });

  // Copy data from old table
  await knex('dictionary_entries_new').insert(
    knex('dictionary_entries').select('*')
  );

  // Drop old table
  await knex.schema.dropTable('dictionary_entries');

  // Rename new table
  await knex.schema.renameTable('dictionary_entries_new', 'dictionary_entries');

  // ===== Rebuild dictionary_deltas with correct constraint =====
  await knex.schema.createTable('dictionary_deltas_new', (table) => {
    table.increments('id').primary();
    
    // Delta information
    table.integer('version').notNullable();
    table.string('field_name', 500).notNullable();
    table.integer('field_index').notNullable();
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('metric');
    
    // Sync tracking
    table.boolean('synced_to_cloud').notNullable().defaultTo(false);
    table.timestamp('synced_at').nullable();  // ✅ Include this column!
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    // Unique constraint per domain
    table.unique(['domain', 'field_index']);
    
    // Indexes
    table.index('version');
    table.index('domain');
    table.index(['domain', 'synced_to_cloud']);
    table.index('synced_to_cloud');
    table.index(['version', 'synced_to_cloud']);
  });

  // Copy data from old table
  await knex('dictionary_deltas_new').insert(
    knex('dictionary_deltas').select('*')
  );

  // Drop old table
  await knex.schema.dropTable('dictionary_deltas');

  // Rename new table
  await knex.schema.renameTable('dictionary_deltas_new', 'dictionary_deltas');
}

export async function down(knex) {
  // Rollback: Rebuild with original constraints (field_index globally unique)
  // This is complex and may lose data, so we'll just recreate the original schema
  
  // Create old-style table
  await knex.schema.createTable('dictionary_entries_old', (table) => {
    table.increments('id').primary();
    
    table.string('field_name', 500).notNullable().unique();
    table.integer('field_index').notNullable().unique();  // Global unique (old way)
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('key');
    table.integer('version_added').notNullable();
    
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('field_name');
    table.index('field_index');
    table.index('version_added');
    table.index('domain');
    table.index(['domain', 'field_name']);
  });

  // Copy only entries without domain conflicts (first occurrence of each index)
  await knex('dictionary_entries_old').insert(
    knex('dictionary_entries')
      .where('domain', 'key')  // Keep only key domain to preserve constraint
      .select('*')
  );

  await knex.schema.dropTable('dictionary_entries');
  await knex.schema.renameTable('dictionary_entries_old', 'dictionary_entries');

  // Similar for deltas
  await knex.schema.createTable('dictionary_deltas_old', (table) => {
    table.increments('id').primary();
    
    table.integer('version').notNullable();
    table.string('field_name', 500).notNullable();
    table.integer('field_index').notNullable().unique();  // Global unique (old way)
    table.enum('domain', ['key', 'metric', 'unit', 'quality', 'device'])
      .notNullable()
      .defaultTo('metric');
    
    table.boolean('synced_to_cloud').notNullable().defaultTo(false);
    table.timestamp('synced_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    
    table.index('version');
    table.index('domain');
    table.index(['domain', 'synced_to_cloud']);
    table.index('synced_to_cloud');
    table.index(['version', 'synced_to_cloud']);
  });

  await knex('dictionary_deltas_old').insert(
    knex('dictionary_deltas')
      .where('domain', 'metric')
      .select('*')
  );

  await knex.schema.dropTable('dictionary_deltas');
  await knex.schema.renameTable('dictionary_deltas_old', 'dictionary_deltas');
}
