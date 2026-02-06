-- Migration: Create metrics dashboard views
-- Purpose: Materialized views and continuous aggregates for high-performance metrics dashboard
-- Date: 2026-02-05
-- Dependencies: readings table (106), TimescaleDB extension (103)

-- =============================================================================
-- TRANSACTIONAL SECTION: Regular materialized views
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. LATEST READINGS VIEW
-- ============================================================================
-- Latest value per metric per device (from extra.deviceName)
-- Refreshed frequently for real-time dashboard displays

CREATE MATERIALIZED VIEW IF NOT EXISTS latest_readings AS
SELECT DISTINCT ON (device_uuid, extra->>'deviceName', metric_name)
    r.device_uuid as agent_uuid,
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
    -- Join with devices table to get agent info
    d.device_name as agent_name,
    d.uuid as agent_full_uuid,
    d.is_online as agent_is_online
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '1 hour'  -- Only recent data for performance
ORDER BY device_uuid, extra->>'deviceName', metric_name, time DESC;

-- Indexes for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_readings_unique ON latest_readings (agent_uuid, device_name, metric_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_device ON latest_readings (device_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_protocol ON latest_readings (protocol);
CREATE INDEX IF NOT EXISTS idx_latest_readings_quality ON latest_readings (quality);

COMMENT ON MATERIALIZED VIEW latest_readings IS 'Latest reading per metric per actual device (from extra.deviceName). Refreshed every 30 seconds for dashboard widgets.';

-- ============================================================================
-- 2. METRIC CATALOG VIEW
-- ============================================================================
-- Available metrics grouped by actual endpoint device
-- Used for metric discovery, widget configuration, and statistics

CREATE MATERIALIZED VIEW IF NOT EXISTS metric_catalog AS
SELECT 
    r.device_uuid as agent_uuid,
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
    -- Quality metrics (percentage of good readings)
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as quality_percentage,
    -- Anomaly metrics
    AVG(r.anomaly_score) FILTER (WHERE r.anomaly_score IS NOT NULL) as avg_anomaly_score,
    MAX(r.anomaly_score) as max_anomaly_score,
    COUNT(*) FILTER (WHERE r.anomaly_score > r.anomaly_threshold) as anomaly_count
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
GROUP BY 
    r.device_uuid,
    d.device_name,
    r.extra->>'deviceName',
    r.protocol,
    r.metric_name,
    r.unit;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_metric_catalog_agent ON metric_catalog (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_device ON metric_catalog (device_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_protocol ON metric_catalog (protocol);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_metric ON metric_catalog (metric_name);

COMMENT ON MATERIALIZED VIEW metric_catalog IS 'Catalog of available metrics with statistics (7-day window). Used for metric discovery and widget configuration.';

-- ============================================================================
-- 3. ENDPOINT DEVICES LIST VIEW
-- ============================================================================
-- Distinct endpoint devices discovered from readings
-- Used for device selector dropdowns and device inventory

CREATE MATERIALIZED VIEW IF NOT EXISTS endpoint_devices AS
SELECT DISTINCT
    r.device_uuid as agent_uuid,
    d.device_name as agent_name,
    d.is_online as agent_is_online,
    r.extra->>'deviceName' as device_name,
    r.protocol,
    MAX(r.time) as last_seen,
    COUNT(DISTINCT r.metric_name) as metric_count,
    -- Sample of available metrics (array for quick reference)
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) as available_metrics,
    -- Quality summary
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as overall_quality_percentage
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'deviceName' IS NOT NULL  -- Filter out readings without device name
GROUP BY 
    r.device_uuid,
    d.device_name,
    d.is_online,
    r.extra->>'deviceName',
    r.protocol;

CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent ON endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device ON endpoint_devices (device_name);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol ON endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen ON endpoint_devices (last_seen DESC);

COMMENT ON MATERIALIZED VIEW endpoint_devices IS 'List of actual endpoint devices (from extra.deviceName) with available metrics. Used for device discovery and selection.';

-- ============================================================================
-- 4. RECENT ANOMALIES VIEW
-- ============================================================================
-- Recent anomaly events (last 24 hours)
-- Uses existing anomaly_events table from migration 110

CREATE MATERIALIZED VIEW IF NOT EXISTS recent_anomalies AS
SELECT 
    ae.timestamp_ms,
    ae.device_id as agent_id,
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
    -- Join with devices table for agent info
    d.device_name as agent_name,
    d.uuid as agent_uuid,
    d.is_online as agent_is_online
FROM anomaly_events ae
LEFT JOIN devices d ON ae.device_id = d.uuid::text
WHERE ae.timestamp_ms > EXTRACT(EPOCH FROM (NOW() - INTERVAL '24 hours'))::BIGINT * 1000
ORDER BY ae.timestamp_ms DESC;

CREATE INDEX IF NOT EXISTS idx_recent_anomalies_agent ON recent_anomalies (agent_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_severity ON recent_anomalies (severity, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_metric ON recent_anomalies (metric);
CREATE INDEX IF NOT EXISTS idx_recent_anomalies_fingerprint ON recent_anomalies (fingerprint);

COMMENT ON MATERIALIZED VIEW recent_anomalies IS 'Recent anomaly events (last 24 hours) from anomaly_events table. Used for anomaly timeline widgets.';

-- ============================================================================
-- 6. REFRESH FUNCTIONS
-- ============================================================================
-- Manual refresh functions for materialized views
-- Can be called via cron or application logic

CREATE OR REPLACE FUNCTION refresh_latest_readings()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY latest_readings;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_metric_catalog()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY metric_catalog;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_endpoint_devices()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_recent_anomalies()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY recent_anomalies;
END;
$$ LANGUAGE plpgsql;

-- Refresh all dashboard views at once
CREATE OR REPLACE FUNCTION refresh_all_dashboard_views()
RETURNS void AS $$
BEGIN
  PERFORM refresh_latest_readings();
  PERFORM refresh_metric_catalog();
  PERFORM refresh_endpoint_devices();
  PERFORM refresh_recent_anomalies();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_all_dashboard_views() IS 'Refresh all metrics dashboard materialized views. Call this periodically (e.g., every 30 seconds via cron).';

-- ============================================================================
-- 7. INITIAL DATA POPULATION
-- ============================================================================
-- Populate views with existing data

REFRESH MATERIALIZED VIEW latest_readings;
REFRESH MATERIALIZED VIEW metric_catalog;
REFRESH MATERIALIZED VIEW endpoint_devices;
REFRESH MATERIALIZED VIEW recent_anomalies;

COMMIT;

-- =============================================================================
-- NON-TRANSACTIONAL SECTION: Continuous aggregates
-- =============================================================================
-- TimescaleDB continuous aggregates cannot be created inside transactions

-- ============================================================================
-- 5. CONTINUOUS AGGREGATES (TimescaleDB)
-- ============================================================================
-- Pre-aggregated time-series data for fast chart rendering
-- Automatically maintained by TimescaleDB

-- 1-minute rollups (for detailed charts - last hour/day)
-- Note: TimescaleDB continuous aggregates cannot have COMMENT ON statements
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1m
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 minute', time) AS bucket,
    device_uuid as agent_uuid,
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
GROUP BY bucket, agent_uuid, device_name, protocol, metric_name, unit
WITH NO DATA;

-- 1-hour rollups (for longer time ranges - last week/month)
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_1h
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', time) AS bucket,
    device_uuid as agent_uuid,
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
GROUP BY bucket, agent_uuid, device_name, protocol, metric_name, unit
WITH NO DATA;

-- Auto-refresh policies for continuous aggregates
-- Refresh 1-minute aggregate every minute (1 hour lag for stability)
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_1m',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    -- Policy might already exist, ignore error
    RAISE NOTICE 'Could not add refresh policy for readings_1m: %', SQLERRM;
END $$;

-- Refresh 1-hour aggregate every hour (1 day lag for stability)
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy('readings_1h',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
EXCEPTION
  WHEN OTHERS THEN
    -- Policy might already exist, ignore error
    RAISE NOTICE 'Could not add refresh policy for readings_1h: %', SQLERRM;
END $$;

-- ============================================================================
-- NOTES
-- ============================================================================
-- Performance:
-- - Materialized views: Refresh every 30 seconds via cron or app scheduler
-- - Continuous aggregates: Auto-refresh by TimescaleDB (1m every minute, 1h every hour)
-- - Use CONCURRENTLY for non-blocking refreshes in production
--
-- Example refresh schedule (pg_cron):
-- SELECT cron.schedule('refresh-dashboard-views', '30 seconds', 'SELECT refresh_all_dashboard_views()');
--
-- Query examples:
-- SELECT * FROM latest_readings WHERE device_name = 'device_1';
-- SELECT * FROM metric_catalog WHERE agent_uuid = '...';
-- SELECT * FROM endpoint_devices ORDER BY last_seen DESC;
-- SELECT * FROM readings_1m WHERE bucket > NOW() - INTERVAL '1 hour';
