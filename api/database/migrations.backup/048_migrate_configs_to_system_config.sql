-- Migration: Consolidate vpn_config and mqtt_broker_config into system_config
-- Description: Migrate VPN and MQTT broker configurations to unified system_config table
-- Author: System
-- Date: 2025-11-05
-- Part 1 of 2: Migrate data

-- ============================================================================
-- STEP 1: Migrate MQTT Broker Configurations
-- ============================================================================

-- Migrate all MQTT broker configs as individual entries
-- Key format: mqtt.brokers.<id> for each broker
INSERT INTO system_config (key, value, updated_at)
SELECT 
    'mqtt.brokers.' || id::text,
    jsonb_build_object(
        'id', id,
        'name', name,
        'description', description,
        'protocol', protocol,
        'host', host,
        'port', port,
        'username', username,
        'passwordHash', password_hash,
        'useTls', use_tls,
        'caCert', ca_cert,
        'clientCert', client_cert,
        'clientKey', client_key,
        'verifyCertificate', verify_certificate,
        'clientIdPrefix', client_id_prefix,
        'keepAlive', keep_alive,
        'cleanSession', clean_session,
        'reconnectPeriod', reconnect_period,
        'connectTimeout', connect_timeout,
        'isActive', is_active,
        'isDefault', is_default,
        'brokerType', broker_type,
        'extraConfig', extra_config,
        'lastConnectedAt', last_connected_at,
        'createdAt', created_at,
        'updatedAt', updated_at
    ),
    updated_at
FROM mqtt_broker_config
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Store the default MQTT broker ID for quick access
INSERT INTO system_config (key, value, updated_at)
SELECT 
    'mqtt.defaultBrokerId',
    to_jsonb(id),
    updated_at
FROM mqtt_broker_config
WHERE is_default = true
LIMIT 1
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Store list of all MQTT broker IDs
INSERT INTO system_config (key, value, updated_at)
VALUES (
    'mqtt.brokerIds',
    (SELECT jsonb_agg(id ORDER BY id) FROM mqtt_broker_config),
    CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- ============================================================================
-- STEP 2: Migrate VPN Configurations
-- ============================================================================

-- Migrate all VPN configs as individual entries
-- Key format: vpn.configs.<id> for each config
INSERT INTO system_config (key, value, updated_at)
SELECT 
    'vpn.configs.' || id::text,
    jsonb_build_object(
        'id', id,
        'name', name,
        'description', description,
        'enabled', enabled,
        'serverHost', server_host,
        'serverPort', server_port,
        'protocol', protocol,
        'caCertUrl', ca_cert_url,
        'caCert', ca_cert,
        'vpnSubnet', vpn_subnet,
        'vpnNetmask', vpn_netmask,
        'cipher', cipher,
        'auth', auth,
        'compressLzo', compress_lzo,
        'isDefault', is_default,
        'isActive', is_active,
        'createdAt', created_at,
        'updatedAt', updated_at,
        'createdBy', created_by
    ),
    updated_at
FROM vpn_config
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Store the default VPN config ID for quick access
INSERT INTO system_config (key, value, updated_at)
SELECT 
    'vpn.defaultConfigId',
    to_jsonb(id),
    updated_at
FROM vpn_config
WHERE is_default = true
LIMIT 1
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Store list of all VPN config IDs
INSERT INTO system_config (key, value, updated_at)
VALUES (
    'vpn.configIds',
    (SELECT jsonb_agg(id ORDER BY id) FROM vpn_config),
    CURRENT_TIMESTAMP
)
ON CONFLICT (key) DO UPDATE 
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- ============================================================================
-- STEP 3: Update Indexes for New Keys
-- ============================================================================

-- Add comments for documentation
COMMENT ON TABLE system_config IS 'Unified system-wide configuration storage including MQTT broker configs, VPN configs, and other system settings (key-value pairs with JSONB values)';

-- Log migration completion
DO $$
BEGIN
    RAISE NOTICE 'Migration complete: Migrated % MQTT broker configs and % VPN configs to system_config',
        (SELECT COUNT(*) FROM mqtt_broker_config),
        (SELECT COUNT(*) FROM vpn_config);
END $$;

