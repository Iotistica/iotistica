/**
 * Add Seasonality Support to Anomaly Detection
 * 
 * Adds time_slot column to anomaly_baselines table to enable temporal baseline bucketing:
 * - -1: Overall baseline (no seasonality)
 * - 0-1: Day/night (0=night, 1=day)
 * - 0-23: Hourly
 * - 0-167: Weekly (day*24 + hour)
 */

export async function up(knex) {
  // Check if time_slot column already exists
  const hasColumn = await knex.schema.hasColumn('anomaly_baselines', 'time_slot');
  
  if (!hasColumn) {
    // Add time_slot column to anomaly_baselines
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.integer('time_slot').notNullable().defaultTo(-1);
    });

    // Check for and drop old unique constraint (metric only) if it exists
    // Query sqlite_master to find the index name
    const indexes = await knex.raw(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND tbl_name='anomaly_baselines' AND sql LIKE '%metric%'
    `);
    
    // Drop any existing unique indexes on metric column only
    for (const idx of indexes) {
      if (idx.name && idx.name.includes('metric') && !idx.name.includes('time_slot')) {
        try {
          await knex.raw(`DROP INDEX IF EXISTS ${idx.name}`);
        } catch (err) {
          // Ignore errors - index might not exist or be auto-generated
        }
      }
    }

    // Create new unique constraint (metric + time_slot)
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.unique(['metric', 'time_slot']);
    });

    // Create index for seasonal baseline lookups
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.index(['metric', 'time_slot', 'calculated_at']);
    });

    // Create index for overall baseline fallback
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.index(['metric', 'calculated_at'], 'idx_anomaly_baselines_overall');
    });
  }
}

export async function down(knex) {
  // Check if time_slot column exists
  const hasColumn = await knex.schema.hasColumn('anomaly_baselines', 'time_slot');
  
  if (hasColumn) {
    // Drop indexes - use IF EXISTS for safety
    try {
      await knex.raw(`DROP INDEX IF EXISTS anomaly_baselines_metric_time_slot_calculated_at_index`);
    } catch (err) {
      // Ignore
    }
    
    try {
      await knex.raw(`DROP INDEX IF EXISTS idx_anomaly_baselines_overall`);
    } catch (err) {
      // Ignore
    }

    // Drop unique constraint
    try {
      await knex.raw(`
        SELECT name FROM sqlite_master 
        WHERE type='index' AND tbl_name='anomaly_baselines' 
        AND (sql LIKE '%metric%' AND sql LIKE '%time_slot%')
      `).then(async (indexes) => {
        for (const idx of indexes) {
          if (idx.name) {
            await knex.raw(`DROP INDEX IF EXISTS ${idx.name}`);
          }
        }
      });
    } catch (err) {
      // Ignore
    }

    // Drop time_slot column
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.dropColumn('time_slot');
    });

    // Restore original unique constraint - but only if it doesn't already exist
    const existingIndexes = await knex.raw(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND tbl_name='anomaly_baselines' AND sql LIKE '%UNIQUE%' AND sql LIKE '%metric%'
    `);
    
    if (existingIndexes.length === 0) {
      await knex.schema.alterTable('anomaly_baselines', (table) => {
        table.unique(['metric']);
      });
    }
  }
}
