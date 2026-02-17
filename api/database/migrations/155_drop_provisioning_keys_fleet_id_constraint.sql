-- Migration: 155_drop_provisioning_keys_fleet_id_constraint.sql
-- Purpose: Drop NOT NULL constraint on fleet_id to eliminate legacy fleet_id usage in provisioning_keys
-- Date: 2026-02-17
-- Rationale: Fleet identification now uses fleet_uuid exclusively. fleet_id kept as nullable for historical data only.

BEGIN;

-- Make fleet_id nullable (remove NOT NULL constraint)
ALTER TABLE provisioning_keys ALTER COLUMN fleet_id DROP NOT NULL;

-- Verify the column now allows NULL values
COMMENT ON COLUMN provisioning_keys.fleet_id IS 'Legacy column - nullable. Use fleet_uuid for all new operations.';

COMMIT;
