-- ========================================
-- UPDATE ANOMALY DEVICE TYPE CONSTRAINT
-- ========================================
-- Update device_type constraint to match agent protocol types
-- 
-- Change: 'mqtt-sensor' → 'mqtt', 'agent-system' → 'system'
-- Reason: Agent uses standardized protocol types ('modbus', 'opcua', 'bacnet', 'mqtt', 'system')
--         No need for code-level mapping if DB accepts the same values

-- Drop old constraint
ALTER TABLE anomaly_events 
  DROP CONSTRAINT IF EXISTS anomaly_events_device_type_check;

-- Add new constraint with updated protocol types
ALTER TABLE anomaly_events 
  ADD CONSTRAINT anomaly_events_device_type_check 
  CHECK (device_type IN ('modbus', 'opcua', 'bacnet', 'mqtt', 'system'));

-- Update existing rows (if any exist with old values)
UPDATE anomaly_events 
SET device_type = 'mqtt' 
WHERE device_type = 'mqtt-sensor';

UPDATE anomaly_events 
SET device_type = 'system' 
WHERE device_type = 'agent-system';

-- Add comment explaining protocol types
COMMENT ON COLUMN anomaly_events.device_type IS 'Protocol/source type: modbus, opcua, bacnet, mqtt (sensors), system (agent metrics)';
