-- ========================================
-- UPDATE ANOMALY DEVICE TYPE CONSTRAINT
-- ========================================
-- Update device_type constraint to use standardized protocol names:
-- - 'mqtt' instead of 'mqtt-sensor'
-- - 'system' instead of 'agent-system'
-- - Keep modbus, opcua, bacnet as-is
--
-- Rationale: Align with agent Protocol type definition and remove redundant suffixes

-- Drop old constraint
ALTER TABLE anomaly_events 
  DROP CONSTRAINT IF EXISTS anomaly_events_device_type_check;

-- Add new constraint with updated protocol types
ALTER TABLE anomaly_events 
  ADD CONSTRAINT anomaly_events_device_type_check 
  CHECK (device_type IN ('modbus', 'opcua', 'bacnet', 'mqtt', 'system'));

-- Update existing rows (if any exist with old values)
-- This is safe since 'mqtt-sensor' and 'agent-system' may not exist yet
UPDATE anomaly_events 
SET device_type = 'mqtt' 
WHERE device_type = 'mqtt-sensor';

UPDATE anomaly_events 
SET device_type = 'system' 
WHERE device_type = 'agent-system';

COMMENT ON COLUMN anomaly_events.device_type IS 'Protocol/source type: modbus, opcua, bacnet, mqtt, system';
