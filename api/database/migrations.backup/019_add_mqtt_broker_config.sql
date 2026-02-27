-- Migration: Add MQTT broker configuration table
-- Created: 2025-10-21
-- Purpose: Store MQTT broker connection details for frontend configuration

-- MQTT Broker Configuration Table
-- Stores connection details for multiple MQTT brokers (local, cloud, etc.)
CREATE TABLE IF NOT EXISTS mqtt_broker_config (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,  -- Friendly name (e.g., "Local Broker", "Cloud Broker")
    description TEXT,
    
    -- Connection Details
    protocol VARCHAR(10) NOT NULL DEFAULT 'mqtt',  -- mqtt, mqtts, ws, wss
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL,
    
    -- Authentication
    username VARCHAR(255),
    password_hash VARCHAR(255),  -- bcrypt hashed password
    
    -- TLS/SSL Configuration
    use_tls BOOLEAN DEFAULT false,
    ca_cert TEXT,  -- CA certificate (PEM format)
    client_cert TEXT,  -- Client certificate (PEM format)
    client_key TEXT,  -- Client private key (PEM format)
    verify_certificate BOOLEAN DEFAULT true,
    
    -- Connection Options
    client_id_prefix VARCHAR(100) DEFAULT 'Iotistic',
    keep_alive INTEGER DEFAULT 60,  -- Seconds
    clean_session BOOLEAN DEFAULT true,
    reconnect_period INTEGER DEFAULT 1000,  -- Milliseconds
    connect_timeout INTEGER DEFAULT 30000,  -- Milliseconds
    
    -- Status & Metadata
    is_active BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,  -- Default broker for new devices
    broker_type VARCHAR(50) DEFAULT 'local',  -- local, cloud, edge
    
    -- Additional Configuration (JSON)
    extra_config JSONB DEFAULT '{}',  -- For custom options
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_connected_at TIMESTAMP,
    
    -- Constraints
    CONSTRAINT valid_protocol CHECK (protocol IN ('mqtt', 'mqtts', 'ws', 'wss')),
    CONSTRAINT valid_broker_type CHECK (broker_type IN ('local', 'cloud', 'edge', 'test')),
    CONSTRAINT valid_port CHECK (port >= 1 AND port <= 65535),
    CONSTRAINT valid_keep_alive CHECK (keep_alive > 0)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_name ON mqtt_broker_config(name);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_is_active ON mqtt_broker_config(is_active);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_is_default ON mqtt_broker_config(is_default);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_broker_type ON mqtt_broker_config(broker_type);

-- Trigger: Auto-update updated_at timestamp
DROP TRIGGER IF EXISTS trigger_mqtt_broker_config_updated_at ON mqtt_broker_config;
CREATE TRIGGER trigger_mqtt_broker_config_updated_at
    BEFORE UPDATE ON mqtt_broker_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function: Ensure only one default broker
CREATE OR REPLACE FUNCTION ensure_one_default_broker()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = true THEN
        -- Unset is_default on all other brokers
        UPDATE mqtt_broker_config 
        SET is_default = false 
        WHERE id != NEW.id AND is_default = true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Ensure only one default broker
DROP TRIGGER IF EXISTS trigger_ensure_one_default_broker ON mqtt_broker_config;
CREATE TRIGGER trigger_ensure_one_default_broker
    BEFORE INSERT OR UPDATE OF is_default ON mqtt_broker_config
    FOR EACH ROW
    WHEN (NEW.is_default = true)
    EXECUTE FUNCTION ensure_one_default_broker();

-- Comments
COMMENT ON TABLE mqtt_broker_config IS 'MQTT broker connection configuration for frontend management';
COMMENT ON COLUMN mqtt_broker_config.protocol IS 'Connection protocol: mqtt, mqtts (TLS), ws (WebSocket), wss (WebSocket Secure)';
COMMENT ON COLUMN mqtt_broker_config.password_hash IS 'bcrypt hashed password for broker authentication';
COMMENT ON COLUMN mqtt_broker_config.extra_config IS 'Additional JSON configuration for custom broker options';
COMMENT ON COLUMN mqtt_broker_config.is_default IS 'Default broker used for new device provisioning';

-- Default Local Broker Configuration
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
    use_tls
) VALUES (
    'Local Broker',
    'Local Mosquitto broker running on this system',
    'mqtt',
    'localhost',
    5883,
    'admin',
    '$2b$10$5vVlT8H5rXVL5vVL5vVL5u5vVL5vVL5vVL5vVL5vVL5vVL5vVL5vO',  -- Default: iotistic42! (CHANGE THIS!)
    true,
    true,
    'local',
    false
) ON CONFLICT (name) DO NOTHING;

-- Link devices to broker configuration (optional)
-- This allows each device to have its own broker configuration
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_broker_id INTEGER REFERENCES mqtt_broker_config(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_devices_mqtt_broker_id ON devices(mqtt_broker_id);

COMMENT ON COLUMN devices.mqtt_broker_id IS 'MQTT broker configuration for this device (NULL = use default)';

-- View: Broker summary with connection counts
CREATE OR REPLACE VIEW mqtt_broker_summary AS
SELECT 
    mbc.id,
    mbc.name,
    mbc.description,
    mbc.protocol,
    mbc.host,
    mbc.port,
    mbc.username,
    mbc.is_active,
    mbc.is_default,
    mbc.broker_type,
    mbc.use_tls,
    mbc.last_connected_at,
    mbc.created_at,
    COUNT(d.uuid) AS device_count,
    COUNT(CASE WHEN d.is_active = true THEN 1 END) AS active_device_count
FROM mqtt_broker_config mbc
LEFT JOIN devices d ON d.mqtt_broker_id = mbc.id
GROUP BY mbc.id, mbc.name, mbc.description, mbc.protocol, mbc.host, mbc.port, 
         mbc.username, mbc.is_active, mbc.is_default, mbc.broker_type, 
         mbc.use_tls, mbc.last_connected_at, mbc.created_at;

COMMENT ON VIEW mqtt_broker_summary IS 'MQTT broker configuration summary with device counts';
