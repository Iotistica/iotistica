/**
 * Migration: Ensure uuid column exists in endpoints table
 * 
 * This migration handles the case where older databases don't have the uuid column.
 * Adds the column if missing, preserving existing data.
 */

exports.up = async function(knex) {
  // Check if uuid column already exists
  const hasColumn = await knex.schema.hasColumn('endpoints', 'uuid');
  
  if (!hasColumn) {
    console.log('⚠️  UUID column missing from endpoints table - adding now...');
    
    try {
      await knex.schema.table('endpoints', function(table) {
        // Add uuid column with nullable constraint (some existing devices may not have it)
        table.string('uuid', 255).nullable().unique();
        
        // Add index for fast lookups
        table.index('uuid', 'idx_endpoints_uuid');
      });
      
      console.log('✅ Added uuid column to endpoints table');
    } catch (error) {
      // If the column already exists by another name or the operation fails,
      // log but don't fail the migration
      console.log('⚠️  Could not add uuid column (may already exist):', error.message);
      
      // Try to add index if it doesn't exist
      try {
        await knex.raw(`CREATE INDEX IF NOT EXISTS idx_endpoints_uuid ON endpoints(uuid)`);
        console.log('✅ Added/verified uuid index');
      } catch (indexError) {
        console.log('⚠️  Could not create uuid index:', indexError.message);
      }
    }
  } else {
    console.log('✅ UUID column already exists');
  }
};

exports.down = async function(knex) {
  // CAREFUL: Don't drop the column in rollback (data loss risk)
  // Just log the rollback attempt
  console.log('⚠️  Rollback: Preserving uuid column (contains data)');
};
