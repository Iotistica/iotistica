-- ========================================
-- ANOMALY DEVICE TRACKING
-- ========================================
-- CRITICAL FIX: Track monitored devices instead of agent UUIDs
--
-- Problem: The original schema stored agent UUIDs in device_id, which is
-- infrastructure info. Users care about which monitored device (e.g.,
-- "COMAP-Main-Controller", "Temp-Sensor-01") had the anomaly, not which
-- edge gateway reported it.
--
-- Solution: Add device_name and device_type fields to track the actual
-- monitored device/sensor, while keeping agent_uuid for infrastructure tracking.

-- ========================================
-- 1. UPDATE ANOMALY_EVENTS TABLE
-- ========================================

-- Rename device_id to agent_uuid for clarity (idempotent)
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'anomaly_events' AND column_name = 'device_id'
  ) THEN
    ALTER TABLE anomaly_events 
    RENAME COLUMN device_id TO agent_uuid;
  END IF;
END $$;

-- Add device tracking columns (idempotent)
ALTER TABLE anomaly_events 
  ADD COLUMN IF NOT EXISTS device_name TEXT NOT NULL DEFAULT 'Unknown',
  ADD COLUMN IF NOT EXISTS device_type TEXT CHECK (device_type IN ('modbus', 'opcua', 'bacnet', 'mqtt-sensor', 'agent-system'));

-- Update fingerprint documentation (breaking change - see notes below)
COMMENT ON COLUMN anomaly_events.fingerprint IS 'Hash of device+metric+method+severity for correlation. NOTE: Old fingerprints (without device) will not correlate with new ones.';

-- Add indexes for device queries
CREATE INDEX IF NOT EXISTS idx_anomaly_events_device_name 
  ON anomaly_events(device_name, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_device_type 
  ON anomaly_events(device_type, timestamp_ms DESC);

-- Update existing index naming (rename for clarity)
DROP INDEX IF EXISTS idx_anomaly_events_device_id;
CREATE INDEX IF NOT EXISTS idx_anomaly_events_agent_uuid 
  ON anomaly_events(agent_uuid, timestamp_ms DESC);

-- ========================================
-- 2. UPDATE ANOMALY_INCIDENTS TABLE
-- ========================================

-- Keep affected_devices column (already correct naming)
-- Add device identification columns (idempotent)
ALTER TABLE anomaly_incidents
  ADD COLUMN IF NOT EXISTS device_name TEXT NOT NULL DEFAULT 'Unknown',
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS affected_agents JSONB;

-- Add index for device queries
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_device_name 
  ON anomaly_incidents(device_name);

-- Add acknowledgment tracking columns (idempotent)
ALTER TABLE anomaly_incidents 
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by TEXT,
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_acknowledged_at 
  ON anomaly_incidents(acknowledged_at);

-- Update column documentation
COMMENT ON COLUMN anomaly_incidents.affected_devices IS 'JSONB array of monitored device names (e.g., ["COMAP-Main-Controller", "Temp-Sensor-01"])';
COMMENT ON COLUMN anomaly_incidents.affected_agents IS 'JSONB array of agent UUIDs for infrastructure tracking (e.g., ["agent-abc123", "agent-xyz789"])';
COMMENT ON COLUMN anomaly_incidents.device_name IS 'Primary device name for this incident';
COMMENT ON COLUMN anomaly_incidents.device_type IS 'Device source type: modbus, opcua, bacnet, mqtt-sensor, or agent-system';

-- ========================================
-- 3. UPDATE ANOMALY_ALERTS TABLE
-- ========================================

-- Keep affected_devices column (already correct naming)
-- Add device name for better alert context (idempotent)
ALTER TABLE anomaly_alerts
  ADD COLUMN IF NOT EXISTS device_name TEXT NOT NULL DEFAULT 'Unknown';

COMMENT ON COLUMN anomaly_alerts.affected_devices IS 'JSONB array of monitored device names';
COMMENT ON COLUMN anomaly_alerts.device_name IS 'Primary device name for this alert';

-- ========================================
-- MIGRATION NOTES
-- ========================================
--
-- BREAKING CHANGES:
-- 1. Fingerprint schema changed - old fingerprints (hash of metric+method+severity)
--    will NOT correlate with new fingerprints (hash of device+metric+method+severity).
--    Existing incidents may be duplicated until agents update their fingerprint logic.
--
-- 2. Default values applied:
--    - device_name = 'Unknown' for all existing events/incidents/alerts
--    - device_type = NULL for existing events/incidents
--
-- POST-MIGRATION ACTIONS REQUIRED:
-- 1. Update agent code to send deviceName and deviceType in anomaly events
-- 2. Update anomaly-handler.ts to use new schema (agentUuid, deviceName, deviceType)
-- 3. Consider manual cleanup: UPDATE anomaly_incidents WHERE device_name = 'Unknown'
--    to resolve existing data if device info can be inferred from fingerprint/metric
--
-- ROLLBACK (if needed):
--   ALTER TABLE anomaly_events RENAME COLUMN agent_uuid TO device_id;
--   ALTER TABLE anomaly_events DROP COLUMN device_name, DROP COLUMN device_type;
--   ALTER TABLE anomaly_incidents DROP COLUMN device_name, DROP COLUMN device_type, DROP COLUMN affected_agents;
--   ALTER TABLE anomaly_incidents DROP COLUMN acknowledged_at, DROP COLUMN acknowledged_by, DROP COLUMN resolution_notes;
--   ALTER TABLE anomaly_alerts DROP COLUMN device_name;
--
-- VERIFICATION QUERIES:
--   -- Check schema updated correctly
--   SELECT column_name, data_type, column_default 
--   FROM information_schema.columns 
--   WHERE table_name = 'anomaly_events' 
--   ORDER BY ordinal_position;
--
--   -- Check existing data migration
--   SELECT device_name, device_type, COUNT(*) 
--   FROM anomaly_events 
--   GROUP BY device_name, device_type;
--
--   -- Check incidents
--   SELECT device_name, device_type, status, COUNT(*) 
--   FROM anomaly_incidents 
--   GROUP BY device_name, device_type, status;
