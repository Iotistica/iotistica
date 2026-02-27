-- Migration 045: Add support for global dashboards (not tied to specific device)
-- Created: 2025-11-03
-- Description: Allow device_uuid to be NULL for global/multi-device dashboards

-- Make device_uuid nullable for global dashboards
ALTER TABLE dashboard_layouts 
    ALTER COLUMN device_uuid DROP NOT NULL;

-- Update unique constraint to handle NULL device_uuid
DROP INDEX IF EXISTS idx_dashboard_layouts_one_default;

-- Create new partial unique index that works with NULL device_uuid
-- One default per user (for global) OR one default per user+device
CREATE UNIQUE INDEX idx_dashboard_layouts_one_default 
    ON dashboard_layouts(user_id, COALESCE(device_uuid::text, 'global')) 
    WHERE is_default = true;

-- Update regular index to handle NULLs
DROP INDEX IF EXISTS idx_dashboard_layouts_user_device;
CREATE INDEX idx_dashboard_layouts_user_device ON dashboard_layouts(user_id, device_uuid) 
    WHERE device_uuid IS NOT NULL;

-- Add index for global dashboards (where device_uuid is NULL)
CREATE INDEX idx_dashboard_layouts_global ON dashboard_layouts(user_id) 
    WHERE device_uuid IS NULL;

-- Update unique layout name constraint to handle NULL device_uuid
ALTER TABLE dashboard_layouts 
    DROP CONSTRAINT IF EXISTS unique_layout_name;

-- Add new unique index that works with NULL device_uuid (using expression)
CREATE UNIQUE INDEX idx_dashboard_layouts_unique_name 
    ON dashboard_layouts(user_id, COALESCE(device_uuid::text, 'global'), layout_name);

-- Add comments
COMMENT ON COLUMN dashboard_layouts.device_uuid IS 'Device UUID for device-specific dashboards, NULL for global/multi-device dashboards';
