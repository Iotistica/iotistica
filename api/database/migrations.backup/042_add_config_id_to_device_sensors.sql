-- Migration: Add config_id to device_sensors table
-- Purpose: Track stable UUID from config through to deployed state
-- Date: 2025-11-02

-- ============================================================================
-- Add config_id column
-- ============================================================================
ALTER TABLE device_sensors 
ADD COLUMN IF NOT EXISTS config_id UUID;

-- ============================================================================
-- Create index for efficient lookups
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_device_sensors_config_id 
ON device_sensors(config_id);

-- ============================================================================
-- Optional: Make config_id unique per device (one config_id can't be deployed twice)
-- ============================================================================
-- Commented out for now - decide if config_id should be globally unique
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_device_sensors_config_id 
-- ON device_sensors(config_id) WHERE config_id IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN device_sensors.config_id IS 'UUID from config JSON - stable tracking ID from creation through deployment lifecycle. Generated client-side, persists through all states.';

-- ============================================================================
-- Backfill existing rows (optional - will be NULL for old sensors)
-- ============================================================================
-- Note: Existing sensors without config_id will have NULL
-- New sensors will have config_id populated from config JSON during sync
