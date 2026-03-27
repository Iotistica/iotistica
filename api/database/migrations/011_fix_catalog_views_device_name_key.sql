-- Migration 011: Fix catalog views to support snake_case device metadata keys
--
-- Problem:
--   Recent ingestion writes readings.extra.device_name (snake_case), but
--   materialized views metric_catalog and endpoint_devices filter on
--   readings.extra.deviceName (camelCase) only.
--
-- Result:
--   metric_catalog/endpoint_devices can remain empty even when readings are flowing.
--
-- Fix:
--   Recreate both views using a normalized device name expression:
--     COALESCE(NULLIF(extra->>'device_name',''), NULLIF(extra->>'deviceName',''))

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS public.metric_catalog CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.endpoint_devices CASCADE;

CREATE MATERIALIZED VIEW public.metric_catalog AS
SELECT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) as device_name,
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
  AND COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) IS NOT NULL
GROUP BY
    r.agent_uuid,
    d.device_name,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')),
    r.protocol,
    r.metric_name,
    r.unit;

CREATE INDEX IF NOT EXISTS idx_metric_catalog_agent
  ON public.metric_catalog (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_device
  ON public.metric_catalog (device_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_protocol
  ON public.metric_catalog (protocol);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_metric
  ON public.metric_catalog (metric_name);
CREATE INDEX IF NOT EXISTS idx_metric_catalog_composite
  ON public.metric_catalog (device_name, metric_name);

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_catalog_unique
  ON public.metric_catalog (
    agent_uuid,
    device_name,
    protocol,
    metric_name,
    unit
  );

COMMENT ON MATERIALIZED VIEW public.metric_catalog
  IS 'Catalog of available metrics with statistics (7-day window). Supports extra.device_name and extra.deviceName.';

CREATE MATERIALIZED VIEW public.endpoint_devices AS
SELECT DISTINCT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    d.is_online as agent_is_online,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) as device_name,
    r.protocol,
    MAX(r.time) as last_seen,
    COUNT(DISTINCT r.metric_name) as metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) as available_metrics,
    (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100) as overall_quality_percentage
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE r.time > NOW() - INTERVAL '7 days'
  AND COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) IS NOT NULL
GROUP BY
    r.agent_uuid,
    d.device_name,
    d.is_online,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')),
    r.protocol;

CREATE INDEX IF NOT EXISTS idx_endpoint_devices_agent
  ON public.endpoint_devices (agent_uuid);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_device
  ON public.endpoint_devices (device_name);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_protocol
  ON public.endpoint_devices (protocol);
CREATE INDEX IF NOT EXISTS idx_endpoint_devices_last_seen
  ON public.endpoint_devices (last_seen DESC);

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoint_devices_unique
  ON public.endpoint_devices (
    agent_uuid,
    device_name,
    protocol
  );

COMMENT ON MATERIALIZED VIEW public.endpoint_devices
  IS 'List of endpoint devices with available metrics. Supports extra.device_name and extra.deviceName.';

COMMIT;
