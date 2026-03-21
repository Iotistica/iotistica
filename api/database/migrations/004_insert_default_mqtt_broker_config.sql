-- Migration: Consolidated MQTT Broker Configuration
-- Description: Single unified migration for MQTT broker configuration
-- Purpose: Simplifies the multi-step migration chain (019 → 048 → 049 → 057)
-- Author: System
-- Date: 2025-12-03

-- ============================================================================
-- DESIGN DECISIONS
-- ============================================================================
-- 1. Keep mqtt_broker_config table as PRIMARY storage (not system_config)
--    - Structured schema is clearer than JSONB blobs
--    - Direct SQL queries are simpler
--    - Easier to add indexes and constraints
--
-- 2. Environment variables ALWAYS override database
--    - Priority: ENV > DB device-specific > DB default
--    - Handled in application code, not database
--
-- 3. Default broker matches environment type:
--    - E2E: mqtt://localhost:5883 (no TLS)
--    - Production: mqtts://localhost:8883 (TLS ready, but TLS disabled by default)
--
-- 4. Simple migration path:
--    - If mqtt_broker_config exists with data: UPDATE default broker
--    - If mqtt_broker_config empty: INSERT default broker
--    - No complex system_config migration needed
--
-- ============================================================================

SET search_path = public;

-- ============================================================================
-- STEP 1: Ensure mqtt_broker_config table exists
-- ============================================================================

CREATE TABLE IF NOT EXISTS mqtt_broker_config (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
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
    is_default BOOLEAN DEFAULT false,
    broker_type VARCHAR(50) DEFAULT 'local',  -- local, cloud, edge, test
    
    -- Additional Configuration (JSON)
    extra_config JSONB DEFAULT '{}',
    
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

-- ============================================================================
-- STEP 2: Create indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_name ON mqtt_broker_config(name);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_is_active ON mqtt_broker_config(is_active);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_is_default ON mqtt_broker_config(is_default);
CREATE INDEX IF NOT EXISTS idx_mqtt_broker_config_broker_type ON mqtt_broker_config(broker_type);

-- ============================================================================
-- STEP 3: Create/update triggers
-- ============================================================================

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

-- ============================================================================
-- STEP 4: Insert or update default broker configuration
-- ============================================================================

-- Strategy: Use upsert to handle both fresh installs and existing databases
-- Default values suitable for development/e2e testing
-- Production deployments should override with environment variables

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
    'Local Mosquitto broker - configure via environment variables',
    'mqtt',                -- Plain MQTT (override with MQTT_BROKER_PROTOCOL)
    'localhost',           -- Localhost (override with MQTT_BROKER_HOST)
    5883,                  -- External port (override with MQTT_BROKER_PORT)
    'admin',               -- Default username (override with MQTT_USERNAME)
    '$2b$10$5vVlT8H5rXVL5vVL5vVL5u5vVL5vVL5vVL5vVL5vVL5vVL5vVL5vO',  -- Default: iotistic42!
    true,                  -- Active
    true,                  -- Default broker
    'local',               -- Local broker type
    false                  -- TLS disabled (override with MQTT_BROKER_USE_TLS)
) ON CONFLICT (name) 
DO UPDATE SET
    -- Update existing "Local Broker" to match e2e defaults if needed
    protocol = EXCLUDED.protocol,
    port = EXCLUDED.port,
    use_tls = EXCLUDED.use_tls,
    updated_at = CURRENT_TIMESTAMP;

-- ============================================================================
-- STEP 5: Link agents to broker configuration
-- ============================================================================

-- Add mqtt_broker_id column to agents table if not exists
ALTER TABLE agents 
ADD COLUMN IF NOT EXISTS mqtt_broker_id INTEGER REFERENCES mqtt_broker_config(id) ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_agents_mqtt_broker_id ON agents(mqtt_broker_id);

-- Add helpful comment
COMMENT ON COLUMN agents.mqtt_broker_id IS 'MQTT broker configuration for this agent (NULL = use default broker)';

-- ============================================================================
-- STEP 6: Create helpful views
-- ============================================================================

-- View: Broker summary with device counts
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
LEFT JOIN agents d ON d.mqtt_broker_id = mbc.id
GROUP BY mbc.id, mbc.name, mbc.description, mbc.protocol, mbc.host, mbc.port, 
         mbc.username, mbc.is_active, mbc.is_default, mbc.broker_type, 
         mbc.use_tls, mbc.last_connected_at, mbc.created_at;

COMMENT ON VIEW mqtt_broker_summary IS 'MQTT broker configuration summary with device counts';

-- ============================================================================
-- STEP 7: Add helpful comments
-- ============================================================================

COMMENT ON TABLE mqtt_broker_config IS 'MQTT broker connection configuration. Environment variables (MQTT_BROKER_*) always override database values.';
COMMENT ON COLUMN mqtt_broker_config.protocol IS 'Connection protocol: mqtt (plain), mqtts (TLS), ws (WebSocket), wss (WebSocket Secure)';
COMMENT ON COLUMN mqtt_broker_config.port IS 'MQTT broker port. E2E/Docker: 5883, Production with TLS: 8883';
COMMENT ON COLUMN mqtt_broker_config.use_tls IS 'Enable TLS/SSL encryption. Requires valid certificates in ca_cert, client_cert, client_key fields';
COMMENT ON COLUMN mqtt_broker_config.is_default IS 'Default broker used for new agent provisioning when agent.mqtt_broker_id is NULL';
COMMENT ON COLUMN mqtt_broker_config.broker_type IS 'Broker deployment type: local (on-premise), cloud (HiveMQ/AWS IoT), edge (cluster edge node), test (e2e testing)';

-- ============================================================================
-- STEP 8: Log completion
-- ============================================================================

DO $$
DECLARE
    broker_count INTEGER;
    default_broker_name VARCHAR(255);
BEGIN
    SELECT COUNT(*) INTO broker_count FROM mqtt_broker_config;
    SELECT name INTO default_broker_name FROM mqtt_broker_config WHERE is_default = true LIMIT 1;
    
    RAISE NOTICE '';
    RAISE NOTICE '✅ MQTT Broker Configuration Migration Complete';
    RAISE NOTICE '   Total brokers: %', broker_count;
    RAISE NOTICE '   Default broker: %', default_broker_name;
    RAISE NOTICE '';
    RAISE NOTICE '📝 Configuration Priority:';
    RAISE NOTICE '   1. Environment variables (MQTT_BROKER_HOST, MQTT_BROKER_PORT, MQTT_BROKER_PROTOCOL)';
    RAISE NOTICE '   2. Agent-specific broker (agents.mqtt_broker_id)';
    RAISE NOTICE '   3. Default broker (mqtt_broker_config.is_default = true)';
    RAISE NOTICE '';
    RAISE NOTICE '🔧 For E2E testing: Set environment variables in docker-compose.e2e.yml';
    RAISE NOTICE '🔧 For production: Configure brokers via API or update database directly';
    RAISE NOTICE '';
END $$;

