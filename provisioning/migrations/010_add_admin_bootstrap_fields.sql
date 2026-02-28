-- Add admin bootstrap password tracking fields
-- Migration 010: Admin Bootstrap Password Management
-- Stores initial admin password and bootstrap timestamp from provisioning

ALTER TABLE customers 
  ADD COLUMN IF NOT EXISTS initial_admin_password VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bootstrapped_at TIMESTAMP;

-- Create index for finding bootstrapped customers
CREATE INDEX IF NOT EXISTS idx_customers_bootstrapped 
  ON customers(bootstrapped_at) 
  WHERE bootstrapped_at IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN customers.initial_admin_password IS 'Encrypted initial admin password (stored for audit, should be deleted after customer confirms receipt)';
COMMENT ON COLUMN customers.bootstrapped_at IS 'Timestamp when admin bootstrap was completed successfully';
