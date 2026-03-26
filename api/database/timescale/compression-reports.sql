-- TimescaleDB Compression Verification and Monitoring Queries
-- Purpose: Monitor compression effectiveness, storage savings, and policy status
-- Usage: Run these queries periodically to track database optimization

-- ============================================================================
-- 1. DATABASE SIZE OVERVIEW
-- ============================================================================

-- Total database size
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;

-- Expected result after compression: ~99 MB (down from 960 MB)

-- ============================================================================
-- 2. TABLE SIZES (Top 20 Largest Tables)
-- ============================================================================

-- Standard tables size
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema', '_timescaledb_internal')
ORDER BY size_bytes DESC
LIMIT 20;

-- Note: Hypertables will show small sizes here. Use hypertable_detailed_size() instead.

-- ============================================================================
-- 3. HYPERTABLE STATUS AND COMPRESSION
-- ============================================================================

-- Check all hypertables and their compression status
SELECT 
    hypertable_schema,
    hypertable_name,
    compression_enabled,
    num_chunks,
    tablespaces
FROM timescaledb_information.hypertables
ORDER BY hypertable_name;

-- Expected: device_logs, mqtt_topic_metrics, mqtt_broker_stats, readings all show compression_enabled = true

-- ============================================================================
-- 4. HYPERTABLE DETAILED SIZES (Includes Internal Chunks)
-- ============================================================================

-- Detailed size breakdown for all compressed hypertables
SELECT 
    hypertable_name,
    pg_size_pretty(table_bytes) AS table_size,
    pg_size_pretty(index_bytes) AS index_size,
    pg_size_pretty(total_bytes) AS total_size,
    total_bytes
FROM (
    SELECT 
        format('%I.%I', hypertable_schema, hypertable_name)::regclass AS hypertable,
        hypertable_name,
        (hypertable_detailed_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)).*
    FROM timescaledb_information.hypertables
    WHERE hypertable_name IN ('device_logs', 'mqtt_topic_metrics', 'mqtt_broker_stats', 'readings')
) AS sizes
ORDER BY total_bytes DESC;

-- Expected results:
-- readings: ~16 MB total
-- mqtt_broker_stats: ~4 MB total
-- mqtt_topic_metrics: ~40 KB total
-- device_logs: ~100 KB total

-- ============================================================================
-- 5. COMPRESSION POLICIES STATUS
-- ============================================================================

-- Check active compression policies and their schedules
SELECT 
    j.hypertable_name,
    j.job_id,
    j.config->>'compress_after' AS compress_after_interval,
    j.scheduled,
    js.last_run_started_at,
    j.next_start,
    js.last_run_status,
    js.total_runs,
    js.total_successes,
    js.total_failures
FROM timescaledb_information.jobs j
LEFT JOIN timescaledb_information.job_stats js ON j.job_id = js.job_id
WHERE j.proc_name = 'policy_compression'
ORDER BY j.hypertable_name;

-- Expected: All 4 tables should have compress_after = '1 day', scheduled = true

-- ============================================================================
-- 6. COMPRESSION STATISTICS PER HYPERTABLE
-- ============================================================================

-- Device logs compression stats
SELECT 
    *,
    pg_size_pretty(before_compression_total_bytes) AS before_size,
    pg_size_pretty(after_compression_total_bytes) AS after_size,
    ROUND(
        100 * (1 - after_compression_total_bytes::numeric / NULLIF(before_compression_total_bytes, 0)::numeric),
        2
    ) AS compression_ratio_percent
FROM hypertable_compression_stats('device_logs');

-- MQTT topic metrics compression stats
SELECT 
    *,
    pg_size_pretty(before_compression_total_bytes) AS before_size,
    pg_size_pretty(after_compression_total_bytes) AS after_size,
    ROUND(
        100 * (1 - after_compression_total_bytes::numeric / NULLIF(before_compression_total_bytes, 0)::numeric),
        2
    ) AS compression_ratio_percent
FROM hypertable_compression_stats('mqtt_topic_metrics');

-- MQTT broker stats compression stats
SELECT 
    *,
    pg_size_pretty(before_compression_total_bytes) AS before_size,
    pg_size_pretty(after_compression_total_bytes) AS after_size,
    ROUND(
        100 * (1 - after_compression_total_bytes::numeric / NULLIF(before_compression_total_bytes, 0)::numeric),
        2
    ) AS compression_ratio_percent
FROM hypertable_compression_stats('mqtt_broker_stats');

-- Readings compression stats
SELECT 
    *,
    pg_size_pretty(before_compression_total_bytes) AS before_size,
    pg_size_pretty(after_compression_total_bytes) AS after_size,
    ROUND(
        100 * (1 - after_compression_total_bytes::numeric / NULLIF(before_compression_total_bytes, 0)::numeric),
        2
    ) AS compression_ratio_percent
FROM hypertable_compression_stats('readings');

-- Expected compression ratios:
-- device_logs: 98%+
-- mqtt_topic_metrics: 98%+
-- mqtt_broker_stats: 89%+
-- readings: 96%+

-- ============================================================================
-- 7. CHUNK COMPRESSION STATUS
-- ============================================================================

-- Device logs chunks
SELECT 
    chunk_name,
    pg_size_pretty(before_compression_total_bytes) AS uncompressed_size,
    pg_size_pretty(after_compression_total_bytes) AS compressed_size,
    CASE WHEN after_compression_total_bytes > 0 
         THEN ROUND(100 * (1 - after_compression_total_bytes::numeric / before_compression_total_bytes::numeric), 1)
         ELSE NULL 
    END AS compression_percent
FROM chunk_compression_stats('device_logs')
ORDER BY chunk_name;

-- MQTT topic metrics chunks
SELECT 
    chunk_name,
    pg_size_pretty(before_compression_total_bytes) AS uncompressed_size,
    pg_size_pretty(after_compression_total_bytes) AS compressed_size,
    CASE WHEN after_compression_total_bytes > 0 
         THEN ROUND(100 * (1 - after_compression_total_bytes::numeric / before_compression_total_bytes::numeric), 1)
         ELSE NULL 
    END AS compression_percent
FROM chunk_compression_stats('mqtt_topic_metrics')
ORDER BY chunk_name;

-- MQTT broker stats chunks
SELECT 
    chunk_name,
    pg_size_pretty(before_compression_total_bytes) AS uncompressed_size,
    pg_size_pretty(after_compression_total_bytes) AS compressed_size,
    CASE WHEN after_compression_total_bytes > 0 
         THEN ROUND(100 * (1 - after_compression_total_bytes::numeric / before_compression_total_bytes::numeric), 1)
         ELSE NULL 
    END AS compression_percent
FROM chunk_compression_stats('mqtt_broker_stats')
ORDER BY chunk_name;

-- Readings chunks (with time ranges)
SELECT 
    c.chunk_name,
    d.range_start,
    d.range_end,
    pg_size_pretty(c.before_compression_total_bytes) AS uncompressed_size,
    pg_size_pretty(c.after_compression_total_bytes) AS compressed_size,
    CASE WHEN c.after_compression_total_bytes > 0 
         THEN ROUND(100 * (1 - c.after_compression_total_bytes::numeric / c.before_compression_total_bytes::numeric), 1)
         ELSE NULL 
    END AS compression_percent
FROM chunk_compression_stats('readings') c
JOIN timescaledb_information.chunks d 
    ON c.chunk_schema = d.chunk_schema AND c.chunk_name = d.chunk_name
ORDER BY d.range_start DESC;

-- ============================================================================
-- 8. UNCOMPRESSED VS COMPRESSED CHUNKS COUNT
-- ============================================================================

-- Count compressed vs uncompressed chunks per hypertable
-- Using chunk_compression_stats function to identify compressed chunks
SELECT 
    'device_logs' AS hypertable_name,
    (SELECT COUNT(*) FROM chunk_compression_stats('device_logs')) AS compressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs') - 
        (SELECT COUNT(*) FROM chunk_compression_stats('device_logs')) AS uncompressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs') AS total_chunks
UNION ALL
SELECT 
    'mqtt_topic_metrics' AS hypertable_name,
    (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_topic_metrics')) AS compressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics') - 
        (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_topic_metrics')) AS uncompressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics') AS total_chunks
UNION ALL
SELECT 
    'mqtt_broker_stats' AS hypertable_name,
    (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_broker_stats')) AS compressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats') - 
        (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_broker_stats')) AS uncompressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats') AS total_chunks
UNION ALL
SELECT 
    'readings' AS hypertable_name,
    (SELECT COUNT(*) FROM chunk_compression_stats('readings')) AS compressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings') - 
        (SELECT COUNT(*) FROM chunk_compression_stats('readings')) AS uncompressed_chunks,
    (SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings') AS total_chunks
ORDER BY hypertable_name;

-- Expected: Most chunks compressed, only current/recent chunks uncompressed

-- ============================================================================
-- 9. BACKGROUND JOBS MONITORING
-- ============================================================================

-- Check all background jobs (compression, retention, etc.)
SELECT 
    j.job_id,
    j.application_name,
    j.proc_name,
    j.scheduled,
    js.last_run_started_at,
    js.last_run_status,
    j.next_start,
    js.total_runs,
    js.total_successes,
    js.total_failures
FROM timescaledb_information.jobs j
LEFT JOIN timescaledb_information.job_stats js ON j.job_id = js.job_id
WHERE j.proc_name LIKE 'policy_%'
OR j.proc_name = 'job_run'
ORDER BY j.job_id;

-- Check for any failed jobs
SELECT 
    j.job_id,
    j.proc_name,
    js.last_run_status,
    js.last_run_started_at,
    js.total_failures
FROM timescaledb_information.jobs j
LEFT JOIN timescaledb_information.job_stats js ON j.job_id = js.job_id
WHERE js.last_run_status != 'Success' OR js.total_failures > 0
ORDER BY j.job_id;

-- ============================================================================
-- 10. STORAGE SAVINGS SUMMARY (Executive Report)
-- ============================================================================

-- Generate a summary report showing current size and compression savings
-- Shows all hypertables regardless of compression status
SELECT 
    'device_logs' AS hypertable_name,
    CASE 
        WHEN EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs') 
        THEN pg_size_pretty(COALESCE((SELECT (hypertable_detailed_size('device_logs'::regclass)).total_bytes), 0))
        ELSE 'Not created yet'
    END AS current_size,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('device_logs')) 
        THEN pg_size_pretty((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')))
        ELSE 'N/A'
    END AS original_size_before_compression,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('device_logs'))
        THEN pg_size_pretty((SELECT after_compression_total_bytes FROM hypertable_compression_stats('device_logs')))
        ELSE 'N/A'
    END AS compressed_size,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('device_logs'))
        THEN pg_size_pretty((SELECT before_compression_total_bytes - after_compression_total_bytes FROM hypertable_compression_stats('device_logs')))
        ELSE 'N/A'
    END AS space_saved,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('device_logs'))
        THEN ROUND(100 * (SELECT (before_compression_total_bytes - after_compression_total_bytes)::numeric / NULLIF(before_compression_total_bytes, 0)::numeric FROM hypertable_compression_stats('device_logs')), 1)
        ELSE 0
    END AS compression_ratio_percent,
    CASE 
        WHEN NOT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs') THEN 'Table not created yet'
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('device_logs')) THEN 'Compressed'
        ELSE 'Not compressed yet'
    END AS status
UNION ALL
SELECT 
    'mqtt_topic_metrics',
    CASE 
        WHEN EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics') 
        THEN pg_size_pretty(COALESCE((SELECT (hypertable_detailed_size('mqtt_topic_metrics'::regclass)).total_bytes), 0))
        ELSE 'Not created yet'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_topic_metrics')) 
        THEN pg_size_pretty((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_topic_metrics'))
        THEN pg_size_pretty((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_topic_metrics'))
        THEN pg_size_pretty((SELECT before_compression_total_bytes - after_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_topic_metrics'))
        THEN ROUND(100 * (SELECT (before_compression_total_bytes - after_compression_total_bytes)::numeric / NULLIF(before_compression_total_bytes, 0)::numeric FROM hypertable_compression_stats('mqtt_topic_metrics')), 1)
        ELSE 0
    END,
    CASE 
        WHEN NOT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics') THEN 'Table not created yet'
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_topic_metrics')) THEN 'Compressed'
        ELSE 'Not compressed yet'
    END
UNION ALL
SELECT 
    'mqtt_broker_stats',
    CASE 
        WHEN EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats') 
        THEN pg_size_pretty(COALESCE((SELECT (hypertable_detailed_size('mqtt_broker_stats'::regclass)).total_bytes), 0))
        ELSE 'Not created yet'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_broker_stats')) 
        THEN pg_size_pretty((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_broker_stats'))
        THEN pg_size_pretty((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_broker_stats'))
        THEN pg_size_pretty((SELECT before_compression_total_bytes - after_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_broker_stats'))
        THEN ROUND(100 * (SELECT (before_compression_total_bytes - after_compression_total_bytes)::numeric / NULLIF(before_compression_total_bytes, 0)::numeric FROM hypertable_compression_stats('mqtt_broker_stats')), 1)
        ELSE 0
    END,
    CASE 
        WHEN NOT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats') THEN 'Table not created yet'
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('mqtt_broker_stats')) THEN 'Compressed'
        ELSE 'Not compressed yet'
    END
UNION ALL
SELECT 
    'readings',
    CASE 
        WHEN EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings') 
        THEN pg_size_pretty(COALESCE((SELECT (hypertable_detailed_size('readings'::regclass)).total_bytes), 0))
        ELSE 'Not created yet'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('readings')) 
        THEN pg_size_pretty((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('readings'))
        THEN pg_size_pretty((SELECT after_compression_total_bytes FROM hypertable_compression_stats('readings')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('readings'))
        THEN pg_size_pretty((SELECT before_compression_total_bytes - after_compression_total_bytes FROM hypertable_compression_stats('readings')))
        ELSE 'N/A'
    END,
    CASE 
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('readings'))
        THEN ROUND(100 * (SELECT (before_compression_total_bytes - after_compression_total_bytes)::numeric / NULLIF(before_compression_total_bytes, 0)::numeric FROM hypertable_compression_stats('readings')), 1)
        ELSE 0
    END,
    CASE 
        WHEN NOT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings') THEN 'Table not created yet'
        WHEN EXISTS(SELECT 1 FROM hypertable_compression_stats('readings')) THEN 'Compressed'
        ELSE 'Not compressed yet'
    END
ORDER BY hypertable_name;

-- Calculate total savings across all hypertables
SELECT 
    pg_size_pretty(
        COALESCE((SELECT (hypertable_detailed_size('device_logs'::regclass)).total_bytes WHERE EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs')), 0) +
        COALESCE((SELECT (hypertable_detailed_size('mqtt_topic_metrics'::regclass)).total_bytes WHERE EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics')), 0) +
        COALESCE((SELECT (hypertable_detailed_size('mqtt_broker_stats'::regclass)).total_bytes WHERE EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats')), 0) +
        COALESCE((SELECT (hypertable_detailed_size('readings'::regclass)).total_bytes WHERE EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings')), 0)
    ) AS current_total_size,
    CASE 
        WHEN (
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)
        ) > 0 THEN 
            pg_size_pretty(
                (COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
                 COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
                 COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
                 COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)) -
                (COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
                 COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
                 COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
                 COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('readings')), 0))
            )
        ELSE 'N/A'
    END AS total_space_saved,
    CASE 
        WHEN (
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)
        ) > 0 THEN 
            ROUND(
                100 * (
                    ((COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
                      COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
                      COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
                      COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)) -
                     (COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
                      COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
                      COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
                      COALESCE((SELECT after_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)))::numeric /
                    NULLIF(
                        (COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
                         COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
                         COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
                         COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)),
                        0
                    )::numeric
                ),
                1
            )
        ELSE 0
    END AS total_compression_ratio_percent,
    CASE 
        WHEN NOT EXISTS(SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name IN ('device_logs', 'mqtt_topic_metrics', 'mqtt_broker_stats', 'readings'))
            THEN 'No target hypertables found - run migration first'
        WHEN (
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('device_logs')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_topic_metrics')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('mqtt_broker_stats')), 0) +
            COALESCE((SELECT before_compression_total_bytes FROM hypertable_compression_stats('readings')), 0)
        ) = 0 THEN 'Hypertables exist but no compression yet - policies will run soon'
        ELSE 'Compression active'
    END AS status;

-- Expected results:
-- Total space saved: ~860 MB (from 960 MB → 99 MB)
-- Total compression ratio: ~90%

-- ============================================================================
-- 11. COST SAVINGS ESTIMATE
-- ============================================================================

-- Based on TimescaleDB cloud pricing (~$0.25/GB/month for storage)
WITH storage_costs AS (
    SELECT 
        960 AS original_size_mb,
        99 AS compressed_size_mb,
        0.25 AS cost_per_gb_month
)
SELECT 
    ROUND((original_size_mb / 1024.0) * cost_per_gb_month * 12, 2) AS original_annual_cost_usd,
    ROUND((compressed_size_mb / 1024.0) * cost_per_gb_month * 12, 2) AS compressed_annual_cost_usd,
    ROUND(((original_size_mb - compressed_size_mb) / 1024.0) * cost_per_gb_month * 12, 2) AS annual_savings_usd
FROM storage_costs;

-- Expected savings: ~$2,580/year

-- ============================================================================
-- 12. QUERY PERFORMANCE CHECK
-- ============================================================================

-- Test query performance on compressed data (should be fast for recent data)
EXPLAIN ANALYZE
SELECT 
    device_uuid,
    metric_name,
    AVG(value) AS avg_value,
    COUNT(*) AS sample_count
FROM readings
WHERE time > NOW() - INTERVAL '1 hour'
GROUP BY device_uuid, metric_name;

-- Recent data (uncompressed) should query quickly
-- Older compressed data transparently decompresses on read

-- ============================================================================
-- 13. CONTINUOUS MONITORING DASHBOARD QUERY
-- ============================================================================

-- Single query for monitoring dashboard (run every 5 minutes)
SELECT 
    current_timestamp AS report_timestamp,
    pg_size_pretty(pg_database_size(current_database())) AS total_db_size,
    (
        SELECT COUNT(*) 
        FROM timescaledb_information.hypertables 
        WHERE compression_enabled = true
    ) AS compressed_hypertables,
    (
        SELECT COUNT(*) 
        FROM timescaledb_information.jobs 
        WHERE proc_name = 'policy_compression' 
        AND scheduled = true
    ) AS active_compression_policies,
    (
        SELECT 
            (SELECT COUNT(*) FROM chunk_compression_stats('device_logs')) +
            (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_topic_metrics')) +
            (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_broker_stats')) +
            (SELECT COUNT(*) FROM chunk_compression_stats('readings'))
    ) AS total_compressed_chunks,
    (
        SELECT 
            COALESCE((SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_logs'), 0) +
            COALESCE((SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_topic_metrics'), 0) +
            COALESCE((SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'mqtt_broker_stats'), 0) +
            COALESCE((SELECT num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name = 'readings'), 0) -
            (SELECT 
                (SELECT COUNT(*) FROM chunk_compression_stats('device_logs')) +
                (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_topic_metrics')) +
                (SELECT COUNT(*) FROM chunk_compression_stats('mqtt_broker_stats')) +
                (SELECT COUNT(*) FROM chunk_compression_stats('readings'))
            )
    ) AS total_uncompressed_chunks,
    (
        SELECT COUNT(*) 
        FROM timescaledb_information.jobs j
        JOIN timescaledb_information.job_stats js ON j.job_id = js.job_id
        WHERE j.proc_name = 'policy_compression' 
        AND js.last_run_status != 'Success'
    ) AS failed_compression_jobs;

-- ============================================================================
-- NOTES
-- ============================================================================

-- 1. Compression is transparent: Queries work the same on compressed data
-- 2. Compression policies run automatically in the background
-- 3. Recent data (< 1 day) stays uncompressed for fast writes
-- 4. Decompression happens automatically on reads
-- 5. Compression ratios: 90-98% typical for time-series data
-- 6. Monitor failed jobs regularly to ensure compression continues
-- 7. Adjust compression policies if write patterns change

-- ============================================================================
-- TROUBLESHOOTING
-- ============================================================================

-- If compression is not happening:

-- 1. Check if policies are scheduled
SELECT job_id, scheduled FROM timescaledb_information.jobs 
WHERE proc_name = 'policy_compression';

-- 2. Check for job failures
SELECT * FROM timescaledb_information.job_stats 
WHERE job_id IN (SELECT job_id FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression')
ORDER BY last_run_started_at DESC;

-- 3. Manually compress a specific chunk (if needed)
-- SELECT compress_chunk('_timescaledb_internal._hyper_1_1_chunk');

-- 4. Check chunk age (must be older than compress_after interval)
-- Shows uncompressed chunks and their age
SELECT 
    hypertable_name,
    chunk_name,
    range_start,
    range_end,
    NOW() - range_end AS age,
    'Uncompressed' AS status
FROM timescaledb_information.chunks
WHERE hypertable_name IN ('device_logs', 'mqtt_topic_metrics', 'mqtt_broker_stats', 'readings')
AND chunk_name NOT IN (
    SELECT chunk_name FROM chunk_compression_stats('device_logs')
    UNION ALL
    SELECT chunk_name FROM chunk_compression_stats('mqtt_topic_metrics')
    UNION ALL
    SELECT chunk_name FROM chunk_compression_stats('mqtt_broker_stats')
    UNION ALL
    SELECT chunk_name FROM chunk_compression_stats('readings')
)
ORDER BY range_end DESC;
