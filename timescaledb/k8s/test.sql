CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
        
-- Create sample hypertable for device metrics
CREATE TABLE IF NOT EXISTS device_metrics (
            time TIMESTAMPTZ NOT NULL,
            device_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            value DOUBLE PRECISION,
            tags JSONB
          );

SELECT create_hypertable('device_metrics', 'time', if_not_exists => TRUE);

-- Enable compression for data older than 7 days
ALTER TABLE device_metrics SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'device_id',
            timescaledb.compress_orderby = 'time DESC'
          );

SELECT add_compression_policy('device_metrics', INTERVAL '7 days');

-- Add retention policy to automatically drop data older than 90 days
SELECT add_retention_policy('device_metrics', INTERVAL '90 days');