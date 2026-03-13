/**
 * Rename Vendor to Profile in Anomaly Baselines
 * 
 * Purpose: Refactor terminology from "vendor" to "profile" for semantic accuracy.
 * "Profile" better describes device configurations (e.g., COMAP vs ComAp-InteliGen are different
 * profiles of the same vendor).
 * 
 * Changes:
 * - anomaly_baselines.vendor → anomaly_baselines.profile
 * - unique constraint [metric, vendor, time_slot] → [metric, profile, time_slot]
 */

export async function up(knex) {
  // SQLite doesn't support column rename, so we use a table recreation strategy
  
  // 1. Create new table with profile column
  await knex.schema.createTable('anomaly_baselines_new', (table) => {
    table.increments('id').primary();
    table.string('metric', 255).notNullable();
    table.string('profile', 100).nullable();  // Renamed from 'vendor'
    table.integer('time_slot').notNullable().defaultTo(-1);
    
    // Statistical measures
    table.float('mean').nullable();
    table.float('median').nullable();
    table.float('std_dev').nullable();
    table.float('mad').nullable();
    table.float('min').nullable();
    table.float('max').nullable();
    table.float('q1').nullable();
    table.float('q3').nullable();
    table.float('iqr').nullable();
    
    // Baseline metadata
    table.integer('sample_count').notNullable();
    table.bigInteger('calculated_at').notNullable();
    table.bigInteger('window_start').nullable();
    table.bigInteger('window_end').nullable();
    
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Recreate unique constraint with new column name
    table.unique(['metric', 'profile', 'time_slot']);
  });

  // 2. Copy data from old table to new table
  await knex.raw(`
    INSERT INTO anomaly_baselines_new 
    (id, metric, profile, time_slot, mean, median, std_dev, mad, min, max, q1, q3, iqr,
     sample_count, calculated_at, window_start, window_end, created_at, updated_at)
    SELECT id, metric, vendor, time_slot, mean, median, std_dev, mad, min, max, q1, q3, iqr,
           sample_count, calculated_at, window_start, window_end, created_at, updated_at
    FROM anomaly_baselines
  `);

  // 3. Drop old table
  await knex.schema.dropTable('anomaly_baselines');

  // 4. Rename new table to original name
  await knex.schema.renameTable('anomaly_baselines_new', 'anomaly_baselines');

  console.log('✓ Renamed anomaly_baselines.vendor → profile');
  console.log('✓ Updated unique constraint to [metric, profile, time_slot]');
}

export async function down(knex) {
  // Reverse: profile → vendor
  
  // 1. Create table with vendor column
  await knex.schema.createTable('anomaly_baselines_new', (table) => {
    table.increments('id').primary();
    table.string('metric', 255).notNullable();
    table.string('vendor', 100).nullable();  // Reverted from 'profile'
    table.integer('time_slot').notNullable().defaultTo(-1);
    
    // Statistical measures
    table.float('mean').nullable();
    table.float('median').nullable();
    table.float('std_dev').nullable();
    table.float('mad').nullable();
    table.float('min').nullable();
    table.float('max').nullable();
    table.float('q1').nullable();
    table.float('q3').nullable();
    table.float('iqr').nullable();
    
    // Baseline metadata
    table.integer('sample_count').notNullable();
    table.bigInteger('calculated_at').notNullable();
    table.bigInteger('window_start').nullable();
    table.bigInteger('window_end').nullable();
    
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.unique(['metric', 'vendor', 'time_slot']);
  });

  // 2. Copy data back
  await knex.raw(`
    INSERT INTO anomaly_baselines_new 
    (id, metric, vendor, time_slot, mean, median, std_dev, mad, min, max, q1, q3, iqr,
     sample_count, calculated_at, window_start, window_end, created_at, updated_at)
    SELECT id, metric, profile, time_slot, mean, median, std_dev, mad, min, max, q1, q3, iqr,
           sample_count, calculated_at, window_start, window_end, created_at, updated_at
    FROM anomaly_baselines
  `);

  // 3. Drop old table
  await knex.schema.dropTable('anomaly_baselines');

  // 4. Rename back
  await knex.schema.renameTable('anomaly_baselines_new', 'anomaly_baselines');

  console.log('✓ Reverted anomaly_baselines.profile → vendor');
}
