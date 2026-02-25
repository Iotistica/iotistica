-- Migration: Add fields for customer signup and deployment tracking
-- Date: 2025-10-21

-- Add password authentication
ALTER TABLE customers 
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);

-- Add deployment tracking
ALTER TABLE customers
ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(50) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS instance_url VARCHAR(255),
ADD COLUMN IF NOT EXISTS instance_namespace VARCHAR(100),
ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS deployment_error TEXT;

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_customers_deployment_status ON customers(deployment_status);
CREATE INDEX IF NOT EXISTS idx_customers_instance_namespace ON customers(instance_namespace);

-- Add comments
COMMENT ON COLUMN customers.password_hash IS 'Bcrypt hash of customer password for self-service signup';
COMMENT ON COLUMN customers.full_name IS 'Customer contact full name';
COMMENT ON COLUMN customers.deployment_status IS 'K8s deployment status: pending, provisioning, ready, failed';
COMMENT ON COLUMN customers.instance_url IS 'Customer instance URL (e.g., https://cust-123.yourdomain.com)';
COMMENT ON COLUMN customers.instance_namespace IS 'Kubernetes namespace for customer instance';
COMMENT ON COLUMN customers.deployed_at IS 'Timestamp when deployment completed successfully';
COMMENT ON COLUMN customers.deployment_error IS 'Error message if deployment failed';
