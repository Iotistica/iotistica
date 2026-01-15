/**
 * Migration: Add fingerprint column to endpoints table
 * 
 * Adds cryptographic fingerprint for stable device identification.
 * Fingerprint is based on physical identity (bus + slave ID + device ID)
 * and survives name changes, reconnections, etc.
 * 
 * Pattern: SHA256("<protocol>:<bus-id>:<slave-id>:<device-id>")
 */

exports.up = async function(knex) {
  // Check if column already exists
  const hasColumn = await knex.schema.hasColumn('endpoints', 'fingerprint');
  
  if (!hasColumn) {
    await knex.schema.table('endpoints', function(table) {
      // Add fingerprint column
      table.string('fingerprint').nullable();
      
      // Add index for fast lookups
      table.index('fingerprint', 'idx_endpoints_fingerprint');
    });
    
    console.log('✅ Added fingerprint column to endpoints table');
  } else {
    console.log('⏭️  Fingerprint column already exists');
  }
  
  // Backfill fingerprints for existing devices (if any)
  // This requires importing the fingerprint generator
  try {
    const endpoints = await knex('endpoints').select('*').whereNull('fingerprint');
    
    if (endpoints.length > 0) {
      console.log(`📋 Found ${endpoints.length} endpoints without fingerprints - backfilling...`);
      
      // Import fingerprint generator dynamically
      // Path: from dist/db/migrations/ to dist/features/discovery/fingerprint
      const { generateModbusFingerprint } = require('../../features/discovery/fingerprint');
      
      for (const endpoint of endpoints) {
        const connection = typeof endpoint.connection === 'string' 
          ? JSON.parse(endpoint.connection) 
          : endpoint.connection;
        
        let fingerprint = null;
        
        // Generate fingerprint based on protocol
        if (endpoint.protocol === 'modbus') {
          const busId = connection.type === 'serial'
            ? connection.port
            : `${connection.host}:${connection.port || 502}`;
          
          const slaveId = connection.slaveId || 1;
          
          // Try to get deviceId from metadata
          const metadata = endpoint.metadata 
            ? (typeof endpoint.metadata === 'string' ? JSON.parse(endpoint.metadata) : endpoint.metadata)
            : null;
          
          const deviceId = metadata?.deviceId;
          
          fingerprint = generateModbusFingerprint(busId, slaveId, deviceId);
        }
        // Add other protocols here when fingerprint generators are available
        
        // Update endpoint with fingerprint
        if (fingerprint) {
          await knex('endpoints')
            .where('id', endpoint.id)
            .update({ fingerprint });
          
          console.log(`  ✓ ${endpoint.name}: ${fingerprint.substring(0, 16)}...`);
        }
      }
      
      console.log('✅ Backfilled fingerprints for existing endpoints');
    } else {
      console.log('✅ No endpoints to backfill');
    }
  } catch (error) {
    console.warn('⚠️  Could not backfill fingerprints (will be added on next discovery):', error.message);
    // Don't fail migration - fingerprints will be added on next discovery
  }
};

exports.down = async function(knex) {
  // Remove index first
  await knex.schema.table('endpoints', function(table) {
    table.dropIndex('fingerprint', 'idx_endpoints_fingerprint');
  });
  
  // Remove column
  await knex.schema.table('endpoints', function(table) {
    table.dropColumn('fingerprint');
  });
  
  console.log('✅ Removed fingerprint column from endpoints table');
};
