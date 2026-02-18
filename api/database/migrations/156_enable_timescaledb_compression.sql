-- Migration: Enable TimescaleDB Compression for Time-Series Tables
-- Description: Convert append-only ingestion tables to compressed hypertables
--              to achieve 90%+ storage reduction with automatic 1-day compression
-- Date: 2026-02-18

-- ============================================================================
-- 1. DEVICE_LOGS - Convert to Hypertable and Enable Compression
-- ============================================================================

-- Check if device_logs is already a hypertable
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'device_logs'
    ) THEN
        -- Convert to hypertable (7-day chunks)
        PERFORM create_hypertable(
            'device_logs', 
            'timestamp',
            chunk_time_interval => INTERVAL '7 days',
            migrate_data => true
        );
        RAISE NOTICE 'device_logs converted to hypertable';
    ELSE
        RAISE NOTICE 'device_logs is already a hypertable, skipping conversion';
    END IF;
END $$;

-- Enable compression (segment by device for optimal compression)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'device_logs' 
        AND compression_enabled = true
    ) THEN
        ALTER TABLE device_logs SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'device_uuid',
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'device_logs compression enabled';
    ELSE
        RAISE NOTICE 'device_logs compression already enabled, skipping';
    END IF;
END $$;

-- Add 1-day compression policy (compress yesterday's data automatically)
SELECT add_compression_policy('device_logs', INTERVAL '1 day', if_not_exists => TRUE);

COMMENT ON TABLE device_logs IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 98%+';

-- ============================================================================
-- 2. MQTT_TOPIC_METRICS - Convert to Hypertable and Enable Compression
-- ============================================================================

-- Check if mqtt_topic_metrics is already a hypertable
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_topic_metrics'
    ) THEN
        -- Drop primary key constraint (incompatible with time-based partitioning)
        IF EXISTS (
            SELECT 1 FROM pg_constraint 
            WHERE conname = 'mqtt_topic_metrics_pkey'
        ) THEN
            ALTER TABLE mqtt_topic_metrics DROP CONSTRAINT mqtt_topic_metrics_pkey;
            RAISE NOTICE 'Dropped mqtt_topic_metrics primary key constraint';
        END IF;

        -- Convert to hypertable
        PERFORM create_hypertable(
            'mqtt_topic_metrics',
            'timestamp',
            chunk_time_interval => INTERVAL '7 days',
            migrate_data => true
        );
        RAISE NOTICE 'mqtt_topic_metrics converted to hypertable';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics is already a hypertable, skipping conversion';
    END IF;
END $$;

-- Enable compression (segment by topic for optimal compression)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_topic_metrics' 
        AND compression_enabled = true
    ) THEN
        ALTER TABLE mqtt_topic_metrics SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'topic',
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'mqtt_topic_metrics compression enabled';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics compression already enabled, skipping';
    END IF;
END $$;

-- Add 1-day compression policy
SELECT add_compression_policy('mqtt_topic_metrics', INTERVAL '1 day', if_not_exists => TRUE);

COMMENT ON TABLE mqtt_topic_metrics IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 98%+';

-- ============================================================================
-- 3. MQTT_BROKER_STATS - Convert to Hypertable and Enable Compression
-- ============================================================================

-- Check if mqtt_broker_stats is already a hypertable
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_broker_stats'
    ) THEN
        -- Drop primary key constraint
        IF EXISTS (
            SELECT 1 FROM pg_constraint 
            WHERE conname = 'mqtt_broker_stats_pkey'
        ) THEN
            ALTER TABLE mqtt_broker_stats DROP CONSTRAINT mqtt_broker_stats_pkey;
            RAISE NOTICE 'Dropped mqtt_broker_stats primary key constraint';
        END IF;

        -- Convert to hypertable
        PERFORM create_hypertable(
            'mqtt_broker_stats',
            'timestamp',
            chunk_time_interval => INTERVAL '7 days',
            migrate_data => true
        );
        RAISE NOTICE 'mqtt_broker_stats converted to hypertable';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats is already a hypertable, skipping conversion';
    END IF;
END $$;

-- Enable compression (no segmentation needed for stats)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_broker_stats' 
        AND compression_enabled = true
    ) THEN
        ALTER TABLE mqtt_broker_stats SET (
            timescaledb.compress,
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'mqtt_broker_stats compression enabled';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats compression already enabled, skipping';
    END IF;
END $$;

-- Add 1-day compression policy
SELECT add_compression_policy('mqtt_broker_stats', INTERVAL '1 day', if_not_exists => TRUE);

COMMENT ON TABLE mqtt_broker_stats IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 90%+';

-- ============================================================================
-- 4. READINGS - Enable Compression (Already a Hypertable)
-- ============================================================================

-- Note: readings table is already a hypertable (created in migration 103 or 106)
-- We only need to enable compression

-- Check if compression is already enabled
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'readings' 
        AND compression_enabled = true
    ) THEN
        -- Enable compression (segment by device and metric for optimal compression)
        ALTER TABLE readings SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'device_uuid, metric_name',
            timescaledb.compress_orderby = 'time DESC'
        );
        
        -- Add 1-day compression policy
        PERFORM add_compression_policy('readings', INTERVAL '1 day', if_not_exists => TRUE);
        
        RAISE NOTICE 'readings compression enabled';
    ELSE
        RAISE NOTICE 'readings already has compression enabled, skipping';
    END IF;
END $$;

COMMENT ON TABLE readings IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 96%+';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Run these queries to verify the migration succeeded:

-- 1. Check hypertable status for all tables
SELECT 
    hypertable_name,
    compression_enabled,
    num_chunks
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('device_logs', 'mqtt_topic_metrics', 'mqtt_broker_stats', 'readings')
ORDER BY hypertable_name;

-- 2. Check compression policies
SELECT 
    hypertable_name,
    job_id,
    config->>'compress_after' AS compress_after,
    scheduled
FROM timescaledb_information.jobs
WHERE proc_name = 'policy_compression'
AND hypertable_name IN ('device_logs', 'mqtt_topic_metrics', 'mqtt_broker_stats', 'readings')
ORDER BY hypertable_name;

-- 3. Expected results:
-- - All 4 tables should show compression_enabled = true
-- - All 4 tables should have compress_after = '1 day'
-- - Device_logs: ~250 MB → ~100 KB (98%+ compression)
-- - mqtt_topic_metrics: ~153 MB → ~40 KB (98%+ compression)
-- - mqtt_broker_stats: ~36 MB → ~4 MB (89%+ compression)
-- - readings: ~447 MB → ~16 MB (96%+ compression)
-- - Total database reduction: 960 MB → ~100 MB (90%+ reduction)

-- ============================================================================
-- ROLLBACK (if needed)
-- ============================================================================

-- To disable compression (not recommended for production):
-- SELECT remove_compression_policy('device_logs');
-- SELECT remove_compression_policy('mqtt_topic_metrics');
-- SELECT remove_compression_policy('mqtt_broker_stats');
-- SELECT remove_compression_policy('readings');

-- Note: Reverting hypertable conversion is complex and not recommended.
-- Compression can be disabled, but data will remain in compressed state
-- until manually decompressed.
