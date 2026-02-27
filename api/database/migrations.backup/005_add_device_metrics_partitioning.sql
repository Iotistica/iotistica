-- Migration: Add Partitioning to device_metrics
-- This converts the existing device_metrics table to use range partitioning by date

BEGIN;

-- Step 1: Rename existing table (backup)
ALTER TABLE device_metrics RENAME TO device_metrics_old;

-- Step 2: Create partitioned table
CREATE TABLE device_metrics (
    id BIGSERIAL,
    device_uuid UUID NOT NULL,
    cpu_usage NUMERIC,
    cpu_temp NUMERIC,
    memory_usage BIGINT,
    memory_total BIGINT,
    storage_usage BIGINT,
    storage_total BIGINT,
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Step 3: Create indexes on partitioned table (IF NOT EXISTS for safety)
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_uuid ON device_metrics(device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_recorded ON device_metrics(device_uuid, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_metrics_recorded_at ON device_metrics(recorded_at DESC);

-- Step 4: Create partition management functions

-- Function to create a partition for a specific date
CREATE OR REPLACE FUNCTION create_device_metrics_partition(
    partition_date DATE
) RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    partition_name := 'device_metrics_' || TO_CHAR(partition_date, 'YYYY_MM_DD');
    start_date := partition_date;
    end_date := partition_date + INTERVAL '1 day';
    
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
        'CREATE TABLE %I PARTITION OF device_metrics 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$ LANGUAGE plpgsql;

-- Function to create partitions for a date range
CREATE OR REPLACE FUNCTION create_device_metrics_partitions_range(
    start_days_ago INTEGER,
    end_days_ahead INTEGER
) RETURNS TABLE(result TEXT) AS $$
DECLARE
    current_day DATE;
    i INTEGER;
BEGIN
    FOR i IN start_days_ago..end_days_ahead LOOP
        current_day := CURRENT_DATE + (i || ' days')::INTERVAL;
        RETURN QUERY SELECT create_device_metrics_partition(current_day);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to drop old partitions based on retention policy
CREATE OR REPLACE FUNCTION drop_old_device_metrics_partitions(
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
        AND tablename LIKE 'device_metrics_%'
        AND tablename ~ '^device_metrics_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    LOOP
        BEGIN
            -- Extract date from partition name (device_metrics_YYYY_MM_DD)
            partition_date_str := SUBSTRING(partition_record.tablename FROM 'device_metrics_(.*)');
            partition_date := TO_DATE(partition_date_str, 'YYYY_MM_DD');
            
            IF partition_date < cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_record.tablename);
                RETURN QUERY SELECT 'DROPPED: ' || partition_record.tablename;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT 'ERROR: ' || partition_record.tablename || ' - ' || SQLERRM;
        END;
    END LOOP;
    
    -- Return count if no partitions dropped
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'No old partitions to drop (retention: ' || retention_days || ' days)';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to get partition statistics
CREATE OR REPLACE FUNCTION get_device_metrics_partition_stats()
RETURNS TABLE(
    partition_name TEXT,
    partition_date DATE,
    row_count BIGINT,
    size TEXT,
    age_days INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pt.tablename::TEXT as partition_name,
        TO_DATE(SUBSTRING(pt.tablename FROM 'device_metrics_(.*)'), 'YYYY_MM_DD') as partition_date,
        COALESCE((
            SELECT n_live_tup 
            FROM pg_stat_user_tables 
            WHERE schemaname = 'public' 
            AND relname = pt.tablename
        ), 0) as row_count,
        pg_size_pretty(pg_total_relation_size('public.' || pt.tablename)) as size,
        (CURRENT_DATE - TO_DATE(SUBSTRING(pt.tablename FROM 'device_metrics_(.*)'), 'YYYY_MM_DD'))::INTEGER as age_days
    FROM pg_tables pt
    WHERE pt.schemaname = 'public'
    AND pt.tablename LIKE 'device_metrics_%'
    AND pt.tablename ~ '^device_metrics_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    ORDER BY partition_date DESC;
END;
$$ LANGUAGE plpgsql;

-- Step 5: Create initial partitions (30 days back + 7 days forward)
SELECT create_device_metrics_partitions_range(-30, 7);

-- Step 6: Migrate existing data
DO $$
DECLARE
    row_count INTEGER;
BEGIN
    -- Check if old table has data
    SELECT COUNT(*) INTO row_count FROM device_metrics_old;
    
    IF row_count > 0 THEN
        RAISE NOTICE 'Migrating % rows from device_metrics_old...', row_count;
        
        -- Insert data (will automatically go to correct partition)
        INSERT INTO device_metrics (
            id, device_uuid, cpu_usage, cpu_temp, 
            memory_usage, memory_total, storage_usage, storage_total, recorded_at
        )
        SELECT 
            id, device_uuid, cpu_usage, cpu_temp,
            memory_usage, memory_total, storage_usage, storage_total, recorded_at
        FROM device_metrics_old;
        
        RAISE NOTICE 'Migration complete!';
    ELSE
        RAISE NOTICE 'No data to migrate';
    END IF;
END $$;

-- Step 7: Drop old table
DROP TABLE IF EXISTS device_metrics_old;

-- Step 8: Reset sequence to continue from max ID
-- The new BIGSERIAL creates a sequence automatically
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

COMMIT;

-- Display partition info
SELECT * FROM get_device_metrics_partition_stats();
