-- Migration: Enable TimescaleDB and convert sensor_data to hypertable (OPTIONAL)
-- Created: 2025-12-06
-- Purpose: Install TimescaleDB extension and convert sensor_data table to hypertable for better time-series performance
-- Dependencies: Requires TimescaleDB extension to be available in PostgreSQL
-- Note: This migration will skip gracefully if TimescaleDB is not installed

-- ============================================================================
-- 1. CHECK TIMESCALEDB AVAILABILITY AND ENABLE IF PRESENT
-- ============================================================================

DO $$
DECLARE
    timescaledb_available BOOLEAN;
BEGIN
    -- Check if TimescaleDB is available in the system
    SELECT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
    ) INTO timescaledb_available;
    
    IF timescaledb_available THEN
        -- Install TimescaleDB extension if available
        RAISE NOTICE 'TimescaleDB extension found, enabling...';
        CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
        
        COMMENT ON EXTENSION timescaledb IS 'Enables high-performance time-series data handling with automatic partitioning';
        
        -- ============================================================================
        -- 2. CONVERT SENSOR_DATA TO HYPERTABLE
        -- ============================================================================
        
        -- Check if sensor_data is already a hypertable
        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables 
            WHERE hypertable_name = 'sensor_data'
        ) THEN
            RAISE NOTICE 'Converting sensor_data to TimescaleDB hypertable...';
            
            -- Convert sensor_data table to TimescaleDB hypertable
            PERFORM create_hypertable(
                'sensor_data',                    -- Table name
                'timestamp',                      -- Time column to partition by
                chunk_time_interval => INTERVAL '7 days',  -- Create new chunk every 7 days
                if_not_exists => TRUE,            -- Don't fail if already a hypertable
                migrate_data => TRUE              -- Migrate existing data into chunks
            );
            
            RAISE NOTICE 'Successfully converted sensor_data to hypertable';
        ELSE
            RAISE NOTICE 'sensor_data is already a TimescaleDB hypertable, skipping conversion';
        END IF;
        
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
        
        RAISE NOTICE 'TimescaleDB hypertable setup complete';
    ELSE
        RAISE NOTICE 'TimescaleDB extension not available in this PostgreSQL installation';
        RAISE NOTICE 'Skipping hypertable conversion - sensor_data will remain as regular table';
        RAISE NOTICE 'To use TimescaleDB features, install it following: https://docs.timescale.com/install/latest/';
    END IF;
END $$;

-- ============================================================================
-- 4. CONFIGURE COMPRESSION (OPTIONAL - TIMESCALEDB ONLY)
-- ============================================================================

DO $$
BEGIN
    -- Only configure compression if TimescaleDB is enabled
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE NOTICE 'Configuring TimescaleDB compression...';
        
        -- Enable compression for older chunks to save storage space
        ALTER TABLE sensor_data SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'device_uuid, sensor_name',
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        
        -- Add compression policy to automatically compress chunks older than 30 days
        PERFORM add_compression_policy('sensor_data', INTERVAL '30 days', if_not_exists => TRUE);
        
        COMMENT ON TABLE sensor_data IS 'Time-series sensor data (TimescaleDB hypertable: 7-day chunks, compress after 30 days)';
        RAISE NOTICE 'Compression configured successfully';
    END IF;
END $$;

-- ============================================================================
-- 5. CONFIGURE RETENTION POLICY (OPTIONAL - TIMESCALEDB ONLY)
-- ============================================================================

-- Automatically drop chunks older than 365 days to prevent unbounded growth
-- Uncomment to enable:
-- DO $$
-- BEGIN
--     IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
--         PERFORM add_retention_policy('sensor_data', INTERVAL '365 days', if_not_exists => TRUE);
--     END IF;
-- END $$;

-- ============================================================================
-- 6. CREATE CONTINUOUS AGGREGATES (OPTIONAL - TIMESCALEDB ONLY)
-- ============================================================================

DO $$
BEGIN
    -- Only create continuous aggregates if TimescaleDB is enabled
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE NOTICE 'Creating continuous aggregate for hourly sensor data...';
        
        -- Check if continuous aggregate already exists
        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.continuous_aggregates 
            WHERE view_name = 'sensor_data_hourly'
        ) THEN
            -- Create materialized view for hourly sensor aggregates
            CREATE MATERIALIZED VIEW sensor_data_hourly
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
            WHERE data->>'value' IS NOT NULL
            GROUP BY device_uuid, sensor_name, hour;
            
            RAISE NOTICE 'Continuous aggregate view created';
            
            -- Create index on continuous aggregate
            CREATE INDEX IF NOT EXISTS idx_sensor_hourly_device_sensor_time 
            ON sensor_data_hourly(device_uuid, sensor_name, hour DESC);
            
            RAISE NOTICE 'Index created on continuous aggregate';
            
            -- Add refresh policy
            PERFORM add_continuous_aggregate_policy('sensor_data_hourly',
                start_offset => INTERVAL '3 hours',
                end_offset => INTERVAL '1 hour',
                schedule_interval => INTERVAL '1 hour',
                if_not_exists => TRUE
            );
            
            COMMENT ON MATERIALIZED VIEW sensor_data_hourly IS 'Hourly sensor data aggregates (auto-refreshed every hour)';
            RAISE NOTICE 'Continuous aggregate created successfully';
        ELSE
            RAISE NOTICE 'Continuous aggregate sensor_data_hourly already exists, skipping';
        END IF;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Failed to create continuous aggregate: %', SQLERRM;
        RAISE NOTICE 'This is optional - continuing anyway';
END $$;

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
