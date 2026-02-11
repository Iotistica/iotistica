-- Migration: Remove 'reconciling' status (legacy)
-- Change all 'reconciling' to 'deployed' since reconciling meant agent was applying changes

UPDATE device_sensors 
SET deployment_status = 'deployed',
    updated_at = NOW()
WHERE deployment_status = 'reconciling';
