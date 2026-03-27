-- Migration 012: Use device_uuid as the identity key for catalog/latest endpoint views
--
-- Problem:
--   Catalog and latest-query paths were keyed by device_name, which is mutable and not unique.
--
-- Fix:
--   Recreate latest_readings, metric_catalog, and endpoint_devices to carry and index
--   device_uuid as the primary identity key. device_name remains display metadata only.

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS public.latest_readings CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.metric_catalog CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.endpoint_devices CASCADE;

CREATE MATERIALIZED VIEW public.latest_readings AS
SELECT DISTINCT ON (r.agent_uuid, COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')), r.metric_name)
    r.agent_uuid,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', ''))::uuid as device_uuid,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) as device_name,
    COALESCE(NULLIF(r.extra->>'endpoint_uuid', ''), NULLIF(r.extra->>'endpointUuid', ''))::uuid as endpoint_uuid,
    r.metric_name,
    r.time,
    r.value,
    r.quality,
    r.unit,
    r.protocol,
    r.extra->>'ingested_at' as ingested_at,
    r.anomaly_score,
    r.anomaly_threshold,
    d.device_name as agent_name,
    d.is_online as agent_is_online
FROM readings r
LEFT JOIN agents d ON r.agent_uuid = d.uuid
WHERE COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')) IS NOT NULL
ORDER BY
    r.agent_uuid,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')),
    r.metric_name,
    r.time DESC;

CREATE INDEX IF NOT EXISTS idx_latest_readings_identity
  ON public.latest_readings (agent_uuid, device_uuid, metric_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_latest_readings_unique
  ON public.latest_readings (agent_uuid, device_uuid, metric_name);
CREATE INDEX IF NOT EXISTS idx_latest_readings_device_uuid
  ON public.latest_readings (device_uuid);
CREATE INDEX IF NOT EXISTS idx_latest_readings_time
  ON public.latest_readings (time DESC);

COMMENT ON MATERIALIZED VIEW public.latest_readings
  IS 'Latest reading per agent_uuid+device_uuid+metric_name, with device_name retained as metadata.';

CREATE MATERIALIZED VIEW public.metric_catalog AS
SELECT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', ''))::uuid as device_uuid,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) as device_name,
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
    d.device_name,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')),
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')),
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
  IS 'Catalog keyed by device_uuid (device_name retained for display only).';

CREATE MATERIALIZED VIEW public.endpoint_devices AS
SELECT DISTINCT
    r.agent_uuid as agent_uuid,
    d.device_name as agent_name,
    d.is_online as agent_is_online,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', ''))::uuid as device_uuid,
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')) as device_name,
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
    d.device_name,
    d.is_online,
    COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')),
    COALESCE(NULLIF(r.extra->>'device_name', ''), NULLIF(r.extra->>'deviceName', '')),
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
  IS 'Endpoint devices keyed by device_uuid (device_name retained for display only).';

COMMIT;
