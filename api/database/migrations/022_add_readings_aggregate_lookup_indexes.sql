-- Migration: Add lookup indexes for readings continuous aggregates used by getTimeseries
--
-- Purpose:
--   Avoid broad scans on continuous aggregate materializations when queries filter by
--   device_uuid + metric_name and order by bucket DESC.
--
-- Notes:
--   - Idempotent via IF NOT EXISTS
--   - Includes readings_hourly because getTimeseries uses it for 7d queries

CREATE INDEX IF NOT EXISTS idx_readings_1m_device_metric_bucket_desc
ON readings_1m (device_uuid, metric_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_readings_1h_device_metric_bucket_desc
ON readings_1h (device_uuid, metric_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_readings_hourly_device_metric_bucket_desc
ON readings_hourly (device_uuid, metric_name, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_readings_daily_device_metric_bucket_desc
ON readings_daily (device_uuid, metric_name, bucket DESC);