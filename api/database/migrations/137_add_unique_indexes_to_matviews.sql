-- Migration 132: Add unique indexes to materialized views for concurrent refresh
-- Purpose: Enable REFRESH MATERIALIZED VIEW CONCURRENTLY for metric_catalog and endpoint_devices
-- Date: 2026-02-10
-- Dependencies: Migration 131 (metric catalog views)

-- ============================================================================
-- UNIQUE INDEX FOR metric_catalog
-- ============================================================================
-- Combination of agent_uuid, device_name, protocol, metric_name uniquely identifies each row

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_catalog_unique 
ON metric_catalog (agent_uuid, device_name, protocol, metric_name);

COMMENT ON INDEX idx_metric_catalog_unique IS 'Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY';

-- ============================================================================
-- UNIQUE INDEX FOR endpoint_devices
-- ============================================================================
-- Combination of agent_uuid, device_name, protocol uniquely identifies each endpoint device

CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_devices_unique 
ON endpoint_devices (agent_uuid, device_name, protocol);

COMMENT ON INDEX idx_endpoint_devices_unique IS 'Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- Verify unique indexes exist
-- SELECT schemaname, matviewname, indexname, indexdef 
-- FROM pg_indexes 
-- WHERE tablename IN ('metric_catalog', 'endpoint_devices', 'latest_readings') 
-- AND indexdef LIKE '%UNIQUE%';
