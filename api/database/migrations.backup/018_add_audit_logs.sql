-- Migration: Add audit logs table
-- Created: 2025-11-03
-- Purpose: Track authentication and user management events for security auditing

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,  -- e.g., 'user_registered', 'user_login', 'login_failed'
    device_uuid VARCHAR(255),           -- Optional: related device
    user_id INTEGER,                    -- Optional: related user (NULL for failed logins)
    ip_address INET,                    -- IP address of request
    details JSONB,                      -- Additional event details
    severity VARCHAR(20) DEFAULT 'info', -- info, warning, error
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_device_uuid ON audit_logs(device_uuid);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity);

-- Optional: Add retention policy (delete logs older than 90 days)
-- This can be run as a scheduled job
-- DELETE FROM audit_logs WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';

COMMENT ON TABLE audit_logs IS 'Security audit trail for authentication and user management events';
COMMENT ON COLUMN audit_logs.event_type IS 'Type of event: user_registered, user_login, login_failed, password_changed, etc.';
COMMENT ON COLUMN audit_logs.details IS 'JSON object with additional event-specific information';
