-- Migration: Add refunds, cancellation, and customer deactivation features
-- Date: 2025-10-22

-- Add refunds table for tracking refunds
CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  stripe_refund_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_payment_intent_id VARCHAR(255),
  amount INTEGER NOT NULL, -- Amount in cents
  reason VARCHAR(50) NOT NULL CHECK (reason IN ('requested_by_customer', 'duplicate', 'fraudulent')),
  description TEXT,
  status VARCHAR(50) DEFAULT 'succeeded',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds(customer_id);
CREATE INDEX IF NOT EXISTS idx_refunds_stripe_refund_id ON refunds(stripe_refund_id);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at ON refunds(created_at DESC);

-- Add cancel_at_period_end field to subscriptions table
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;

-- Add soft delete fields to customers table
ALTER TABLE customers
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS scheduled_deletion TIMESTAMP;

-- Create indexes for deleted customers
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at ON customers(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_scheduled_deletion ON customers(scheduled_deletion) WHERE scheduled_deletion IS NOT NULL;

-- Add cleanup queue table for Kubernetes namespace deletion
CREATE TABLE IF NOT EXISTS cleanup_queue (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  namespace VARCHAR(255) NOT NULL,
  scheduled_for TIMESTAMP NOT NULL,
  status VARCHAR(50) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'completed', 'failed', 'canceled')),
  executed_at TIMESTAMP,
  canceled_at TIMESTAMP,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for cleanup queue
CREATE INDEX IF NOT EXISTS idx_cleanup_queue_customer_id ON cleanup_queue(customer_id);
CREATE INDEX IF NOT EXISTS idx_cleanup_queue_scheduled_for ON cleanup_queue(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_cleanup_queue_status ON cleanup_queue(status);

-- Create audit_log table for tracking important actions
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  customer_id VARCHAR(255) REFERENCES customers(customer_id) ON DELETE SET NULL,
  user_id VARCHAR(255),
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for audit log
CREATE INDEX IF NOT EXISTS idx_audit_log_customer_id ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_refunds_updated_at BEFORE UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cleanup_queue_updated_at BEFORE UPDATE ON cleanup_queue
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE refunds IS 'Tracks all refunds issued to customers';
COMMENT ON TABLE cleanup_queue IS 'Manages scheduled deletion of Kubernetes namespaces and customer data';
COMMENT ON TABLE audit_log IS 'Audit trail for important system actions';
COMMENT ON COLUMN subscriptions.cancel_at_period_end IS 'If true, subscription will cancel at the end of the current billing period';
COMMENT ON COLUMN customers.deleted_at IS 'Timestamp when customer was soft-deleted';
COMMENT ON COLUMN customers.scheduled_deletion IS 'Timestamp when customer data will be permanently deleted';
