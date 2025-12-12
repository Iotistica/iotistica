-- Migration: Create optimized readings table (TimescaleDB hypertable)
-- 
-- Replaces sensor_data table with normalized schema for better performance:
-- - Normalized columns instead of JSONB
-- - Timestamptz for proper timezone handling
-- - Protocol tracking
-- - Optimized for TimescaleDB compression and aggregates

-- 1. Create new readings table
CREATE TABLE IF NOT EXISTS readings (
  time timestamptz NOT NULL,
  device_uuid uuid NOT NULL,
  metric_name text NOT NULL,
  value double precision,
  quality text DEFAULT 'good',
  unit text,
  protocol text NOT NULL,
  extra jsonb DEFAULT '{}'::jsonb,
  
  PRIMARY KEY (device_uuid, metric_name, time)
);

COMMENT ON TABLE readings IS 'Normalized time-series sensor data (TimescaleDB hypertable)';
COMMENT ON COLUMN readings.metric_name IS 'Modbus register, OPC UA NodeId, MQTT topic, or sensor name';
COMMENT ON COLUMN readings.quality IS 'Data quality: good, bad, uncertain';
COMMENT ON COLUMN readings.extra IS 'Protocol-specific metadata (slave_id, register, etc)';

-- 2. Convert to hypertable (1-day chunks)
SELECT create_hypertable(
  'readings', 
  'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- 3. Create optimized indexes
-- Query by device + time range
CREATE INDEX IF NOT EXISTS idx_readings_device_time 
  ON readings (device_uuid, time DESC);

-- Query by metric across devices
CREATE INDEX IF NOT EXISTS idx_readings_metric_time 
  ON readings (metric_name, time DESC);

-- Filter by protocol
CREATE INDEX IF NOT EXISTS idx_readings_protocol 
  ON readings (protocol, time DESC);

-- JSONB queries on extra metadata
CREATE INDEX IF NOT EXISTS idx_readings_extra 
  ON readings USING GIN (extra);

-- 4. Enable compression (compress after 7 days)
ALTER TABLE readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_uuid, metric_name',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('readings', INTERVAL '7 days', if_not_exists => TRUE);

-- 5. Add retention policy (keep 2 years of data)
SELECT add_retention_policy('readings', INTERVAL '730 days', if_not_exists => TRUE);

-- 6. Create hourly continuous aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  device_uuid,
  metric_name,
  protocol,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count,
  LAST(value, time) AS last_value,
  LAST(time, time) AS last_time,
  FIRST(value, time) AS first_value,
  FIRST(time, time) AS first_time
FROM readings
GROUP BY bucket, device_uuid, metric_name, protocol
WITH NO DATA;

-- Refresh policy: every hour, cover last 3 hours (at least 2 buckets required)
SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- 7. Create daily continuous aggregate
CREATE MATERIALIZED VIEW IF NOT EXISTS readings_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  device_uuid,
  metric_name,
  protocol,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  COUNT(*) AS sample_count
FROM readings
GROUP BY bucket, device_uuid, metric_name, protocol
WITH NO DATA;

-- Refresh policy: daily, cover last 3 days
SELECT add_continuous_aggregate_policy('readings_daily',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- Migration complete
-- Next steps:
--   1. Run migration 107 to backfill data from sensor_data
--   2. Update application code to use readings table
--   3. Run dual-write for 7 days
--   4. Verify data accuracy
--   5. Switch reads to readings table
--   6. Drop sensor_data table
