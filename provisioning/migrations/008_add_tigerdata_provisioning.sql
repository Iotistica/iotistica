-- Migration: Add TigerData and 1Password provisioning fields
-- Date: 2026-02-24

-- Add TigerData database provisioning fields
ALTER TABLE customers 
ADD COLUMN IF NOT EXISTS db_service_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS db_host VARCHAR(255),
ADD COLUMN IF NOT EXISTS db_port INTEGER DEFAULT 5432,
ADD COLUMN IF NOT EXISTS db_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS db_region VARCHAR(50),
ADD COLUMN IF NOT EXISTS db_provisioned_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS db_api_response JSONB,
ADD COLUMN IF NOT EXISTS db_initialized BOOLEAN DEFAULT false;

-- Add 1Password secret management fields
ALTER TABLE customers
ADD COLUMN IF NOT EXISTS secret_item_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS secret_created_at TIMESTAMP;

-- Add Argo CD retry tracking fields
ALTER TABLE customers
ADD COLUMN IF NOT EXISTS argo_retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS argo_last_retry_at TIMESTAMP;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_customers_db_service_id ON customers(db_service_id);
CREATE INDEX IF NOT EXISTS idx_customers_secret_item_id ON customers(secret_item_id);

-- Add comments
COMMENT ON COLUMN customers.db_service_id IS 'TigerData service ID for provisioned database';
COMMENT ON COLUMN customers.db_host IS 'Database connection hostname (e.g., xyz.tsdb.cloud.timescale.com)';
COMMENT ON COLUMN customers.db_port IS 'Database connection port';
COMMENT ON COLUMN customers.db_name IS 'Database name';
COMMENT ON COLUMN customers.db_region IS 'TigerData provisioning region (e.g., us-east-1)';
COMMENT ON COLUMN customers.db_provisioned_at IS 'Timestamp when TigerData database provisioning completed';
COMMENT ON COLUMN customers.db_api_response IS 'Full TigerData API response for audit trail';
COMMENT ON COLUMN customers.db_initialized IS 'Whether database migrations have been run';
COMMENT ON COLUMN customers.secret_item_id IS '1Password Connect item ID for database credentials';
COMMENT ON COLUMN customers.secret_created_at IS 'Timestamp when 1Password secret was created';
COMMENT ON COLUMN customers.argo_retry_count IS 'Number of Argo CD sync retry attempts';
COMMENT ON COLUMN customers.argo_last_retry_at IS 'Timestamp of last Argo CD retry attempt';

-- Update deployment_status to support new provisioning states
-- Valid states: 'pending', 'db_provisioning', 'db_ready', 'secret_creating', 
-- 'secret_ready', 'provisioning', 'deploying', 'ready', 'failed', 'deployment_failed'
COMMENT ON COLUMN customers.deployment_status IS 'Deployment status: pending, db_provisioning, db_ready, secret_creating, secret_ready, provisioning, deploying, ready, failed, deployment_failed';
