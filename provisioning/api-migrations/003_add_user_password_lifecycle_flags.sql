-- Migration 003: Add password lifecycle and first-login enforcement fields
-- Purpose: Support secure initial admin onboarding and forced password updates

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS password_last_changed_at TIMESTAMP;

UPDATE users
SET must_change_password = true
WHERE username = 'admin'
  AND COALESCE(password_last_changed_at, TIMESTAMP 'epoch') = TIMESTAMP 'epoch';

COMMENT ON COLUMN users.must_change_password IS 'When true, user must change password before normal use';
COMMENT ON COLUMN users.password_last_changed_at IS 'Timestamp when password was last changed';
