-- Migration: Recreate readings continuous aggregates with identity columns
--
-- Purpose:
--  - Materialize device_uuid and endpoint_uuid from readings.extra in all readings_* aggregates
--  - Standardize device_name extraction (snake_case with camelCase fallback)
--  - Keep existing aggregate names so API routes continue to work unchanged
--
-- Safe strategy:
--  - Drop existing continuous aggregate views (user confirmed delete/recreate is acceptable)
--  - Recreate with expanded schema
--  - Reattach refresh policies

SET search_path = public;

-- Drop existing cagg views so we can change projection/schema safely.
DO $$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['readings_1m', 'readings_1h', 'readings_hourly', 'readings_daily']
  LOOP
    -- Continuous aggregates must be dropped as MATERIALIZED VIEW.
    -- Some environments can report legacy state inconsistently, so we
    -- attempt MATVIEW drop first and only fallback to VIEW when required.
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

-- Reattach refresh policies.
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
