-- Migration: Add security tables for provisioning keys, device API keys, and audit logging
-- Created: 2025-10-14
-- Purpose: Implement secure provisioning with key validation and audit trails

-- Provisioning keys table - for fleet-level device registration
CREATE TABLE IF NOT EXISTS provisioning_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(255) NOT NULL,  -- bcrypt hashed provisioning key
    fleet_id VARCHAR(100) NOT NULL,  -- Fleet/application identifier
    description TEXT,
    max_devices INTEGER DEFAULT 100,
    devices_provisioned INTEGER DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    last_used_at TIMESTAMP,
    CONSTRAINT devices_not_exceeded CHECK (devices_provisioned <= max_devices)
);

CREATE INDEX idx_provisioning_keys_fleet_id ON provisioning_keys(fleet_id);
CREATE INDEX idx_provisioning_keys_is_active ON provisioning_keys(is_active);
CREATE INDEX idx_provisioning_keys_expires_at ON provisioning_keys(expires_at);

-- Device API keys table - for device-specific authentication with rotation support
CREATE TABLE IF NOT EXISTS device_api_keys (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,  -- bcrypt hashed device API key
    issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    revoked BOOLEAN DEFAULT false,
    revoked_at TIMESTAMP,
    revoked_reason VARCHAR(255),
    last_used_at TIMESTAMP,
    UNIQUE(device_uuid, key_hash)
);

CREATE INDEX idx_device_api_keys_device_uuid ON device_api_keys(device_uuid);
CREATE INDEX idx_device_api_keys_expires_at ON device_api_keys(expires_at);
CREATE INDEX idx_device_api_keys_revoked ON device_api_keys(revoked);

-- Audit logs table - for security event tracking
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,  -- e.g., 'device_provisioned', 'key_exchange', 'authentication_failed'
    device_uuid UUID REFERENCES devices(uuid) ON DELETE SET NULL,
    user_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    details JSONB,  -- Flexible storage for event-specific data
    severity VARCHAR(20) DEFAULT 'info',  -- info, warning, error, critical
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_device_uuid ON audit_logs(device_uuid);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_severity ON audit_logs(severity);

-- Provisioning attempts tracking - for rate limiting and abuse detection
CREATE TABLE IF NOT EXISTS provisioning_attempts (
    id BIGSERIAL PRIMARY KEY,
    ip_address INET NOT NULL,
    device_uuid UUID,
    provisioning_key_id UUID REFERENCES provisioning_keys(id) ON DELETE SET NULL,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_provisioning_attempts_ip ON provisioning_attempts(ip_address, created_at);
CREATE INDEX idx_provisioning_attempts_success ON provisioning_attempts(success);

-- Add fleet_id to devices table to track which provisioning key was used
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fleet_id VARCHAR(100);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS provisioned_by_key_id UUID REFERENCES provisioning_keys(id) ON DELETE SET NULL;

CREATE INDEX idx_devices_fleet_id ON devices(fleet_id);

-- Add device_api_key_hash column to devices table (for backward compatibility)
-- This will store the CURRENT active key hash for quick lookups
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_api_key_hash VARCHAR(255);

COMMENT ON TABLE provisioning_keys IS 'Fleet-level provisioning keys with device limits and expiration';
COMMENT ON TABLE device_api_keys IS 'Device-specific API keys with rotation and revocation support';
COMMENT ON TABLE audit_logs IS 'Security and operational event audit trail';
COMMENT ON TABLE provisioning_attempts IS 'Tracks provisioning attempts for rate limiting and security monitoring';
