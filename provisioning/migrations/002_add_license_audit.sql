-- Migration: Add license audit logging
-- Purpose: Track license generation, plan changes, and usage for compliance and analytics
-- Created: 2025-10-21

-- License history/audit log table
CREATE TABLE IF NOT EXISTS license_history (
    id SERIAL PRIMARY KEY,
    customer_id VARCHAR(100) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,  -- 'generated', 'regenerated', 'upgraded', 'downgraded', 'revoked'
    plan VARCHAR(50) NOT NULL,
    max_devices INTEGER NOT NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    generated_by VARCHAR(100) DEFAULT 'system',  -- Admin user or 'system', 'api', etc.
    license_hash VARCHAR(64) NOT NULL,  -- SHA-256 hash of JWT (for debugging, NOT the actual JWT)
    metadata JSONB  -- Additional context (e.g., features, limits, reason for regeneration)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_license_history_customer ON license_history(customer_id);
CREATE INDEX IF NOT EXISTS idx_license_history_generated_at ON license_history(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_license_history_action ON license_history(action);

-- Comments for documentation
COMMENT ON TABLE license_history IS 'Audit log of license generation and plan changes (stores metadata only, NOT actual JWTs)';
COMMENT ON COLUMN license_history.license_hash IS 'SHA-256 hash of generated JWT for debugging (allows verification without storing actual JWT)';
COMMENT ON COLUMN license_history.action IS 'Type of license operation: generated (new customer), regenerated (same plan), upgraded, downgraded, revoked';
COMMENT ON COLUMN license_history.metadata IS 'Additional context stored as JSON (features, limits, subscription status, etc.)';

-- Example usage:
-- Track new license generation:
-- INSERT INTO license_history (customer_id, action, plan, max_devices, license_hash, metadata)
-- VALUES ('cust_abc123', 'generated', 'professional', 50, 'sha256hash...', '{"features": {...}}');

-- Find all plan changes for a customer:
-- SELECT * FROM license_history WHERE customer_id = 'cust_abc123' ORDER BY generated_at DESC;

-- Find recent license generations:
-- SELECT * FROM license_history WHERE action = 'generated' AND generated_at > NOW() - INTERVAL '7 days';
