-- Migration: Add authentication method tracking to devices
-- Purpose: Record whether device authenticated via PoP (asymmetric) or bcrypt (symmetric)
-- 
-- Enables future fleet-level policies:
-- - Disable bcrypt per-fleet (enforce PoP-only)
-- - Audit legacy stragglers still using bcrypt
-- - Enforce high-security fleets to use PoP
-- 
-- Columns:
-- - last_auth_method: 'pop' | 'bcrypt' | null (authentication method used)
-- - last_auth_at: timestamp (when device last authenticated)

ALTER TABLE devices
ADD COLUMN IF NOT EXISTS last_auth_method VARCHAR(10) CHECK (last_auth_method IN ('pop', 'bcrypt')),
ADD COLUMN IF NOT EXISTS last_auth_at TIMESTAMP;

COMMENT ON COLUMN devices.last_auth_method IS 'Authentication method used in last successful key exchange: pop=asymmetric proof-of-possession, bcrypt=symmetric fallback';
COMMENT ON COLUMN devices.last_auth_at IS 'Timestamp of last successful authentication attempt';

-- Create index for auditing legacy bcrypt usage
CREATE INDEX IF NOT EXISTS idx_devices_last_auth_method ON devices(last_auth_method) 
WHERE last_auth_method = 'bcrypt' AND is_active = true;

-- Create index for querying PoP-enabled devices
CREATE INDEX IF NOT EXISTS idx_devices_last_auth_pop ON devices(last_auth_method, last_auth_at)
WHERE last_auth_method = 'pop' AND is_active = true;
