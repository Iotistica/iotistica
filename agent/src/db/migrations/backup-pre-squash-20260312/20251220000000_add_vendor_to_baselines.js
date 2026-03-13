/**
 * Add Vendor Field to Anomaly Baselines
 * 
 * Purpose: Track which vendor config each baseline belongs to.
 * When vendor changes (e.g., Generic → COMAP), baselines are preserved and filtered by vendor.
 * This prevents contaminated baselines without losing historical data.
 */

export async function up(knex) {
  // Add vendor column to anomaly_baselines
  await knex.schema.table('anomaly_baselines', (table) => {
    table.string('vendor', 100).nullable();
  });

  // Find and drop existing unique constraint on [metric, time_slot]
  const indexes = await knex.raw(`
    SELECT name FROM sqlite_master 
    WHERE type='index' 
    AND tbl_name='anomaly_baselines' 
    AND sql LIKE '%UNIQUE%' 
    AND sql LIKE '%metric%' 
    AND sql LIKE '%time_slot%'
  `);

  // Drop the old unique constraint if it exists
  for (const idx of indexes) {
    if (idx.name) {
      await knex.raw(`DROP INDEX IF EXISTS ${idx.name}`);
    }
  }

  // Add new unique constraint: [metric, vendor, time_slot]
  await knex.schema.table('anomaly_baselines', (table) => {
    table.unique(['metric', 'vendor', 'time_slot']);
  });

  console.log('✓ Added vendor field to anomaly_baselines');
  console.log('✓ Updated unique constraint to include vendor');
}

export async function down(knex) {
  // Find and drop the new unique constraint [metric, vendor, time_slot]
  const indexes = await knex.raw(`
    SELECT name FROM sqlite_master 
    WHERE type='index' 
    AND tbl_name='anomaly_baselines' 
    AND sql LIKE '%UNIQUE%' 
    AND sql LIKE '%metric%' 
    AND sql LIKE '%vendor%'
  `);

  for (const idx of indexes) {
    if (idx.name) {
      await knex.raw(`DROP INDEX IF EXISTS ${idx.name}`);
    }
  }

  // Restore old unique constraint [metric, time_slot]
  await knex.schema.table('anomaly_baselines', (table) => {
    table.unique(['metric', 'time_slot']);
  });

  // Drop vendor column
  await knex.schema.table('anomaly_baselines', (table) => {
    table.dropColumn('vendor');
  });

  console.log('✓ Removed vendor field from anomaly_baselines');
}

