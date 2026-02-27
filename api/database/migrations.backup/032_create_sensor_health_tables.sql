-- Migration: Create sensor health tracking tables
-- Purpose: Track sensor connection health and protocol adapter device status over time
-- Author: System
-- Date: 2025-10-30

-- ============================================================================
-- Table: sensor_health_history
-- Purpose: Track sensor connection health over time (from sensor-publish feature)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor_health_history (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    sensor_name VARCHAR(255) NOT NULL,
    
    -- Connection status
    state VARCHAR(50) NOT NULL, -- DISCONNECTED, CONNECTING, CONNECTED, ERROR
    healthy BOOLEAN NOT NULL DEFAULT false,
    addr VARCHAR(500) NOT NULL, -- Socket path or connection string
    enabled BOOLEAN NOT NULL DEFAULT true,
    
    -- Error tracking
    last_error TEXT,
    last_error_time TIMESTAMPTZ,
    last_connected_time TIMESTAMPTZ,
    
    -- Statistics
    messages_received BIGINT DEFAULT 0,
    messages_published BIGINT DEFAULT 0,
    bytes_received BIGINT DEFAULT 0,
    bytes_published BIGINT DEFAULT 0,
    reconnect_attempts INTEGER DEFAULT 0,
    last_publish_time TIMESTAMPTZ,
    last_heartbeat_time TIMESTAMPTZ,
    
    -- Metadata
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_sensor_health_device_uuid ON sensor_health_history(device_uuid);
CREATE INDEX idx_sensor_health_sensor_name ON sensor_health_history(sensor_name);
CREATE INDEX idx_sensor_health_state ON sensor_health_history(state);
CREATE INDEX idx_sensor_health_healthy ON sensor_health_history(healthy);
CREATE INDEX idx_sensor_health_reported_at ON sensor_health_history(reported_at DESC);
CREATE INDEX idx_sensor_health_device_sensor ON sensor_health_history(device_uuid, sensor_name);

-- Composite index for dashboard queries (device + sensor + time range)
CREATE INDEX idx_sensor_health_dashboard ON sensor_health_history(device_uuid, sensor_name, reported_at DESC);

-- ============================================================================
-- Table: protocol_adapter_health_history
-- Purpose: Track protocol adapter device status (Modbus/CAN/OPC-UA devices)
-- ============================================================================
CREATE TABLE IF NOT EXISTS protocol_adapter_health_history (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    protocol_type VARCHAR(50) NOT NULL, -- modbus, can, opcua
    device_name VARCHAR(255) NOT NULL,
    
    -- Connection status
    connected BOOLEAN NOT NULL DEFAULT false,
    last_poll TIMESTAMPTZ,
    
    -- Error tracking
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    
    -- Metadata
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_protocol_health_device_uuid ON protocol_adapter_health_history(device_uuid);
CREATE INDEX idx_protocol_health_protocol_type ON protocol_adapter_health_history(protocol_type);
CREATE INDEX idx_protocol_health_device_name ON protocol_adapter_health_history(device_name);
CREATE INDEX idx_protocol_health_connected ON protocol_adapter_health_history(connected);
CREATE INDEX idx_protocol_health_reported_at ON protocol_adapter_health_history(reported_at DESC);
CREATE INDEX idx_protocol_health_device_protocol ON protocol_adapter_health_history(device_uuid, protocol_type, device_name);

-- Composite index for dashboard queries
CREATE INDEX idx_protocol_health_dashboard ON protocol_adapter_health_history(device_uuid, protocol_type, device_name, reported_at DESC);

-- ============================================================================
-- View: sensor_health_latest
-- Purpose: Get latest sensor health status for each device (for dashboard)
-- ============================================================================
CREATE OR REPLACE VIEW sensor_health_latest AS
SELECT DISTINCT ON (device_uuid, sensor_name)
    id,
    device_uuid,
    sensor_name,
    state,
    healthy,
    addr,
    enabled,
    last_error,
    last_error_time,
    last_connected_time,
    messages_received,
    messages_published,
    bytes_received,
    bytes_published,
    reconnect_attempts,
    last_publish_time,
    last_heartbeat_time,
    reported_at
FROM sensor_health_history
ORDER BY device_uuid, sensor_name, reported_at DESC;

-- ============================================================================
-- View: protocol_adapter_health_latest
-- Purpose: Get latest protocol adapter health for each device
-- ============================================================================
CREATE OR REPLACE VIEW protocol_adapter_health_latest AS
SELECT DISTINCT ON (device_uuid, protocol_type, device_name)
    id,
    device_uuid,
    protocol_type,
    device_name,
    connected,
    last_poll,
    error_count,
    last_error,
    reported_at
FROM protocol_adapter_health_history
ORDER BY device_uuid, protocol_type, device_name, reported_at DESC;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE sensor_health_history IS 'Historical tracking of sensor connection health from sensor-publish feature';
COMMENT ON TABLE protocol_adapter_health_history IS 'Historical tracking of protocol adapter device status (Modbus/CAN/OPC-UA)';
COMMENT ON VIEW sensor_health_latest IS 'Latest sensor health status for each device (dashboard view)';
COMMENT ON VIEW protocol_adapter_health_latest IS 'Latest protocol adapter health for each device (dashboard view)';

-- ============================================================================
-- Grant permissions
-- ============================================================================
-- Note: Grants moved to migration 033 with conditional logic to handle missing role
-- This allows migration to work on both local (no iotistic role) and production (with role)
