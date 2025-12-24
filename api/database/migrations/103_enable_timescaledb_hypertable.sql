-- Migration: Enable TimescaleDB and convert sensor_data to hypertable (OPTIONAL)
-- Created: 2025-12-06
-- Purpose: Install TimescaleDB extension and convert sensor_data table to hypertable
-- Note: This migration skips gracefully if TimescaleDB is not installed


-- ============================================================================
-- 1. CHECK TIMESCALEDB AVAILABILITY AND ENABLE IF PRESENT
-- ============================================================================

DO $$
DECLARE
    timescaledb_available BOOLEAN;
    timescaledb_installed BOOLEAN;
    is_superuser BOOLEAN;
BEGIN
    -- Check if we have superuser privileges
    SELECT usesuper FROM pg_user WHERE usename = CURRENT_USER INTO is_superuser;
    
    -- Check if TimescaleDB is available as an extension
    SELECT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
    ) INTO timescaledb_available;
    
    -- Check if TimescaleDB is already installed
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
    ) INTO timescaledb_installed;

    IF timescaledb_installed THEN
        RAISE NOTICE 'TimescaleDB extension already enabled';
    ELSIF timescaledb_available THEN
        -- Try to enable TimescaleDB (may fail on managed services without superuser)
        BEGIN
            RAISE NOTICE 'TimescaleDB extension found, attempting to enable...';
            CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

            COMMENT ON EXTENSION timescaledb IS
                'Enables high-performance time-series data handling with automatic partitioning';
            
            RAISE NOTICE 'TimescaleDB extension successfully enabled';
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE WARNING 'Cannot enable TimescaleDB: insufficient privileges (requires superuser or rds_superuser). Continuing without TimescaleDB features.';
            WHEN OTHERS THEN
                RAISE WARNING 'Failed to enable TimescaleDB: % (%). Continuing without TimescaleDB features.', SQLERRM, SQLSTATE;
        END;

        -- ============================================================================
        -- 2. PREPARE FOR HYPERTABLE CONVERSION
        -- ============================================================================

        -- Drop old unique index BEFORE conversion (must happen BEFORE PK changes)
        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables
            WHERE hypertable_name = 'sensor_data'
        ) THEN
            RAISE NOTICE 'Dropping old unique index before hypertable conversion...';
            DROP INDEX IF EXISTS idx_sensor_data_unique;
        END IF;

        -- ============================================================================
        -- 3. CONVERT SENSOR_DATA TO HYPERTABLE
        -- ============================================================================

        IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables
            WHERE hypertable_name = 'sensor_data'
        ) THEN
            RAISE NOTICE 'Converting sensor_data to TimescaleDB hypertable...';

            -- ----------------------------------------
            -- Fix primary key to include timestamp
            -- ----------------------------------------
            ALTER TABLE sensor_data
                DROP CONSTRAINT IF EXISTS sensor_data_pkey CASCADE;

            ALTER TABLE sensor_data
                ADD CONSTRAINT sensor_data_pkey
                PRIMARY KEY (device_uuid, sensor_name, timestamp);

            RAISE NOTICE 'Updated primary key to include timestamp';

            -- ----------------------------------------
            -- Convert to hypertable
            -- ----------------------------------------
            PERFORM create_hypertable(
                'sensor_data',
                'timestamp',
                chunk_time_interval => INTERVAL '7 days',
                if_not_exists => TRUE,
                migrate_data      => TRUE
            );

            RAISE NOTICE 'Successfully converted sensor_data to hypertable';
        ELSE
            RAISE NOTICE 'sensor_data is already a hypertable, skipping conversion';
        END IF;

        COMMENT ON TABLE sensor_data IS
            'Time-series sensor data (TimescaleDB hypertable with 7-day chunks)';

        RAISE NOTICE 'TimescaleDB hypertable setup complete';

    ELSE
        RAISE NOTICE 'TimescaleDB extension not available';
        RAISE NOTICE 'Skipping hypertable conversion — table stays regular';
    END IF;
END $$;


-- ============================================================================
-- 4. CONFIGURE COMPRESSION (OPTIONAL)
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE NOTICE 'Configuring TimescaleDB compression...';

        ALTER TABLE sensor_data SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'device_uuid, sensor_name',
            timescaledb.compress_orderby   = 'timestamp DESC'
        );

        PERFORM add_compression_policy(
            'sensor_data',
            INTERVAL '30 days',
            if_not_exists => TRUE
        );

        COMMENT ON TABLE sensor_data IS
            'Time-series sensor data (TimescaleDB hypertable: 7-day chunks, compressed after 30 days)';

        RAISE NOTICE 'Compression configured successfully';
    END IF;
END $$;
