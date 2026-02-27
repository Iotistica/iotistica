-- Migration: Add API key rotation support
-- Created: 2025-10-18
-- Purpose: Enable automatic periodic device API key rotation for enhanced security

-- Add key rotation tracking columns to devices table
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_expires_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_last_rotated_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_rotation_enabled BOOLEAN DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_key_rotation_days INTEGER DEFAULT 90;

CREATE INDEX IF NOT EXISTS idx_devices_api_key_expires_at ON devices(api_key_expires_at) 
WHERE api_key_expires_at IS NOT NULL AND is_active = true;

COMMENT ON COLUMN devices.api_key_expires_at IS 'When the current API key expires (NULL = never expires)';
COMMENT ON COLUMN devices.api_key_last_rotated_at IS 'Timestamp of last successful key rotation';
COMMENT ON COLUMN devices.api_key_rotation_enabled IS 'Whether automatic rotation is enabled for this device';
COMMENT ON COLUMN devices.api_key_rotation_days IS 'Number of days before key expires and rotation is needed';

-- Device API key history table (for tracking rotations and emergency rollback)
CREATE TABLE IF NOT EXISTS device_api_key_history (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    revoked_at TIMESTAMP,
    revoked_reason VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_device_key_history_device_uuid ON device_api_key_history(device_uuid);
CREATE INDEX idx_device_key_history_issued_at ON device_api_key_history(issued_at DESC);
CREATE INDEX idx_device_key_history_is_active ON device_api_key_history(is_active);

COMMENT ON TABLE device_api_key_history IS 'History of device API keys for rotation tracking and rollback';
COMMENT ON COLUMN device_api_key_history.is_active IS 'Whether this key is currently active (supports grace period)';

-- Audit log for key rotation events
INSERT INTO audit_logs (event_type, severity, details)
VALUES ('api_key_rotation_enabled', 'info', '{"message": "API key rotation system initialized"}')
ON CONFLICT DO NOTHING;

-- Function to automatically archive old API key when rotating
CREATE OR REPLACE FUNCTION archive_device_api_key()
RETURNS TRIGGER AS $$
BEGIN
    -- Only archive if key actually changed
    IF OLD.device_api_key_hash IS DISTINCT FROM NEW.device_api_key_hash THEN
        INSERT INTO device_api_key_history (
            device_uuid,
            key_hash,
            issued_at,
            expires_at,
            is_active
        ) VALUES (
            OLD.uuid,
            OLD.device_api_key_hash,
            OLD.api_key_last_rotated_at,
            OLD.api_key_expires_at,
            false  -- Old key is no longer active
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to archive old key on rotation
DROP TRIGGER IF EXISTS trigger_archive_device_api_key ON devices;
CREATE TRIGGER trigger_archive_device_api_key
    BEFORE UPDATE OF device_api_key_hash ON devices
    FOR EACH ROW
    WHEN (OLD.device_api_key_hash IS DISTINCT FROM NEW.device_api_key_hash)
    EXECUTE FUNCTION archive_device_api_key();

-- View for devices needing rotation (keys expiring soon)
CREATE OR REPLACE VIEW devices_needing_rotation AS
SELECT 
    d.id,
    d.uuid,
    d.device_name,
    d.api_key_expires_at,
    d.api_key_last_rotated_at,
    d.api_key_rotation_days,
    EXTRACT(DAY FROM (d.api_key_expires_at - NOW())) as days_until_expiry
FROM devices d
WHERE 
    d.is_active = true
    AND d.api_key_rotation_enabled = true
    AND d.api_key_expires_at IS NOT NULL
    AND d.api_key_expires_at <= NOW() + INTERVAL '7 days'  -- Rotate if expiring within 7 days
ORDER BY d.api_key_expires_at ASC;

COMMENT ON VIEW devices_needing_rotation IS 'Devices with API keys that need rotation soon (within 7 days)';

-- Set expiry for existing devices (90 days from now)
UPDATE devices 
SET 
    api_key_expires_at = NOW() + INTERVAL '90 days',
    api_key_rotation_days = 90,
    api_key_rotation_enabled = true
WHERE 
    is_active = true 
    AND device_api_key_hash IS NOT NULL
    AND api_key_expires_at IS NULL;
