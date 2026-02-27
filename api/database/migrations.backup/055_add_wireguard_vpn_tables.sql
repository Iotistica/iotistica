-- WireGuard VPN Management Tables
-- Migration: 055_add_wireguard_vpn_tables.sql

-- WireGuard Peers Table
CREATE TABLE IF NOT EXISTS wg_peers (
  id SERIAL PRIMARY KEY,
  peer_id VARCHAR(255) UNIQUE NOT NULL,
  public_key VARCHAR(255) UNIQUE NOT NULL,
  private_key VARCHAR(255) NOT NULL,
  preshared_key VARCHAR(255),
  ip_address VARCHAR(45) NOT NULL,
  allowed_ips TEXT NOT NULL DEFAULT '0.0.0.0/0, ::/0',
  endpoint VARCHAR(255),
  persistent_keepalive INTEGER DEFAULT 25,
  device_id VARCHAR(255),
  device_name VARCHAR(255),
  notes TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_handshake TIMESTAMP,
  rx_bytes BIGINT DEFAULT 0,
  tx_bytes BIGINT DEFAULT 0
);

-- WireGuard Interface Configuration
CREATE TABLE IF NOT EXISTS wg_config (
  id SERIAL PRIMARY KEY,
  interface_name VARCHAR(50) NOT NULL DEFAULT 'wg0',
  listen_port INTEGER NOT NULL DEFAULT 51820,
  private_key VARCHAR(255) NOT NULL,
  public_key VARCHAR(255) NOT NULL,
  address VARCHAR(100) NOT NULL DEFAULT '10.8.0.1/24',
  dns VARCHAR(255),
  mtu INTEGER DEFAULT 1420,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- IP Address Pool
CREATE TABLE IF NOT EXISTS wg_ip_pool (
  id SERIAL PRIMARY KEY,
  ip_address VARCHAR(45) UNIQUE NOT NULL,
  assigned_to VARCHAR(255),
  assigned_at TIMESTAMP,
  is_available BOOLEAN DEFAULT true
);

-- Initialize IP pool (10.8.0.2 - 10.8.0.254)
INSERT INTO wg_ip_pool (ip_address, is_available)
SELECT 
  '10.8.0.' || generate_series(2, 254) AS ip_address,
  true
ON CONFLICT (ip_address) DO NOTHING;

-- Initialize server configuration
-- IMPORTANT: Replace these keys with your actual server keys!
INSERT INTO wg_config (
  interface_name,
  listen_port,
  private_key,
  public_key,
  address,
  dns
) VALUES (
  'wg0',
  51820,
  'vcGSdmmqDJW2SUYXzDKVh8smqAqowJ33YAxMjd7Pggo=',  -- Replace with your server private key
  'SAe7/qU7wKgDx32mUxd8t4pIDATRlpjmgPqtdYrVPEw=',  -- Replace with your server public key
  '10.8.0.1/24',
  '1.1.1.1, 1.0.0.1'
)
ON CONFLICT DO NOTHING;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_wg_peers_device_id ON wg_peers(device_id);
CREATE INDEX IF NOT EXISTS idx_wg_peers_enabled ON wg_peers(enabled);
CREATE INDEX IF NOT EXISTS idx_wg_ip_pool_available ON wg_ip_pool(is_available);

-- Comments
COMMENT ON TABLE wg_peers IS 'WireGuard VPN peer configurations';
COMMENT ON TABLE wg_config IS 'WireGuard server interface configuration';
COMMENT ON TABLE wg_ip_pool IS 'Available IP addresses for VPN clients (10.8.0.2-254)';
COMMENT ON COLUMN wg_peers.peer_id IS 'Unique peer identifier (UUID)';
COMMENT ON COLUMN wg_peers.public_key IS 'WireGuard peer public key';
COMMENT ON COLUMN wg_peers.private_key IS 'WireGuard peer private key (for client config generation)';
COMMENT ON COLUMN wg_peers.preshared_key IS 'Optional preshared key for post-quantum security';
COMMENT ON COLUMN wg_peers.ip_address IS 'Allocated VPN IP address';
COMMENT ON COLUMN wg_peers.device_id IS 'Associated IoT device identifier';
