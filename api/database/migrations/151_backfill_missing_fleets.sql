-- Migration: 151_backfill_missing_fleets.sql
-- Purpose: Create fleet records for existing provisioned devices that have fleet_id but no matching fleet
-- Date: 2026-02-17
-- Author: AI Assistant
--
-- Problem: Devices provisioned with fleet_id from provisioning keys but no corresponding fleet record exists
-- Solution: Auto-create fleet records for orphaned devices so they appear in dashboard

BEGIN;

-- Show count of affected devices before backfill
DO $$
DECLARE
  orphaned_device_count INTEGER;
  orphaned_fleet_count INTEGER;
BEGIN
  -- Count devices with fleet_id but no matching fleet
  SELECT COUNT(*) INTO orphaned_device_count
  FROM devices d
  LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
  WHERE d.fleet_id IS NOT NULL 
    AND d.fleet_id != ''
    AND f.fleet_id IS NULL;
  
  -- Count distinct fleet_ids that need to be created
  SELECT COUNT(DISTINCT d.fleet_id) INTO orphaned_fleet_count
  FROM devices d
  LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
  WHERE d.fleet_id IS NOT NULL 
    AND d.fleet_id != ''
    AND f.fleet_id IS NULL;
  
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Fleet Backfill Migration';
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Devices without matching fleet: %', orphaned_device_count;
  RAISE NOTICE 'Fleet records to be created: %', orphaned_fleet_count;
  RAISE NOTICE '';
END $$;

-- Create missing fleet records for existing devices
INSERT INTO fleets (
  fleet_id,
  fleet_name,
  customer_id,
  fleet_type,
  description,
  status,
  created_at,
  created_by
)
SELECT DISTINCT
  d.fleet_id,
  -- Generate friendly fleet name from fleet_id
  CASE 
    WHEN d.fleet_id = 'default-fleet' THEN 'Default Fleet'
    WHEN d.fleet_id ~* '^fleet-[a-z0-9]+$' THEN 
      'Fleet ' || UPPER(SUBSTRING(d.fleet_id FROM 7 FOR 1)) || SUBSTRING(d.fleet_id FROM 8)
    ELSE INITCAP(REPLACE(d.fleet_id, '-', ' '))
  END as fleet_name,
  -- Default customer for single-tenant deployments
  '00000000-0000-0000-0000-000000000001'::uuid as customer_id,
  -- Determine fleet type from device types
  CASE 
    WHEN bool_and(d.device_type = 'virtual') THEN 'virtual'
    WHEN bool_and(d.device_type = 'physical') THEN 'physical'
    ELSE 'mixed'
  END as fleet_type,
  -- Description indicates backfill
  'Backfilled from ' || COUNT(d.uuid)::text || ' existing provisioned device(s)' as description,
  'active' as status,
  -- Use earliest device creation date as fleet creation date
  COALESCE(MIN(d.created_at), NOW()) as created_at,
  'migration-151' as created_by
FROM devices d
LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
WHERE d.fleet_id IS NOT NULL 
  AND d.fleet_id != ''
  AND f.fleet_id IS NULL
GROUP BY d.fleet_id
-- Handle race condition if fleet was just created
ON CONFLICT (fleet_id) DO NOTHING;

-- Report results
DO $$
DECLARE
  created_count INTEGER;
  rec RECORD;
BEGIN
  -- Count fleets created by this migration
  SELECT COUNT(*) INTO created_count
  FROM fleets
  WHERE created_by = 'migration-151';
  
  RAISE NOTICE '';
  RAISE NOTICE '================================================';
  RAISE NOTICE 'Migration Results:';
  RAISE NOTICE '================================================';
  RAISE NOTICE '✓ Successfully created % fleet record(s)', created_count;
  RAISE NOTICE '';
  
  -- Show summary of created fleets
  IF created_count > 0 THEN
    RAISE NOTICE 'Created Fleets:';
    FOR rec IN 
      SELECT 
        f.fleet_id, 
        f.fleet_name, 
        f.fleet_type,
        COUNT(d.uuid) as device_count
      FROM fleets f
      LEFT JOIN devices d ON d.fleet_id = f.fleet_id
      WHERE f.created_by = 'migration-151'
      GROUP BY f.fleet_id, f.fleet_name, f.fleet_type
      ORDER BY f.fleet_id
    LOOP
      RAISE NOTICE '  - % (%) - % device(s)', rec.fleet_name, rec.fleet_type, rec.device_count;
    END LOOP;
  END IF;
  
  RAISE NOTICE '================================================';
END $$;

-- Verify no orphaned devices remain
DO $$
DECLARE
  remaining_orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_orphans
  FROM devices d
  LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
  WHERE d.fleet_id IS NOT NULL 
    AND d.fleet_id != ''
    AND f.fleet_id IS NULL;
  
  IF remaining_orphans > 0 THEN
    RAISE WARNING 'Still have % device(s) without matching fleet!', remaining_orphans;
  ELSE
    RAISE NOTICE '✓ All devices now have matching fleet records';
  END IF;
END $$;

COMMIT;

-- Post-migration verification query (run manually if needed)
-- SELECT 
--   d.fleet_id,
--   f.fleet_name,
--   COUNT(d.uuid) as device_count,
--   STRING_AGG(d.device_name, ', ') as devices
-- FROM devices d
-- LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
-- WHERE d.fleet_id IS NOT NULL
-- GROUP BY d.fleet_id, f.fleet_name
-- ORDER BY f.fleet_name NULLS LAST;
