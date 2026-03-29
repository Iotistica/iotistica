-- Add lease_until column to refresh_control to prevent overlapping refreshes.
--
-- Design: lease_until serves dual purpose:
--   - While refresh is running: NOW() + 120s  (active lock, self-expiring on crash)
--   - After release (success or failure): NOW() + 60s  (throttle cooldown)
--
-- Claim condition: NOW() > lease_until
-- This means: no other worker holds an active lock AND cooldown has elapsed.
ALTER TABLE refresh_control
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ NOT NULL DEFAULT 'epoch';
