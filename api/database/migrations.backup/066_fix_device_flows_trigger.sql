-- Migration: Fix device_flows trigger to use correct column name
-- Description: The original trigger referenced 'modified_at' but the column is 'updated_at'
-- Date: 2025-11-21

-- Drop the incorrect trigger
DROP TRIGGER IF EXISTS trigger_device_flows_updated_at ON device_flows;

-- Recreate trigger with correct function that updates 'updated_at' column
CREATE TRIGGER trigger_device_flows_updated_at
    BEFORE UPDATE ON device_flows
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comment explaining the fix
COMMENT ON TRIGGER trigger_device_flows_updated_at ON device_flows IS 
    'Automatically updates updated_at timestamp on row modification';
