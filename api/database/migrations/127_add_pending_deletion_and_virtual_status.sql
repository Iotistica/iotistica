-- Migration: Add pending_deletion and virtual to deployment_status constraint
-- Purpose: 
--   - pending_deletion: Support soft delete pattern with agent reconciliation
--   - virtual: Support virtual devices for simulation/testing (future feature)
-- Pattern: 
--   - Soft delete: Device marked for deletion → agent stops it → hard delete on confirmation
--   - Virtual device: Simulated devices for testing without physical hardware
-- Date: 2026-01-21

BEGIN;

-- ============================================================================
-- Drop existing constraint
-- ============================================================================
ALTER TABLE device_sensors 
DROP CONSTRAINT IF EXISTS chk_deployment_status;

-- ============================================================================
-- Recreate constraint with pending_deletion and virtual added
-- ============================================================================
ALTER TABLE device_sensors 
ADD CONSTRAINT chk_deployment_status 
CHECK (deployment_status IN (
  'pending',           -- Waiting for initial deployment
  'deployed',          -- Successfully deployed and running
  'failed',            -- Deployment failed
  'reconciling',       -- Agent is applying changes
  'pending_deletion',  -- Marked for deletion, waiting for agent confirmation
  'virtual'            -- Virtual/simulated device for testing
));

-- ============================================================================
-- Completion
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ Migration complete: Added pending_deletion and virtual deployment statuses';
    RAISE NOTICE '   Updated deployment_status constraint to include:';
    RAISE NOTICE '     - pending_deletion (soft delete pattern)';
    RAISE NOTICE '     - virtual (virtual/simulated devices)';
END $$;

COMMIT;
