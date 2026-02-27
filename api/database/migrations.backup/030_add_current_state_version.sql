-- Add version tracking to device_current_state
-- This allows us to determine if device has applied the latest target_state

ALTER TABLE device_current_state
ADD COLUMN version INTEGER DEFAULT 0;

-- Add index for version queries
CREATE INDEX idx_device_current_state_version ON device_current_state(version);

COMMENT ON COLUMN device_current_state.version IS 'Version of target_state that device has applied';
