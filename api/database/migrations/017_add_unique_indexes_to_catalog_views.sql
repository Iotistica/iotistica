-- Migration 017: Add missing unique indexes to metric_catalog and endpoint_devices
-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY to work on both views.
--
-- PostgreSQL requires simple column-only unique indexes (no expressions/COALESCE)
-- for CONCURRENTLY refresh. Since both views use GROUP BY over these exact columns,
-- each GROUP BY combination produces exactly one row — no duplicates possible.
-- NULL values in the GROUP BY key columns are unified by GROUP BY (unlike unique
-- indexes where NULLs are considered distinct), so there are no spurious conflicts.
--
-- metric_catalog groups by: agent_uuid, device_name, device_uuid, endpoint_uuid,
--   metric_name, protocol, unit — device_name is NOT NULL (WHERE filter in view).
--
-- endpoint_devices groups by: agent_uuid, device_name, device_uuid, endpoint_uuid,
--   protocol — device_name is NOT NULL (WHERE filter in view).

BEGIN;

-- metric_catalog ----------------------------------------------------------
DROP INDEX IF EXISTS idx_metric_catalog_unique;

CREATE UNIQUE INDEX idx_metric_catalog_unique
    ON metric_catalog (
        agent_uuid,
        device_name,
        metric_name,
        protocol,
        endpoint_uuid,
        device_uuid,
        unit
    );

-- endpoint_devices --------------------------------------------------------
DROP INDEX IF EXISTS idx_endpoint_devices_unique;

CREATE UNIQUE INDEX idx_endpoint_devices_unique
    ON endpoint_devices (
        agent_uuid,
        device_name,
        endpoint_uuid,
        device_uuid,
        protocol
    );

COMMIT;
