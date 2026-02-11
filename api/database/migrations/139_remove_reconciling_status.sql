-- Migration: Remove 'reconciling' status (legacy)
-- Change all 'reconciling' to 'deployed' since reconciling meant agent was applying changes

UPDATE device_sensors 
SET deployment_status = 'deployed',
    updated_at = NOW()
WHERE deployment_status = 'reconciling';

-- Update check constraint to remove 'reconciling'
ALTER TABLE device_sensors 
DROP CONSTRAINT IF EXISTS chk_deployment_status;

ALTER TABLE device_sensors 
ADD CONSTRAINT chk_deployment_status 
CHECK (deployment_status IN (
  'pending',           -- Waiting for initial deployment
  'deployed',          -- Successfully deployed and running
  'failed',            -- Deployment failed
  'pending_deletion',  -- Marked for deletion, waiting for agent confirmation
  'virtual',           -- Virtual/simulated device for testing
  'draft'              -- Saved in config but not yet deployed (React state only, shouldn't be in DB)
));
