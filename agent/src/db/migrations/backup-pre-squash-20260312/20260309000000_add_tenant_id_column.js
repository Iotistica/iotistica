/**
 * Migration: Add tenantId column to device table
 * 
 * This migration adds the tenantId column to support tenant-aware MQTT topic construction.
 * The tenantId is received from the provisioning response and used by the agent to build
 * properly scoped MQTT topics in the format: iot/{tenantId}/device/{deviceUuid}/...
 * 
 * Replaces the deprecated applicationId field with tenantId for multi-tenant architecture.
 */

exports.up = async function(knex) {
  try {
    // Check if device table exists
    const tableExists = await knex.schema.hasTable('device');
    
    if (!tableExists) {
      console.log('⚠️  device table does not exist - skipping migration');
      return;
    }

    // Check if tenantId column already exists
    const hasColumn = await knex.schema.hasColumn('device', 'tenantId');
    
    if (hasColumn) {
      console.log('✅ tenantId column already exists - skipping');
      return;
    }

    // Add tenantId column
    await knex.schema.table('device', (table) => {
      table.string('tenantId', 255).nullable().after('provisioningState');
    });

    console.log('✅ Added tenantId column to device table');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
};

exports.down = async function(knex) {
  try {
    const tableExists = await knex.schema.hasTable('device');
    
    if (!tableExists) {
      console.log('⚠️  device table does not exist - skipping rollback');
      return;
    }

    const hasColumn = await knex.schema.hasColumn('device', 'tenantId');
    
    if (!hasColumn) {
      console.log('✅ tenantId column does not exist - skipping rollback');
      return;
    }

    // Remove tenantId column
    await knex.schema.table('device', (table) => {
      table.dropColumn('tenantId');
    });

    console.log('✅ Removed tenantId column from device table');
  } catch (error) {
    console.error('❌ Rollback failed:', error);
    throw error;
  }
};
