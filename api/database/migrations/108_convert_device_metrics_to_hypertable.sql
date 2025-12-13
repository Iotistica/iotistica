-- Migration 108: Convert device_metrics from manual partitioning to TimescaleDB hypertable
-- Purpose: Replace manual RANGE partitioning with TimescaleDB's automatic chunk management
-- Benefits: Automatic compression (90% storage reduction), retention policies, continuous aggregates

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

-- Step 2: Get row count for validation
DO $$
DECLARE
    original_count INTEGER;
BEGIN
    -- Count rows in all partitions
    SELECT COUNT(*) INTO original_count FROM device_metrics;
    RAISE NOTICE 'Current device_metrics row count: %', original_count;
END $$;

-- Step 3: Create new unpartitioned table (cannot convert partitioned table directly)
-- CRITICAL: PRIMARY KEY must include partitioning column for TimescaleDB
CREATE TABLE device_metrics_ts (
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

-- Step 4: Copy all data from partitioned table
-- This reads from all partitions automatically
DO $$
DECLARE
    copied_count INTEGER;
    original_count INTEGER;
BEGIN
    -- Get original count
    SELECT COUNT(*) INTO original_count FROM device_metrics;
    
    -- Copy data
    -- Handle case where top_processes column might not exist in source
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'device_metrics' AND column_name = 'top_processes'
    ) THEN
        -- Source has top_processes column
        INSERT INTO device_metrics_ts (
            id, device_uuid, cpu_usage, cpu_temp,
            memory_usage, memory_total, storage_usage, storage_total, top_processes, recorded_at
        )
        SELECT 
            id, device_uuid, cpu_usage, cpu_temp,
            memory_usage, memory_total, storage_usage, storage_total, top_processes, recorded_at
        FROM device_metrics
        ORDER BY recorded_at;
    ELSE
        -- Source doesn't have top_processes column, use default
        INSERT INTO device_metrics_ts (
            id, device_uuid, cpu_usage, cpu_temp,
            memory_usage, memory_total, storage_usage, storage_total, top_processes, recorded_at
        )
        SELECT 
            id, device_uuid, cpu_usage, cpu_temp,
            memory_usage, memory_total, storage_usage, storage_total, '[]'::jsonb, recorded_at
        FROM device_metrics
        ORDER BY recorded_at;
    END IF;
    
    GET DIAGNOSTICS copied_count = ROW_COUNT;
    RAISE NOTICE 'Copied % rows from device_metrics to device_metrics_ts', copied_count;
    
    -- Validation
    IF copied_count != original_count THEN
        RAISE EXCEPTION 'Row count mismatch! Original: %, Copied: %', original_count, copied_count;
    END IF;
    
    RAISE NOTICE 'Data copy validated successfully';
END $$;

-- Step 5: Rename tables (keep old as backup)
ALTER TABLE device_metrics RENAME TO device_metrics_old;
ALTER TABLE device_metrics_ts RENAME TO device_metrics;

-- Step 6: Reset sequence to continue from max ID
DO $$
DECLARE
    max_id BIGINT;
    seq_name TEXT;
BEGIN
    -- Get the sequence name created by BIGSERIAL
    SELECT pg_get_serial_sequence('device_metrics', 'id') INTO seq_name;
    
    IF seq_name IS NOT NULL THEN
        SELECT COALESCE(MAX(id), 0) INTO max_id FROM device_metrics;
        IF max_id > 0 THEN
            EXECUTE format('SELECT setval(%L, %s, true)', seq_name, max_id);
            RAISE NOTICE 'Sequence % reset to %', seq_name, max_id;
        END IF;
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
DROP FUNCTION IF EXISTS create_device_metrics_partition(DATE);
DROP FUNCTION IF EXISTS create_device_metrics_partitions_range(INTEGER, INTEGER);
DROP FUNCTION IF EXISTS drop_old_device_metrics_partitions(INTEGER);
DROP FUNCTION IF EXISTS get_device_metrics_partition_stats();

-- Step 13: Final validation
DO $$
DECLARE
    old_count INTEGER;
    new_count INTEGER;
    chunk_count INTEGER;
BEGIN
    -- Count rows in old and new tables
    SELECT COUNT(*) INTO old_count FROM device_metrics_old;
    SELECT COUNT(*) INTO new_count FROM device_metrics;
    
    -- Count chunks
    SELECT COUNT(*) INTO chunk_count 
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'device_metrics';
    
    RAISE NOTICE '=== Migration Validation ===';
    RAISE NOTICE 'Old table rows: %', old_count;
    RAISE NOTICE 'New table rows: %', new_count;
    RAISE NOTICE 'TimescaleDB chunks: %', chunk_count;
    
    IF old_count != new_count THEN
        RAISE EXCEPTION 'Row count mismatch! Old: %, New: %', old_count, new_count;
    END IF;
    
    RAISE NOTICE 'Migration validated successfully!';
END $$;

COMMIT;

-- =============================================================================
-- CONTINUOUS AGGREGATES (Must be outside transaction)
-- =============================================================================

-- Step 14: Create continuous aggregates for dashboards

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
    RAISE NOTICE 'Check hypertable status with: SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = ''device_metrics'';';
    RAISE NOTICE 'Check continuous aggregates with: SELECT * FROM timescaledb_information.continuous_aggregates;';
END $$;

-- Migration 108 complete
-- 
-- Rollback: DROP TABLE device_metrics CASCADE; ALTER TABLE device_metrics_old RENAME TO device_metrics;
-- Cleanup: DROP TABLE device_metrics_old; (after validation)

