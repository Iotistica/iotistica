-- Migrate from plaintext password storage to secure reset token flow
-- Migration 011: Admin Password Reset Token Management
-- Implements SOC2-compliant password delivery via one-time reset links

-- Drop the plaintext password column (not compliant)
ALTER TABLE customers 
  DROP COLUMN IF EXISTS initial_admin_password;

-- Add secure reset token fields for password setup
ALTER TABLE customers 
  ADD COLUMN IF NOT EXISTS admin_reset_token_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS admin_reset_token_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS admin_reset_token_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS admin_reset_token_used BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_reset_token_used_at TIMESTAMP;

-- Create index for finding customers with pending password reset
CREATE INDEX IF NOT EXISTS idx_customers_admin_reset_pending 
  ON customers(admin_reset_token_expires_at) 
  WHERE admin_reset_token_used = false 
  AND admin_reset_token_expires_at > CURRENT_TIMESTAMP;

-- Create index for finding expired reset tokens
CREATE INDEX IF NOT EXISTS idx_customers_admin_reset_expired 
  ON customers(admin_reset_token_expires_at) 
  WHERE admin_reset_token_used = false 
  AND admin_reset_token_expires_at <= CURRENT_TIMESTAMP;

-- Add comments for documentation
COMMENT ON COLUMN customers.admin_reset_token_hash IS 'bcrypt hash of the admin password reset token (one-time use)';
COMMENT ON COLUMN customers.admin_reset_token_expires_at IS 'When the reset token expires (24 hours after generation)';
COMMENT ON COLUMN customers.admin_reset_token_sent_at IS 'When the reset link was EmailSent to customer';
COMMENT ON COLUMN customers.admin_reset_token_used IS 'Whether the reset token has been used to set a password';
COMMENT ON COLUMN customers.admin_reset_token_used_at IS 'When the customer used the reset token to set their password';
