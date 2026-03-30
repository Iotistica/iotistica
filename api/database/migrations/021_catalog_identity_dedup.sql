-- Migration 021: Identity-based dedup for catalog views
--
-- Problem:
--   metric_catalog and endpoint_devices grouped by display metadata (device_name/agent_name),
--   which can vary for the same endpoint identity and cause unique index collisions during
--   REFRESH MATERIALIZED VIEW CONCURRENTLY.
--
-- Fix:
--   Recreate metric_catalog and endpoint_devices with identity-first grouping keys:
--   (agent_uuid, device_uuid, endpoint_uuid, protocol[, metric_name, unit])
--   and aggregate display fields via MAX()/BOOL_OR().

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS public.metric_catalog CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.endpoint_devices CASCADE;

CREATE MATERIALIZED VIEW public.metric_catalog AS
SELECT
    r.agent_uuid as agent_uuid,
    MAX(d.name) as agent_name,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', ''))::uuid as device_uuid,
    MAX(COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', ''))) as device_name,
    COALESCE(NULLIF(r.extra->>'endpoint_uuid', ''), NULLIF(r.extra->>'endpointUuid', ''))::uuid as endpoint_uuid,
    r.protocol,
    r.metric_name,
    r.unit,
    COUNT(*) as sample_count,
    MIN(r.time) as first_seen,
    MAX(r.time) as last_seen,
    AVG(r.value) as avg_value,
    MIN(r.value) as min_value,
    MAX(r.value) as max_value,
    STDDEV(r.value) as stddev_value,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as quality_percentage,
    AVG(r.anomaly_score) FILTER (WHERE r.anomaly_score IS NOT NULL) as avg_anomaly_score,
    MAX(r.anomaly_score) as max_anomaly_score,
    COUNT(*) FILTER (WHERE r.anomaly_score > r.anomaly_threshold) as anomaly_count
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')) IS NOT NULL
GROUP BY
    r.agent_uuid,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')),
    COALESCE(NULLIF(r.extra->>'endpoint_uuid', ''), NULLIF(r.extra->>'endpointUuid', '')),
    r.protocol,
    r.metric_name,
    r.unit;

CREATE INDEX IF NOT EXISTS idx_metric_catalog_agent
  ON public.metric_catalog (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_device_uuid
  ON public.metric_catalog (device_uuid);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_protocol
  ON public.metric_catalog (protocol);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_metric
  ON public.metric_catalog (metric_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_composite
  ON public.metric_catalog (device_uuid, metric_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_catalog_unique
  ON public.metric_catalog (
    agent_uuid,
    device_uuid,
    endpoint_uuid,
    protocol,
    metric_name,
    unit
  );

COMMENT ON MATERIALIZED VIEW public.metric_catalog
  IS 'Catalog keyed by endpoint identity; display names are aggregated metadata.';

CREATE MATERIALIZED VIEW public.endpoint_devices AS
SELECT
    r.agent_uuid as agent_uuid,
    MAX(d.name) as agent_name,
    COALESCE(BOOL_OR(d.is_online), false) as agent_is_online,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', ''))::uuid as device_uuid,
    MAX(COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', ''))) as device_name,
    COALESCE(NULLIF(r.extra->>'endpoint_uuid', ''), NULLIF(r.extra->>'endpointUuid', ''))::uuid as endpoint_uuid,
    r.protocol,
    MAX(r.time) as last_seen,
    COUNT(DISTINCT r.metric_name) as metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) as available_metrics,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as overall_quality_percentage
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')) IS NOT NULL
GROUP BY
    r.agent_uuid,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')),
    COALESCE(NULLIF(r.extra->>'endpoint_uuid', ''), NULLIF(r.extra->>'endpointUuid', '')),
    r.protocol;

CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent
  ON public.endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device_uuid
  ON public.endpoint_devices (device_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol
  ON public.endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen
  ON public.endpoint_devices (last_seen DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_devices_unique
  ON public.endpoint_devices (
    agent_uuid,
    device_uuid,
    endpoint_uuid,
    protocol
  );

COMMENT ON MATERIALIZED VIEW public.endpoint_devices
  IS 'Endpoint catalog keyed by endpoint identity; display names are aggregated metadata.';

COMMIT;
