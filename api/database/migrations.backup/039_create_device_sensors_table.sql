-- Migration: Create device sensors configuration table
-- Purpose: Maintain relational record of configured sensor devices
-- Pattern: Dual-write with device_target_state.config as source of truth
-- Date: 2025-11-02

-- ============================================================================
-- Table: device_sensors
-- Purpose: Relational storage of sensor device configurations
--          (Modbus, CAN, OPC-UA, and other protocol adapter devices)
--          for querying and UI display
-- Note: Config field in device_target_state remains source of truth for agent
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_sensors (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    
    -- Sensor identification
    name VARCHAR(255) NOT NULL,
    protocol VARCHAR(50) NOT NULL, -- modbus, can, opcua, mqtt, etc.
    
    -- Configuration
    enabled BOOLEAN NOT NULL DEFAULT true,
    poll_interval INTEGER NOT NULL DEFAULT 5000, -- milliseconds
    connection JSONB NOT NULL, -- Protocol-specific connection details
    data_points JSONB NOT NULL DEFAULT '[]'::jsonb, -- Data points configuration (registers, tags, etc.)
    
    -- Metadata
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Sync tracking
    synced_to_config BOOLEAN NOT NULL DEFAULT true,
    config_version INTEGER, -- Tracks which target state version this came from
    
    -- Unique constraint: one sensor name per device
    CONSTRAINT uq_device_sensor_name UNIQUE (device_uuid, name)
);

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX idx_device_sensors_device_uuid ON device_sensors(device_uuid);
CREATE INDEX idx_device_sensors_protocol ON device_sensors(protocol);
CREATE INDEX idx_device_sensors_enabled ON device_sensors(enabled);
CREATE INDEX idx_device_sensors_device_protocol ON device_sensors(device_uuid, protocol);
CREATE INDEX idx_device_sensors_sync ON device_sensors(synced_to_config);

-- ============================================================================
-- Trigger: Update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_device_sensor_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_device_sensor_timestamp
    BEFORE UPDATE ON device_sensors
    FOR EACH ROW
    EXECUTE FUNCTION update_device_sensor_timestamp();

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE device_sensors IS 'Relational storage of sensor device configurations. Config field in device_target_state remains source of truth for agent deployment.';
COMMENT ON COLUMN device_sensors.synced_to_config IS 'Tracks whether this record is in sync with device_target_state.config';
COMMENT ON COLUMN device_sensors.config_version IS 'Target state version this configuration was synced from';

-- ============================================================================
-- Grant permissions
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iotistic') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON device_sensors TO iotistic;
        GRANT USAGE, SELECT ON SEQUENCE device_sensors_id_seq TO iotistic;
    END IF;
END
$$;
