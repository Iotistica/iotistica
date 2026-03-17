/**
 * Add device_id partitioning for anomaly baselines.
 *
 * Enables per-logical-device baselines keyed by:
 *   (metric, profile, time_slot, device_state, device_id)
 *
 * Backward compatibility:
 * - Existing rows are defaulted to device_id='unknown-device'
 */

export async function up(knex) {
  const hasTable = await knex.schema.hasTable('anomaly_baselines');
  if (!hasTable) {
    return;
  }

  const hasDeviceId = await knex.schema.hasColumn('anomaly_baselines', 'device_id');
  if (!hasDeviceId) {
    await knex.schema.alterTable('anomaly_baselines', (table) => {
      table.string('device_id', 128).notNullable().defaultTo('unknown-device');
    });
  }

  await knex.raw('DROP INDEX IF EXISTS anomaly_baselines_new_metric_profile_time_slot_unique');

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_new_metric_profile_time_slot_unique
    ON anomaly_baselines (metric, profile, time_slot, device_state, device_id)
  `);

  await knex.raw('DROP INDEX IF EXISTS idx_anomaly_baselines_lookup');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_lookup
    ON anomaly_baselines (metric, time_slot, device_state, device_id, calculated_at)
  `);
}

export async function down(knex) {
  const hasTable = await knex.schema.hasTable('anomaly_baselines');
  if (!hasTable) {
    return;
  }

  await knex.raw('DROP INDEX IF EXISTS idx_anomaly_baselines_lookup');
  await knex.raw('DROP INDEX IF EXISTS anomaly_baselines_new_metric_profile_time_slot_unique');

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_new_metric_profile_time_slot_unique
    ON anomaly_baselines (metric, profile, time_slot, device_state)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_lookup
    ON anomaly_baselines (metric, time_slot, device_state, calculated_at)
  `);

  // SQLite does not support dropping columns safely without table recreation.
}
