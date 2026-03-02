-- Add API key authentication to customers table

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(255),
ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS api_key_last_used TIMESTAMP;

-- Add index for API key lookups
CREATE INDEX IF NOT EXISTS idx_customers_api_key ON customers(api_key_hash);
