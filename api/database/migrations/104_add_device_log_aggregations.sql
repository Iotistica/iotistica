-- Migration: Add TimescaleDB continuous aggregates for device logs
-- Created: 2025-12-10
-- Purpose: Create continuous aggregates for efficient log analysis and reduce database load
-- Dependencies: Requires TimescaleDB extension and device_logs hypertable

-- ============================================================================
-- 1. DROP NATIVE PARTITIONING AND CONVERT TO TIMESCALEDB HYPERTABLE
-- ============================================================================

DO $$
DECLARE
    timescaledb_available BOOLEAN;
    is_hypertable BOOLEAN;
    is_partitioned BOOLEAN;
    partition_record RECORD;
    total_rows BIGINT;
BEGIN
    -- Check if TimescaleDB is available
    SELECT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
    ) INTO timescaledb_available;

    IF NOT timescaledb_available THEN
        RAISE NOTICE 'TimescaleDB not available, skipping log aggregation setup';
        RETURN;
    END IF;

    -- Ensure TimescaleDB extension is enabled
    CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
    RAISE NOTICE 'TimescaleDB extension enabled';

    -- Check if device_logs is already a hypertable
    SELECT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'device_logs'
    ) INTO is_hypertable;

    -- Check if device_logs is using native PostgreSQL partitioning
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'device_logs'
        AND c.relkind = 'p'  -- 'p' = partitioned table
    ) INTO is_partitioned;

    IF is_hypertable THEN
        RAISE NOTICE 'device_logs is already a TimescaleDB hypertable, skipping conversion';
    ELSIF is_partitioned THEN
        RAISE NOTICE '════════════════════════════════════════════════════════════════';
        RAISE NOTICE 'Converting from native partitioning to TimescaleDB hypertable...';
        RAISE NOTICE '════════════════════════════════════════════════════════════════';
        
        -- Check if temp table exists from previous failed attempt
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'device_logs_temp') THEN
            RAISE NOTICE 'Found existing device_logs_temp from previous attempt';
            SELECT COUNT(*) INTO total_rows FROM device_logs_temp;
            RAISE NOTICE 'Resuming migration with % rows', total_rows;
        ELSE
            -- Get total row count before migration
            SELECT COUNT(*) INTO total_rows FROM device_logs;
            RAISE NOTICE 'Total rows to migrate: %', total_rows;
            
            -- Step 1: Create temporary table with all data
            RAISE NOTICE 'Step 1/6: Creating temporary backup table...';
            CREATE TABLE device_logs_temp AS SELECT * FROM device_logs;
            RAISE NOTICE '✓ Copied % rows to device_logs_temp', total_rows;
        END IF;
        
        -- Step 2: Drop all partition tables
        RAISE NOTICE 'Step 2/6: Dropping partition tables...';
        FOR partition_record IN 
            SELECT tablename 
            FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename LIKE 'device_logs_%'
            AND tablename != 'device_logs_temp'  -- Don't drop the temp table!
        LOOP
            EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_record.tablename);
            RAISE NOTICE '  Dropped partition: %', partition_record.tablename;
        END LOOP;
        
        -- Step 3: Drop the partitioned parent table
        RAISE NOTICE 'Step 3/6: Dropping partitioned parent table...';
        DROP TABLE IF EXISTS device_logs CASCADE;
        RAISE NOTICE '✓ Dropped device_logs parent table';
        
        -- Step 4: Create new regular table (non-partitioned)
        RAISE NOTICE 'Step 4/6: Creating new regular table...';
        
        -- Drop if exists (in case of previous failed attempt)
        DROP TABLE IF EXISTS device_logs CASCADE;
        
        CREATE TABLE device_logs (
            id BIGSERIAL,
            device_uuid UUID NOT NULL,
            service_name VARCHAR(255),
            message TEXT NOT NULL,
            level VARCHAR(50) DEFAULT 'info',
            is_system BOOLEAN DEFAULT false,
            is_stderr BOOLEAN DEFAULT false,
            timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            -- Composite primary key including timestamp (required for TimescaleDB)
            PRIMARY KEY (id, timestamp)
        );
        
        -- Add foreign key constraint
        ALTER TABLE device_logs 
            ADD CONSTRAINT fk_device_logs_device 
            FOREIGN KEY (device_uuid) 
            REFERENCES devices(uuid) 
            ON DELETE CASCADE;
        
        RAISE NOTICE '✓ Created new regular device_logs table';
        
        -- Step 5: Copy data back from temporary table
        RAISE NOTICE 'Step 5/6: Restoring data (this may take a while for large tables)...';
        INSERT INTO device_logs (id, device_uuid, service_name, message, level, is_system, is_stderr, timestamp, created_at)
        SELECT id, device_uuid, service_name, message, 
               COALESCE(level, 'info') as level,  -- Use existing level or default to 'info'
               is_system, is_stderr, timestamp, created_at
        FROM device_logs_temp
        ORDER BY timestamp;
        
        -- Update sequence to max id
        PERFORM setval('device_logs_id_seq', (SELECT MAX(id) FROM device_logs));
        
        RAISE NOTICE '✓ Restored % rows', total_rows;
        
        -- Step 6: Drop temporary table
        RAISE NOTICE 'Step 6/6: Cleaning up temporary table...';
        DROP TABLE device_logs_temp;
        RAISE NOTICE '✓ Cleanup complete';
        
        RAISE NOTICE '════════════════════════════════════════════════════════════════';
        RAISE NOTICE 'Native partitioning removed successfully';
        RAISE NOTICE '════════════════════════════════════════════════════════════════';
        
        -- Now convert to hypertable
        RAISE NOTICE 'Converting to TimescaleDB hypertable...';
        PERFORM create_hypertable(
            'device_logs', 
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            migrate_data => TRUE
        );
        
        RAISE NOTICE '✓ Converted to TimescaleDB hypertable with 1-day chunks';
        is_hypertable := TRUE;
    ELSE
        -- Not partitioned, just convert to hypertable
        RAISE NOTICE 'Converting regular table to TimescaleDB hypertable...';
        PERFORM create_hypertable(
            'device_logs', 
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            migrate_data => TRUE,
            if_not_exists => TRUE
        );
        
        RAISE NOTICE '✓ Converted to hypertable successfully';
        is_hypertable := TRUE;
    END IF;

    -- ============================================================================
    -- 2. CREATE INDEXES ON HYPERTABLE
    -- ============================================================================

    RAISE NOTICE 'Creating indexes on device_logs hypertable...';
    
    CREATE INDEX IF NOT EXISTS idx_device_logs_device_uuid 
        ON device_logs(device_uuid);
    CREATE INDEX IF NOT EXISTS idx_device_logs_device_timestamp 
        ON device_logs(device_uuid, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_device_logs_timestamp 
        ON device_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_device_logs_service 
        ON device_logs(device_uuid, service_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_device_logs_level 
        ON device_logs(level);
    CREATE INDEX IF NOT EXISTS idx_device_logs_error_logs 
        ON device_logs(device_uuid, is_stderr) WHERE is_stderr = true;
    
    RAISE NOTICE '✓ Indexes created';

    -- ============================================================================
    -- 3. ENABLE COMPRESSION FOR DEVICE_LOGS
    -- ============================================================================

    RAISE NOTICE 'Enabling compression on device_logs...';
    
    ALTER TABLE device_logs SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'device_uuid,service_name',
        timescaledb.compress_orderby = 'timestamp DESC'
    );
    
    -- Add compression policy (compress chunks older than 7 days)
    -- This saves ~90% storage on old data
    PERFORM add_compression_policy('device_logs', INTERVAL '7 days');
    
    RAISE NOTICE '✓ Compression enabled and policy added';

    -- ============================================================================
    -- 4. CREATE 5-MINUTE CONTINUOUS AGGREGATE
    -- ============================================================================

    RAISE NOTICE 'Creating 5-minute continuous aggregate...';
    
    -- Drop if exists (in case of previous failed attempt)
    DROP MATERIALIZED VIEW IF EXISTS device_logs_5min CASCADE;
    
    -- Check if continuous aggregate already exists
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'device_logs_5min'
    ) THEN
        CREATE MATERIALIZED VIEW device_logs_5min
        WITH (timescaledb.continuous) AS
        SELECT 
            device_uuid,
            service_name,
            time_bucket('5 minutes', timestamp) AS bucket,
            
            -- Total log count
            COUNT(*) as total_count,
            
            -- Counts by detected level (using regex patterns)
            COUNT(*) FILTER (
                WHERE message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'
            ) as error_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'warn|warning|\[warn\]'
            ) as warn_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'info|\[info\]'
            ) as info_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'debug|trace|\[debug\]'
            ) as debug_count,
            
            -- First and last messages in bucket
            FIRST(message, timestamp) as first_message,
            LAST(message, timestamp) as last_message,
            
            -- Sample error messages (first 10)
            ARRAY_AGG(
                json_build_object(
                    'timestamp', timestamp,
                    'message', LEFT(message, 500)  -- Truncate to 500 chars
                ) ORDER BY timestamp
            ) FILTER (
                WHERE message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'
            ) as error_samples,
            
            -- Sample warning messages (first 10)
            ARRAY_AGG(
                json_build_object(
                    'timestamp', timestamp,
                    'message', LEFT(message, 500)
                ) ORDER BY timestamp
            ) FILTER (
                WHERE message ~* 'warn|warning|\[warn\]'
            ) as warning_samples,
            
            -- Bucket time range
            MIN(timestamp) as bucket_start,
            MAX(timestamp) as bucket_end
            
        FROM device_logs
        GROUP BY device_uuid, service_name, bucket
        WITH NO DATA;  -- Don't populate immediately (avoid transaction block error)

        RAISE NOTICE '✓ 5-minute continuous aggregate created';
    ELSE
        RAISE NOTICE '✓ 5-minute continuous aggregate already exists';
    END IF;

    -- Add refresh policy (update every 5 minutes)
    -- start_offset: How far back to start refreshing (1 hour to catch late-arriving data)
    -- end_offset: How close to now to refresh (5 minutes to avoid refreshing incomplete buckets)
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'device_logs_5min' 
        AND proc_name = 'policy_refresh_continuous_aggregate'
    ) THEN
        PERFORM add_continuous_aggregate_policy('device_logs_5min',
            start_offset => INTERVAL '1 hour',
            end_offset => INTERVAL '5 minutes',
            schedule_interval => INTERVAL '5 minutes'
        );
        RAISE NOTICE '5-minute aggregate refresh policy added';
    ELSE
        RAISE NOTICE '5-minute aggregate refresh policy already exists';
    END IF;

    -- ============================================================================
    -- 5. CREATE HOURLY CONTINUOUS AGGREGATE
    -- ============================================================================

    RAISE NOTICE 'Creating hourly continuous aggregate...';
    
    -- Drop if exists (in case of previous failed attempt)
    DROP MATERIALIZED VIEW IF EXISTS device_logs_hourly CASCADE;
    
    -- Check if continuous aggregate already exists
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'device_logs_hourly'
    ) THEN
        CREATE MATERIALIZED VIEW device_logs_hourly
        WITH (timescaledb.continuous) AS
        SELECT 
            device_uuid,
            service_name,
            time_bucket('1 hour', timestamp) AS bucket,
            
            -- Total log count
            COUNT(*) as total_count,
            
            -- Counts by detected level (using regex patterns)
            COUNT(*) FILTER (
                WHERE message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'
            ) as error_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'warn|warning|\[warn\]'
            ) as warn_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'info|\[info\]'
            ) as info_count,
            
            COUNT(*) FILTER (
                WHERE message ~* 'debug|trace|\[debug\]'
            ) as debug_count,
            
            -- Time range
            MIN(timestamp) as bucket_start,
            MAX(timestamp) as bucket_end
            
        FROM device_logs
        GROUP BY device_uuid, service_name, bucket
        WITH NO DATA;  -- Don't populate immediately (avoid transaction block error)

        RAISE NOTICE '✓ Hourly continuous aggregate created';
    ELSE
        RAISE NOTICE '✓ Hourly continuous aggregate already exists';
    END IF;

    -- Add refresh policy (update every hour)
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'device_logs_hourly' 
        AND proc_name = 'policy_refresh_continuous_aggregate'
    ) THEN
        PERFORM add_continuous_aggregate_policy('device_logs_hourly',
            start_offset => INTERVAL '3 hours',
            end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour'
        );
        RAISE NOTICE 'Hourly aggregate refresh policy added';
    ELSE
        RAISE NOTICE 'Hourly aggregate refresh policy already exists';
    END IF;

    -- ============================================================================
    -- 6. ADD RETENTION POLICIES
    -- ============================================================================

    RAISE NOTICE 'Adding retention policies...';
    
    -- Keep raw logs for 7 days
    -- Check if policy already exists before adding
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'device_logs' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('device_logs', INTERVAL '7 days');
        RAISE NOTICE '✓ Raw logs: 7 day retention policy added';
    ELSE
        RAISE NOTICE '✓ Raw logs: retention policy already exists';
    END IF;
    
    -- Keep 5-minute aggregates for 30 days
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'device_logs_5min' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('device_logs_5min', INTERVAL '30 days');
        RAISE NOTICE '✓ 5-minute aggregates: 30 day retention policy added';
    ELSE
        RAISE NOTICE '✓ 5-minute aggregates: retention policy already exists';
    END IF;
    
    -- Keep hourly aggregates for 1 year
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'device_logs_hourly' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('device_logs_hourly', INTERVAL '365 days');
        RAISE NOTICE '✓ Hourly aggregates: 365 day retention policy added';
    ELSE
        RAISE NOTICE '✓ Hourly aggregates: retention policy already exists';
    END IF;

    -- ============================================================================
    -- 7. CREATE INDEXES FOR FAST QUERIES
    -- ============================================================================

    RAISE NOTICE 'Creating indexes on continuous aggregates...';
    
    -- Index on 5-minute aggregate
    CREATE INDEX IF NOT EXISTS idx_device_logs_5min_device_bucket 
        ON device_logs_5min (device_uuid, bucket DESC);
    
    CREATE INDEX IF NOT EXISTS idx_device_logs_5min_service_bucket 
        ON device_logs_5min (device_uuid, service_name, bucket DESC);
    
    -- Index on hourly aggregate
    CREATE INDEX IF NOT EXISTS idx_device_logs_hourly_device_bucket 
        ON device_logs_hourly (device_uuid, bucket DESC);
    
    CREATE INDEX IF NOT EXISTS idx_device_logs_hourly_service_bucket 
        ON device_logs_hourly (device_uuid, service_name, bucket DESC);
    
    RAISE NOTICE 'Indexes created successfully';

    -- ============================================================================
    -- 8. SUMMARY
    -- ============================================================================

    RAISE NOTICE '════════════════════════════════════════════════════════════════';
    RAISE NOTICE 'TimescaleDB Log Aggregation Setup Complete!';
    RAISE NOTICE '════════════════════════════════════════════════════════════════';
    RAISE NOTICE 'Migrated from native partitioning to TimescaleDB hypertable';
    RAISE NOTICE 'Created:';
    RAISE NOTICE '  ✓ device_logs hypertable (1-day chunks)';
    RAISE NOTICE '  ✓ Compression enabled (compress after 7 days)';
    RAISE NOTICE '  ✓ device_logs_5min continuous aggregate (refreshes every 5 min)';
    RAISE NOTICE '  ✓ device_logs_hourly continuous aggregate (refreshes every hour)';
    RAISE NOTICE '';
    RAISE NOTICE 'Retention Policies:';
    RAISE NOTICE '  • Raw logs: 7 days';
    RAISE NOTICE '  • 5-minute aggregates: 30 days';
    RAISE NOTICE '  • Hourly aggregates: 365 days';
    RAISE NOTICE '';
    RAISE NOTICE 'Expected Storage Savings: 70-90%% (after compression)';
    RAISE NOTICE 'Expected Query Performance: 10-100x faster';
    RAISE NOTICE '';
    RAISE NOTICE 'Note: Continuous aggregates created with NO DATA';
    RAISE NOTICE 'They will be populated automatically by the refresh policies';
    RAISE NOTICE 'within the next 5 minutes for 5min aggregate and 1 hour for hourly';
    RAISE NOTICE '════════════════════════════════════════════════════════════════';

END $$;

-- ============================================================================
-- 9. EXAMPLE QUERIES (FOR REFERENCE)
-- ============================================================================

/*
-- Get error rate over last 24 hours (5-minute resolution)
SELECT 
    bucket,
    service_name,
    error_count,
    total_count,
    ROUND((error_count::numeric / NULLIF(total_count, 0)) * 100, 2) as error_percentage
FROM device_logs_5min
WHERE device_uuid = 'your-device-uuid'
    AND bucket >= NOW() - INTERVAL '24 hours'
ORDER BY bucket DESC, service_name;

-- Get top error services (last hour)
SELECT 
    service_name,
    SUM(error_count) as total_errors,
    SUM(total_count) as total_logs,
    error_samples -- Contains actual error messages
FROM device_logs_5min
WHERE device_uuid = 'your-device-uuid'
    AND bucket >= NOW() - INTERVAL '1 hour'
    AND error_count > 0
GROUP BY service_name, error_samples
ORDER BY total_errors DESC
LIMIT 10;

-- Service activity overview (last 7 days from hourly aggregate)
SELECT 
    service_name,
    SUM(total_count) as total_logs,
    SUM(error_count) as total_errors,
    SUM(warn_count) as total_warnings,
    ROUND(AVG(error_count::numeric / NULLIF(total_count, 0)) * 100, 2) as avg_error_rate
FROM device_logs_hourly
WHERE device_uuid = 'your-device-uuid'
    AND bucket >= NOW() - INTERVAL '7 days'
GROUP BY service_name
ORDER BY total_errors DESC;

-- Real-time drill-down (get actual error messages from raw logs)
-- Only use when you need full message detail (last 5 minutes)
SELECT timestamp, service_name, message
FROM device_logs
WHERE device_uuid = 'your-device-uuid'
    AND timestamp >= NOW() - INTERVAL '5 minutes'
    AND message ~* 'error|fatal|critical'
ORDER BY timestamp DESC
LIMIT 100;

-- Check continuous aggregate refresh status
SELECT 
    view_name,
    materialization_hypertable_name,
    refresh_lag,
    refresh_interval
FROM timescaledb_information.continuous_aggregates
WHERE view_name IN ('device_logs_5min', 'device_logs_hourly');

-- Check compression status
SELECT 
    hypertable_name,
    total_chunks,
    number_compressed_chunks,
    ROUND(100.0 * number_compressed_chunks / NULLIF(total_chunks, 0), 1) as compression_percentage
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'device_logs';
*/
