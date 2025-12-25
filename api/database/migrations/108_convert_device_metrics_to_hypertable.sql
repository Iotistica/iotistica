-- Migration 108: Convert device_metrics to TimescaleDB hypertable
-- Purpose: Replace manual RANGE partitioning with TimescaleDB's automatic chunk management
-- Benefits: Automatic compression (90% storage reduction), retention policies, continuous aggregates
-- NOTE: This version DOES NOT copy existing data - starts fresh

-- Azure PostgreSQL: Set reasonable timeouts
SET statement_timeout = '120s';
SET lock_timeout = '30s';

BEGIN;

-- Step 0: Cleanup from any previous failed migration attempts
DO $$
BEGIN
    -- Drop continuous aggregate views if they exist
    DROP MATERIALIZED VIEW IF EXISTS device_metrics_5min CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS device_metrics_hourly CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS device_metrics_daily CASCADE;
    
    -- Drop temp tables if they exist
    DROP TABLE IF EXISTS device_metrics_ts CASCADE;
    DROP TABLE IF EXISTS device_metrics_old CASCADE;
    
    RAISE NOTICE 'Cleanup complete';
END $$;

-- Step 1: Verify TimescaleDB extension is available
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE EXCEPTION 'TimescaleDB extension not found. Install with: CREATE EXTENSION timescaledb;';
    END IF;
    RAISE NOTICE 'TimescaleDB extension verified';
END $$;

-- Step 2: Archive old table (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'device_metrics') THEN
        -- Rename old table for potential recovery
        ALTER TABLE device_metrics RENAME TO device_metrics_old;
        RAISE NOTICE 'Old device_metrics table archived as device_metrics_old';
        RAISE NOTICE 'You can drop it later with: DROP TABLE device_metrics_old CASCADE;';
    ELSE
        RAISE NOTICE 'No existing device_metrics table found';
    END IF;
END $$;

-- Step 3: Create new unpartitioned table with TimescaleDB-compatible schema
CREATE TABLE device_metrics (
    id BIGSERIAL,
    device_uuid UUID NOT NULL,
    cpu_usage NUMERIC,
    cpu_temp NUMERIC,
    memory_usage BIGINT,
    memory_total BIGINT,
    storage_usage BIGINT,
    storage_total BIGINT,
    top_processes JSONB DEFAULT '[]',
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, recorded_at)  -- Composite PK required by TimescaleDB
);

RAISE NOTICE 'Created new device_metrics table (empty)';
    END IF;
END $$;

-- Step 7: Convert to TimescaleDB hypertable
-- chunk_time_interval: 1 day (86400 seconds = 1 day in microseconds)
-- migrate_data: Required because table has data after copy operation
SELECT create_hypertable(
    'device_metrics',
    'recorded_at',
    chunk_time_interval => INTERVAL '1 day',
    migrate_data => TRUE,
    if_not_exists => TRUE
);

-- Verify hypertable creation
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'device_metrics'
    ) THEN
        RAISE EXCEPTION 'Failed to create hypertable for device_metrics';
    END IF;
    RAISE NOTICE 'Hypertable created successfully';
END $$;

-- Step 8: Enable compression (90% storage reduction expected)
-- segmentby device_uuid: Groups data by device for better compression
-- orderby recorded_at DESC: Recent data queries are faster
ALTER TABLE device_metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_uuid',
    timescaledb.compress_orderby = 'recorded_at DESC'
);

-- Step 9: Add compression policy (compress chunks older than 7 days)
-- This runs automatically in the background
SELECT add_compression_policy('device_metrics', INTERVAL '7 days');

-- Step 10: Add retention policy (drop chunks older than 180 days)
-- Adjust retention period based on requirements:
-- - 90 days: Short-term monitoring
-- - 180 days: Medium-term analysis (RECOMMENDED)
-- - 365 days: Long-term compliance
SELECT add_retention_policy('device_metrics', INTERVAL '180 days');

-- Step 11: Recreate indexes for query performance
-- Index 1: Device lookup
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_uuid 
ON device_metrics (device_uuid);

-- Index 2: Time-series queries
CREATE INDEX IF NOT EXISTS idx_device_metrics_recorded_at_desc 
ON device_metrics (recorded_at DESC);

-- Index 3: Device + time range queries (most common)
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_time 
ON device_metrics (device_uuid, recorded_at DESC);

-- Index 4: GIN index for top_processes JSONB queries
CREATE INDEX IF NOT EXISTS idx_device_metrics_top_processes 
ON device_metrics USING GIN (top_processes);

-- Step 12: Drop obsolete partition management functions
-- These were for manual partitioning and are no longer needed
-- Step 4: Convert to hypertable
SELECT create_hypertable('device_metrics', 'recorded_at', 
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

RAISE NOTICE 'Created hypertable with 7-day chunks';

-- Step 5: Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_uuid 
    ON device_metrics (device_uuid, recorded_at DESC);
    
CREATE INDEX IF NOT EXISTS idx_device_metrics_recorded_at 
    ON device_metrics (recorded_at DESC);

RAISE NOTICE 'Created indexes';

-- Step 6: Enable compression (requires TimescaleDB 2.0+)
DO $$
BEGIN
    -- Enable compression on chunks older than 7 days
    ALTER TABLE device_metrics SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'device_uuid'
    );
    
    -- Add compression policy
    SELECT add_compression_policy('device_metrics', INTERVAL '7 days');
    
    RAISE NOTICE 'Compression enabled (90% storage reduction for old data)';
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Could not enable compression: % (continuing without compression)', SQLERRM;
END $$;

-- Step 7: Add retention policy (optional - keeps last 90 days)
DO $$
BEGIN
    SELECT add_retention_policy('device_metrics', INTERVAL '90 days');
    RAISE NOTICE 'Retention policy added (keeps last 90 days)';
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Could not add retention policy: % (continuing without retention)', SQLERRM;
END $$;

COMMIT;

-- =============================================================================
-- CONTINUOUS AGGREGATES (Must be outside transaction)
-- =============================================================================

-- Step 8: Create continuous aggregates for dashboards

-- 5-minute aggregates (real-time monitoring)
CREATE MATERIALIZED VIEW device_metrics_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', recorded_at) AS bucket,
    device_uuid,
    -- CPU metrics
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    -- Memory metrics
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    -- Storage metrics
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    -- Row count
    count(*) AS sample_count
FROM device_metrics
GROUP BY bucket, device_uuid
WITH NO DATA;  -- Data populated by refresh policy

-- Hourly aggregates (medium-term trends)
CREATE MATERIALIZED VIEW device_metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', recorded_at) AS bucket,
    device_uuid,
    -- CPU metrics
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    -- Memory metrics
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    -- Storage metrics
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    -- Row count
    count(*) AS sample_count
FROM device_metrics
GROUP BY bucket, device_uuid
WITH NO DATA;  -- Data populated by refresh policy

-- Daily aggregates (long-term analysis)
CREATE MATERIALIZED VIEW device_metrics_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', recorded_at) AS bucket,
    device_uuid,
    -- CPU metrics
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    -- Memory metrics
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    -- Storage metrics
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    -- Row count
    count(*) AS sample_count
FROM device_metrics
GROUP BY bucket, device_uuid
WITH NO DATA;  -- Data populated by refresh policy

-- Step 15: Add refresh policies for continuous aggregates
-- This keeps the materialized views up-to-date automatically

-- 5-minute view: Refresh every 5 minutes, covering last 3 hours
-- start_offset must be >= 2 buckets (10 minutes) to avoid errors
SELECT add_continuous_aggregate_policy('device_metrics_5min',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes');

-- Hourly view: Refresh every hour, covering last 24 hours
SELECT add_continuous_aggregate_policy('device_metrics_hourly',
    start_offset => INTERVAL '24 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Daily view: Refresh daily, covering last 7 days
SELECT add_continuous_aggregate_policy('device_metrics_daily',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day');

-- Display final statistics
DO $$
BEGIN
    RAISE NOTICE 'Migration 108 completed successfully!';
    RAISE NOTICE 'Device metrics table is now a TimescaleDB hypertable (empty, ready for new data)';
    RAISE NOTICE 'Old data preserved in device_metrics_old (drop manually if not needed)';
    RAISE NOTICE 'Check hypertable: SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = ''device_metrics'';';
    RAISE NOTICE 'Check aggregates: SELECT * FROM timescaledb_information.continuous_aggregates;';
END $$;

-- Reset timeouts to defaults
RESET statement_timeout;
RESET lock_timeout;

-- Migration 108 complete
-- 
-- Rollback: DROP TABLE device_metrics CASCADE; ALTER TABLE device_metrics_old RENAME TO device_metrics;
-- Cleanup: DROP TABLE device_metrics_old; (after validation)

