/**
 * Add Alert Suppression Metadata
 * 
 * Adds suppression tracking fields to anomaly_alerts table:
 * - cooldown_sec: Cooldown period in seconds
 * - first_seen: Unix timestamp when first detected
 * - consecutive_count: Consecutive detections without reset
 * 
 * Enables cloud-side deduplication and flapping detection.
 */

export async function up(knex) {
  // Check if columns already exist
  const hasColumns = await knex.schema.hasColumn('anomaly_alerts', 'cooldown_sec');
  
  if (!hasColumns) {
    // Add suppression metadata columns
    await knex.schema.alterTable('anomaly_alerts', (table) => {
      table.integer('cooldown_sec').notNullable().defaultTo(300);
      table.bigInteger('first_seen').notNullable().defaultTo(0);
      table.integer('consecutive_count').notNullable().defaultTo(1);
    });

    // Create index for finding persistent alerts (consecutiveCount >= N)
    await knex.schema.alterTable('anomaly_alerts', (table) => {
      table.index(['metric', 'consecutive_count', 'first_seen'], 'idx_anomaly_alerts_consecutive');
    });

    // Create index for finding flapping alerts (high count, low consecutive)
    await knex.schema.alterTable('anomaly_alerts', (table) => {
      table.index(['fingerprint', 'count', 'consecutive_count'], 'idx_anomaly_alerts_flapping');
    });

    console.log('✓ Added alert suppresion metadata');
  }
}

export async function down(knex) {
  // Check if columns exist
  const hasColumns = await knex.schema.hasColumn('anomaly_alerts', 'cooldown_sec');
  
  if (hasColumns) {
    // Drop indexes - use IF EXISTS for safety
    try {
      await knex.raw(`DROP INDEX IF EXISTS idx_anomaly_alerts_consecutive`);
    } catch (err) {
      // Ignore
    }
    
    try {
      await knex.raw(`DROP INDEX IF EXISTS idx_anomaly_alerts_flapping`);
    } catch (err) {
      // Ignore
    }

    // Drop columns
    await knex.schema.alterTable('anomaly_alerts', (table) => {
      table.dropColumn('cooldown_sec');
      table.dropColumn('first_seen');
      table.dropColumn('consecutive_count');
    });
  }
}
