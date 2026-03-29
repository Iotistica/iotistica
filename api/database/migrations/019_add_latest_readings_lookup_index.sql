-- Migration 019: Add index optimized for latest-per-metric lookups
--
-- Purpose:
--   Speed up latest-reading queries that fetch one newest row per metric for an agent.
--
-- Query pattern:
--   WHERE agent_uuid = ? AND metric_name = ? ORDER BY time DESC LIMIT 1
--
-- Also helps time-series queries with metric filter:
--   WHERE agent_uuid = ? AND metric_name = ? [AND time range] ORDER BY time DESC LIMIT N

CREATE INDEX IF NOT EXISTS idx_readings_agent_metric_time_desc
  ON public.readings (agent_uuid, metric_name, time DESC);