-- Migration: Add Deployment Tracking to device_target_state
-- Enables version-based deployment workflow with explicit deploy step

BEGIN;

-- Add deployment tracking columns to device_target_state
ALTER TABLE device_target_state 
  ADD COLUMN IF NOT EXISTS needs_deployment BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_deployed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deployed_by VARCHAR(255);

-- Add comments for documentation
COMMENT ON COLUMN device_target_state.needs_deployment IS 'Flag indicating configuration has changed but not deployed to device yet';
COMMENT ON COLUMN device_target_state.last_deployed_at IS 'Timestamp of last deployment (version increment)';
COMMENT ON COLUMN device_target_state.deployed_by IS 'User/system that triggered the deployment (e.g., dashboard, api, automation)';

-- Create index for querying devices needing deployment
CREATE INDEX IF NOT EXISTS idx_device_target_state_needs_deployment 
  ON device_target_state(needs_deployment) 
  WHERE needs_deployment = true;

-- Create index for deployment audit queries
CREATE INDEX IF NOT EXISTS idx_device_target_state_deployed_at 
  ON device_target_state(last_deployed_at DESC);

-- Update existing records: mark all as already deployed (migration safety)
UPDATE device_target_state 
SET 
  needs_deployment = false,
  last_deployed_at = COALESCE(updated_at, created_at),
  deployed_by = 'migration'
WHERE needs_deployment IS NULL;

COMMIT;

-- Display summary
SELECT 
  'Deployment tracking columns added' as status,
  (SELECT COUNT(*) FROM device_target_state WHERE needs_deployment = false) as devices_marked_deployed,
  'Ready for version-based deployment workflow' as next_step;
