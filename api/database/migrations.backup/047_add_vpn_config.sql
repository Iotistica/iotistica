-- Migration: Add VPN Configuration Table
-- Description: Store VPN server settings per customer/fleet for device provisioning
-- Author: System
-- Date: 2025-11-05

-- VPN configuration table (similar to mqtt_broker_config pattern)
CREATE TABLE IF NOT EXISTS vpn_config (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- VPN Server Settings
    enabled BOOLEAN NOT NULL DEFAULT false,
    server_host VARCHAR(255) NOT NULL,  -- e.g., "vpn-abc123.iotistic.ca"
    server_port INTEGER NOT NULL DEFAULT 1194,
    protocol VARCHAR(10) NOT NULL DEFAULT 'udp',  -- udp or tcp
    
    -- CA Certificate
    ca_cert_url VARCHAR(512),  -- e.g., "http://customer-abc123-vpn:8080"
    ca_cert TEXT,  -- Inline CA certificate (optional, fetched on-demand)
    
    -- VPN Network Settings
    vpn_subnet VARCHAR(20) DEFAULT '10.8.0.0',  -- VPN network subnet
    vpn_netmask VARCHAR(20) DEFAULT '255.255.0.0',  -- /16
    
    -- Client Configuration
    cipher VARCHAR(50) DEFAULT 'AES-256-GCM',
    auth VARCHAR(50) DEFAULT 'SHA256',
    compress_lzo BOOLEAN DEFAULT true,
    
    -- Metadata
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Constraints
    CONSTRAINT vpn_config_name_unique UNIQUE(name)
);

-- Only one default VPN config allowed
CREATE UNIQUE INDEX IF NOT EXISTS idx_vpn_config_default 
ON vpn_config(is_default) 
WHERE is_default = true;

-- Index for active configs
CREATE INDEX IF NOT EXISTS idx_vpn_config_active 
ON vpn_config(is_active) 
WHERE is_active = true;

-- Add VPN config reference to devices table
ALTER TABLE devices 
ADD COLUMN IF NOT EXISTS vpn_config_id INTEGER REFERENCES vpn_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_vpn_config 
ON devices(vpn_config_id);

-- Insert default VPN configuration (disabled by default)
INSERT INTO vpn_config (
    name, 
    description, 
    enabled, 
    server_host, 
    server_port, 
    is_default, 
    created_by
) VALUES (
    'Default VPN Server',
    'Default VPN configuration for customer namespace',
    false,  -- Disabled by default, enable via dashboard
    'localhost',  -- Override via environment or dashboard
    1194,
    true,
    'system'
) ON CONFLICT (name) DO NOTHING;

-- Comments for documentation
COMMENT ON TABLE vpn_config IS 'VPN server configurations for secure device connectivity';
COMMENT ON COLUMN vpn_config.enabled IS 'Enable/disable VPN for devices using this config';
COMMENT ON COLUMN vpn_config.server_host IS 'External VPN server hostname (e.g., vpn-abc123.iotistic.ca)';
COMMENT ON COLUMN vpn_config.ca_cert_url IS 'Internal URL to fetch CA certificate (e.g., http://vpn:8080)';
COMMENT ON COLUMN devices.vpn_config_id IS 'VPN configuration to use for this device (NULL = use default)';
