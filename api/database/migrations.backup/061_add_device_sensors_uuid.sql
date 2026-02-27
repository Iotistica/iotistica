-- Migration: Add UUID to device_sensors table
-- Purpose: Provide stable identifier for cloud/edge sync (name can change)
-- Date: 2025-11-18

BEGIN;

-- ============================================================================
-- Add uuid column
-- ============================================================================
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;

-- Generate UUIDs for existing sensors
UPDATE device_sensors SET uuid = gen_random_uuid() WHERE uuid IS NULL;

-- Make uuid NOT NULL
ALTER TABLE device_sensors ALTER COLUMN uuid SET NOT NULL;

-- Add index for fast lookups
CREATE INDEX IF NOT EXISTS idx_device_sensors_uuid ON device_sensors(uuid);

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN device_sensors.uuid IS 'Stable identifier for cloud/edge sync. Never changes even if name is updated.';

-- ============================================================================
-- Completion
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ Migration complete: Added UUID column to device_sensors';
    RAISE NOTICE '   - Generated UUIDs for existing sensors';
    RAISE NOTICE '   - Created unique index on uuid';
    RAISE NOTICE '   - Use uuid (not name) for sync between cloud and edge';
END
$$;

COMMIT;
