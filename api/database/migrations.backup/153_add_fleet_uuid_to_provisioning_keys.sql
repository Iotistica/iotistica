-- Migration: 153_add_fleet_uuid_to_provisioning_keys.sql
-- Purpose: Add fleet_uuid to provisioning_keys table and migrate from fleet_id to fleet_uuid relationships
-- Date: 2026-02-17
-- Author: AI Assistant
--
-- Changes:
-- 1. Add fleet_uuid column to provisioning_keys table
-- 2. Backfill fleet_uuid by joining with fleets table on fleet_id
-- 3. Add index for performance
-- 4. Keep fleet_id for backward compatibility during transition
-- 5. Add NOT NULL constraint after successful backfill

BEGIN;

-- ============================================================================
-- Step 1: Add fleet_uuid column to provisioning_keys table
-- ============================================================================

ALTER TABLE provisioning_keys
  ADD COLUMN IF NOT EXISTS fleet_uuid UUID;

COMMENT ON COLUMN provisioning_keys.fleet_uuid IS 'UUID reference to fleets.fleet_uuid (preferred over fleet_id)';

-- ============================================================================
-- Step 2: Backfill fleet_uuid from existing fleet_id relationships
-- ============================================================================

-- Report on provisioning keys before backfill
DO $$
DECLARE
  total_keys INTEGER;
  keys_with_fleet_id INTEGER;
  keys_without_fleet_id INTEGER;
  orphaned_keys INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_keys FROM provisioning_keys WHERE is_active = true;
  
  SELECT COUNT(*) INTO keys_with_fleet_id 
  FROM provisioning_keys 
  WHERE is_active = true AND fleet_id IS NOT NULL AND fleet_id != '';
  
  SELECT COUNT(*) INTO keys_without_fleet_id 
  FROM provisioning_keys 
  WHERE is_active = true AND (fleet_id IS NULL OR fleet_id = '');
  
  SELECT COUNT(*) INTO orphaned_keys
  FROM provisioning_keys pk
  LEFT JOIN fleets f ON pk.fleet_id = f.fleet_id
  WHERE pk.is_active = true 
    AND pk.fleet_id IS NOT NULL 
    AND pk.fleet_id != ''
    AND f.fleet_id IS NULL;
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Fleet UUID Migration - Provisioning Keys Table';
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Total active provisioning keys: %', total_keys;
  RAISE NOTICE 'Keys with fleet_id: %', keys_with_fleet_id;
  RAISE NOTICE 'Keys without fleet_id: %', keys_without_fleet_id;
  RAISE NOTICE 'Orphaned keys (fleet_id exists but fleet not found): %', orphaned_keys;
  RAISE NOTICE '';
  
  IF orphaned_keys > 0 THEN
    RAISE WARNING 'Found % orphaned provisioning key(s)! Run migration 151 first to create missing fleets.', orphaned_keys;
  END IF;
END $$;

-- Backfill fleet_uuid by joining with fleets table
UPDATE provisioning_keys pk
SET fleet_uuid = f.fleet_uuid
FROM fleets f
WHERE pk.fleet_id = f.fleet_id
  AND pk.fleet_uuid IS NULL
  AND pk.fleet_id IS NOT NULL
  AND pk.fleet_id != '';

-- Report backfill results
DO $$
DECLARE
  backfilled_count INTEGER;
  remaining_null INTEGER;
BEGIN
  SELECT COUNT(*) INTO backfilled_count
  FROM provisioning_keys
  WHERE fleet_uuid IS NOT NULL;
  
  SELECT COUNT(*) INTO remaining_null
  FROM provisioning_keys
  WHERE is_active = true 
    AND fleet_uuid IS NULL 
    AND fleet_id IS NOT NULL 
    AND fleet_id != '';
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Backfill Results:';
  RAISE NOTICE '================================================';
  RAISE NOTICE '✓ Provisioning keys with fleet_uuid set: %', backfilled_count;
  
  IF remaining_null > 0 THEN
    RAISE WARNING '% active provisioning key(s) still have NULL fleet_uuid despite having fleet_id!', remaining_null;
    RAISE NOTICE 'This likely means the fleet_id references non-existent fleets.';
    RAISE NOTICE 'Run migration 151 to create missing fleet records.';
  ELSE
    RAISE NOTICE '✓ All provisioning keys with fleet_id now have fleet_uuid';
  END IF;
  RAISE NOTICE '';
END $$;

-- ============================================================================
-- Step 3: Create indexes for performance
-- ============================================================================

-- Index for fleet_uuid lookups (primary index)
CREATE INDEX IF NOT EXISTS idx_provisioning_keys_fleet_uuid ON provisioning_keys(fleet_uuid);

-- Composite index for common queries (fleet + active status)
CREATE INDEX IF NOT EXISTS idx_provisioning_keys_fleet_uuid_active 
ON provisioning_keys(fleet_uuid, is_active) 
WHERE fleet_uuid IS NOT NULL;

-- ============================================================================
-- Step 4: Add foreign key constraint (optional - uncomment if strict referential integrity desired)
-- ============================================================================

-- NOTE: This constraint will prevent provisioning keys from having invalid fleet_uuid references
-- Only enable after confirming all fleet_uuid values are valid

-- ALTER TABLE provisioning_keys
--   ADD CONSTRAINT fk_provisioning_keys_fleet_uuid 
--   FOREIGN KEY (fleet_uuid) 
--   REFERENCES fleets(fleet_uuid) 
--   ON DELETE CASCADE
--   ON UPDATE CASCADE;

-- COMMENT ON CONSTRAINT fk_provisioning_keys_fleet_uuid ON provisioning_keys IS 
--   'Ensures provisioning key fleet_uuid references valid fleet record';

-- ============================================================================
-- Step 5: Create helper view for transition period
-- ============================================================================

-- View showing provisioning keys with both fleet_id and fleet_uuid for debugging
CREATE OR REPLACE VIEW provisioning_key_fleet_references AS
SELECT 
  pk.id as key_id,
  pk.description,
  pk.fleet_id as legacy_fleet_id,
  pk.fleet_uuid,
  f.fleet_name,
  f.fleet_type,
  pk.max_devices,
  pk.devices_provisioned,
  pk.is_active,
  pk.expires_at,
  CASE 
    WHEN pk.fleet_id IS NULL AND pk.fleet_uuid IS NULL THEN 'no_fleet'
    WHEN pk.fleet_id IS NOT NULL AND pk.fleet_uuid IS NULL THEN 'orphaned_fleet_id'
    WHEN pk.fleet_id IS NULL AND pk.fleet_uuid IS NOT NULL THEN 'uuid_only'
    WHEN pk.fleet_id IS NOT NULL AND pk.fleet_uuid IS NOT NULL AND f.fleet_id IS NOT NULL THEN 'migrated'
    WHEN pk.fleet_id IS NOT NULL AND pk.fleet_uuid IS NOT NULL AND f.fleet_id IS NULL THEN 'invalid_fleet_uuid'
    ELSE 'unknown'
  END as migration_status
FROM provisioning_keys pk
LEFT JOIN fleets f ON pk.fleet_uuid = f.fleet_uuid
ORDER BY pk.created_at DESC;

COMMENT ON VIEW provisioning_key_fleet_references IS 
  'Helper view showing provisioning key fleet references during migration from fleet_id to fleet_uuid. Check migration_status column for issues.';

-- ============================================================================
-- Step 6: Add NOT NULL constraint to fleet_uuid after successful backfill
-- ============================================================================

-- NOTE: Uncomment this section AFTER confirming all active provisioning keys have fleet_uuid

-- DO $$
-- DECLARE
--   orphaned_count INTEGER;
-- BEGIN
--   SELECT COUNT(*) INTO orphaned_count
--   FROM provisioning_keys
--   WHERE is_active = true AND fleet_uuid IS NULL;
--   
--   IF orphaned_count = 0 THEN
--     ALTER TABLE provisioning_keys
--       ALTER COLUMN fleet_uuid SET NOT NULL;
--     
--     RAISE NOTICE '✓ Added NOT NULL constraint to provisioning_keys.fleet_uuid';
--   ELSE
--     RAISE WARNING 'Cannot add NOT NULL constraint: % active key(s) still have NULL fleet_uuid', orphaned_count;
--   END IF;
-- END $$;

-- ============================================================================
-- Step 7: Migration verification query
-- ============================================================================

-- Query to verify migration success
-- Run this after applying the migration:
--
-- SELECT 
--   migration_status, 
--   COUNT(*) as count,
--   STRING_AGG(key_id::text, ', ') as key_ids
-- FROM provisioning_key_fleet_references
-- GROUP BY migration_status
-- ORDER BY count DESC;
--
-- Expected result after successful migration:
-- migration_status | count | key_ids
-- -----------------+-------+--------
-- migrated         |  XXX  | ...
--
-- If you see 'orphaned_fleet_id' or 'no_fleet', investigate those keys

COMMIT;

-- ============================================================================
-- Post-Migration Notes
-- ============================================================================
--
-- 1. After this migration, provisioning_keys table will have both fleet_id and fleet_uuid
-- 2. Application code should be updated to use fleet_uuid instead of fleet_id
-- 3. Legacy fleet_id column can be made nullable after full transition
-- 4. Eventually fleet_id can be dropped entirely after confirming no dependencies
--
-- To make fleet_id nullable (Phase 3):
-- ALTER TABLE provisioning_keys ALTER COLUMN fleet_id DROP NOT NULL;
--
-- To eventually drop fleet_id (Phase 4 - after all code migrated):
-- ALTER TABLE provisioning_keys DROP COLUMN fleet_id;
-- DROP INDEX IF EXISTS idx_provisioning_keys_fleet_id;
