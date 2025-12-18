/**
 * Fix Anomaly Baselines Unique Constraint
 * 
 * Problem: The unique constraint on ['metric', 'calculated_at'] prevents
 * saving multiple metrics at the same timestamp (which happens when
 * saveBaselines() loops through metrics with Date.now()).
 * 
 * Solution: Remove the combined unique constraint. We want to allow
 * multiple baseline snapshots over time for historical analysis.
 */

export async function up(knex) {
  // SQLite doesn't support DROP CONSTRAINT directly
  // We need to recreate the table without the constraint
  
  // 1. Create temporary table with correct schema
  await knex.schema.createTable('anomaly_baselines_new', (table) => {
    table.increments('id').primary();
    table.string('metric', 255).notNullable();
    
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
    
    // Indexes (no unique constraint on calculated_at combo)
    table.index('metric');
    table.index('calculated_at');
    table.index(['metric', 'calculated_at']); // Index for queries, not uniqueness
  });
  
  // 2. Copy existing data (if any)
  const hasData = await knex.schema.hasTable('anomaly_baselines');
  if (hasData) {
    await knex.raw(`
      INSERT INTO anomaly_baselines_new 
      (id, metric, mean, median, std_dev, mad, min, max, q1, q3, iqr, 
       sample_count, calculated_at, window_start, window_end, created_at, updated_at)
      SELECT id, metric, mean, median, std_dev, mad, min, max, q1, q3, iqr,
             sample_count, calculated_at, window_start, window_end, created_at, updated_at
      FROM anomaly_baselines
    `);
  }
  
  // 3. Drop old table
  await knex.schema.dropTableIfExists('anomaly_baselines');
  
  // 4. Rename new table
  await knex.schema.renameTable('anomaly_baselines_new', 'anomaly_baselines');
}

export async function down(knex) {
  // Recreate with the old unique constraint
  await knex.schema.createTable('anomaly_baselines_new', (table) => {
    table.increments('id').primary();
    table.string('metric', 255).notNullable();
    table.float('mean').nullable();
    table.float('median').nullable();
    table.float('std_dev').nullable();
    table.float('mad').nullable();
    table.float('min').nullable();
    table.float('max').nullable();
    table.float('q1').nullable();
    table.float('q3').nullable();
    table.float('iqr').nullable();
    table.integer('sample_count').notNullable();
    table.bigInteger('calculated_at').notNullable();
    table.bigInteger('window_start').nullable();
    table.bigInteger('window_end').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index('metric');
    table.index('calculated_at');
    table.unique(['metric', 'calculated_at']);
  });
  
  await knex.raw(`
    INSERT INTO anomaly_baselines_new 
    (id, metric, mean, median, std_dev, mad, min, max, q1, q3, iqr,
     sample_count, calculated_at, window_start, window_end, created_at, updated_at)
    SELECT id, metric, mean, median, std_dev, mad, min, max, q1, q3, iqr,
           sample_count, calculated_at, window_start, window_end, created_at, updated_at
    FROM anomaly_baselines
  `);
  
  await knex.schema.dropTableIfExists('anomaly_baselines');
  await knex.schema.renameTable('anomaly_baselines_new', 'anomaly_baselines');
}
