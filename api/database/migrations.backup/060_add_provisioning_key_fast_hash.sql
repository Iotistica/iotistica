-- Migration: Add fast hash lookup column for provisioning keys
-- Purpose: Optimize key validation from O(N) bcrypt comparisons to O(1)
-- Impact: Reduces validation time from ~3s to ~350ms

-- Add SHA-256 hash column for fast lookups
ALTER TABLE provisioning_keys 
ADD COLUMN IF NOT EXISTS key_hash_fast VARCHAR(64);

-- Create index for fast lookups (without WHERE clause to avoid IMMUTABLE requirement)
-- Filter in application layer instead
CREATE INDEX IF NOT EXISTS idx_provisioning_keys_fast_hash 
ON provisioning_keys(key_hash_fast);

-- Add comment explaining the optimization
COMMENT ON COLUMN provisioning_keys.key_hash_fast IS 
  'SHA-256 hash for fast O(1) lookup before bcrypt verification. Reduces validation from O(N) to O(1) + 1 bcrypt.';
