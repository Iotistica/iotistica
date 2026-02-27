-- Migration: Drop old config tables after consolidation
-- Description: Remove mqtt_broker_config and vpn_config tables after migration to system_config
-- Author: System
-- Date: 2025-11-05
-- Part 2 of 2: Cleanup old tables
-- IMPORTANT: Run this ONLY after verifying migration 048 succeeded and code is updated

-- ============================================================================
-- SAFETY CHECK: Verify data was migrated
-- ============================================================================

DO $$
DECLARE
    mqtt_count INTEGER;
    vpn_count INTEGER;
    mqtt_migrated INTEGER;
    vpn_migrated INTEGER;
BEGIN
    -- Count records in old tables
    SELECT COUNT(*) INTO mqtt_count FROM mqtt_broker_config;
    SELECT COUNT(*) INTO vpn_count FROM vpn_config;
    
    -- Count migrated records in system_config
    SELECT COUNT(*) INTO mqtt_migrated FROM system_config WHERE key LIKE 'mqtt.brokers.%';
    SELECT COUNT(*) INTO vpn_migrated FROM system_config WHERE key LIKE 'vpn.configs.%';
    
    -- Verify counts match
    IF mqtt_count != mqtt_migrated THEN
        RAISE EXCEPTION 'MQTT broker migration incomplete: % in mqtt_broker_config but only % in system_config', 
            mqtt_count, mqtt_migrated;
    END IF;
    
    IF vpn_count != vpn_migrated THEN
        RAISE EXCEPTION 'VPN config migration incomplete: % in vpn_config but only % in system_config', 
            vpn_count, vpn_migrated;
    END IF;
    
    RAISE NOTICE 'Safety check passed: All % MQTT brokers and % VPN configs migrated successfully', 
        mqtt_count, vpn_count;
END $$;

-- ============================================================================
-- STEP 1: Drop Foreign Key Constraints
-- ============================================================================

-- Drop foreign key from devices table for MQTT broker
ALTER TABLE devices 
DROP CONSTRAINT IF EXISTS devices_mqtt_broker_id_fkey;

-- Drop foreign key from devices table for VPN config
ALTER TABLE devices 
DROP CONSTRAINT IF EXISTS devices_vpn_config_id_fkey;

-- ============================================================================
-- STEP 2: Drop Views (if any depend on the tables)
-- ============================================================================

DROP VIEW IF EXISTS mqtt_broker_summary;

-- ============================================================================
-- STEP 3: Drop Triggers
-- ============================================================================

-- Drop MQTT broker triggers
DROP TRIGGER IF EXISTS trigger_mqtt_broker_config_updated_at ON mqtt_broker_config;
DROP TRIGGER IF EXISTS trigger_ensure_one_default_broker ON mqtt_broker_config;

-- Drop associated function
DROP FUNCTION IF EXISTS ensure_one_default_broker();

-- ============================================================================
-- STEP 4: Drop Old Tables
-- ============================================================================

-- Drop MQTT broker config table
DROP TABLE IF EXISTS mqtt_broker_config CASCADE;

-- Drop VPN config table
DROP TABLE IF EXISTS vpn_config CASCADE;

-- ============================================================================
-- STEP 5: Keep Device Reference Columns (for backward compatibility)
-- ============================================================================
-- NOTE: We keep devices.mqtt_broker_id and devices.vpn_config_id columns
-- They will now store IDs that map to keys in system_config
-- Example: mqtt_broker_id = 1 maps to system_config key 'mqtt.brokers.1'
-- The columns are no longer foreign keys but simple INTEGER references

-- Add comments to clarify new usage
COMMENT ON COLUMN devices.mqtt_broker_id IS 'MQTT broker configuration ID (maps to system_config key mqtt.brokers.<id>)';
COMMENT ON COLUMN devices.vpn_config_id IS 'VPN configuration ID (maps to system_config key vpn.configs.<id>)';

-- ============================================================================
-- COMPLETION
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Migration complete: Old config tables dropped successfully';
    RAISE NOTICE '   - mqtt_broker_config table removed';
    RAISE NOTICE '   - vpn_config table removed';
    RAISE NOTICE '   - All configurations now stored in system_config table';
    RAISE NOTICE '   - Device reference columns retained for ID mapping';
END $$;

