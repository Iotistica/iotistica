-- Migration: Add location fields for agents and endpoint devices
-- Adds simple text location field for both physical/facility and geographic locations
-- Supports Azure Digital Twins integration

-- ============================================================================
-- Add location to devices table (agents)
-- ============================================================================
ALTER TABLE devices 
ADD COLUMN IF NOT EXISTS location TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_location ON devices(location) WHERE location IS NOT NULL;

COMMENT ON COLUMN devices.location IS 'Physical or geographic location of the agent (e.g., "Building A, Floor 2, Room 201" or "Toronto Data Center")';

-- ============================================================================
-- Add location to readings table (endpoint devices inherit from here)
-- ============================================================================
-- The endpoint_devices materialized view pulls from readings.extra->>'deviceName'
-- We'll store location in the extra JSONB field for endpoint devices
-- This allows location to be set per endpoint device reading

COMMENT ON COLUMN readings.extra IS 'Extra metadata JSONB field. Can include: deviceName (endpoint device name), location (endpoint device location), and other protocol-specific metadata';

-- ============================================================================
-- Update endpoint_devices view to include location
-- ============================================================================
DROP MATERIALIZED VIEW IF EXISTS endpoint_devices CASCADE;

CREATE MATERIALIZED VIEW endpoint_devices AS
SELECT DISTINCT
    r.device_uuid as agent_uuid,
    d.device_name as agent_name,
    d.is_online as agent_is_online,
    d.location as agent_location,
    r.extra->>'deviceName' as device_name,
    r.extra->>'location' as device_location,
    r.protocol,
    MAX(r.time) as last_seen,
    COUNT(DISTINCT r.metric_name) as metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) as available_metrics,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as overall_quality_percentage
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND r.extra->>'deviceName' IS NOT NULL
GROUP BY 
    r.device_uuid,
    d.device_name,
    d.is_online,
    d.location,
    r.extra->>'deviceName',
    r.extra->>'location',
    r.protocol;

-- Indexes for fast lookups
-- UNIQUE index required for CONCURRENT refresh (no WHERE clause allowed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_devices_unique ON endpoint_devices (agent_uuid, device_name, protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent ON endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device ON endpoint_devices (device_name);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol ON endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen ON endpoint_devices (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent_location ON endpoint_devices (agent_location) WHERE agent_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device_location ON endpoint_devices (device_location) WHERE device_location IS NOT NULL;

COMMENT ON MATERIALIZED VIEW endpoint_devices IS 'List of actual endpoint devices (from extra.deviceName) with available metrics and location. Used for device discovery and widget selection. Includes both agent location and endpoint device location.';

-- ============================================================================
-- Update latest_readings view to include location
-- ============================================================================
DROP MATERIALIZED VIEW IF EXISTS latest_readings CASCADE;

CREATE MATERIALIZED VIEW latest_readings AS
SELECT DISTINCT ON (device_uuid, extra->>'deviceName', metric_name)
    r.device_uuid as agent_uuid,
    r.extra->>'deviceName' as device_name,
    r.extra->>'location' as device_location,
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
    d.location as agent_location,
    d.uuid as agent_full_uuid,
    d.is_online as agent_is_online
FROM readings r
LEFT JOIN devices d ON r.device_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '1 hour'
ORDER BY device_uuid, extra->>'deviceName', metric_name, time DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_readings_unique ON latest_readings (agent_uuid, device_name, metric_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_device ON latest_readings (device_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_protocol ON latest_readings (protocol);
CREATE INDEX IF NOT EXISTS idx_latest_readings_quality ON latest_readings (quality);
CREATE INDEX IF NOT EXISTS idx_latest_readings_agent_location ON latest_readings (agent_location) WHERE agent_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_latest_readings_device_location ON latest_readings (device_location) WHERE device_location IS NOT NULL;

COMMENT ON MATERIALIZED VIEW latest_readings IS 'Latest reading per metric per actual device (from extra.deviceName) with location info. Refreshed frequently for dashboard widgets.';

-- ============================================================================
-- Refresh materialized views
-- ============================================================================
REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
REFRESH MATERIALIZED VIEW CONCURRENTLY latest_readings;
