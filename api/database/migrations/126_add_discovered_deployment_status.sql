-- Migration: Add 'discovered' deployment status
-- Purpose: Allow 'discovered' status for sensors found by agent during reconciliation
-- Pattern: Separates initial discovery from deployment confirmation
-- Date: 2026-01-20

-- ============================================================================
-- Drop existing constraint
-- ============================================================================
ALTER TABLE device_sensors 
DROP CONSTRAINT IF EXISTS chk_deployment_status;

-- ============================================================================
-- Add new constraint with 'discovered' status
-- ============================================================================
ALTER TABLE device_sensors 
ADD CONSTRAINT chk_deployment_status 
CHECK (deployment_status IN ('draft', 'saved-draft', 'pending', 'reconciling', 'discovered', 'deployed', 'failed'));

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN device_sensors.deployment_status IS 'Deployment status: draft (local only), saved-draft (saved but not deployed), pending (awaiting deployment), reconciling (being synced), discovered (found by agent, initial state), deployed (confirmed by agent after changes), failed (deployment error)';
