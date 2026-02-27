-- Migration: Add VPN support to devices table
-- Description: Adds columns for VPN username, password hash, and connection tracking
-- Date: 2025-11-05

-- Add VPN columns to devices table
ALTER TABLE devices 
  ADD COLUMN IF NOT EXISTS vpn_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS vpn_username VARCHAR(255),
  ADD COLUMN IF NOT EXISTS vpn_password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS vpn_last_connected_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS vpn_ip_address INET,
  ADD COLUMN IF NOT EXISTS vpn_bytes_sent BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vpn_bytes_received BIGINT DEFAULT 0;

-- Create index for VPN lookups
CREATE INDEX IF NOT EXISTS idx_devices_vpn_username ON devices(vpn_username) WHERE vpn_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_vpn_enabled ON devices(vpn_enabled) WHERE vpn_enabled = true;

-- Add comment
COMMENT ON COLUMN devices.vpn_enabled IS 'Whether VPN is enabled for this device';
COMMENT ON COLUMN devices.vpn_username IS 'VPN username (typically device UUID)';
COMMENT ON COLUMN devices.vpn_password_hash IS 'Bcrypt hash of VPN password';
COMMENT ON COLUMN devices.vpn_last_connected_at IS 'Last VPN connection timestamp';
COMMENT ON COLUMN devices.vpn_ip_address IS 'Assigned VPN IP address (10.8.x.x)';
COMMENT ON COLUMN devices.vpn_bytes_sent IS 'Total bytes sent over VPN';
COMMENT ON COLUMN devices.vpn_bytes_received IS 'Total bytes received over VPN';
