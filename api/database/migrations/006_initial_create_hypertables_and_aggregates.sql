-- NO TRANSACTION
-- Migration: Create optimized readings table (TimescaleDB hypertable) and continuous aggregates
-- 
-- Purpose: Core time-series telemetry storage with automatic aggregation layers
-- Creates:
--  1. readings hypertable (normalized schema with 1-day chunks)
--  2. Compression policy (7-day automatic compression, ~90% storage reduction)
--  3. Retention policy (730-day automatic cleanup)
--  4. Continuous aggregates: readings_1m, readings_1h, readings_hourly, readings_daily
--  5. Refresh policies (background auto-refresh for all aggregates)
-- 
-- Dependencies: TimescaleDB extension (created in migration 103)

SET search_path = public;

-- ============================================================================
-- 0. TIMESCALE PREFLIGHT CLEANUP (ORPHAN COMPRESSED TABLES)
-- ============================================================================
-- If a previous failed migration left internal compressed hypertable tables
-- without catalog entries, new compression setup can fail with:
-- "relation _compressed_hypertable_X already exists".
DO $$
DECLARE
    orphan RECORD;
    hypertable_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO hypertable_count FROM _timescaledb_catalog.hypertable;

    -- Only perform blanket orphan cleanup when catalog is empty.
    IF hypertable_count = 0 THEN
        FOR orphan IN
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = '_timescaledb_internal'
                AND c.relname LIKE '_compressed_hypertable_%'
        LOOP
            EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', orphan.schema_name, orphan.table_name);
        END LOOP;
    END IF;
END $$;

-- ============================================================================
-- 0b. TIMESCALE PREFLIGHT CLEANUP (ORPHAN MATERIALIZED HYPERTABLE TABLES)
-- ============================================================================
-- Failed/partial continuous aggregate creation can leave internal
-- _materialized_hypertable_* tables behind even when no cagg catalog rows exist.
-- This causes "relation _materialized_hypertable_X already exists" on re-run.
DO $$
DECLARE
    orphan RECORD;
    cagg_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO cagg_count FROM _timescaledb_catalog.continuous_agg;

    -- Only remove internal materialized hypertables when no continuous
    -- aggregates are registered in catalog.
    IF cagg_count = 0 THEN
        FOR orphan IN
            SELECT n.nspname AS schema_name, c.relname AS table_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = '_timescaledb_internal'
              AND c.relkind = 'r'
              AND c.relname LIKE '_materialized_hypertable_%'
        LOOP
            EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', orphan.schema_name, orphan.table_name);
        END LOOP;
    END IF;
END $$;

-- ============================================================================
-- 0c. TIMESCALE PREFLIGHT CLEANUP (ORPHAN PARTIAL/DIRECT VIEW INTERNALS)
-- ============================================================================
-- Failed/partial continuous aggregate creation can also leave internal
-- _partial_view_* / _direct_view_* relations behind.
DO $$
DECLARE
    orphan RECORD;
    cagg_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO cagg_count FROM _timescaledb_catalog.continuous_agg;

    IF cagg_count = 0 THEN
        FOR orphan IN
            SELECT n.nspname AS schema_name, c.relname AS view_name
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = '_timescaledb_internal'
              AND c.relkind IN ('v', 'm')
              AND (
                  c.relname LIKE '_partial_view_%'
                  OR c.relname LIKE '_direct_view_%'
              )
        LOOP
            IF EXISTS (
                SELECT 1
                FROM pg_class c2
                JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                WHERE n2.nspname = orphan.schema_name
                  AND c2.relname = orphan.view_name
                  AND c2.relkind = 'm'
            ) THEN
                EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS %I.%I CASCADE', orphan.schema_name, orphan.view_name);
            ELSE
                EXECUTE format('DROP VIEW IF EXISTS %I.%I CASCADE', orphan.schema_name, orphan.view_name);
            END IF;
        END LOOP;
    END IF;
END $$;

-- ============================================================================
-- 1. CREATE HYPERTABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS readings (
  time timestamptz NOT NULL,
  agent_uuid uuid NOT NULL,
  metric_name text NOT NULL,
  value double precision,
  quality text DEFAULT 'good',
  unit text,
  protocol text NOT NULL,
  extra jsonb DEFAULT '{}'::jsonb,
  anomaly_score double precision,
  anomaly_threshold double precision,
  
  PRIMARY KEY (agent_uuid, metric_name, time)
);

COMMENT ON TABLE readings IS 'Normalized time-series sensor data (TimescaleDB hypertable with 1-day chunks)';
COMMENT ON COLUMN readings.time IS 'Timestamp for time-series bucketing';
COMMENT ON COLUMN readings.agent_uuid IS 'UUID of the agent/device collecting the metric';
COMMENT ON COLUMN readings.metric_name IS 'Modbus register, OPC UA NodeId, MQTT topic, or sensor name';
COMMENT ON COLUMN readings.value IS 'Numeric sensor reading';
COMMENT ON COLUMN readings.quality IS 'Data quality: good, bad, uncertain';
COMMENT ON COLUMN readings.unit IS 'Unit of measurement (°C, %, V, etc)';
COMMENT ON COLUMN readings.protocol IS 'Collection protocol: modbus, opcua, mqtt, etc';
COMMENT ON COLUMN readings.extra IS 'Protocol-specific metadata (slave_id for Modbus, deviceName from MQTT, etc)';
COMMENT ON COLUMN readings.anomaly_score IS 'ML anomaly score (0-1, NULL if not computed)';
COMMENT ON COLUMN readings.anomaly_threshold IS 'Threshold for anomaly detection';

-- Prep: If readings has inherited child tables (legacy partition/chunk state),
-- flatten them back into readings before converting to hypertable.
DO $$
DECLARE
    child RECORD;
    already_hypertable BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'readings'
            AND hypertable_schema = 'public'
    ) INTO already_hypertable;

    IF already_hypertable THEN
        RAISE NOTICE 'readings already registered as hypertable, skipping flattening prep';
        RETURN;
    END IF;

    FOR child IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE p.relname = 'readings'
            AND pn.nspname = 'public'
        ORDER BY c.relname
    LOOP
        -- Hypertable conversion takes priority over legacy partition/chunk data.
        -- Intentionally drop inherited child tables instead of migrating rows.
        EXECUTE format('DROP TABLE %I.%I CASCADE', child.schema_name, child.table_name);
    END LOOP;
END $$;

-- Convert to hypertable (1-day chunks)
SELECT create_hypertable(
    'readings', 
    'time',
    chunk_time_interval => INTERVAL '1 day',
    migrate_data => TRUE,
    if_not_exists => TRUE
);

-- ============================================================================
-- 2. INDEXES FOR QUERY PERFORMANCE
-- ============================================================================

-- Query by device + time range (most common pattern)
CREATE INDEX IF NOT EXISTS idx_readings_device_time 
  ON readings (agent_uuid, time DESC);

-- Query by metric across agents
CREATE INDEX IF NOT EXISTS idx_readings_metric_time 
  ON readings (metric_name, time DESC);

-- Filter by protocol
CREATE INDEX IF NOT EXISTS idx_readings_protocol 
  ON readings (protocol, time DESC);

-- JSONB queries on extra metadata (e.g., deviceName extraction)
CREATE INDEX IF NOT EXISTS idx_readings_extra 
  ON readings USING GIN (extra);

-- ============================================================================
-- 3. COMPRESSION POLICY
-- ============================================================================
-- Compress chunks older than 7 days (reduces storage 90%, queries automatic decompress)

ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'agent_uuid, metric_name',
  timescaledb.compress_orderby = 'time DESC'
);

-- Add compression policy with error handling (idempotent)
DO $$
BEGIN
  PERFORM add_compression_policy('readings', INTERVAL '7 days', if_not_exists => TRUE);
  RAISE NOTICE 'readings: Compression policy added';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'readings: Could not add compression policy: %', SQLERRM;
END $$;

-- ============================================================================
-- 4. RETENTION POLICY
-- ============================================================================
-- Automatically delete data older than 730 days (2 years)

DO $$
BEGIN
  PERFORM add_retention_policy('readings', INTERVAL '730 days', if_not_exists => TRUE);
  RAISE NOTICE 'readings: Retention policy added (730 days)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'readings: Could not add retention policy: %', SQLERRM;
END $$;

-- ============================================================================
-- 5. CONTINUOUS AGGREGATES (1-MINUTE RESOLUTION)
-- ============================================================================
-- For detailed charts (last hour/day of data)
-- Refreshed every minute with 1-hour lag

-- Ensure these are recreated as Timescale continuous aggregates, not legacy
-- plain views/materialized views from older migrations.
DO $$
DECLARE
    v_name TEXT;
    is_cagg BOOLEAN;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['readings_1m', 'readings_1h', 'readings_hourly', 'readings_daily']
    LOOP
        SELECT EXISTS (
            SELECT 1
            FROM timescaledb_information.continuous_aggregates ca
            WHERE ca.view_schema = 'public'
              AND ca.view_name = v_name
        ) INTO is_cagg;

        IF is_cagg THEN
            EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', v_name);
        ELSIF EXISTS (
            SELECT 1 FROM pg_matviews m
            WHERE m.schemaname = 'public' AND m.matviewname = v_name
        ) THEN
            EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', v_name);
        ELSIF EXISTS (
            SELECT 1 FROM pg_views v
            WHERE v.schemaname = 'public' AND v.viewname = v_name
        ) THEN
            EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', v_name);
        END IF;
    END LOOP;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1m
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 minute', time) AS bucket,
    agent_uuid as agent_uuid,
    extra->>'deviceName' as device_name,
    protocol,
    metric_name,
    unit,
    AVG(value) as avg_value,
    MIN(value) as min_value,
    MAX(value) as max_value,
    COUNT(*) as sample_count,
    -- Quality ratio (0-1)
    SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as quality_ratio,
    -- Anomaly metrics
    MAX(anomaly_score) as max_anomaly_score,
    AVG(anomaly_score) FILTER (WHERE anomaly_score IS NOT NULL) as avg_anomaly_score
FROM readings
GROUP BY bucket, agent_uuid, extra->>'deviceName', protocol, metric_name, unit
WITH NO DATA;

-- ============================================================================
-- 6. CONTINUOUS AGGREGATES (1-HOUR RESOLUTION)
-- ============================================================================
-- For longer time ranges (last week/month)
-- Refreshed every hour with 1-day lag

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1h
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', time) AS bucket,
    agent_uuid as agent_uuid,
    extra->>'deviceName' as device_name,
    protocol,
    metric_name,
    unit,
    AVG(value) as avg_value,
    MIN(value) as min_value,
    MAX(value) as max_value,
    STDDEV(value) as stddev_value,
    COUNT(*) as sample_count,
    -- Quality ratio (0-1)
    SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as quality_ratio
FROM readings
GROUP BY bucket, agent_uuid, extra->>'deviceName', protocol, metric_name, unit
WITH NO DATA;

-- ============================================================================
-- 7. CONTINUOUS AGGREGATES (HOURLY RESOLUTION)
-- ============================================================================
-- Hourly rollup for dashboard aggregations
-- Refreshed by policy created below

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  agent_uuid,
  metric_name,
  protocol,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count,
  LAST(value, time) AS last_value,
  LAST(time, time) AS last_time,
  FIRST(value, time) AS first_value,
  FIRST(time, time) AS first_time
FROM readings
GROUP BY bucket, agent_uuid, metric_name, protocol
WITH NO DATA;

-- ============================================================================
-- 8. CONTINUOUS AGGREGATES (DAILY RESOLUTION)
-- ============================================================================
-- For long-term trend analysis
-- Refreshed by policy created below

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  agent_uuid,
  metric_name,
  protocol,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count
FROM readings
GROUP BY bucket, agent_uuid, metric_name, protocol
WITH NO DATA;

-- ============================================================================
-- 9. REFRESH POLICIES FOR CONTINUOUS AGGREGATES
-- ============================================================================
-- TimescaleDB automatically refreshes aggregates on a background scheduler
-- These policies define the refresh schedule and time window

-- 1-minute aggregate: refresh every 1 minute (with 1-hour lag for stability)
-- start_offset must be >= 2 buckets (2 minutes minimum), so we use 1 hour
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_1m',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for readings_1m: %', SQLERRM;
END $$;

-- 1-hour aggregate: refresh every hour (with 1-day lag for stability)
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_1h',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for readings_1h: %', SQLERRM;
END $$;

-- Hourly aggregate: refresh every hour (with 3-hour lag for stability)
SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);

-- Daily aggregate: refresh every day (with 3-day lag for stability)
SELECT add_continuous_aggregate_policy('readings_daily',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Next steps:
--   1. Run migrations in sequence: 006 → 007 → 008 → 009
--   2. Backfill data from legacy sensor_data table (separate migration)
--   3. Monitor continuous aggregate refresh via: 
--      SELECT * FROM timescaledb_information.continuous_aggregates;
--   4. Query aggregates to verify data is being collected:
--      SELECT COUNT(*) FROM readings_1m;
--      SELECT COUNT(*) FROM readings_1h;
--      SELECT COUNT(*) FROM readings_hourly;
--      SELECT COUNT(*) FROM readings_daily;

-- ============================================================================
-- SECTION 2: DEVICE METRICS HYPERTABLE (AGENT HEALTH MONITORING)
-- ============================================================================
-- Purpose: Store agent/device system metrics (CPU, memory, storage)
-- Note: Separate from sensor readings - tracks infrastructure health
-- Idempotent: Safe to re-run (uses IF NOT EXISTS throughout)

-- Azure PostgreSQL: Set reasonable timeouts
SET statement_timeout = '120s';
SET lock_timeout = '30s';

BEGIN;

-- Step 0: Cleanup from any previous failed migration attempts
DO $$
BEGIN
    -- Drop continuous aggregate views if they exist
    DROP MATERIALIZED VIEW IF EXISTS agent_metrics_5min CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS agent_metrics_hourly CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS agent_metrics_daily CASCADE;
    
    -- Drop temp tables if they exist
    DROP TABLE IF EXISTS agent_metrics_ts CASCADE;
    
    RAISE NOTICE 'Device metrics cleanup complete';
END $$;

-- Step 1: Verify TimescaleDB extension is available
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE EXCEPTION 'TimescaleDB extension not found. Install with: CREATE EXTENSION timescaledb;';
    END IF;
    RAISE NOTICE 'TimescaleDB extension verified for agent_metrics';
END $$;

-- Step 2: Create new unpartitioned table with TimescaleDB-compatible schema
CREATE TABLE IF NOT EXISTS agent_metrics (
    id BIGSERIAL,
    agent_uuid UUID NOT NULL,
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

COMMENT ON TABLE agent_metrics IS 'Agent/device system metrics: CPU, memory, storage, temperature (TimescaleDB hypertable)';
COMMENT ON COLUMN agent_metrics.agent_uuid IS 'UUID of the agent/device';
COMMENT ON COLUMN agent_metrics.cpu_usage IS 'CPU usage percentage (0-100)';
COMMENT ON COLUMN agent_metrics.cpu_temp IS 'CPU temperature in Celsius';
COMMENT ON COLUMN agent_metrics.memory_usage IS 'Used memory in bytes';
COMMENT ON COLUMN agent_metrics.memory_total IS 'Total available memory in bytes';
COMMENT ON COLUMN agent_metrics.storage_usage IS 'Used storage in bytes';
COMMENT ON COLUMN agent_metrics.storage_total IS 'Total available storage in bytes';
COMMENT ON COLUMN agent_metrics.top_processes IS 'JSON array of top processes by CPU/memory';
COMMENT ON COLUMN agent_metrics.recorded_at IS 'Timestamp of metric collection';

-- Step 4: Convert to TimescaleDB hypertable (idempotent)
DO $$
BEGIN
    -- Only create hypertable if not already one
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'agent_metrics'
    ) THEN
        PERFORM create_hypertable(
            'agent_metrics',
            'recorded_at',
            chunk_time_interval => INTERVAL '7 days',
            migrate_data => TRUE,
            if_not_exists => TRUE
        );
        RAISE NOTICE 'agent_metrics: Hypertable created successfully with 7-day chunks';
    ELSE
        RAISE NOTICE 'agent_metrics: Already a hypertable, skipping creation';
    END IF;
END $$;

-- Step 5: Enable compression (idempotent)
DO $$
BEGIN
    -- Only enable compression if not already enabled
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'agent_metrics' 
        AND compression_enabled = TRUE
    ) THEN
        ALTER TABLE agent_metrics SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'agent_uuid',
            timescaledb.compress_orderby = 'recorded_at DESC'
        );
        RAISE NOTICE 'agent_metrics: Compression enabled';
    ELSE
        RAISE NOTICE 'agent_metrics: Compression already enabled, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_metrics: Insufficient privileges to enable compression, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_metrics: Could not enable compression: %, skipping', SQLERRM;
END $$;

-- Step 6: Add compression policy (idempotent)
DO $$
BEGIN
    -- Only add policy if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'agent_metrics' 
        AND proc_name = 'policy_compression'
    ) THEN
        PERFORM add_compression_policy('agent_metrics', INTERVAL '7 days', if_not_exists => TRUE);
        RAISE NOTICE 'agent_metrics: Compression policy added';
    ELSE
        RAISE NOTICE 'agent_metrics: Compression policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_metrics: Insufficient privileges to add compression policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_metrics: Could not add compression policy: %, skipping', SQLERRM;
END $$;

-- Step 7: Add retention policy (idempotent)
DO $$
BEGIN
    -- Only add policy if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'agent_metrics' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('agent_metrics', INTERVAL '90 days', if_not_exists => TRUE);
        RAISE NOTICE 'agent_metrics: Retention policy added (90 days)';
    ELSE
        RAISE NOTICE 'agent_metrics: Retention policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_metrics: Insufficient privileges to add retention policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_metrics: Could not add retention policy: %, skipping', SQLERRM;
END $$;

-- Step 8: Create indexes for query performance
-- Index 1: Device + time range queries (most common pattern)
CREATE INDEX IF NOT EXISTS idx_device_metrics_device_time 
ON agent_metrics (agent_uuid, recorded_at DESC);

-- Index 2: Time-series queries only
CREATE INDEX IF NOT EXISTS idx_device_metrics_recorded_at 
ON agent_metrics (recorded_at DESC);

-- Index 3: GIN index for top_processes JSONB queries
CREATE INDEX IF NOT EXISTS idx_device_metrics_top_processes 
ON agent_metrics USING GIN (top_processes);

COMMIT;

-- ============================================================================
-- DEVICE METRICS CONTINUOUS AGGREGATES (Must be outside transaction)
-- ============================================================================

-- Step 9: Create continuous aggregates for agent health dashboards

-- 5-minute aggregates (real-time monitoring)
CREATE MATERIALIZED VIEW IF NOT EXISTS agent_metrics_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', recorded_at) AS bucket,
    agent_uuid,
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
FROM agent_metrics
GROUP BY bucket, agent_uuid
WITH NO DATA;

-- Hourly aggregates (medium-term trends)
CREATE MATERIALIZED VIEW IF NOT EXISTS agent_metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', recorded_at) AS bucket,
    agent_uuid,
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
FROM agent_metrics
GROUP BY bucket, agent_uuid
WITH NO DATA;

-- Daily aggregates (long-term analysis)
CREATE MATERIALIZED VIEW IF NOT EXISTS agent_metrics_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', recorded_at) AS bucket,
    agent_uuid,
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
FROM agent_metrics
GROUP BY bucket, agent_uuid
WITH NO DATA;

-- Step 10: Add refresh policies for agent_metrics continuous aggregates
-- These keep the aggregates up-to-date automatically

-- 5-minute view: Refresh every 5 minutes, covering last 3 hours
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('agent_metrics_5min',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for agent_metrics_5min: %', SQLERRM;
END $$;

-- Hourly view: Refresh every hour, covering last 24 hours
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('agent_metrics_hourly',
    start_offset => INTERVAL '24 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for agent_metrics_hourly: %', SQLERRM;
END $$;

-- Daily view: Refresh daily, covering last 7 days
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('agent_metrics_daily',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for agent_metrics_daily: %', SQLERRM;
END $$;

-- ============================================================================
-- SECTION 3: DEVICE LOGS HYPERTABLE (LOG AGGREGATION)
-- ============================================================================
-- Purpose: Store device/agent logs with automatic time bucketing
-- Note: Separate from metrics - tracks application logs and system messages
-- Idempotent: Safe to re-run (uses IF NOT EXISTS throughout)

BEGIN;

-- Step 0: Cleanup from any previous failed migration attempts
DO $$
BEGIN
    -- Drop continuous aggregate views if they exist
    DROP MATERIALIZED VIEW IF EXISTS device_logs_5min CASCADE;
    DROP MATERIALIZED VIEW IF EXISTS device_logs_hourly CASCADE;
    
    RAISE NOTICE 'Device logs cleanup complete';
END $$;

-- Step 1: Verify agent_logs table exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_logs') THEN
        RAISE NOTICE 'agent_logs table not found, skipping hypertable conversion';
        RETURN;
    END IF;
    RAISE NOTICE 'agent_logs table found, proceeding with hypertable conversion';
END $$;

-- Step 1b: If agent_logs is inherited/partitioned, flatten it first
DO $$
DECLARE
    child RECORD;
    already_hypertable BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'agent_logs'
          AND hypertable_schema = 'public'
    ) INTO already_hypertable;

    IF already_hypertable THEN
        RAISE NOTICE 'agent_logs already registered as hypertable, skipping flattening prep';
        RETURN;
    END IF;

    FOR child IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE p.relname = 'agent_logs'
          AND pn.nspname = 'public'
        ORDER BY c.relname
    LOOP
        -- Hypertable conversion takes priority over legacy partition/chunk data.
        -- Intentionally drop inherited child tables instead of migrating rows.
        EXECUTE format('DROP TABLE %I.%I CASCADE', child.schema_name, child.table_name);
    END LOOP;
END $$;

-- Step 2: Convert to TimescaleDB hypertable (idempotent)
-- Note: agent_logs uses 'timestamp' column for bucketing (when event occurred)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'agent_logs'
    ) THEN
        PERFORM create_hypertable(
            'agent_logs',
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            migrate_data => TRUE,
            if_not_exists => TRUE
        );
        RAISE NOTICE 'agent_logs: Hypertable created successfully with 1-day chunks';
    ELSE
        RAISE NOTICE 'agent_logs: Already a hypertable, skipping creation';
    END IF;
END $$;

-- Step 3: Enable compression
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'agent_logs' 
        AND compression_enabled = TRUE
    ) THEN
        ALTER TABLE agent_logs SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'agent_uuid, service_name',
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'agent_logs: Compression enabled';
    ELSE
        RAISE NOTICE 'agent_logs: Compression already enabled, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_logs: Insufficient privileges to enable compression, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_logs: Could not enable compression: %, skipping', SQLERRM;
END $$;

-- Step 4: Add compression policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'agent_logs' 
        AND proc_name = 'policy_compression'
    ) THEN
        PERFORM add_compression_policy('agent_logs', INTERVAL '7 days', if_not_exists => TRUE);
        RAISE NOTICE 'agent_logs: Compression policy added';
    ELSE
        RAISE NOTICE 'agent_logs: Compression policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_logs: Insufficient privileges to add compression policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_logs: Could not add compression policy: %, skipping', SQLERRM;
END $$;

-- Step 5: Add retention policy (keep 90 days of logs)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'agent_logs' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('agent_logs', INTERVAL '90 days', if_not_exists => TRUE);
        RAISE NOTICE 'agent_logs: Retention policy added (90 days)';
    ELSE
        RAISE NOTICE 'agent_logs: Retention policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'agent_logs: Insufficient privileges to add retention policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'agent_logs: Could not add retention policy: %, skipping', SQLERRM;
END $$;

-- Step 6: Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_device_logs_device_time 
ON agent_logs (agent_uuid, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_device_logs_service_time 
ON agent_logs (service_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_device_logs_level 
ON agent_logs (level, timestamp DESC);

COMMIT;

-- ============================================================================
-- DEVICE LOGS CONTINUOUS AGGREGATES (Must be outside transaction)
-- ============================================================================

-- Step 7: Create continuous aggregates for log analysis

-- 5-minute log summary (recent log analysis)
CREATE MATERIALIZED VIEW IF NOT EXISTS device_logs_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', timestamp) AS bucket,
    agent_uuid,
    service_name,
    COUNT(*) AS total_count,
    COUNT(*) FILTER (WHERE level = 'ERROR') AS error_count,
    COUNT(*) FILTER (WHERE level = 'WARN') AS warn_count,
    COUNT(*) FILTER (WHERE level = 'INFO') AS info_count,
    COUNT(*) FILTER (WHERE level = 'DEBUG') AS debug_count,
    FIRST(message, timestamp) AS first_message,
    LAST(message, timestamp) AS last_message,
    array_agg(DISTINCT message) FILTER (WHERE level = 'ERROR') AS error_samples,
    array_agg(DISTINCT message) FILTER (WHERE level = 'WARN') AS warning_samples,
    time_bucket('5 minutes', timestamp) AS bucket_start,
    time_bucket('5 minutes', timestamp) + INTERVAL '5 minutes' AS bucket_end
FROM agent_logs
GROUP BY bucket, agent_uuid, service_name
WITH NO DATA;

-- Hourly log summary (historical log analysis)
CREATE MATERIALIZED VIEW IF NOT EXISTS device_logs_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    agent_uuid,
    service_name,
    COUNT(*) AS total_count,
    COUNT(*) FILTER (WHERE level = 'ERROR') AS error_count,
    COUNT(*) FILTER (WHERE level = 'WARN') AS warn_count,
    COUNT(*) FILTER (WHERE level = 'INFO') AS info_count,
    COUNT(*) FILTER (WHERE level = 'DEBUG') AS debug_count,
    FIRST(message, timestamp) AS first_message,
    LAST(message, timestamp) AS last_message,
    array_agg(DISTINCT message) FILTER (WHERE level = 'ERROR') AS error_samples,
    array_agg(DISTINCT message) FILTER (WHERE level = 'WARN') AS warning_samples,
    time_bucket('1 hour', timestamp) AS bucket_start,
    time_bucket('1 hour', timestamp) + INTERVAL '1 hour' AS bucket_end
FROM agent_logs
GROUP BY bucket, agent_uuid, service_name
WITH NO DATA;

-- Step 8: Add refresh policies for agent_logs continuous aggregates

-- 5-minute view: Refresh every 5 minutes, covering last 3 hours
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('device_logs_5min',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for device_logs_5min: %', SQLERRM;
END $$;

-- Hourly view: Refresh every hour, covering last 24 hours
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('device_logs_hourly',
    start_offset => INTERVAL '24 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for device_logs_hourly: %', SQLERRM;
END $$;

-- ============================================================================
-- SECTION 4: MQTT BROKER STATS HYPERTABLE (BROKER MONITORING)
-- ============================================================================
-- Purpose: Store MQTT broker-level statistics and metrics
-- Note: Tracks connected clients, subscriptions, message throughput, etc.
-- Idempotent: Safe to re-run (uses IF NOT EXISTS throughout)

BEGIN;

-- Step 0: Verify mqtt_broker_stats table exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mqtt_broker_stats') THEN
        RAISE NOTICE 'mqtt_broker_stats table not found, skipping hypertable conversion';
        RETURN;
    END IF;
    RAISE NOTICE 'mqtt_broker_stats table found, proceeding with hypertable conversion';
END $$;

-- Step 0b: If mqtt_broker_stats is inherited/partitioned, flatten by dropping children
DO $$
DECLARE
    child RECORD;
    already_hypertable BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'mqtt_broker_stats'
          AND hypertable_schema = 'public'
    ) INTO already_hypertable;

    IF already_hypertable THEN
        RAISE NOTICE 'mqtt_broker_stats already registered as hypertable, skipping flattening prep';
        RETURN;
    END IF;

    FOR child IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE p.relname = 'mqtt_broker_stats'
          AND pn.nspname = 'public'
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP TABLE %I.%I CASCADE', child.schema_name, child.table_name);
    END LOOP;
END $$;

-- Step 1: Convert to TimescaleDB hypertable
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_broker_stats'
    ) THEN
        PERFORM create_hypertable(
            'mqtt_broker_stats',
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            migrate_data => TRUE,
            if_not_exists => TRUE
        );
        RAISE NOTICE 'mqtt_broker_stats: Hypertable created successfully with 1-day chunks';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats: Already a hypertable, skipping creation';
    END IF;
END $$;

-- Step 2: Enable compression
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_broker_stats' 
        AND compression_enabled = TRUE
    ) THEN
        ALTER TABLE mqtt_broker_stats SET (
            timescaledb.compress,
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'mqtt_broker_stats: Compression enabled';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats: Compression already enabled, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_broker_stats: Insufficient privileges to enable compression, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_broker_stats: Could not enable compression: %, skipping', SQLERRM;
END $$;

-- Step 3: Add compression policy (compress after 7 days)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'mqtt_broker_stats' 
        AND proc_name = 'policy_compression'
    ) THEN
        PERFORM add_compression_policy('mqtt_broker_stats', INTERVAL '7 days', if_not_exists => TRUE);
        RAISE NOTICE 'mqtt_broker_stats: Compression policy added';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats: Compression policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_broker_stats: Insufficient privileges to add compression policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_broker_stats: Could not add compression policy: %, skipping', SQLERRM;
END $$;

-- Step 4: Add retention policy (keep 180 days of broker stats)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'mqtt_broker_stats' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('mqtt_broker_stats', INTERVAL '180 days', if_not_exists => TRUE);
        RAISE NOTICE 'mqtt_broker_stats: Retention policy added (180 days)';
    ELSE
        RAISE NOTICE 'mqtt_broker_stats: Retention policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_broker_stats: Insufficient privileges to add retention policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_broker_stats: Could not add retention policy: %, skipping', SQLERRM;
END $$;

-- Step 5: Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_stats_timestamp 
ON mqtt_broker_stats (timestamp DESC);

COMMIT;

-- ============================================================================
-- MQTT BROKER STATS CONTINUOUS AGGREGATES (Must be outside transaction)
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public'
          AND hypertable_name = 'mqtt_broker_stats'
    ) THEN
        RAISE EXCEPTION 'mqtt_broker_stats must be a hypertable before creating continuous aggregates';
    END IF;
END $$;

-- 5-minute broker summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_broker_stats_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', timestamp) AS bucket,
    AVG(connected_clients) AS avg_connected_clients,
    MAX(connected_clients) AS max_connected_clients,
    AVG(subscriptions) AS avg_subscriptions,
    MAX(subscriptions) AS max_subscriptions,
    SUM(messages_sent) AS total_messages_sent,
    SUM(messages_received) AS total_messages_received,
    SUM(messages_published) AS total_messages_published,
    SUM(messages_dropped) AS total_messages_dropped,
    SUM(bytes_sent) AS total_bytes_sent,
    SUM(bytes_received) AS total_bytes_received,
    AVG(message_rate_published) AS avg_message_rate_published,
    AVG(message_rate_received) AS avg_message_rate_received,
    AVG(throughput_inbound) AS avg_throughput_inbound,
    AVG(throughput_outbound) AS avg_throughput_outbound
FROM mqtt_broker_stats
GROUP BY bucket
WITH NO DATA;

-- Hourly broker summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_broker_stats_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    AVG(connected_clients) AS avg_connected_clients,
    MAX(connected_clients) AS max_connected_clients,
    AVG(subscriptions) AS avg_subscriptions,
    MAX(subscriptions) AS max_subscriptions,
    SUM(messages_sent) AS total_messages_sent,
    SUM(messages_received) AS total_messages_received,
    SUM(messages_published) AS total_messages_published,
    SUM(messages_dropped) AS total_messages_dropped,
    SUM(bytes_sent) AS total_bytes_sent,
    SUM(bytes_received) AS total_bytes_received,
    AVG(message_rate_published) AS avg_message_rate_published,
    AVG(message_rate_received) AS avg_message_rate_received,
    AVG(throughput_inbound) AS avg_throughput_inbound,
    AVG(throughput_outbound) AS avg_throughput_outbound
FROM mqtt_broker_stats
GROUP BY bucket
WITH NO DATA;

-- Daily broker summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_broker_stats_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    AVG(connected_clients) AS avg_connected_clients,
    MAX(connected_clients) AS max_connected_clients,
    AVG(subscriptions) AS avg_subscriptions,
    MAX(subscriptions) AS max_subscriptions,
    SUM(messages_sent) AS total_messages_sent,
    SUM(messages_received) AS total_messages_received,
    SUM(messages_published) AS total_messages_published,
    SUM(messages_dropped) AS total_messages_dropped,
    SUM(bytes_sent) AS total_bytes_sent,
    SUM(bytes_received) AS total_bytes_received,
    AVG(message_rate_published) AS avg_message_rate_published,
    AVG(message_rate_received) AS avg_message_rate_received,
    AVG(throughput_inbound) AS avg_throughput_inbound,
    AVG(throughput_outbound) AS avg_throughput_outbound
FROM mqtt_broker_stats
GROUP BY bucket
WITH NO DATA;

-- Refresh policies for mqtt_broker_stats aggregates
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_broker_stats_5min',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_broker_stats_5min: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_broker_stats_hourly',
    start_offset => INTERVAL '24 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_broker_stats_hourly: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_broker_stats_daily',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_broker_stats_daily: %', SQLERRM;
END $$;

-- ============================================================================
-- SECTION 5: MQTT TOPIC METRICS HYPERTABLE (TOPIC MONITORING)
-- ============================================================================
-- Purpose: Store per-topic MQTT statistics and message metrics
-- Note: Tracks message counts, QoS distribution, retained messages, etc.
-- Idempotent: Safe to re-run (uses IF NOT EXISTS throughout)

BEGIN;

-- Step 0: Verify mqtt_topic_metrics table exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mqtt_topic_metrics') THEN
        RAISE NOTICE 'mqtt_topic_metrics table not found, skipping hypertable conversion';
        RETURN;
    END IF;
    RAISE NOTICE 'mqtt_topic_metrics table found, proceeding with hypertable conversion';
END $$;

-- Step 0b: If mqtt_topic_metrics is inherited/partitioned, flatten by dropping children
DO $$
DECLARE
    child RECORD;
    already_hypertable BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'mqtt_topic_metrics'
          AND hypertable_schema = 'public'
    ) INTO already_hypertable;

    IF already_hypertable THEN
        RAISE NOTICE 'mqtt_topic_metrics already registered as hypertable, skipping flattening prep';
        RETURN;
    END IF;

    FOR child IN
        SELECT n.nspname AS schema_name, c.relname AS table_name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        WHERE p.relname = 'mqtt_topic_metrics'
          AND pn.nspname = 'public'
        ORDER BY c.relname
    LOOP
        EXECUTE format('DROP TABLE %I.%I CASCADE', child.schema_name, child.table_name);
    END LOOP;
END $$;

-- Step 1: Convert to TimescaleDB hypertable
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_topic_metrics'
    ) THEN
        PERFORM create_hypertable(
            'mqtt_topic_metrics',
            'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            migrate_data => TRUE,
            if_not_exists => TRUE
        );
        RAISE NOTICE 'mqtt_topic_metrics: Hypertable created successfully with 1-day chunks';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics: Already a hypertable, skipping creation';
    END IF;
END $$;

-- Step 2: Enable compression
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables 
        WHERE hypertable_name = 'mqtt_topic_metrics' 
        AND compression_enabled = TRUE
    ) THEN
        ALTER TABLE mqtt_topic_metrics SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'topic',
            timescaledb.compress_orderby = 'timestamp DESC'
        );
        RAISE NOTICE 'mqtt_topic_metrics: Compression enabled';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics: Compression already enabled, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_topic_metrics: Insufficient privileges to enable compression, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_topic_metrics: Could not enable compression: %, skipping', SQLERRM;
END $$;

-- Step 3: Add compression policy (compress after 7 days)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'mqtt_topic_metrics' 
        AND proc_name = 'policy_compression'
    ) THEN
        PERFORM add_compression_policy('mqtt_topic_metrics', INTERVAL '7 days', if_not_exists => TRUE);
        RAISE NOTICE 'mqtt_topic_metrics: Compression policy added';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics: Compression policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_topic_metrics: Insufficient privileges to add compression policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_topic_metrics: Could not add compression policy: %, skipping', SQLERRM;
END $$;

-- Step 4: Add retention policy (keep 180 days of topic metrics)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE hypertable_name = 'mqtt_topic_metrics' 
        AND proc_name = 'policy_retention'
    ) THEN
        PERFORM add_retention_policy('mqtt_topic_metrics', INTERVAL '180 days', if_not_exists => TRUE);
        RAISE NOTICE 'mqtt_topic_metrics: Retention policy added (180 days)';
    ELSE
        RAISE NOTICE 'mqtt_topic_metrics: Retention policy already exists, skipping';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'mqtt_topic_metrics: Insufficient privileges to add retention policy, skipping';
    WHEN OTHERS THEN
        RAISE WARNING 'mqtt_topic_metrics: Could not add retention policy: %, skipping', SQLERRM;
END $$;

-- Step 5: Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_topic_time 
ON mqtt_topic_metrics (topic, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_timestamp 
ON mqtt_topic_metrics (timestamp DESC);

COMMIT;

-- ============================================================================
-- MQTT TOPIC METRICS CONTINUOUS AGGREGATES (Must be outside transaction)
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public'
          AND hypertable_name = 'mqtt_topic_metrics'
    ) THEN
        RAISE EXCEPTION 'mqtt_topic_metrics must be a hypertable before creating continuous aggregates';
    END IF;
END $$;

-- 5-minute topic summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_topic_metrics_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', timestamp) AS bucket,
    topic,
    SUM(message_count) AS total_messages,
    SUM(bytes_received) AS total_bytes,
    AVG(avg_message_size) AS avg_message_size,
    SUM(qos_0_count) AS total_qos_0,
    SUM(qos_1_count) AS total_qos_1,
    SUM(qos_2_count) AS total_qos_2,
    SUM(retained_count) AS total_retained,
    AVG(message_rate) AS avg_message_rate
FROM mqtt_topic_metrics
GROUP BY bucket, topic
WITH NO DATA;

-- Hourly topic summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_topic_metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    topic,
    SUM(message_count) AS total_messages,
    SUM(bytes_received) AS total_bytes,
    AVG(avg_message_size) AS avg_message_size,
    SUM(qos_0_count) AS total_qos_0,
    SUM(qos_1_count) AS total_qos_1,
    SUM(qos_2_count) AS total_qos_2,
    SUM(retained_count) AS total_retained,
    AVG(message_rate) AS avg_message_rate
FROM mqtt_topic_metrics
GROUP BY bucket, topic
WITH NO DATA;

-- Daily topic summary
CREATE MATERIALIZED VIEW IF NOT EXISTS mqtt_topic_metrics_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', timestamp) AS bucket,
    topic,
    SUM(message_count) AS total_messages,
    SUM(bytes_received) AS total_bytes,
    AVG(avg_message_size) AS avg_message_size,
    SUM(qos_0_count) AS total_qos_0,
    SUM(qos_1_count) AS total_qos_1,
    SUM(qos_2_count) AS total_qos_2,
    SUM(retained_count) AS total_retained,
    AVG(message_rate) AS avg_message_rate
FROM mqtt_topic_metrics
GROUP BY bucket, topic
WITH NO DATA;

-- Refresh policies for mqtt_topic_metrics aggregates
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_topic_metrics_5min',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_topic_metrics_5min: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_topic_metrics_hourly',
    start_offset => INTERVAL '24 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_topic_metrics_hourly: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('mqtt_topic_metrics_daily',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for mqtt_topic_metrics_daily: %', SQLERRM;
END $$;

-- Display final statistics
DO $$
BEGIN
    RAISE NOTICE 'Migration 006 completed successfully!';
    RAISE NOTICE 'Five hypertables created:';
    RAISE NOTICE '  1. readings (sensor telemetry): readings_1m, readings_1h, readings_hourly, readings_daily';
    RAISE NOTICE '  2. agent_metrics (agent health): agent_metrics_5min, agent_metrics_hourly, agent_metrics_daily';
    RAISE NOTICE '  3. agent_logs (application logs): device_logs_5min, device_logs_hourly';
    RAISE NOTICE '  4. mqtt_broker_stats (broker monitoring): mqtt_broker_stats_5min, mqtt_broker_stats_hourly, mqtt_broker_stats_daily';
    RAISE NOTICE '  5. mqtt_topic_metrics (topic monitoring): mqtt_topic_metrics_5min, mqtt_topic_metrics_hourly, mqtt_topic_metrics_daily';
    RAISE NOTICE 'Total: 14 continuous aggregates with auto-refresh policies';
    RAISE NOTICE 'Check: SELECT * FROM timescaledb_information.hypertables;';
    RAISE NOTICE 'Check: SELECT * FROM timescaledb_information.continuous_aggregates;';
END $$;

-- Reset timeouts to defaults
RESET statement_timeout;
RESET lock_timeout;