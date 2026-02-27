-- Migration 138: Migrate 'saved-draft' deployment status to 'draft'
-- Purpose: Simplify deployment status by removing 'saved-draft' state
-- Date: 2026-02-10

-- Update existing records
UPDATE device_sensors 
SET deployment_status = 'draft' 
WHERE deployment_status = 'saved-draft';

-- Clean up any references in metadata or logs (if needed)
COMMENT ON COLUMN device_sensors.deployment_status IS 
'Deployment lifecycle: draft → pending → deployed/reconciling/failed. Agent sets to deployed/reconciling based on actual state.';
