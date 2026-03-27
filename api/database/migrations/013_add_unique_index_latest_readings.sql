-- Migration 013: Add unique index required for concurrent refresh of latest_readings
--
-- PostgreSQL requires a plain unique index on materialized views refreshed with
-- REFRESH MATERIALIZED VIEW CONCURRENTLY.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_readings_unique
  ON public.latest_readings (agent_uuid, device_uuid, metric_name);

COMMENT ON INDEX public.idx_latest_readings_unique
  IS 'Required for REFRESH MATERIALIZED VIEW CONCURRENTLY on latest_readings';

COMMIT;
