-- Add network_interfaces column to devices table
-- Stores network interface information reported by the agent

ALTER TABLE devices 
ADD COLUMN IF NOT EXISTS network_interfaces JSONB;

-- Add index for querying network interfaces
CREATE INDEX IF NOT EXISTS idx_devices_network_interfaces 
ON devices USING GIN (network_interfaces);

-- Add comment
COMMENT ON COLUMN devices.network_interfaces IS 'Network interface data reported by agent (name, IP, MAC, type, WiFi signal, etc.)';
