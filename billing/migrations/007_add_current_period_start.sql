-- Migration: Add current_period_start to subscriptions
-- Date: 2026-02-21

ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_subscriptions_current_period_start
ON subscriptions(current_period_start);
