-- Migration: Add deployment status tracking to device_sensors
-- Purpose: Track whether sensors are pending, deployed, or failed
-- Pattern: Supports Event Sourcing/CQRS reconciliation loop
-- Date: 2025-11-02

-- ============================================================================
-- Add deployment_status column
-- ============================================================================
ALTER TABLE device_sensors 
ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(20) DEFAULT 'pending';

-- ============================================================================
-- Add deployment tracking columns
-- ============================================================================
ALTER TABLE device_sensors 
ADD COLUMN IF NOT EXISTS last_deployed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS deployment_error TEXT,
ADD COLUMN IF NOT EXISTS deployment_attempts INTEGER DEFAULT 0;

-- ============================================================================
-- Update constraint for valid deployment statuses
-- ============================================================================
ALTER TABLE device_sensors 
ADD CONSTRAINT chk_deployment_status 
CHECK (deployment_status IN ('pending', 'deployed', 'failed', 'reconciling'));

-- ============================================================================
-- Create index for filtering by deployment status
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_device_sensors_deployment_status 
ON device_sensors(deployment_status);

CREATE INDEX IF NOT EXISTS idx_device_sensors_device_status 
ON device_sensors(device_uuid, deployment_status);

-- ============================================================================
-- Update existing rows to 'deployed' status
-- (Assume existing sensors are already deployed)
-- ============================================================================
UPDATE device_sensors 
SET deployment_status = 'deployed',
    last_deployed_at = updated_at
WHERE deployment_status IS NULL OR deployment_status = 'pending';

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN device_sensors.deployment_status IS 'Deployment status: pending (in config, not deployed), deployed (running on agent), failed (deployment error), reconciling (being synced)';
COMMENT ON COLUMN device_sensors.last_deployed_at IS 'Timestamp when sensor was last successfully deployed by agent';
COMMENT ON COLUMN device_sensors.deployment_error IS 'Last deployment error message if status is failed';
COMMENT ON COLUMN device_sensors.deployment_attempts IS 'Number of deployment attempts (for retry logic)';

-- ============================================================================
-- Create trigger to update last_deployed_at
-- ============================================================================
CREATE OR REPLACE FUNCTION update_sensor_deployment_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deployment_status = 'deployed' AND 
       (OLD.deployment_status IS NULL OR OLD.deployment_status != 'deployed') THEN
        NEW.last_deployed_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_sensor_deployment_timestamp
    BEFORE UPDATE ON device_sensors
    FOR EACH ROW
    EXECUTE FUNCTION update_sensor_deployment_timestamp();

-- ============================================================================
-- Grant permissions
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iotistic') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON device_sensors TO iotistic;
    END IF;
END
$$;
