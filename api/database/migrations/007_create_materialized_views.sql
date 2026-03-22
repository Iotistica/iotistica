-- NO TRANSACTION
-- Migration: Create materialized views and recreate readings continuous aggregates with identity columns
--
-- Purpose:
--  1. Drop and recreate readings_* continuous aggregates (readings_1m, readings_1h, readings_hourly,
--     readings_daily) with device_uuid, endpoint_uuid, and device_name identity columns materialized
--     from readings.extra — standardises snake_case with camelCase fallback
--  2. Create materialized views for metrics discovery, device inventory, and catalog:
--       latest_readings, metric_catalog, endpoint_devices, recent_anomalies
--  3. Create refresh functions and orchestrator helpers
--
-- Dependencies: readings hypertable (006), anomaly_events table, agents table
-- Transaction: -- NO TRANSACTION (continuous aggregates cannot run inside a transaction block)

SET search_path = public;

-- ============================================================================
-- SECTION 1: RECREATE READINGS CONTINUOUS AGGREGATES WITH IDENTITY COLUMNS
-- ============================================================================

-- Drop existing cagg views so we can change projection/schema safely.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['readings_1m', 'readings_1h', 'readings_hourly', 'readings_daily']
  LOOP
    BEGIN
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', v_name);
    EXCEPTION
      WHEN wrong_object_type THEN
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', v_name);
    END;
  END LOOP;
END $$;

-- Backfill identity metadata in raw readings so aggregate columns are populated.
-- Fallback parsing assumes canonical metric naming:
--   <agentUuid>_<endpointUuid>_<metricName> or <agentUuid>_system_<metricName>
WITH normalized AS (
  SELECT
    ctid AS row_id,
    COALESCE(
      NULLIF(extra->>'device_name', ''),
      NULLIF(extra->>'deviceName', '')
    ) AS normalized_device_name,
    COALESCE(
      NULLIF(extra->>'device_uuid', ''),
      NULLIF(extra->>'deviceUuid', ''),
      CASE
        WHEN split_part(metric_name, '_', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN split_part(metric_name, '_', 1)
      END
    ) AS normalized_device_uuid,
    COALESCE(
      NULLIF(extra->>'endpoint_uuid', ''),
      NULLIF(extra->>'endpointUuid', ''),
      CASE
        WHEN split_part(metric_name, '_', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN split_part(metric_name, '_', 2)
      END
    ) AS normalized_endpoint_uuid
  FROM readings
)
UPDATE readings r
SET extra = COALESCE(r.extra, '{}'::jsonb)
  || CASE WHEN n.normalized_device_name IS NOT NULL THEN jsonb_build_object('device_name', n.normalized_device_name) ELSE '{}'::jsonb END
  || CASE WHEN n.normalized_device_uuid IS NOT NULL THEN jsonb_build_object('device_uuid', n.normalized_device_uuid) ELSE '{}'::jsonb END
  || CASE WHEN n.normalized_endpoint_uuid IS NOT NULL THEN jsonb_build_object('endpoint_uuid', n.normalized_endpoint_uuid) ELSE '{}'::jsonb END
FROM normalized n
WHERE r.ctid = n.row_id
  AND (
    NULLIF(r.extra->>'device_name', '') IS NULL
    OR NULLIF(r.extra->>'device_uuid', '') IS NULL
    OR NULLIF(r.extra->>'endpoint_uuid', '') IS NULL
  );

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')) AS device_name,
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) AS device_uuid,
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')) AS endpoint_uuid,
  protocol,
  metric_name,
  unit,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  COUNT(*) AS sample_count,
  SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS quality_ratio,
  MAX(anomaly_score) AS max_anomaly_score,
  AVG(anomaly_score) FILTER (WHERE anomaly_score IS NOT NULL) AS avg_anomaly_score
FROM readings
GROUP BY
  bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')),
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')),
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')),
  protocol,
  metric_name,
  unit
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')) AS device_name,
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) AS device_uuid,
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')) AS endpoint_uuid,
  protocol,
  metric_name,
  unit,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count,
  SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS quality_ratio
FROM readings
GROUP BY
  bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')),
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')),
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')),
  protocol,
  metric_name,
  unit
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')) AS device_name,
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) AS device_uuid,
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')) AS endpoint_uuid,
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
GROUP BY
  bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')),
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')),
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')),
  metric_name,
  protocol
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')) AS device_name,
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) AS device_uuid,
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')) AS endpoint_uuid,
  metric_name,
  protocol,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count
FROM readings
GROUP BY
  bucket,
  agent_uuid,
  COALESCE(NULLIF(extra->>'device_name', ''), NULLIF(extra->>'deviceName', '')),
  COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')),
  COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')),
  metric_name,
  protocol
WITH NO DATA;

-- Reattach refresh policies for readings aggregates.
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

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for readings_hourly: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_daily',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for readings_daily: %', SQLERRM;
END $$;

-- ============================================================================
-- SECTION 2: MATERIALIZED VIEWS FOR METRICS DISCOVERY AND DEVICE INVENTORY
-- ============================================================================

-- ============================================================================
-- 1. LATEST READINGS VIEW
-- ============================================================================
-- Latest value per metric per device (from extra.deviceName)
-- Refreshed frequently for real-time dashboard displays

CREATE MATERIALIZED VIEW IF NOT EXISTS latest_readings AS
SELECT DISTINCT ON (agent_uuid, extra->>'deviceName', metric_name)
    r.agent_uuid as agent_uuid,
    r.extra->>'deviceName' as device_name,
    r.metric_name,
    r.time,
    r.value,
    r.quality,
    r.unit,
    r.protocol,
    r.extra->>'ingested_at' as ingested_at,
    r.anomaly_score,
    r.anomaly_threshold,
    d.device_name as agent_name,
    d.uuid as agent_full_uuid,
    d.is_online as agent_is_online
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '1 hour'
ORDER BY agent_uuid, extra->>'deviceName', metric_name, time DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_readings_unique
  ON latest_readings (agent_uuid, device_name, metric_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_device
  ON latest_readings (device_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_protocol
  ON latest_readings (protocol);
CREATE INDEX IF NOT EXISTS idx_latest_readings_quality
  ON latest_readings (quality);

COMMENT ON MATERIALIZED VIEW latest_readings
  IS 'Latest reading per metric per actual device (from extra.deviceName). Refreshed frequently (every 30s) for dashboard widgets.';

-- ============================================================================
-- 2. METRIC CATALOG VIEW
-- ============================================================================
-- Available metrics with statistics over 7-day window

CREATE MATERIALIZED VIEW IF NOT EXISTS metric_catalog AS
SELECT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    r.extra->>'deviceName' as device_name,
    r.protocol,
    r.metric_name,
    r.unit,
    COUNT(*) as sample_count,
    MIN(r.time) as first_seen,
    MAX(r.time) as last_seen,
    AVG(r.value) as avg_value,
    MIN(r.value) as min_value,
    MAX(r.value) as max_value,
    STDDEV(r.value) as stddev_value,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as quality_percentage,
    AVG(r.anomaly_score) FILTER (WHERE r.anomaly_score IS NOT NULL) as avg_anomaly_score,
    MAX(r.anomaly_score) as max_anomaly_score,
    COUNT(*) FILTER (WHERE r.anomaly_score > r.anomaly_threshold) as anomaly_count
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'deviceName' IS NOT NULL
GROUP BY
    r.agent_uuid,
    d.device_name,
    r.extra->>'deviceName',
    r.protocol,
    r.metric_name,
    r.unit;

CREATE INDEX IF NOT EXISTS idx_metric_catalog_agent
  ON metric_catalog (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_device
  ON metric_catalog (device_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_protocol
  ON metric_catalog (protocol);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_metric
  ON metric_catalog (metric_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_composite
  ON metric_catalog (device_name, metric_name);

COMMENT ON MATERIALIZED VIEW metric_catalog
  IS 'Catalog of available metrics with statistics (7-day window). Used for metric discovery and widget configuration.';

-- ============================================================================
-- 3. ENDPOINT DEVICES VIEW
-- ============================================================================
-- Distinct endpoint agents discovered from readings

CREATE MATERIALIZED VIEW IF NOT EXISTS endpoint_devices AS
SELECT DISTINCT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    d.is_online as agent_is_online,
    r.extra->>'deviceName' as device_name,
    r.protocol,
    MAX(r.time) as last_seen,
    COUNT(DISTINCT r.metric_name) as metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) as available_metrics,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as overall_quality_percentage
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'deviceName' IS NOT NULL
GROUP BY
    r.agent_uuid,
    d.device_name,
    d.is_online,
    r.extra->>'deviceName',
    r.protocol;

CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent
  ON endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device
  ON endpoint_devices (device_name);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol
  ON endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen
  ON endpoint_devices (last_seen DESC);

COMMENT ON MATERIALIZED VIEW endpoint_devices
  IS 'List of actual endpoint agents (from extra.deviceName) with available metrics. Used for device discovery and widget selection.';

-- ============================================================================
-- 4. RECENT ANOMALIES VIEW
-- ============================================================================
-- Recent anomaly events (last 24 hours)

CREATE MATERIALIZED VIEW IF NOT EXISTS recent_anomalies AS
SELECT
    ae.timestamp_ms,
    ae.agent_uuid as agent_id,
    ae.metric,
    ae.observed_value,
    ae.anomaly_score,
    ae.confidence,
    ae.severity,
    ae.severity_reason,
    ae.fingerprint,
    ae.triggered_by,
    ae.baseline,
    ae.expected_range,
    ae.deviation,
    ae.consecutive_count,
    ae.event_count,
    d.device_name as agent_name,
    d.uuid as agent_uuid_full,
    d.is_online as agent_is_online
FROM anomaly_events ae
LEFT JOIN agents d ON ae.agent_uuid = d.uuid::text
WHERE ae.timestamp_ms > EXTRACT(EPOCH FROM (NOW() - INTERVAL '24 hours'))::BIGINT * 1000
ORDER BY ae.timestamp_ms DESC;

CREATE INDEX IF NOT EXISTS idx_recent_anomalies_agent
  ON recent_anomalies (agent_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_severity
  ON recent_anomalies (severity, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_metric
  ON recent_anomalies (metric);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_fingerprint
  ON recent_anomalies (fingerprint);

COMMENT ON MATERIALIZED VIEW recent_anomalies
  IS 'Recent anomaly events (last 24 hours) from anomaly_events table. Used for anomaly timeline widgets.';

-- ============================================================================
-- SECTION 3: REFRESH FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_latest_readings()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY latest_readings;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_latest_readings()
  IS 'Refresh latest_readings materialized view. Call frequently (e.g., every 30 seconds). Uses CONCURRENTLY flag for non-blocking refresh.';

CREATE OR REPLACE FUNCTION refresh_metric_catalog()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY metric_catalog;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_metric_catalog()
  IS 'Refresh metric_catalog materialized view. Call periodically (e.g., every 5 minutes). Uses CONCURRENTLY flag for non-blocking refresh.';

CREATE OR REPLACE FUNCTION refresh_endpoint_devices()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_endpoint_devices()
  IS 'Refresh endpoint_devices materialized view. Call periodically (e.g., every 5 minutes). Uses CONCURRENTLY flag for non-blocking refresh.';

CREATE OR REPLACE FUNCTION refresh_recent_anomalies()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY recent_anomalies;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_recent_anomalies()
  IS 'Refresh recent_anomalies materialized view. Call periodically (e.g., every minute).';

-- ============================================================================
-- SECTION 4: ORCHESTRATOR FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_all_catalog_views()
RETURNS void AS $$
BEGIN
  PERFORM refresh_metric_catalog();
  PERFORM refresh_endpoint_devices();
  PERFORM refresh_latest_readings();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_all_catalog_views()
  IS 'Refresh all metric catalog views (metric_catalog, endpoint_devices, latest_readings). Call this periodically (e.g., every 30 seconds via pg_cron scheduler).';

CREATE OR REPLACE FUNCTION refresh_all_dashboard_views()
RETURNS void AS $$
BEGIN
  PERFORM refresh_latest_readings();
  PERFORM refresh_metric_catalog();
  PERFORM refresh_endpoint_devices();
  PERFORM refresh_recent_anomalies();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_all_dashboard_views()
  IS 'Refresh all dashboard materialized views. Call this periodically (e.g., every 30 seconds via cron).';

-- ============================================================================
-- SECTION 5: INITIAL DATA POPULATION
-- ============================================================================

REFRESH MATERIALIZED VIEW latest_readings;
REFRESH MATERIALIZED VIEW metric_catalog;
REFRESH MATERIALIZED VIEW endpoint_devices;
REFRESH MATERIALIZED VIEW recent_anomalies;
