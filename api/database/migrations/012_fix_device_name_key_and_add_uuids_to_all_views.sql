-- Migration 012: Fix device_name JSONB key and add asset_uuid/endpoint_uuid to all views
--
-- Problem:
--   - readings.extra stores: { "device_name": "...", "device_uuid": "...", "endpoint_uuid": "..." }
--   - All previous migrations (006, 007, 011) used extra->>'deviceName' (camelCase) — WRONG
--   - Result: device_name NULL in all views/aggregates; endpoint_devices had 0 rows (filtered out)
--
-- This migration:
--   1. Recreates latest_readings    with extra->>'device_name' + keeps asset_uuid/endpoint_uuid
--   2. Recreates metric_catalog     with extra->>'device_name' + adds asset_uuid/endpoint_uuid
--   3. Recreates endpoint_devices   with extra->>'device_name' + adds asset_uuid/endpoint_uuid
--   4. Recreates readings_1m        with extra->>'device_name' + adds asset_uuid/endpoint_uuid
--   5. Recreates readings_1h        with extra->>'device_name' + adds asset_uuid/endpoint_uuid
--   6. Recreates readings_hourly    with extra->>'device_name' + adds asset_uuid/endpoint_uuid
--   7. Recreates readings_daily     with extra->>'device_name' + adds asset_uuid/endpoint_uuid

BEGIN;

-- ============================================================================
-- 1. LATEST READINGS (regular materialized view)
-- ============================================================================

DROP INDEX IF EXISTS idx_latest_readings_unique;
DROP INDEX IF EXISTS idx_latest_readings_device;
DROP INDEX IF EXISTS idx_latest_readings_protocol;
DROP INDEX IF EXISTS idx_latest_readings_quality;
DROP INDEX IF EXISTS idx_latest_readings_agent;
DROP MATERIALIZED VIEW IF EXISTS latest_readings;

CREATE MATERIALIZED VIEW latest_readings AS
SELECT DISTINCT ON (r.device_uuid, r.extra->>'device_name', r.metric_name)
    r.device_uuid                       AS agent_uuid,
    r.extra->>'device_name'             AS device_name,
    r.metric_name,
    r.time,
    r.value,
    r.quality,
    r.unit,
    r.protocol,
    r.extra->>'ingested_at'             AS ingested_at,
    r.extra->>'device_uuid'             AS asset_uuid,
    r.extra->>'endpoint_uuid'           AS endpoint_uuid,
    r.anomaly_score,
    r.anomaly_threshold,
    d.device_name                       AS agent_name,
    d.is_online                         AS agent_is_online
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '1 hour'
ORDER BY r.device_uuid, r.extra->>'device_name', r.metric_name, r.time DESC;

CREATE UNIQUE INDEX idx_latest_readings_unique
  ON latest_readings (agent_uuid, device_name, metric_name);
CREATE INDEX idx_latest_readings_device
  ON latest_readings (device_name);
CREATE INDEX idx_latest_readings_protocol
  ON latest_readings (protocol);
CREATE INDEX idx_latest_readings_quality
  ON latest_readings (quality);
CREATE INDEX idx_latest_readings_agent
  ON latest_readings (agent_uuid);

COMMENT ON MATERIALIZED VIEW latest_readings
  IS 'Latest reading per metric per actual device (from extra.device_name). Includes asset_uuid and endpoint_uuid. Refreshed frequently (every 30s) for dashboard widgets.';

-- ============================================================================
-- 2. METRIC CATALOG (regular materialized view)
-- ============================================================================

DROP INDEX IF EXISTS idx_metric_catalog_agent;
DROP INDEX IF EXISTS idx_metric_catalog_device;
DROP INDEX IF EXISTS idx_metric_catalog_protocol;
DROP INDEX IF EXISTS idx_metric_catalog_metric;
DROP INDEX IF EXISTS idx_metric_catalog_composite;
DROP MATERIALIZED VIEW IF EXISTS metric_catalog;

CREATE MATERIALIZED VIEW metric_catalog AS
SELECT
    r.device_uuid                               AS agent_uuid,
    d.device_name                               AS agent_name,
    r.extra->>'device_name'                     AS device_name,
    r.extra->>'device_uuid'                     AS asset_uuid,
    r.extra->>'endpoint_uuid'                   AS endpoint_uuid,
    r.protocol,
    r.metric_name,
    r.unit,
    COUNT(*)                                    AS sample_count,
    MIN(r.time)                                 AS first_seen,
    MAX(r.time)                                 AS last_seen,
    AVG(r.value)                                AS avg_value,
    MIN(r.value)                                AS min_value,
    MAX(r.value)                                AS max_value,
    STDDEV(r.value)                             AS stddev_value,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float
        / NULLIF(COUNT(*), 0) * 100)            AS quality_percentage,
    AVG(r.anomaly_score)
        FILTER (WHERE r.anomaly_score IS NOT NULL) AS avg_anomaly_score,
    MAX(r.anomaly_score)                        AS max_anomaly_score,
    COUNT(*) FILTER (WHERE r.anomaly_score > r.anomaly_threshold) AS anomaly_count
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'device_name' IS NOT NULL
GROUP BY
    r.device_uuid,
    d.device_name,
    r.extra->>'device_name',
    r.extra->>'device_uuid',
    r.extra->>'endpoint_uuid',
    r.protocol,
    r.metric_name,
    r.unit;

CREATE INDEX idx_metric_catalog_agent     ON metric_catalog (agent_uuid);
CREATE INDEX idx_metric_catalog_device    ON metric_catalog (device_name);
CREATE INDEX idx_metric_catalog_protocol  ON metric_catalog (protocol);
CREATE INDEX idx_metric_catalog_metric    ON metric_catalog (metric_name);
CREATE INDEX idx_metric_catalog_composite ON metric_catalog (device_name, metric_name);

COMMENT ON MATERIALIZED VIEW metric_catalog
  IS 'Catalog of available metrics with statistics (7-day window). Includes asset_uuid and endpoint_uuid. Used for metric discovery and widget configuration.';

-- ============================================================================
-- 3. ENDPOINT DEVICES (regular materialized view)
-- ============================================================================

DROP INDEX IF EXISTS idx_endpoint_devices_agent;
DROP INDEX IF EXISTS idx_endpoint_devices_device;
DROP INDEX IF EXISTS idx_endpoint_devices_protocol;
DROP INDEX IF EXISTS idx_endpoint_devices_last_seen;
DROP MATERIALIZED VIEW IF EXISTS endpoint_devices;

CREATE MATERIALIZED VIEW endpoint_devices AS
SELECT
    r.device_uuid                               AS agent_uuid,
    d.device_name                               AS agent_name,
    d.is_online                                 AS agent_is_online,
    r.extra->>'device_name'                     AS device_name,
    r.extra->>'device_uuid'                     AS asset_uuid,
    r.extra->>'endpoint_uuid'                   AS endpoint_uuid,
    r.protocol,
    MAX(r.time)                                 AS last_seen,
    COUNT(DISTINCT r.metric_name)               AS metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) AS available_metrics,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float
        / NULLIF(COUNT(*), 0) * 100)            AS overall_quality_percentage
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'device_name' IS NOT NULL
GROUP BY
    r.device_uuid,
    d.device_name,
    d.is_online,
    r.extra->>'device_name',
    r.extra->>'device_uuid',
    r.extra->>'endpoint_uuid',
    r.protocol;

CREATE INDEX idx_endpoint_devices_agent    ON endpoint_devices (agent_uuid);
CREATE INDEX idx_endpoint_devices_device   ON endpoint_devices (device_name);
CREATE INDEX idx_endpoint_devices_protocol ON endpoint_devices (protocol);
CREATE INDEX idx_endpoint_devices_last_seen ON endpoint_devices (last_seen DESC);

COMMENT ON MATERIALIZED VIEW endpoint_devices
  IS 'List of actual endpoint devices (from extra.device_name) with available metrics and UUIDs. Used for device discovery and widget selection.';

-- ============================================================================
-- 4. CONTINUOUS AGGREGATES
--    DROP CASCADE removes dependent refresh policies automatically.
--    Recreated with: correct device_name key + asset_uuid + endpoint_uuid
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS readings_1m CASCADE;
DROP MATERIALIZED VIEW IF EXISTS readings_1h CASCADE;
DROP MATERIALIZED VIEW IF EXISTS readings_hourly CASCADE;
DROP MATERIALIZED VIEW IF EXISTS readings_daily CASCADE;

-- readings_1m: 1-minute buckets for detailed charts (last hour/day)
CREATE MATERIALIZED VIEW readings_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time)                   AS bucket,
    device_uuid                                     AS agent_uuid,
    extra->>'device_name'                           AS device_name,
    extra->>'device_uuid'                           AS asset_uuid,
    extra->>'endpoint_uuid'                         AS endpoint_uuid,
    protocol,
    metric_name,
    unit,
    AVG(value)                                      AS avg_value,
    MIN(value)                                      AS min_value,
    MAX(value)                                      AS max_value,
    COUNT(*)                                        AS sample_count,
    SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float
        / NULLIF(COUNT(*), 0)                       AS quality_ratio,
    MAX(anomaly_score)                              AS max_anomaly_score,
    AVG(anomaly_score) FILTER (WHERE anomaly_score IS NOT NULL) AS avg_anomaly_score
FROM readings
GROUP BY
    bucket, device_uuid,
    extra->>'device_name', extra->>'device_uuid', extra->>'endpoint_uuid',
    protocol, metric_name, unit
WITH NO DATA;

-- readings_1h: 1-hour buckets for longer time ranges (last week/month)
CREATE MATERIALIZED VIEW readings_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)                     AS bucket,
    device_uuid                                     AS agent_uuid,
    extra->>'device_name'                           AS device_name,
    extra->>'device_uuid'                           AS asset_uuid,
    extra->>'endpoint_uuid'                         AS endpoint_uuid,
    protocol,
    metric_name,
    unit,
    AVG(value)                                      AS avg_value,
    MIN(value)                                      AS min_value,
    MAX(value)                                      AS max_value,
    STDDEV(value)                                   AS stddev_value,
    COUNT(*)                                        AS sample_count,
    SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::float
        / NULLIF(COUNT(*), 0)                       AS quality_ratio
FROM readings
GROUP BY
    bucket, device_uuid,
    extra->>'device_name', extra->>'device_uuid', extra->>'endpoint_uuid',
    protocol, metric_name, unit
WITH NO DATA;

-- readings_hourly: hourly rollup with FIRST/LAST for dashboard aggregations
CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time)                     AS bucket,
    device_uuid,
    extra->>'device_name'                           AS device_name,
    extra->>'device_uuid'                           AS asset_uuid,
    extra->>'endpoint_uuid'                         AS endpoint_uuid,
    metric_name,
    protocol,
    AVG(value)                                      AS avg_value,
    MIN(value)                                      AS min_value,
    MAX(value)                                      AS max_value,
    STDDEV(value)                                   AS stddev_value,
    COUNT(*)                                        AS sample_count,
    LAST(value, time)                               AS last_value,
    LAST(time, time)                                AS last_time,
    FIRST(value, time)                              AS first_value,
    FIRST(time, time)                               AS first_time
FROM readings
GROUP BY
    bucket, device_uuid,
    extra->>'device_name', extra->>'device_uuid', extra->>'endpoint_uuid',
    metric_name, protocol
WITH NO DATA;

-- readings_daily: daily buckets for long-term trend analysis
CREATE MATERIALIZED VIEW readings_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', time)                      AS bucket,
    device_uuid,
    extra->>'device_name'                           AS device_name,
    extra->>'device_uuid'                           AS asset_uuid,
    extra->>'endpoint_uuid'                         AS endpoint_uuid,
    metric_name,
    protocol,
    AVG(value)                                      AS avg_value,
    MIN(value)                                      AS min_value,
    MAX(value)                                      AS max_value,
    STDDEV(value)                                   AS stddev_value,
    COUNT(*)                                        AS sample_count
FROM readings
GROUP BY
    bucket, device_uuid,
    extra->>'device_name', extra->>'device_uuid', extra->>'endpoint_uuid',
    metric_name, protocol
WITH NO DATA;

-- ============================================================================
-- 5. REFRESH POLICIES FOR CONTINUOUS AGGREGATES
-- ============================================================================

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_1m',
    start_offset => INTERVAL '1 hour',
    end_offset   => INTERVAL '1 minute',
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
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add refresh policy for readings_1h: %', SQLERRM;
END $$;

SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('readings_daily',
  start_offset => INTERVAL '3 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE);

COMMIT;
