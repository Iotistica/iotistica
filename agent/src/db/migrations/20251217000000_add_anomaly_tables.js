/**
 * Anomaly Detection Storage Migration
 * 
 * Tables:
 * - anomaly_alerts: Stores detected anomalies with context
 * - anomaly_baselines: Stores statistical baselines for metrics
 */

export async function up(knex) {
  // ===== Anomaly Alerts Table =====
  // Stores all detected anomalies with full context
  await knex.schema.createTable('anomaly_alerts', (table) => {
    table.increments('id').primary();
    table.string('alert_id', 255).notNullable().unique(); // UUID from AnomalyAlert
    table.string('severity', 50).notNullable(); // 'info', 'warning', 'critical'
    table.string('metric', 255).notNullable();
    table.float('value').notNullable();
    table.float('expected_min').nullable();
    table.float('expected_max').nullable();
    table.float('deviation').notNullable(); // Standard deviations or MADs from normal
    table.string('detection_method', 50).notNullable(); // 'zscore', 'mad', 'iqr', etc.
    table.bigInteger('timestamp').notNullable(); // Unix timestamp in milliseconds
    table.float('confidence').notNullable(); // 0-1 confidence score
    
    // Context information (stored as JSON)
    table.text('context').nullable(); // JSON: { recent_values, baseline, trend, windowSize }
    
    table.string('message', 1000).nullable(); // Human-readable description
    table.string('fingerprint', 255).notNullable(); // For deduplication
    table.integer('count').defaultTo(1); // Number of times this alert fired
    
    // Metadata
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes for efficient queries
    table.index('metric');
    table.index('severity');
    table.index('timestamp');
    table.index('fingerprint');
    table.index(['metric', 'timestamp']); // Composite index for metric-based time-series queries
  });

  // ===== Anomaly Baselines Table =====
  // Stores statistical baselines for metrics (updated periodically)
  await knex.schema.createTable('anomaly_baselines', (table) => {
    table.increments('id').primary();
    table.string('metric', 255).notNullable();
    
    // Statistical measures
    table.float('mean').nullable();
    table.float('median').nullable();
    table.float('std_dev').nullable(); // Standard deviation
    table.float('mad').nullable(); // Median Absolute Deviation
    table.float('min').nullable();
    table.float('max').nullable();
    table.float('q1').nullable(); // First quartile (25th percentile)
    table.float('q3').nullable(); // Third quartile (75th percentile)
    table.float('iqr').nullable(); // Interquartile Range
    
    // Baseline metadata
    table.integer('sample_count').notNullable(); // Number of samples used
    table.bigInteger('calculated_at').notNullable(); // Unix timestamp
    table.bigInteger('window_start').nullable(); // Start of time window
    table.bigInteger('window_end').nullable(); // End of time window
    
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Indexes
    table.index('metric');
    table.index('calculated_at');
    table.unique(['metric', 'calculated_at']); // One baseline per metric per calculation time
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('anomaly_baselines');
  await knex.schema.dropTableIfExists('anomaly_alerts');
}
