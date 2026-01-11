-- Migration: Update MQTT broker to cloud endpoint
-- Created: 2026-01-11
-- Purpose: Update default MQTT broker configuration to use mqtt1.iotistica.com

-- Update default broker to cloud endpoint
-- Migration 019 already created 'Local Broker', so just update it
UPDATE mqtt_broker_config
SET 
    name = 'Cloud Broker',
    description = 'Cloud MQTT broker at mqtt1.iotistica.com',
    protocol = 'mqtt',
    host = 'mqtt1.iotistica.com',
    port = 1883,
    broker_type = 'cloud',
    use_tls = false,
    updated_at = CURRENT_TIMESTAMP
WHERE name = 'Local Broker';

-- Log the migration
DO $$
BEGIN
    RAISE NOTICE 'Updated MQTT broker configuration to mqtt1.iotistica.com:1883';
END $$;
