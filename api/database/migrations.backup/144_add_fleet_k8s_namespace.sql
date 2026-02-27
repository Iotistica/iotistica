-- Migration: 144_add_fleet_k8s_namespace.sql
-- Purpose: Add K8s namespace tracking for virtual fleets
-- Date: 2026-02-14

BEGIN;

-- Add K8s namespace column to track fleet's dedicated namespace
ALTER TABLE fleets 
ADD COLUMN IF NOT EXISTS k8s_namespace VARCHAR(63);

-- Add index for namespace lookups
CREATE INDEX IF NOT EXISTS idx_fleets_k8s_namespace ON fleets(k8s_namespace) WHERE k8s_namespace IS NOT NULL;

-- Add comment
COMMENT ON COLUMN fleets.k8s_namespace IS 'Kubernetes namespace for this fleet (virtual fleets only). Format: fleet-{fleet_id}';

COMMIT;
