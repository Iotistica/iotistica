-- Migration: Add anomaly score tracking and aggregates
-- 
-- Purpose: Track anomaly detection scores from edge AI and create
-- continuous aggregates for per-device anomaly monitoring

-- 1. Add anomaly score columns to readings table
ALTER TABLE readings 
  ADD COLUMN IF NOT EXISTS anomaly_score real,
  ADD COLUMN IF NOT EXISTS anomaly_threshold real,
  ADD COLUMN IF NOT EXISTS baseline_samples integer,
  ADD COLUMN IF NOT EXISTS detection_methods jsonb;

COMMENT ON COLUMN readings.anomaly_score IS 'Anomaly score from edge AI (0-1, higher = more anomalous)';
COMMENT ON COLUMN readings.anomaly_threshold IS 'Threshold used for anomaly detection';
COMMENT ON COLUMN readings.baseline_samples IS 'Number of baseline samples used for detection';
COMMENT ON COLUMN readings.detection_methods IS 'Array of detection methods applied';

-- 2. Create index for anomaly queries
CREATE INDEX IF NOT EXISTS idx_readings_anomaly_score 
  ON readings (device_uuid, time DESC) 
  WHERE anomaly_score IS NOT NULL;

-- 3. Create hourly anomaly aggregate
-- Provides hourly statistics on anomaly scores per device (deviceName from extra->>'deviceName')
CREATE MATERIALIZED VIEW IF NOT EXISTS anomaly_scores_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  device_uuid,
  extra->>'deviceName' AS device_name,
  metric_name,
  protocol,
  -- Anomaly score statistics
  AVG(anomaly_score) AS avg_anomaly_score,
  MIN(anomaly_score) AS min_anomaly_score,
  MAX(anomaly_score) AS max_anomaly_score,
  STDDEV(anomaly_score) AS stddev_anomaly_score,
  -- Count of readings with anomaly scores
  COUNT(*) FILTER (WHERE anomaly_score IS NOT NULL) AS scored_count,
  -- Count of high anomaly scores (>0.7)
  COUNT(*) FILTER (WHERE anomaly_score > 0.7) AS high_anomaly_count,
  -- Percentage of readings with high anomaly scores
  (COUNT(*) FILTER (WHERE anomaly_score > 0.7)::float / 
   NULLIF(COUNT(*) FILTER (WHERE anomaly_score IS NOT NULL), 0) * 100) AS high_anomaly_percent,
  -- Latest anomaly score
  LAST(anomaly_score, time) AS last_anomaly_score,
  LAST(time, time) AS last_scored_time,
  -- Threshold info
  AVG(anomaly_threshold) AS avg_threshold,
  AVG(baseline_samples) AS avg_baseline_samples
FROM readings
WHERE anomaly_score IS NOT NULL
GROUP BY bucket, device_uuid, extra->>'deviceName', metric_name, protocol
WITH NO DATA;

-- Create indexes on anomaly aggregate
CREATE INDEX IF NOT EXISTS idx_anomaly_hourly_device_time 
  ON anomaly_scores_hourly (device_uuid, device_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_hourly_device_name 
  ON anomaly_scores_hourly (device_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_hourly_high_scores 
  ON anomaly_scores_hourly (bucket DESC) 
  WHERE high_anomaly_count > 0;

-- Refresh policy: every hour, cover last 3 hours
SELECT add_continuous_aggregate_policy('anomaly_scores_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- 4. Create daily anomaly aggregate
-- Provides daily overview of anomaly patterns per device (deviceName)
CREATE MATERIALIZED VIEW IF NOT EXISTS anomaly_scores_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  device_uuid,
  extra->>'deviceName' AS device_name,
  metric_name,
  protocol,
  -- Daily anomaly statistics
  AVG(anomaly_score) AS avg_anomaly_score,
  MIN(anomaly_score) AS min_anomaly_score,
  MAX(anomaly_score) AS max_anomaly_score,
  STDDEV(anomaly_score) AS stddev_anomaly_score,
  -- Counts by severity
  COUNT(*) FILTER (WHERE anomaly_score IS NOT NULL) AS scored_count,
  COUNT(*) FILTER (WHERE anomaly_score > 0.9) AS critical_count,
  COUNT(*) FILTER (WHERE anomaly_score > 0.7 AND anomaly_score <= 0.9) AS high_count,
  COUNT(*) FILTER (WHERE anomaly_score > 0.5 AND anomaly_score <= 0.7) AS medium_count,
  COUNT(*) FILTER (WHERE anomaly_score <= 0.5) AS low_count,
  -- Percentages
  (COUNT(*) FILTER (WHERE anomaly_score > 0.9)::float / 
   NULLIF(COUNT(*) FILTER (WHERE anomaly_score IS NOT NULL), 0) * 100) AS critical_percent,
  (COUNT(*) FILTER (WHERE anomaly_score > 0.7)::float / 
   NULLIF(COUNT(*) FILTER (WHERE anomaly_score IS NOT NULL), 0) * 100) AS high_plus_percent,
  -- Threshold info
  AVG(anomaly_threshold) AS avg_threshold,
  AVG(baseline_samples) AS avg_baseline_samples
FROM readings
WHERE anomaly_score IS NOT NULL
GROUP BY bucket, device_uuid, extra->>'deviceName', metric_name, protocol
WITH NO DATA;

-- Create indexes on daily aggregate
CREATE INDEX IF NOT EXISTS idx_anomaly_daily_device_time 
  ON anomaly_scores_daily (device_uuid, device_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_daily_device_name 
  ON anomaly_scores_daily (device_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_anomaly_daily_critical 
  ON anomaly_scores_daily (bucket DESC) 
  WHERE critical_count > 0;

-- Refresh policy: daily, cover last 3 days
SELECT add_continuous_aggregate_policy('anomaly_scores_daily',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- 5. Create real-time device anomaly summary view
-- Provides current anomaly status for each monitored device (deviceName)
CREATE OR REPLACE VIEW device_anomaly_summary AS
SELECT
  r.device_uuid,
  r.extra->>'deviceName' AS device_name,
  -- Overall device anomaly stats (last 24 hours)
  AVG(r.anomaly_score) FILTER (WHERE r.time > NOW() - INTERVAL '24 hours') AS avg_anomaly_24h,
  MAX(r.anomaly_score) FILTER (WHERE r.time > NOW() - INTERVAL '24 hours') AS max_anomaly_24h,
  COUNT(*) FILTER (WHERE r.time > NOW() - INTERVAL '24 hours' AND r.anomaly_score > 0.7) AS high_anomaly_count_24h,
  -- Latest anomaly score
  (SELECT anomaly_score 
   FROM readings 
   WHERE device_uuid = r.device_uuid 
     AND anomaly_score IS NOT NULL 
   ORDER BY time DESC 
   LIMIT 1) AS latest_anomaly_score,
  (SELECT time 
   FROM readings 
   WHERE device_uuid = r.device_uuid 
     AND anomaly_score IS NOT NULL 
   ORDER BY time DESC 
   LIMIT 1) AS latest_scored_time,
  -- Metric with highest average anomaly
  (SELECT metric_name 
   FROM readings 
   WHERE device_uuid = r.device_uuid 
     AND time > NOW() - INTERVAL '24 hours'
     AND anomaly_score IS NOT NULL
   GROUP BY metric_name 
   ORDER BY AVG(anomaly_score) DESC 
   LIMIT 1) AS most_anomalous_metric,
  -- Total metrics being monitored
  COUNT(DISTINCT r.metric_name) FILTER (WHERE r.anomaly_score IS NOT NULL AND r.time > NOW() - INTERVAL '24 hours') AS monitored_metrics_count
FROM readings r
WHERE r.anomaly_score IS NOT NULL
  AND r.time > NOW() - INTERVAL '7 days'
GROUP BY r.device_uuid, r.extra->>'deviceName';

COMMENT ON VIEW device_anomaly_summary IS 'Real-time anomaly summary per device (last 24 hours)';

-- Migration complete
-- Usage examples:
-- 1. Query aggregates by device name:
--    SELECT * FROM anomaly_scores_hourly WHERE device_name = 'COMAP-Main-Controller' ORDER BY bucket DESC LIMIT 24;
--    SELECT * FROM anomaly_scores_daily WHERE device_name = 'ATS-Panel' ORDER BY bucket DESC LIMIT 7;
--    SELECT * FROM device_anomaly_summary WHERE device_name = 'COMAP-Main-Controller';
-- 2. Query aggregates by device UUID:
--    SELECT * FROM anomaly_scores_hourly WHERE device_uuid = '...' ORDER BY bucket DESC LIMIT 24;
--    SELECT * FROM anomaly_scores_daily WHERE device_uuid = '...' ORDER BY bucket DESC LIMIT 7;
--    SELECT * FROM device_anomaly_summary WHERE device_uuid = '...';
-- 3. Query all devices on an edge gateway:
--    SELECT DISTINCT device_name FROM anomaly_scores_hourly WHERE device_uuid = '...' ORDER BY device_name;
