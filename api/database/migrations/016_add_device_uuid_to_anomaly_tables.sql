-- Migration 016: Add device_uuid to anomaly_events, anomaly_incidents, anomaly_alerts
--
-- device_uuid is the per-sensor/endpoint UUID extracted from the metric name
-- (metrics are stored as "{endpoint_uuid}_{metric_name}").
-- This allows filtering anomalies by the specific sensor/endpoint that triggered them,
-- without relying on the human-readable device_name which can change.

BEGIN;

-- ============================================================
-- 1. anomaly_events: add device_uuid column + index
-- ============================================================
ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS device_uuid text;

-- Backfill from metric name: extract leading UUID if metric matches pattern
-- "{uuid}_{anything}" (36-char UUID prefix)
UPDATE anomaly_events
SET device_uuid = substring(metric FROM '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_')
WHERE device_uuid IS NULL
  AND metric ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_';

CREATE INDEX IF NOT EXISTS idx_anomaly_events_device_uuid
  ON anomaly_events (device_uuid, timestamp_ms DESC)
  WHERE device_uuid IS NOT NULL;

-- ============================================================
-- 2. anomaly_incidents: add device_uuid column + index
-- ============================================================
ALTER TABLE anomaly_incidents ADD COLUMN IF NOT EXISTS device_uuid text;

-- Backfill from metric name
UPDATE anomaly_incidents
SET device_uuid = substring(metric FROM '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_')
WHERE device_uuid IS NULL
  AND metric ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_';

CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_device_uuid
  ON anomaly_incidents (device_uuid)
  WHERE device_uuid IS NOT NULL;

-- ============================================================
-- 3. anomaly_alerts: add device_uuid column + index
-- ============================================================
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS device_uuid text;

-- Backfill from metric name
UPDATE anomaly_alerts
SET device_uuid = substring(metric FROM '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_')
WHERE device_uuid IS NULL
  AND metric ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_';

CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_device_uuid
  ON anomaly_alerts (device_uuid)
  WHERE device_uuid IS NOT NULL;

-- ============================================================
-- 4. Recreate device_anomaly_summary view with device_uuid
-- ============================================================
DROP VIEW IF EXISTS device_anomaly_summary;

CREATE OR REPLACE VIEW device_anomaly_summary AS
SELECT
  agent_uuid,
  extra ->> 'deviceName' AS device_name,
  extra ->> 'device_uuid' AS device_uuid,
  AVG(anomaly_score) FILTER (WHERE time > NOW() - INTERVAL '24 hours') AS avg_anomaly_24h,
  MAX(anomaly_score) FILTER (WHERE time > NOW() - INTERVAL '24 hours') AS max_anomaly_24h,
  COUNT(*) FILTER (WHERE time > NOW() - INTERVAL '24 hours' AND anomaly_score > 0.7) AS high_anomaly_count_24h,
  (
    SELECT r2.anomaly_score
    FROM readings r2
    WHERE r2.agent_uuid = r.agent_uuid AND r2.anomaly_score IS NOT NULL
    ORDER BY r2.time DESC
    LIMIT 1
  ) AS latest_anomaly_score,
  (
    SELECT r2.time
    FROM readings r2
    WHERE r2.agent_uuid = r.agent_uuid AND r2.anomaly_score IS NOT NULL
    ORDER BY r2.time DESC
    LIMIT 1
  ) AS latest_scored_time,
  (
    SELECT r2.metric_name
    FROM readings r2
    WHERE r2.agent_uuid = r.agent_uuid
      AND r2.time > NOW() - INTERVAL '24 hours'
      AND r2.anomaly_score IS NOT NULL
    GROUP BY r2.metric_name
    ORDER BY AVG(r2.anomaly_score) DESC
    LIMIT 1
  ) AS most_anomalous_metric,
  COUNT(DISTINCT metric_name) FILTER (WHERE anomaly_score IS NOT NULL AND time > NOW() - INTERVAL '24 hours') AS monitored_metrics_count
FROM readings r
WHERE anomaly_score IS NOT NULL
  AND time > NOW() - INTERVAL '7 days'
GROUP BY agent_uuid, (extra ->> 'deviceName'), (extra ->> 'device_uuid');

COMMENT ON VIEW device_anomaly_summary IS
  'Real-time anomaly summary per agent+device_name+device_uuid. Groups by per-sensor device_uuid from JSONB extra field.';

-- ============================================================
-- 5. Recreate recent_anomalies materialized view with device_uuid
-- ============================================================
DROP MATERIALIZED VIEW IF EXISTS recent_anomalies;

CREATE MATERIALIZED VIEW recent_anomalies AS
SELECT
  ae.timestamp_ms,
  ae.agent_uuid AS agent_id,
  ae.device_uuid,
  ae.metric,
  ae.observed_value,
  ae.anomaly_score,
  ae.confidence,
  ae.severity,
  ae.severity_reason,
  ae.fingerprint,
  ae.triggered_by,
  ae.baseline,
  ae.expected_range,
  ae.deviation,
  ae.consecutive_count,
  ae.event_count,
  d.device_name AS agent_name,
  d.uuid AS agent_uuid,
  d.is_online AS agent_is_online
FROM anomaly_events ae
LEFT JOIN devices d ON ae.agent_uuid = d.uuid::text
WHERE ae.timestamp_ms > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours')::bigint * 1000)
ORDER BY ae.timestamp_ms DESC;

CREATE INDEX IF NOT EXISTS idx_recent_anomalies_timestamp
  ON recent_anomalies (timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_recent_anomalies_device_uuid
  ON recent_anomalies (device_uuid)
  WHERE device_uuid IS NOT NULL;

COMMENT ON MATERIALIZED VIEW recent_anomalies IS
  'Recent anomaly events (last 24h) with device_uuid for per-sensor filtering.';

COMMIT;
