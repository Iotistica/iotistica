-- Migration: Create materialized views for metrics discovery, device inventory, and catalog
-- 
-- Purpose: High-performance cached views for dashboard, API, and device discovery
-- Creates:
--  1. latest_readings (current value per metric per device)
--  2. metric_catalog (available metrics with statistics)
--  3. endpoint_devices (discovered devices with metric inventory)
--  4. recent_anomalies (recent anomaly events from anomaly_events table)
--  5. Refresh functions for manual and scheduled updates
--  6. Orchestrator function to refresh all views at once
--
-- Dependencies: readings hypertable (006), anomaly_events table (110), devices table

-- ============================================================================
-- SECTION 1: TRANSACTIONAL MATERIALIZED VIEW DEFINITIONS
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. LATEST READINGS VIEW
-- ============================================================================
-- Latest value per metric per device (from extra.deviceName)
-- Refreshed frequently for real-time dashboard displays
-- ~50ms refresh per 1000 unique metric rows

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
-- Used for metric discovery, widget configuration, and sensor inventory
-- ~200ms refresh per 10k unique metric rows (with 7-day data window)

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
  AND r.extra->>'deviceName' IS NOT NULL  -- Only include readings with device name
GROUP BY 
    r.device_uuid,
    d.device_name,
    r.extra->>'deviceName',
    r.protocol,
    r.metric_name,
    r.unit;

-- Indexes for fast lookups
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
-- Distinct endpoint devices discovered from readings
-- Used for device selector dropdowns and device inventory
-- ~150ms refresh per 1000 unique devices (with 7-day data window)

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

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent 
  ON endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device 
  ON endpoint_devices (device_name);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol 
  ON endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen 
  ON endpoint_devices (last_seen DESC);

COMMENT ON MATERIALIZED VIEW endpoint_devices 
  IS 'List of actual endpoint devices (from extra.deviceName) with available metrics. Used for device discovery and widget selection.';

-- ============================================================================
-- 4. RECENT ANOMALIES VIEW
-- ============================================================================
-- Recent anomaly events (last 24 hours)
-- Uses anomaly_events table from migration 110
-- Provides timeline for anomaly detection widgets

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
    -- Join with devices table for agent info
    d.device_name as agent_name,
    d.uuid as agent_uuid_full,
    d.is_online as agent_is_online
FROM anomaly_events ae
LEFT JOIN devices d ON ae.agent_uuid = d.uuid::text
WHERE ae.timestamp_ms > EXTRACT(EPOCH FROM (NOW() - INTERVAL '24 hours'))::BIGINT * 1000
ORDER BY ae.timestamp_ms DESC;

-- Indexes for fast lookups
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
-- SECTION 2: REFRESH FUNCTIONS
-- ============================================================================
-- Manual refresh functions for materialized views
-- Can be called via cron scheduler (pg_cron) or application logic

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
-- SECTION 3: ORCHESTRATOR FUNCTIONS
-- ============================================================================
-- High-level functions to refresh all views at once

-- For catalog views (NOT dashboard views)
-- Legacy name used by API and agent code
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

-- For all dashboard views including anomalies
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
-- SECTION 4: INITIAL DATA POPULATION
-- ============================================================================
-- Populate all views with existing data from readings table

REFRESH MATERIALIZED VIEW latest_readings;
REFRESH MATERIALIZED VIEW metric_catalog;
REFRESH MATERIALIZED VIEW endpoint_devices;
REFRESH MATERIALIZED VIEW recent_anomalies;

COMMIT;

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================
-- Get all devices with their available metrics:
-- SELECT * FROM endpoint_devices ORDER BY last_seen DESC;
--
-- Get all metrics for a specific device:
-- SELECT * FROM metric_catalog WHERE device_name = 'modbus-device-001';
--
-- Get latest value for a specific metric:
-- SELECT * FROM latest_readings WHERE device_name = 'modbus-device-001' AND metric_name = 'temperature';
--
-- Get recent anomalies:
-- SELECT * FROM recent_anomalies ORDER BY timestamp_ms DESC LIMIT 10;
--
-- Refresh all views:
-- SELECT refresh_all_catalog_views();
--
-- Schedule automatic refresh (requires pg_cron extension):
-- SELECT cron.schedule('refresh-catalog-views', '30 seconds', 'SELECT refresh_all_catalog_views()');
