-- Migration: Add Partitioning to device_logs
-- This converts the existing device_logs table to use range partitioning by timestamp (monthly)
-- Also adds automatic partition management and retention policy functions

BEGIN;

-- Step 1: Check if table is already partitioned, skip table conversion if so
DO $$
DECLARE
    is_partitioned BOOLEAN;
BEGIN
    -- Check if device_logs is already a partitioned table
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'device_logs'
        AND c.relkind = 'p'  -- 'p' = partitioned table
    ) INTO is_partitioned;
    
    IF is_partitioned THEN
        RAISE NOTICE '✅ device_logs is already partitioned, skipping table conversion';
    ELSE
        RAISE NOTICE '🔄 Converting device_logs to partitioned table...';
        
        -- Step 2: Rename existing table (backup)
        EXECUTE 'ALTER TABLE device_logs RENAME TO device_logs_old';
        
        -- Step 3: Create partitioned table
        CREATE TABLE device_logs (
            id BIGSERIAL,
            device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
            service_name VARCHAR(255),  -- Service/container name
            message TEXT NOT NULL,
            is_system BOOLEAN DEFAULT false,
            is_stderr BOOLEAN DEFAULT false,
            timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id, timestamp)
        ) PARTITION BY RANGE (timestamp);
        
        RAISE NOTICE '✅ Created partitioned device_logs table';
    END IF;
END $$;

-- Step 4: Create indexes on partitioned table (will be inherited by partitions)
CREATE INDEX IF NOT EXISTS idx_device_logs_device_uuid ON device_logs(device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_logs_device_timestamp ON device_logs(device_uuid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_timestamp ON device_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_service ON device_logs(device_uuid, service_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_error_logs ON device_logs(device_uuid, is_stderr) WHERE is_stderr = true;

-- Step 5: Add table comments
COMMENT ON TABLE device_logs IS 'Container and system logs streamed from devices (partitioned by month)';
COMMENT ON COLUMN device_logs.service_name IS 'Service/container name that generated the log';
COMMENT ON COLUMN device_logs.is_system IS 'True if this is a system log (not from a container)';
COMMENT ON COLUMN device_logs.is_stderr IS 'True if log came from stderr stream';

-- Step 6: Create partition management functions

-- Function to create a partition for a specific month
CREATE OR REPLACE FUNCTION create_device_logs_partition(
    partition_date DATE
) RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    -- Use first day of month for partition boundaries
    start_date := DATE_TRUNC('month', partition_date)::DATE;
    end_date := (DATE_TRUNC('month', partition_date) + INTERVAL '1 month')::DATE;
    partition_name := 'device_logs_' || TO_CHAR(start_date, 'YYYY_MM');
    
    -- Check if partition already exists
    IF EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public'
        AND tablename = partition_name
    ) THEN
        RETURN 'EXISTS: ' || partition_name;
    END IF;
    
    -- Create the partition
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF device_logs 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$ LANGUAGE plpgsql;

-- Function to create partitions for a month range
CREATE OR REPLACE FUNCTION create_device_logs_partitions_range(
    start_months_ago INTEGER,
    end_months_ahead INTEGER
) RETURNS TABLE(result TEXT) AS $$
DECLARE
    current_month DATE;
    i INTEGER;
BEGIN
    FOR i IN start_months_ago..end_months_ahead LOOP
        current_month := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL)::DATE;
        RETURN QUERY SELECT create_device_logs_partition(current_month);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to drop old partitions based on retention policy
CREATE OR REPLACE FUNCTION drop_old_device_logs_partitions(
    retention_days INTEGER DEFAULT 30
) RETURNS TABLE(result TEXT) AS $$
DECLARE
    partition_record RECORD;
    cutoff_date DATE;
    partition_date DATE;
    partition_date_str TEXT;
BEGIN
    cutoff_date := CURRENT_DATE - retention_days;
    
    FOR partition_record IN
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'device_logs_%'
        AND tablename ~ '^device_logs_[0-9]{4}_[0-9]{2}$'
    LOOP
        BEGIN
            -- Extract date from partition name (device_logs_YYYY_MM)
            partition_date_str := SUBSTRING(partition_record.tablename FROM 'device_logs_(.*)');
            partition_date := TO_DATE(partition_date_str || '_01', 'YYYY_MM_DD');
            
            IF partition_date < DATE_TRUNC('month', cutoff_date)::DATE THEN
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_record.tablename);
                RETURN QUERY SELECT 'DROPPED: ' || partition_record.tablename;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT 'ERROR: ' || partition_record.tablename || ' - ' || SQLERRM;
        END;
    END LOOP;
    
    -- Return message if no partitions dropped
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'No old partitions to drop (retention: ' || retention_days || ' days)';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to get partition statistics
CREATE OR REPLACE FUNCTION get_device_logs_partition_stats()
RETURNS TABLE(
    partition_name TEXT,
    partition_month DATE,
    row_count BIGINT,
    size TEXT,
    age_days INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pt.tablename::TEXT as partition_name,
        TO_DATE(SUBSTRING(pt.tablename FROM 'device_logs_(.*)') || '_01', 'YYYY_MM_DD') as partition_month,
        COALESCE((
            SELECT n_live_tup 
            FROM pg_stat_user_tables 
            WHERE schemaname = 'public' 
            AND relname = pt.tablename
        ), 0) as row_count,
        pg_size_pretty(pg_total_relation_size('public.' || pt.tablename)) as size,
        (CURRENT_DATE - TO_DATE(SUBSTRING(pt.tablename FROM 'device_logs_(.*)') || '_01', 'YYYY_MM_DD'))::INTEGER as age_days
    FROM pg_tables pt
    WHERE pt.schemaname = 'public'
    AND pt.tablename LIKE 'device_logs_%'
    AND pt.tablename ~ '^device_logs_[0-9]{4}_[0-9]{2}$'
    ORDER BY partition_month DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to auto-create future partitions (run monthly)
CREATE OR REPLACE FUNCTION ensure_device_logs_partitions()
RETURNS TABLE(result TEXT) AS $$
BEGIN
    -- Create partitions for current month + next 3 months
    RETURN QUERY SELECT * FROM create_device_logs_partitions_range(0, 3);
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create initial partitions (6 months back + 3 months forward for safety)
SELECT create_device_logs_partitions_range(-6, 3);

-- Step 8: Migrate existing data (only if old table exists)
DO $$
DECLARE
    row_count BIGINT;
    old_table_exists BOOLEAN;
BEGIN
    -- Check if old table exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'device_logs_old'
    ) INTO old_table_exists;
    
    IF NOT old_table_exists THEN
        RAISE NOTICE '⏭️  No device_logs_old table found, skipping data migration';
        RETURN;
    END IF;
    
    -- Check if old table has data
    EXECUTE 'SELECT COUNT(*) FROM device_logs_old' INTO row_count;
    
    IF row_count > 0 THEN
        RAISE NOTICE '🔄 Migrating % rows from device_logs_old...', row_count;
        
        -- Insert data (will automatically go to correct partition)
        INSERT INTO device_logs (
            id, device_uuid, service_name, message, 
            is_system, is_stderr, timestamp, created_at
        )
        SELECT 
            id, 
            device_uuid, 
            COALESCE(container_name, service_name) as service_name,
            message,
            false as is_system,  -- Assume old logs are not system logs
            CASE 
                WHEN stream = 'stderr' THEN true 
                WHEN is_stderr IS NOT NULL THEN is_stderr
                ELSE false 
            END as is_stderr,
            timestamp,
            created_at
        FROM device_logs_old;
        
        RAISE NOTICE '✅ Migration complete! Migrated % rows', row_count;
    ELSE
        RAISE NOTICE '⏭️  No data to migrate from device_logs_old';
    END IF;
END $$;

-- Step 9: Drop old table (only if it exists)
DROP TABLE IF EXISTS device_logs_old CASCADE;

-- Step 10: Reset sequence to continue from max ID
DO $$
DECLARE
    max_id BIGINT;
    seq_name TEXT;
BEGIN
    -- Get the sequence name created by BIGSERIAL
    SELECT pg_get_serial_sequence('device_logs', 'id') INTO seq_name;
    
    IF seq_name IS NOT NULL THEN
        SELECT COALESCE(MAX(id), 0) INTO max_id FROM device_logs;
        IF max_id > 0 THEN
            EXECUTE format('SELECT setval(%L, %s, true)', seq_name, max_id);
            RAISE NOTICE 'Sequence % reset to %', seq_name, max_id;
        END IF;
    END IF;
END $$;

COMMIT;

-- Display partition info
SELECT * FROM get_device_logs_partition_stats();

-- Show example usage
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== Device Logs Partitioning Successfully Applied ===';
    RAISE NOTICE '';
    RAISE NOTICE 'Partition Management Functions:';
    RAISE NOTICE '  - SELECT * FROM create_device_logs_partition(''2025-12-01'');';
    RAISE NOTICE '  - SELECT * FROM create_device_logs_partitions_range(0, 12);  -- Create next 12 months';
    RAISE NOTICE '  - SELECT * FROM drop_old_device_logs_partitions(30);  -- Drop logs older than 30 days';
    RAISE NOTICE '  - SELECT * FROM get_device_logs_partition_stats();  -- View partition info';
    RAISE NOTICE '  - SELECT * FROM ensure_device_logs_partitions();  -- Auto-create future partitions';
    RAISE NOTICE '';
    RAISE NOTICE 'Recommended: Schedule ensure_device_logs_partitions() to run monthly';
    RAISE NOTICE 'Recommended: Schedule drop_old_device_logs_partitions(30) to run daily';
    RAISE NOTICE '';
END $$;
