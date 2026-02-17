-- Migration: 154_drop_fleet_id_constraints.sql
-- Purpose: Drop NOT NULL and UNIQUE constraints on fleet_id to eliminate legacy fleet_id usage
-- Date: 2026-02-17
-- Rationale: Fleet identification now uses fleet_uuid exclusively. fleet_id kept as nullable for historical data only.

BEGIN;

-- Drop UNIQUE constraint on fleet_id if it exists
ALTER TABLE fleets DROP CONSTRAINT IF EXISTS fleets_fleet_id_key;

-- Make fleet_id nullable (remove NOT NULL constraint)
ALTER TABLE fleets ALTER COLUMN fleet_id DROP NOT NULL;

-- Verify the column now allows NULL values
COMMENT ON COLUMN fleets.fleet_id IS 'Legacy column - nullable. Use fleet_uuid for all new operations.';

COMMIT;
