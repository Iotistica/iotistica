-- Migration 130: Create hourly and daily continuous aggregates for Prometheus and long-term analytics
-- Complements migration 129's 1-minute aggregates with coarser-grained views

-- ============================================================================
-- CONTINUOUS AGGREGATE: readings_hourly (1-hour buckets)
-- ============================================================================
-- Purpose: Optimized for Prometheus scraping and medium-term analytics
-- Retention: Auto-refresh with 1-day lag
-- Use case: GET /metrics, 6h-24h dashboard views, alerting

CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  device_uuid,
  extra->>'deviceName' AS device_name,
  metric_name,
  protocol,
  -- Aggregates
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count,
  -- First/last values in bucket
  FIRST(value, time) AS first_value,
  LAST(value, time) AS last_value,
  LAST(time, time) AS last_time,
  -- Quality metrics
  SUM(CASE WHEN quality = 'GOOD' THEN 1 ELSE 0 END)::FLOAT / COUNT(*)::FLOAT AS quality_ratio
FROM readings
GROUP BY bucket, device_uuid, device_name, metric_name, protocol
WITH NO DATA;

-- Auto-refresh policy: refresh every hour, 1-day lag
SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');

-- ============================================================================
-- CONTINUOUS AGGREGATE: readings_daily (1-day buckets)
-- ============================================================================
-- Purpose: Long-term trend analysis and historical reporting
-- Retention: Auto-refresh with 2-day lag
-- Use case: Weekly/monthly reports, capacity planning, trend analysis

CREATE MATERIALIZED VIEW readings_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  device_uuid,
  extra->>'deviceName' AS device_name,
  metric_name,
  protocol,
  -- Aggregates
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count,
  -- First/last values in bucket
  FIRST(value, time) AS first_value,
  LAST(value, time) AS last_value,
  LAST(time, time) AS last_time,
  -- Quality metrics
  SUM(CASE WHEN quality = 'GOOD' THEN 1 ELSE 0 END)::FLOAT / COUNT(*)::FLOAT AS quality_ratio
FROM readings
GROUP BY bucket, device_uuid, device_name, metric_name, protocol
WITH NO DATA;

-- Auto-refresh policy: refresh every day, 2-day lag
SELECT add_continuous_aggregate_policy('readings_daily',
  start_offset => INTERVAL '4 days',
  end_offset => INTERVAL '2 days',
  schedule_interval => INTERVAL '1 day');
