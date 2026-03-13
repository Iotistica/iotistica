/**
 * Migration: Ensure uuid column exists in endpoints table
 * 
 * This migration handles the case where older databases don't have the uuid column.
 * Adds the column if missing, preserving existing data.
 * 
 * CRITICAL: If the endpoints table doesn't exist, this migration will fail.
 * Run the initial schema migration (20250101000000) first.
 */

exports.up = async function(knex) {
  try {
    // First check if table exists
    const tableExists = await knex.schema.hasTable('endpoints');
    
    if (!tableExists) {
      console.log('⚠️  endpoints table does not exist - creating with uuid column...');
      
      // Create the table with all required columns including uuid
      await knex.schema.createTable('endpoints', (table) => {
        table.increments('id').primary();
        table.string('uuid', 255).nullable().unique(); // Device UUID
        table.string('name', 255).notNullable().unique(); // e.g., "temperature-sensor"
        table.string('protocol', 50).notNullable(); // "modbus", "can", "opcua", "snmp"
        table.boolean('enabled').notNullable().defaultTo(true);
        table.integer('poll_interval').notNullable().defaultTo(5000); // ms
        table.text('connection').notNullable(); // JSON: Connection details
        table.text('data_points').nullable(); // JSON: Register/data point mappings
        table.text('metadata').nullable(); // JSON: Protocol-specific config
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
        table.timestamp('lastSeenAt').nullable(); // Last discovery/validation timestamp
        
        table.index('protocol');
        table.index('enabled');
        table.index('uuid');
      });
      
      console.log('✅ Created endpoints table with uuid column');
      return;
    }
    
    // Table exists - check if uuid column exists
    const hasColumn = await knex.schema.hasColumn('endpoints', 'uuid');
    
    if (!hasColumn) {
      console.log('⚠️  UUID column missing from endpoints table - adding now...');
      
      await knex.schema.table('endpoints', function(table) {
        // Add uuid column with nullable constraint (some existing devices may not have it)
        table.string('uuid', 255).nullable().unique();
        
        // Add index for fast lookups
        table.index('uuid', 'idx_endpoints_uuid');
      });
      
      console.log('✅ Added uuid column to endpoints table');
    } else {
      console.log('✅ UUID column already exists');
    }
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error; // Don't swallow the error - let Knex handle it
  }
};

exports.down = async function(knex) {
  // CAREFUL: Don't drop the column in rollback (data loss risk)
  // Just log the rollback attempt
  console.log('⚠️  Rollback: Preserving uuid column (contains data)');
};
