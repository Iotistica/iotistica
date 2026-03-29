-- Distributed throttle table for refresh_all_catalog_views().
-- A single-row UPDATE ... RETURNING pattern lets all API pods share one cooldown
-- window without advisory locks or in-process timestamps.
CREATE TABLE IF NOT EXISTS refresh_control (
  key         TEXT        PRIMARY KEY,
  last_refresh TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);

-- Seed the single row so the UPDATE path always finds a target.
INSERT INTO refresh_control (key, last_refresh)
VALUES ('metric_catalog', 'epoch')
ON CONFLICT (key) DO NOTHING;
