-- Migration: Enable TimescaleDB and convert sensor_data to hypertable
-- Created: 2025-12-06
-- Purpose: Install TimescaleDB extension and convert sensor_data table to hypertable for better time-series performance
-- Dependencies: Requires TimescaleDB extension to be available in PostgreSQL

-- ============================================================================
-- 1. ENABLE TIMESCALEDB EXTENSION
-- ============================================================================

-- Install TimescaleDB extension if available
-- Note: This requires TimescaleDB to be installed on the PostgreSQL server
-- For installation instructions: https://docs.timescale.com/install/latest/
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

COMMENT ON EXTENSION timescaledb IS 'Enables high-performance time-series data handling with automatic partitioning';

-- ============================================================================
-- 2. CONVERT SENSOR_DATA TO HYPERTABLE
-- ============================================================================

-- Convert sensor_data table to TimescaleDB hypertable
-- This enables automatic time-based partitioning (chunks) for efficient time-series queries
-- Chunk interval: 7 days (optimized for IoT sensor data retention/query patterns)
SELECT create_hypertable(
    'sensor_data',                    -- Table name
    'timestamp',                      -- Time column to partition by
    chunk_time_interval => INTERVAL '7 days',  -- Create new chunk every 7 days
    if_not_exists => TRUE,            -- Don't fail if already a hypertable
    migrate_data => TRUE              -- Migrate existing data into chunks
);

COMMENT ON TABLE sensor_data IS 'Time-series sensor data from devices (TimescaleDB hypertable with 7-day chunks)';

-- ============================================================================
-- 3. OPTIMIZE INDEXES FOR HYPERTABLE
-- ============================================================================

-- Drop the old unique constraint that conflicts with hypertable requirements
-- TimescaleDB requires time column to be part of unique constraints
DROP INDEX IF EXISTS idx_sensor_data_unique;

-- Recreate unique constraint including the time dimension (required for hypertables)
-- This prevents duplicate sensor readings at the same timestamp
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_data_unique_hyper 
ON sensor_data(device_uuid, sensor_name, timestamp DESC);

-- Optimize existing indexes for TimescaleDB
-- TimescaleDB automatically creates time-based indexes per chunk
-- We keep device/sensor indexes for non-time filtered queries
-- Note: Indexes on hypertables are automatically created on each chunk

-- ============================================================================
-- 4. CONFIGURE COMPRESSION (OPTIONAL - RECOMMENDED FOR PRODUCTION)
-- ============================================================================

-- Enable compression for older chunks to save storage space
-- Compression reduces storage by 90%+ for time-series data
-- Compress chunks older than 30 days
ALTER TABLE sensor_data SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_uuid, sensor_name',  -- Group by device/sensor for better compression
    timescaledb.compress_orderby = 'timestamp DESC'               -- Order by time within compressed chunks
);

-- Add compression policy to automatically compress chunks older than 30 days
SELECT add_compression_policy('sensor_data', INTERVAL '30 days', if_not_exists => TRUE);

COMMENT ON TABLE sensor_data IS 'Time-series sensor data (TimescaleDB hypertable: 7-day chunks, compress after 30 days)';

-- ============================================================================
-- 5. CONFIGURE RETENTION POLICY (OPTIONAL - RECOMMENDED FOR PRODUCTION)
-- ============================================================================

-- Automatically drop chunks older than 365 days to prevent unbounded growth
-- Adjust retention period based on your requirements
-- Uncomment the following line to enable automatic data retention:
-- SELECT add_retention_policy('sensor_data', INTERVAL '365 days', if_not_exists => TRUE);

-- To enable retention policy, run:
-- SELECT add_retention_policy('sensor_data', INTERVAL '365 days', if_not_exists => TRUE);

-- ============================================================================
-- 6. CREATE CONTINUOUS AGGREGATES (OPTIONAL - FOR DASHBOARDS)
-- ============================================================================

-- Create materialized view for hourly sensor aggregates (faster dashboard queries)
-- This pre-computes hourly averages and is automatically maintained by TimescaleDB
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_data_hourly
WITH (timescaledb.continuous) AS
SELECT 
    device_uuid,
    sensor_name,
    time_bucket('1 hour', timestamp) AS hour,
    AVG((data->>'value')::numeric) AS avg_value,
    MIN((data->>'value')::numeric) AS min_value,
    MAX((data->>'value')::numeric) AS max_value,
    COUNT(*) AS sample_count,
    FIRST(data, timestamp) AS first_reading,
    LAST(data, timestamp) AS last_reading
FROM sensor_data
WHERE data->>'value' IS NOT NULL  -- Only aggregate numeric values
GROUP BY device_uuid, sensor_name, hour;

-- Create index on continuous aggregate for fast queries
CREATE INDEX IF NOT EXISTS idx_sensor_hourly_device_sensor_time 
ON sensor_data_hourly(device_uuid, sensor_name, hour DESC);

-- Add refresh policy to keep continuous aggregate up-to-date
-- Refresh hourly aggregates within 1 hour of real-time
SELECT add_continuous_aggregate_policy('sensor_data_hourly',
    start_offset => INTERVAL '3 hours',   -- Start refreshing data 3 hours old
    end_offset => INTERVAL '1 hour',      -- Finish refreshing data 1 hour old
    schedule_interval => INTERVAL '1 hour', -- Run refresh every hour
    if_not_exists => TRUE
);

COMMENT ON MATERIALIZED VIEW sensor_data_hourly IS 'Hourly sensor data aggregates (auto-refreshed every hour)';

-- ============================================================================
-- 7. VERIFY HYPERTABLE CONFIGURATION
-- ============================================================================

-- Query to check hypertable configuration (for debugging)
-- SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'sensor_data';

-- Query to check compression status
-- SELECT * FROM timescaledb_information.compression_settings WHERE hypertable_name = 'sensor_data';

-- Query to check chunks
-- SELECT * FROM timescaledb_information.chunks WHERE hypertable_name = 'sensor_data';

-- ============================================================================
-- MIGRATION NOTES
-- ============================================================================
-- 
-- Benefits of TimescaleDB hypertable:
-- 1. Automatic time-based partitioning (no manual partition management)
-- 2. 10-100x faster time-series queries (optimized query planner)
-- 3. 90%+ storage savings with compression
-- 4. Automatic data retention policies (drop old chunks)
-- 5. Continuous aggregates for fast dashboard queries
-- 6. Transparent - existing queries work without modification
--
-- Storage savings example:
-- - Before: 1 million rows = ~500 MB
-- - After compression: 1 million rows = ~50 MB (10x reduction)
--
-- Query performance example:
-- - Before: SELECT * FROM sensor_data WHERE timestamp > NOW() - INTERVAL '7 days'
--   Query time: 2-5 seconds (full table scan)
-- - After: Same query on hypertable
--   Query time: 50-200ms (chunk exclusion, optimized indexes)
--
-- Compression trade-off:
-- - Compressed chunks are read-only (cannot INSERT/UPDATE/DELETE)
-- - Recent data (< 30 days) remains uncompressed for write performance
-- - Queries automatically decompress on-the-fly (transparent to application)
--
-- To disable compression if needed:
-- SELECT remove_compression_policy('sensor_data');
-- ALTER TABLE sensor_data SET (timescaledb.compress = false);
--
-- To disable retention policy if needed:
-- SELECT remove_retention_policy('sensor_data');
--
-- ============================================================================
