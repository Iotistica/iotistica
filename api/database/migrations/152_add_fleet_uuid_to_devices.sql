-- Migration: 152_add_fleet_uuid_to_devices.sql
-- Purpose: Add fleet_uuid to devices table and migrate from fleet_id to fleet_uuid relationships
-- Date: 2026-02-17
-- Author: AI Assistant
--
-- Changes:
-- 1. Add fleet_uuid column to devices table
-- 2. Backfill fleet_uuid by joining with fleets table on fleet_id
-- 3. Add index for performance
-- 4. Keep fleet_id for backward compatibility during transition

BEGIN;

-- ============================================================================
-- Step 1: Add fleet_uuid column to devices table
-- ============================================================================

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS fleet_uuid UUID;

COMMENT ON COLUMN devices.fleet_uuid IS 'UUID reference to fleets.fleet_uuid (preferred over fleet_id)';

-- ============================================================================
-- Step 2: Backfill fleet_uuid from existing fleet_id relationships
-- ============================================================================

-- Report on devices before backfill
DO $$
DECLARE
  total_devices INTEGER;
  devices_with_fleet_id INTEGER;
  devices_without_fleet_id INTEGER;
  orphaned_devices INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_devices FROM devices WHERE is_active = true;
  
  SELECT COUNT(*) INTO devices_with_fleet_id 
  FROM devices 
  WHERE is_active = true AND fleet_id IS NOT NULL AND fleet_id != '';
  
  SELECT COUNT(*) INTO devices_without_fleet_id 
  FROM devices 
  WHERE is_active = true AND (fleet_id IS NULL OR fleet_id = '');
  
  SELECT COUNT(*) INTO orphaned_devices
  FROM devices d
  LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
  WHERE d.is_active = true 
    AND d.fleet_id IS NOT NULL 
    AND d.fleet_id != ''
    AND f.fleet_id IS NULL;
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Fleet UUID Migration - Devices Table';
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Total active devices: %', total_devices;
  RAISE NOTICE 'Devices with fleet_id: %', devices_with_fleet_id;
  RAISE NOTICE 'Devices without fleet_id: %', devices_without_fleet_id;
  RAISE NOTICE 'Orphaned devices (fleet_id exists but fleet not found): %', orphaned_devices;
  RAISE NOTICE '';
  
  IF orphaned_devices > 0 THEN
    RAISE WARNING 'Found % orphaned device(s)! Run migration 151 first to create missing fleets.', orphaned_devices;
  END IF;
END $$;

-- Backfill fleet_uuid by joining with fleets table
UPDATE devices d
SET fleet_uuid = f.fleet_uuid
FROM fleets f
WHERE d.fleet_id = f.fleet_id
  AND d.fleet_uuid IS NULL
  AND d.fleet_id IS NOT NULL
  AND d.fleet_id != '';

-- Report backfill results
DO $$
DECLARE
  backfilled_count INTEGER;
  remaining_null INTEGER;
BEGIN
  SELECT COUNT(*) INTO backfilled_count
  FROM devices
  WHERE fleet_uuid IS NOT NULL;
  
  SELECT COUNT(*) INTO remaining_null
  FROM devices
  WHERE is_active = true 
    AND fleet_uuid IS NULL 
    AND fleet_id IS NOT NULL 
    AND fleet_id != '';
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Backfill Results:';
  RAISE NOTICE '================================================';
  RAISE NOTICE '✓ Devices with fleet_uuid set: %', backfilled_count;
  
  IF remaining_null > 0 THEN
    RAISE WARNING '% active device(s) still have NULL fleet_uuid despite having fleet_id!', remaining_null;
    RAISE NOTICE 'This likely means the fleet_id references non-existent fleets.';
    RAISE NOTICE 'Run migration 151 to create missing fleet records.';
  ELSE
    RAISE NOTICE '✓ All devices with fleet_id now have fleet_uuid';
  END IF;
  RAISE NOTICE '';
END $$;

-- ============================================================================
-- Step 3: Create indexes for performance
-- ============================================================================

-- Index for fleet_uuid lookups (primary index)
CREATE INDEX IF NOT EXISTS idx_devices_fleet_uuid ON devices(fleet_uuid);

-- Composite index for common queries (fleet + status)
CREATE INDEX IF NOT EXISTS idx_devices_fleet_uuid_status 
ON devices(fleet_uuid, is_online, is_active) 
WHERE fleet_uuid IS NOT NULL;

-- ============================================================================
-- Step 4: Add foreign key constraint (optional - uncomment if strict referential integrity desired)
-- ============================================================================

-- NOTE: This constraint will prevent devices from having invalid fleet_uuid references
-- Only enable after confirming all fleet_uuid values are valid

-- ALTER TABLE devices
--   ADD CONSTRAINT fk_devices_fleet_uuid 
--   FOREIGN KEY (fleet_uuid) 
--   REFERENCES fleets(fleet_uuid) 
--   ON DELETE SET NULL
--   ON UPDATE CASCADE;

-- COMMENT ON CONSTRAINT fk_devices_fleet_uuid ON devices IS 
--   'Ensures device fleet_uuid references valid fleet record';

-- ============================================================================
-- Step 5: Create helper view for transition period
-- ============================================================================

-- View showing devices with both fleet_id and fleet_uuid for debugging
CREATE OR REPLACE VIEW device_fleet_references AS
SELECT 
  d.uuid as device_uuid,
  d.device_name,
  d.device_type,
  d.fleet_id as legacy_fleet_id,
  d.fleet_uuid,
  f.fleet_name,
  f.fleet_type,
  CASE 
    WHEN d.fleet_uuid IS NULL AND d.fleet_id IS NOT NULL THEN 'missing_uuid'
    WHEN d.fleet_uuid IS NOT NULL AND d.fleet_id IS NULL THEN 'missing_id'
    WHEN d.fleet_uuid IS NULL AND d.fleet_id IS NULL THEN 'no_fleet'
    WHEN d.fleet_uuid IS NOT NULL AND d.fleet_id IS NOT NULL AND f.fleet_uuid IS NOT NULL THEN 'valid'
    ELSE 'inconsistent'
  END as reference_status
FROM devices d
LEFT JOIN fleets f ON d.fleet_uuid = f.fleet_uuid
ORDER BY reference_status, d.device_name;

COMMENT ON VIEW device_fleet_references IS 
  'Debug view showing device → fleet relationships during migration from fleet_id to fleet_uuid';

-- ============================================================================
-- Step 6: Verification query
-- ============================================================================

DO $$
DECLARE
  missing_uuid_count INTEGER;
  inconsistent_count INTEGER;
  valid_count INTEGER;
BEGIN
  -- Count devices with missing UUID
  SELECT COUNT(*) INTO missing_uuid_count
  FROM devices d
  WHERE d.is_active = true 
    AND d.fleet_id IS NOT NULL 
    AND d.fleet_id != ''
    AND d.fleet_uuid IS NULL;
  
  -- Count devices where fleet_uuid doesn't match fleet_id
  SELECT COUNT(*) INTO inconsistent_count
  FROM devices d
  INNER JOIN fleets f1 ON d.fleet_id = f1.fleet_id
  LEFT JOIN fleets f2 ON d.fleet_uuid = f2.fleet_uuid
  WHERE d.fleet_uuid IS NOT NULL 
    AND f1.fleet_uuid != d.fleet_uuid;
  
  -- Count valid relationships
  SELECT COUNT(*) INTO valid_count
  FROM devices d
  INNER JOIN fleets f ON d.fleet_uuid = f.fleet_uuid
  WHERE d.is_active = true;
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Migration Verification:';
  RAISE NOTICE '================================================';
  
  IF missing_uuid_count > 0 THEN
    RAISE WARNING '❌ % device(s) have fleet_id but missing fleet_uuid', missing_uuid_count;
  ELSE
    RAISE NOTICE '✓ All devices with fleet_id have fleet_uuid';
  END IF;
  
  IF inconsistent_count > 0 THEN
    RAISE WARNING '❌ % device(s) have mismatched fleet_id and fleet_uuid', inconsistent_count;
  ELSE
    RAISE NOTICE '✓ No inconsistent fleet references found';
  END IF;
  
  RAISE NOTICE '✓ % device(s) have valid fleet_uuid references', valid_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Migration complete! Query device_fleet_references view to debug any issues.';
  RAISE NOTICE '================================================';
END $$;

COMMIT;

-- ============================================================================
-- Post-Migration Notes
-- ============================================================================

-- To check for any issues after migration:
-- SELECT * FROM device_fleet_references WHERE reference_status != 'valid' AND reference_status != 'no_fleet';

-- To count devices by fleet using new UUID:
-- SELECT f.fleet_name, COUNT(d.uuid) as device_count
-- FROM fleets f
-- LEFT JOIN devices d ON d.fleet_uuid = f.fleet_uuid
-- GROUP BY f.fleet_uuid, f.fleet_name
-- ORDER BY device_count DESC;

-- To find devices that need manual cleanup:
-- SELECT * FROM devices 
-- WHERE is_active = true 
--   AND fleet_id IS NOT NULL 
--   AND fleet_uuid IS NULL;
