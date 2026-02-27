-- Migration: Add system_config table for persistent system state
-- Purpose: Store configuration values and system state (e.g., heartbeat last check time)
-- Created: 2025-10-16

-- System configuration key-value store
CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups (though primary key already provides this)
CREATE INDEX IF NOT EXISTS idx_system_config_key ON system_config(key);

-- Add comment for documentation
COMMENT ON TABLE system_config IS 'System-wide configuration and state storage (key-value pairs)';
COMMENT ON COLUMN system_config.key IS 'Configuration key (e.g., heartbeat_last_check)';
COMMENT ON COLUMN system_config.value IS 'Configuration value stored as JSON';
COMMENT ON COLUMN system_config.updated_at IS 'Last update timestamp';

-- Example usage:
-- INSERT INTO system_config (key, value) VALUES ('heartbeat_last_check', '{"timestamp": "2025-10-16T10:00:00Z"}')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
