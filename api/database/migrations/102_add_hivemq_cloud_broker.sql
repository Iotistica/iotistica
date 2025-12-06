-- Migration: Add HiveMQ Cloud broker configuration option
-- Created: 2025-12-06
-- Purpose: Add managed MQTT broker option (HiveMQ Cloud) alongside local Mosquitto

-- Add HiveMQ Cloud broker preset (disabled by default)
INSERT INTO mqtt_broker_config (
    name, 
    description, 
    protocol, 
    host, 
    port, 
    username, 
    password_hash,
    is_active, 
    is_default,
    broker_type,
    use_tls,
    ca_cert,
    verify_certificate,
    client_id_prefix,
    keep_alive,
    clean_session,
    reconnect_period,
    connect_timeout,
    extra_config
) VALUES (
    'HiveMQ Cloud',
    'Managed MQTT broker service - requires customer configuration. Visit hivemq.com to create cluster and obtain credentials.',
    'mqtts',                              -- Always TLS for cloud
    'cluster.hivemq.cloud',               -- Placeholder - customer must configure actual cluster URL
    8883,                                 -- Standard MQTTS port
    NULL,                                 -- Customer must set username
    NULL,                                 -- Customer must set password
    false,                                -- Inactive by default (requires customer configuration)
    false,                                -- Not default (Local Broker remains default)
    'cloud',                              -- Cloud broker type
    true,                                 -- Always use TLS
    NULL,                                 -- Uses system CA certificates (HiveMQ uses public CAs)
    true,                                 -- Always verify certificates
    'Iotistic',                           -- Client ID prefix
    60,                                   -- Keep alive (seconds)
    true,                                 -- Clean session
    5000,                                 -- Reconnect period (ms)
    30000,                                -- Connect timeout (ms)
    '{
        "provider": "hivemq",
        "max_packet_size": 268435456,
        "message_expiry_interval": 86400,
        "session_expiry_interval": 3600,
        "connection_limit": null,
        "message_rate_limit": null,
        "bandwidth_limit": null,
        "cluster_url_format": "*.s1.eu.hivemq.cloud",
        "documentation_url": "https://docs.hivemq.com/hivemq-cloud/",
        "setup_instructions": "1. Sign up at console.hivemq.cloud\n2. Create a cluster (select region)\n3. Create credentials (username/password)\n4. Update this broker config with cluster URL and credentials\n5. Set is_active=true and optionally is_default=true"
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Add comment explaining broker selection
COMMENT ON COLUMN mqtt_broker_config.broker_type IS 'Broker deployment type: local (self-hosted Mosquitto), cloud (HiveMQ Cloud, AWS IoT Core), edge (gateway broker), test (development)';

-- Create view for easy broker comparison
CREATE OR REPLACE VIEW mqtt_broker_comparison AS
SELECT 
    id,
    name,
    broker_type,
    protocol,
    host,
    port,
    use_tls,
    is_active,
    is_default,
    CASE 
        WHEN broker_type = 'local' THEN 'Self-hosted, full control, infrastructure management required'
        WHEN broker_type = 'cloud' THEN 'Managed service, zero infrastructure, usage-based pricing'
        WHEN broker_type = 'edge' THEN 'Edge gateway broker for local device communication'
        ELSE 'Testing/development broker'
    END as deployment_model,
    CASE 
        WHEN broker_type = 'local' THEN 'Customer infrastructure'
        WHEN broker_type = 'cloud' THEN extra_config->>'provider'
        ELSE 'N/A'
    END as provider,
    created_at,
    updated_at,
    last_connected_at
FROM mqtt_broker_config
ORDER BY is_default DESC, is_active DESC, name;

COMMENT ON VIEW mqtt_broker_comparison IS 'Comparison view of available MQTT brokers for customer selection';

-- Migration validation
DO $$
DECLARE
    broker_count INTEGER;
BEGIN
    -- Verify HiveMQ broker was created
    SELECT COUNT(*) INTO broker_count 
    FROM mqtt_broker_config 
    WHERE name = 'HiveMQ Cloud';
    
    IF broker_count = 0 THEN
        RAISE EXCEPTION 'Migration failed: HiveMQ Cloud broker not created';
    END IF;
    
    -- Verify Local Broker still exists and is default
    SELECT COUNT(*) INTO broker_count 
    FROM mqtt_broker_config 
    WHERE broker_type = 'local' AND is_default = true;
    
    IF broker_count = 0 THEN
        RAISE WARNING 'No local broker set as default - customer must configure broker preference';
    END IF;
    
    RAISE NOTICE 'Migration successful: HiveMQ Cloud broker added, Local Broker remains default';
END $$;
