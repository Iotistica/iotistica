-- Add observability fields for provisioning lifecycle tracking
-- Migration 009: Provisioning Observability
-- These fields help track provisioning progress and diagnose failures

ALTER TABLE customers 
  ADD COLUMN IF NOT EXISTS last_provisioning_step VARCHAR(100),
  ADD COLUMN IF NOT EXISTS last_provisioning_error TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS provisioning_completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS provisioning_retry_count INTEGER DEFAULT 0;

-- Create index for querying stuck provisioning jobs
CREATE INDEX IF NOT EXISTS idx_customers_provisioning_status 
  ON customers(deployment_status, provisioning_started_at) 
  WHERE deployment_status NOT IN ('ready', 'cancelled');

-- Add comments for documentation
COMMENT ON COLUMN customers.last_provisioning_step IS 'Last successful provisioning step (e.g., db_provisioned, secret_created, git_committed, argo_deployed)';
COMMENT ON COLUMN customers.last_provisioning_error IS 'Detailed error message from last provisioning failure';
COMMENT ON COLUMN customers.provisioning_started_at IS 'When the current provisioning attempt started';
COMMENT ON COLUMN customers.provisioning_completed_at IS 'When provisioning successfully completed';
COMMENT ON COLUMN customers.provisioning_retry_count IS 'Number of times provisioning has been retried';
