-- Migration: Add shell audit log table for command tracking
-- Created: 2026-02-10
-- Description: Track all shell commands executed via Remote Access feature

CREATE TABLE IF NOT EXISTS shell_audit_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_uuid UUID NOT NULL,
  session_id UUID NOT NULL,
  command TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX idx_shell_audit_device ON shell_audit_log(device_uuid, timestamp DESC);
CREATE INDEX idx_shell_audit_user ON shell_audit_log(user_id, timestamp DESC);
CREATE INDEX idx_shell_audit_session ON shell_audit_log(session_id);
CREATE INDEX idx_shell_audit_timestamp ON shell_audit_log(timestamp DESC);

-- Comment on table
COMMENT ON TABLE shell_audit_log IS 'Audit log of shell commands executed via Remote Access';
COMMENT ON COLUMN shell_audit_log.command IS 'The command text entered by the user (logged when Enter is pressed)';
