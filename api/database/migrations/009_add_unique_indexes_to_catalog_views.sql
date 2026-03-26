-- Migration: Add unique indexes required for concurrent refresh of catalog materialized views
--
-- PostgreSQL requires a plain unique index on a materialized view before
-- REFRESH MATERIALIZED VIEW CONCURRENTLY can be used.
--
-- The refresh helpers in this codebase call:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY metric_catalog;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
--
-- The base view migration creates only non-unique indexes, so concurrent
-- refresh fails at runtime. These unique indexes match the effective row
-- identity of each materialized view.

BEGIN;

-- metric_catalog: one row per agent/device/protocol/metric/unit over the 7-day window
CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_catalog_unique
  ON public.metric_catalog (
    agent_uuid,
    device_name,
    protocol,
    metric_name,
    unit
  );

COMMENT ON INDEX public.idx_metric_catalog_unique
  IS 'Required for REFRESH MATERIALIZED VIEW CONCURRENTLY on metric_catalog';

-- endpoint_devices: one row per agent/device/protocol over the 7-day window
CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_devices_unique
  ON public.endpoint_devices (
    agent_uuid,
    device_name,
    protocol
  );

COMMENT ON INDEX public.idx_endpoint_devices_unique
  IS 'Required for REFRESH MATERIALIZED VIEW CONCURRENTLY on endpoint_devices';

COMMIT;
