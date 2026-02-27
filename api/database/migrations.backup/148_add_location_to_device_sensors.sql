-- Migration: Add location field to device_sensors table
-- Purpose: Store physical location for endpoint devices (Modbus, OPC-UA, etc.)
-- Supports Azure Digital Twins integration for endpoint devices

-- ============================================================================
-- Add location to device_sensors table
-- ============================================================================
ALTER TABLE device_sensors 
ADD COLUMN IF NOT EXISTS location TEXT;

CREATE INDEX IF NOT EXISTS idx_device_sensors_location ON device_sensors(location) WHERE location IS NOT NULL;

COMMENT ON COLUMN device_sensors.location IS 'Physical or geographic location of the endpoint device (e.g., "Building A, Floor 2, Room 201" or "Production Line 3, Station 5")';

-- ============================================================================
-- Migration complete
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ Migration 148 complete: Added location column to device_sensors table';
END
$$;
