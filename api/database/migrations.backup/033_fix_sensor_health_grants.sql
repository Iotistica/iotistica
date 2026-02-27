-- Migration: Fix sensor health table grants for missing iotistic role
-- Purpose: Make grants conditional on role existence (works for both local and production)
-- Author: System
-- Date: 2025-10-30

-- Drop the problematic grants from migration 032
-- They will be re-added conditionally below

-- Check if iotistic role exists, and only grant if it does
DO $$
BEGIN
    -- Check if role exists
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iotistic') THEN
        -- Grant permissions on tables
        GRANT SELECT, INSERT ON sensor_health_history TO iotistic;
        GRANT SELECT, INSERT ON protocol_adapter_health_history TO iotistic;
        
        -- Grant permissions on views
        GRANT SELECT ON sensor_health_latest TO iotistic;
        GRANT SELECT ON protocol_adapter_health_latest TO iotistic;
        
        -- Grant permissions on sequences
        GRANT USAGE, SELECT ON SEQUENCE sensor_health_history_id_seq TO iotistic;
        GRANT USAGE, SELECT ON SEQUENCE protocol_adapter_health_history_id_seq TO iotistic;
        
        RAISE NOTICE 'Granted permissions to iotistic role';
    ELSE
        RAISE NOTICE 'Role iotistic does not exist - skipping grants (OK for local development)';
    END IF;
END $$;

-- Add comment explaining this migration
COMMENT ON TABLE sensor_health_history IS 'Historical tracking of sensor connection health from sensor-publish feature. Grants applied conditionally based on role existence.';
