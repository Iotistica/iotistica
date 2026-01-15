-- Migration: Add endpoint health tracking to device_sensors
-- Purpose: Store real-time health status reported by agents (connected, lastPoll, errors)
-- Date: 2026-01-15

BEGIN;

-- ============================================================================
-- Add health columns to device_sensors
-- ============================================================================
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_status VARCHAR(50); -- 'connected', 'disconnected', 'error', 'disabled'
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_connected BOOLEAN;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_last_poll TIMESTAMPTZ;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_error_count INTEGER DEFAULT 0;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_last_error TEXT;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS health_updated_at TIMESTAMPTZ;

-- ============================================================================
-- Create indexes for efficient health queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_device_sensors_health_status 
  ON device_sensors(health_status) WHERE health_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_sensors_health_updated 
  ON device_sensors(device_uuid, health_updated_at DESC) WHERE health_updated_at IS NOT NULL;

-- Index for dashboard queries (device + protocol + health)
CREATE INDEX IF NOT EXISTS idx_device_sensors_health_dashboard 
  ON device_sensors(device_uuid, protocol, health_status) WHERE health_status IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN device_sensors.health_status IS 'Current connection status: connected, disconnected, error, disabled';
COMMENT ON COLUMN device_sensors.health_connected IS 'Boolean connection state from adapter';
COMMENT ON COLUMN device_sensors.health_last_poll IS 'Timestamp of last successful poll';
COMMENT ON COLUMN device_sensors.health_error_count IS 'Cumulative error count';
COMMENT ON COLUMN device_sensors.health_last_error IS 'Most recent error message';
COMMENT ON COLUMN device_sensors.health_updated_at IS 'When health was last updated by agent';

-- ============================================================================
-- Completion
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ Migration complete: Added health tracking to device_sensors';
    RAISE NOTICE '   Columns added:';
    RAISE NOTICE '     - health_status (connected/disconnected/error/disabled)';
    RAISE NOTICE '     - health_connected (boolean state)';
    RAISE NOTICE '     - health_last_poll (last successful poll timestamp)';
    RAISE NOTICE '     - health_error_count (cumulative errors)';
    RAISE NOTICE '     - health_last_error (error message)';
    RAISE NOTICE '     - health_updated_at (last health update timestamp)';
    RAISE NOTICE '   Indexes created:';
    RAISE NOTICE '     - idx_device_sensors_health_status';
    RAISE NOTICE '     - idx_device_sensors_health_updated';
    RAISE NOTICE '     - idx_device_sensors_health_dashboard';
    RAISE NOTICE '';
    RAISE NOTICE '   Health data updated automatically from agent state reports';
END $$;

COMMIT;
