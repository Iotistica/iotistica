-- Add discovered baseline columns to device_sensors table
-- These columns store the original discovered values so we can detect user modifications

ALTER TABLE device_sensors
ADD COLUMN IF NOT EXISTS discovered_connection JSONB,
ADD COLUMN IF NOT EXISTS discovered_data_points JSONB,
ADD COLUMN IF NOT EXISTS discovered_enabled BOOLEAN,
ADD COLUMN IF NOT EXISTS discovered_poll_interval INTEGER;

-- For existing records, copy current values to discovered_* columns
-- (assumes current values are the baseline if no modification yet)
UPDATE device_sensors
SET 
  discovered_connection = connection,
  discovered_data_points = data_points,
  discovered_enabled = enabled,
  discovered_poll_interval = poll_interval
WHERE 
  discovered_connection IS NULL
  AND synced_to_config = FALSE; -- Only for non-modified records

COMMENT ON COLUMN device_sensors.discovered_connection IS 'Original connection from discovery - used to detect user modifications';
COMMENT ON COLUMN device_sensors.discovered_data_points IS 'Original data points from discovery - used to detect user modifications';
COMMENT ON COLUMN device_sensors.discovered_enabled IS 'Original enabled state from discovery - used to detect user modifications';
COMMENT ON COLUMN device_sensors.discovered_poll_interval IS 'Original poll interval from discovery - used to detect user modifications';
