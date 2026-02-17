-- Migration: Update MQTT broker to Envoy Gateway IP
-- Created: 2026-02-17
-- Purpose: Update default MQTT broker to use Envoy Gateway external IP for standalone agent access
--
-- Context: 
-- - Virtual agents (K8s pods) use MQTT_BROKER_URL env variable with K8s internal DNS
-- - Standalone agents (local/physical) need public Gateway IP from this database config
-- - Envoy Gateway exposes Mosquitto at 20.220.137.172:1883 (via TCPRoute)

-- Update default broker to Gateway IP
UPDATE mqtt_broker_config
SET 
    name = 'Cloud Broker (Gateway)',
    description = 'Cloud MQTT broker via Envoy Gateway at 20.220.137.172',
    protocol = 'mqtt',
    host = '20.220.137.172',  -- Envoy Gateway external IP
    port = 1883,
    broker_type = 'cloud',
    use_tls = false,
    updated_at = CURRENT_TIMESTAMP
WHERE is_default = true;

-- Verify the update
DO $$
DECLARE
    broker_host TEXT;
    broker_port INT;
BEGIN
    SELECT host, port INTO broker_host, broker_port
    FROM mqtt_broker_config
    WHERE is_default = true;
    
    IF broker_host = '20.220.137.172' AND broker_port = 1883 THEN
        RAISE NOTICE 'Successfully updated MQTT broker to Gateway IP: %:%', broker_host, broker_port;
    ELSE
        RAISE WARNING 'MQTT broker update may have failed. Current: %:%', broker_host, broker_port;
    END IF;
END $$;

-- Optional: Insert new record if no default exists (shouldn't happen, but safe fallback)
INSERT INTO mqtt_broker_config (
    name,
    description,
    protocol,
    host,
    port,
    broker_type,
    is_default,
    is_active,
    use_tls,
    verify_certificate,
    client_id_prefix,
    keep_alive,
    clean_session,
    reconnect_period,
    connect_timeout
)
SELECT 
    'Cloud Broker (Gateway)',
    'Cloud MQTT broker via Envoy Gateway at 20.220.137.172',
    'mqtt',
    '20.220.137.172',
    1883,
    'cloud',
    true,
    true,
    false,
    true,
    'Iotistic',
    60,
    true,
    1000,
    30000
WHERE NOT EXISTS (
    SELECT 1 FROM mqtt_broker_config WHERE is_default = true
);
