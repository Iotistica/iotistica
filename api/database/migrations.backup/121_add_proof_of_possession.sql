-- Add Proof of Possession (PoP) columns to devices table
-- Supports asymmetric cryptography (Ed25519/P-256) for strong device identity

ALTER TABLE devices
ADD COLUMN IF NOT EXISTS device_public_key TEXT,
ADD COLUMN IF NOT EXISTS pop_verified BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS pop_verified_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_challenge TEXT,
ADD COLUMN IF NOT EXISTS last_challenge_expires_at TIMESTAMP;

-- Create index for challenge expiration cleanup
CREATE INDEX IF NOT EXISTS idx_devices_challenge_expires 
ON devices(last_challenge_expires_at) 
WHERE last_challenge_expires_at IS NOT NULL;

-- Create index for PoP verification status
CREATE INDEX IF NOT EXISTS idx_devices_pop_verified 
ON devices(pop_verified) 
WHERE pop_verified = false;

COMMENT ON COLUMN devices.device_public_key IS 'Ed25519/P-256 public key for proof-of-possession (PEM format)';
COMMENT ON COLUMN devices.pop_verified IS 'Whether device has completed proof-of-possession challenge';
COMMENT ON COLUMN devices.pop_verified_at IS 'Timestamp when PoP was verified';
COMMENT ON COLUMN devices.last_challenge IS 'Current PoP challenge nonce (cleared after verification)';
COMMENT ON COLUMN devices.last_challenge_expires_at IS 'Challenge expiration timestamp (5 min TTL)';
