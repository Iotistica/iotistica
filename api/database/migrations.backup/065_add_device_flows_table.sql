-- Migration: Add device_flows table for device-specific subflow storage
-- Description: Stores extracted subflows for each device, enabling version tracking and deployment management
-- Created: 2025-11-21

-- Device-specific flows storage
CREATE TABLE IF NOT EXISTS device_flows (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    subflow_id VARCHAR(64) NOT NULL,
    subflow_name VARCHAR(255),
    flows JSONB NOT NULL,
    settings JSONB DEFAULT '{}'::jsonb,
    modules JSONB DEFAULT '[]'::jsonb,
    hash VARCHAR(64) NOT NULL,
    version INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deployed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT unique_device_subflow UNIQUE(device_uuid, subflow_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_device_flows_device_uuid ON device_flows(device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_flows_subflow_id ON device_flows(subflow_id);
CREATE INDEX IF NOT EXISTS idx_device_flows_hash ON device_flows(hash);
CREATE INDEX IF NOT EXISTS idx_device_flows_active ON device_flows(is_active);
CREATE INDEX IF NOT EXISTS idx_device_flows_deployed_at ON device_flows(deployed_at);

-- Auto-update timestamps
CREATE TRIGGER trigger_device_flows_updated_at
    BEFORE UPDATE ON device_flows
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_at_column();

-- Grants
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iotistic_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON device_flows TO iotistic_app;
        GRANT USAGE, SELECT ON SEQUENCE device_flows_id_seq TO iotistic_app;
    END IF;
END $$;

-- Comments
COMMENT ON TABLE device_flows IS 'Device-specific Node-RED subflows extracted from main flows';
COMMENT ON COLUMN device_flows.device_uuid IS 'Device this subflow is assigned to';
COMMENT ON COLUMN device_flows.subflow_id IS 'Node-RED subflow ID from main flows';
COMMENT ON COLUMN device_flows.subflow_name IS 'Human-readable subflow name';
COMMENT ON COLUMN device_flows.flows IS 'Array of subflow nodes (subflow + child nodes)';
COMMENT ON COLUMN device_flows.settings IS 'Device-specific settings and configuration';
COMMENT ON COLUMN device_flows.modules IS 'Required npm modules for this subflow';
COMMENT ON COLUMN device_flows.hash IS 'SHA-256 hash of flows for change detection';
COMMENT ON COLUMN device_flows.version IS 'Incremented on each update';
COMMENT ON COLUMN device_flows.deployed_at IS 'Timestamp when last pushed to device via MQTT';
