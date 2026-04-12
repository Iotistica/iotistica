-- Migration 023: Replace agent_metrics table with a view over readings
--
-- Agent system metrics (cpu_usage, cpu_temp, memory_*, storage_*) now flow
-- through the shared readings hypertable with protocol = 'system'.  To avoid
-- touching the dashboard read path we replace the agent_metrics table — and
-- its two downstream continuous aggregates — with equivalent views/aggregates
-- sourced from readings.
--
-- Changes:
--   1. Rename agent_metrics           → agent_metrics_legacy  (preserves history)
--   2. Drop agent_metrics_5min / agent_metrics_hourly          (depend on old table)
--   3. CREATE VIEW agent_metrics       (pivots readings WHERE protocol='system')
--   4. CREATE MATERIALIZED VIEW agent_metrics_5min  (continuous, from readings)
--   5. CREATE MATERIALIZED VIEW agent_metrics_hourly (continuous, from readings)
--   6. Add refresh policies for continuus aggregates

-- ============================================================
-- Step 1: preserve existing data under a legacy name
-- ============================================================
ALTER TABLE IF EXISTS agent_metrics RENAME TO agent_metrics_legacy;

-- ============================================================
-- Step 2: drop old continuous aggregates
-- (CASCADE removes policies and dependent views)
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS agent_metrics_5min    CASCADE;
DROP MATERIALIZED VIEW IF EXISTS agent_metrics_hourly  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS agent_metrics_daily   CASCADE;

-- ============================================================
-- Step 3: view that mimics the agent_metrics table shape
--
-- Groups readings by (agent_uuid, time) and pivots each
-- metric_name into the matching column.  The original table had
-- one row per sample with every metric in a separate column;
-- since we write each metric as a separate readings row we need
-- MAX(CASE …) to collapse them back.
-- ============================================================
CREATE VIEW agent_metrics AS
SELECT
    agent_uuid,
    MAX(CASE WHEN metric_name = 'cpu_usage'     THEN value END)::numeric        AS cpu_usage,
    MAX(CASE WHEN metric_name = 'cpu_temp'      THEN value END)::numeric        AS cpu_temp,
    MAX(CASE WHEN metric_name = 'memory_usage'  THEN value END)::bigint         AS memory_usage,
    MAX(CASE WHEN metric_name = 'memory_total'  THEN value END)::bigint         AS memory_total,
    MAX(CASE WHEN metric_name = 'storage_usage' THEN value END)::bigint         AS storage_usage,
    MAX(CASE WHEN metric_name = 'storage_total' THEN value END)::bigint         AS storage_total,
    NULL::jsonb                                                                  AS top_processes,
    "time"                                                                       AS recorded_at
FROM readings
WHERE protocol = 'system'
GROUP BY agent_uuid, "time";

-- ============================================================
-- Step 4 & 5: new continuous aggregates sourced from readings
--
-- These must be created OUTSIDE any transaction block because
-- TimescaleDB does not support creating continuous aggregates
-- inside explicit transactions.
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS agent_metrics_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', "time")           AS bucket,
    agent_uuid,
    avg(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS avg_cpu_usage,
    max(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS max_cpu_usage,
    min(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS min_cpu_usage,
    avg(CASE WHEN metric_name = 'cpu_temp'      THEN value END) AS avg_cpu_temp,
    max(CASE WHEN metric_name = 'cpu_temp'      THEN value END) AS max_cpu_temp,
    avg(CASE WHEN metric_name = 'memory_usage'  THEN value END) AS avg_memory_usage,
    max(CASE WHEN metric_name = 'memory_usage'  THEN value END) AS max_memory_usage,
    avg(CASE WHEN metric_name = 'memory_total'  THEN value END) AS avg_memory_total,
    avg(CASE WHEN metric_name = 'storage_usage' THEN value END) AS avg_storage_usage,
    max(CASE WHEN metric_name = 'storage_usage' THEN value END) AS max_storage_usage,
    avg(CASE WHEN metric_name = 'storage_total' THEN value END) AS avg_storage_total,
    count(*)                                                       AS sample_count
FROM readings
WHERE protocol = 'system'
GROUP BY bucket, agent_uuid
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS agent_metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', "time")              AS bucket,
    agent_uuid,
    avg(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS avg_cpu_usage,
    max(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS max_cpu_usage,
    min(CASE WHEN metric_name = 'cpu_usage'     THEN value END) AS min_cpu_usage,
    avg(CASE WHEN metric_name = 'cpu_temp'      THEN value END) AS avg_cpu_temp,
    max(CASE WHEN metric_name = 'cpu_temp'      THEN value END) AS max_cpu_temp,
    avg(CASE WHEN metric_name = 'memory_usage'  THEN value END) AS avg_memory_usage,
    max(CASE WHEN metric_name = 'memory_usage'  THEN value END) AS max_memory_usage,
    avg(CASE WHEN metric_name = 'memory_total'  THEN value END) AS avg_memory_total,
    avg(CASE WHEN metric_name = 'storage_usage' THEN value END) AS avg_storage_usage,
    max(CASE WHEN metric_name = 'storage_usage' THEN value END) AS max_storage_usage,
    avg(CASE WHEN metric_name = 'storage_total' THEN value END) AS avg_storage_total,
    count(*)                                                       AS sample_count
FROM readings
WHERE protocol = 'system'
GROUP BY bucket, agent_uuid
WITH NO DATA;

-- ============================================================
-- Step 6: refresh policies (mirrors old migration 006 values)
-- ============================================================
DO $$
BEGIN
    BEGIN
        PERFORM add_continuous_aggregate_policy(
            'agent_metrics_5min',
            start_offset  => INTERVAL '1 hour',
            end_offset    => INTERVAL '5 minutes',
            schedule_interval => INTERVAL '5 minutes'
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not add refresh policy for agent_metrics_5min: %', SQLERRM;
    END;

    BEGIN
        PERFORM add_continuous_aggregate_policy(
            'agent_metrics_hourly',
            start_offset  => INTERVAL '3 hours',
            end_offset    => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour'
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Could not add refresh policy for agent_metrics_hourly: %', SQLERRM;
    END;
END;
$$;

-- ============================================================
-- Note on the legacy table
-- ============================================================
-- agent_metrics_legacy holds pre-migration data and can be
-- dropped whenever you no longer need historical data from
-- before this migration.
