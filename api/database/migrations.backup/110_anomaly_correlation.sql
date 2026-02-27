-- Anomaly Correlation Tables
-- Cloud-side incident management and alerting
-- Uses TimescaleDB hypertable for high-volume time-series events

-- ========================================
-- 1. ANOMALY EVENTS (TimescaleDB Hypertable)
-- ========================================
-- Raw anomaly events from edge devices (high-volume time-series)
-- JSONB used for flexible schema evolution
CREATE TABLE IF NOT EXISTS anomaly_events (
    id BIGSERIAL,
    msg_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    timestamp_ms BIGINT NOT NULL,
    window_start_ms BIGINT NOT NULL,      -- Detection window start (for correlation)
    window_end_ms BIGINT NOT NULL,        -- Detection window end (for correlation)
    observed_value DOUBLE PRECISION NOT NULL,
    anomaly_score DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    severity_reason TEXT,                 -- Explainability: why this severity?
    fingerprint TEXT NOT NULL,
    consecutive_count INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    triggered_by JSONB NOT NULL,          -- Array of detection methods
    baseline JSONB,                       -- {median, mean, stdDev, sampleCount, method, source}
    expected_range JSONB,                 -- [min, max]
    deviation DOUBLE PRECISION NOT NULL,
    cooldown_sec INTEGER NOT NULL,
    first_seen BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, timestamp_ms),
    UNIQUE (msg_id, timestamp_ms)
);

-- Convert to TimescaleDB hypertable (requires TimescaleDB extension)
-- Time dimension: timestamp_ms (1-day chunks)
-- Uncomment after installing TimescaleDB: CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT create_hypertable(
    'anomaly_events',
    'timestamp_ms',
    chunk_time_interval => 86400000,     -- 1 day in milliseconds
    if_not_exists => TRUE
);

-- Optional: Add space partitioning for multi-tenant scale (100+ devices)
-- SELECT add_dimension('anomaly_events', 'device_id', number_partitions => 16);

-- Indexes for correlation queries
CREATE INDEX IF NOT EXISTS idx_anomaly_events_device_id ON anomaly_events(device_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_fingerprint ON anomaly_events(fingerprint, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_metric ON anomaly_events(metric, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_severity ON anomaly_events(severity, timestamp_ms DESC);

-- Enable compression for older chunks (storage optimization)
ALTER TABLE anomaly_events SET (
    timescaledb.compress,
    timescaledb.compress_orderby = 'timestamp_ms DESC',
    timescaledb.compress_segmentby = 'device_id, metric'
);

-- Create integer_now function for integer time dimension
CREATE OR REPLACE FUNCTION anomaly_events_integer_now()
RETURNS BIGINT LANGUAGE SQL STABLE AS
$$
  SELECT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000;
$$;

-- Set integer_now function for hypertable (idempotent - ignores if already set)
DO $$
BEGIN
  PERFORM set_integer_now_func('anomaly_events', 'anomaly_events_integer_now');
EXCEPTION
  WHEN SQLSTATE '42710' THEN  -- custom time function already set
    RAISE NOTICE 'integer_now_func already set for anomaly_events, skipping';
END $$;

-- Automatic compression policy: compress chunks older than 14 days
-- Balance: recent data fast, old data compressed
SELECT add_compression_policy('anomaly_events', compress_after => 1209600000, if_not_exists => true);  -- 14 days in ms

-- Retention policy: drop chunks older than 90 days (adjust based on requirements)
SELECT add_retention_policy('anomaly_events', drop_after => 7776000000, if_not_exists => true);  -- 90 days in ms

-- ========================================
-- 2. ANOMALY INCIDENTS (Regular Table)
-- ========================================
-- Low-volume: aggregated correlated events
CREATE TABLE IF NOT EXISTS anomaly_incidents (
    id BIGSERIAL PRIMARY KEY,
    incident_id TEXT UNIQUE NOT NULL,
    fingerprint TEXT NOT NULL,
    metric TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    affected_devices JSONB NOT NULL,
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    max_anomaly_score DOUBLE PRECISION NOT NULL,
    max_confidence DOUBLE PRECISION NOT NULL,
    event_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'active', 'resolved')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for incident queries
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_fingerprint ON anomaly_incidents(fingerprint);
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_status ON anomaly_incidents(status);
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_last_seen ON anomaly_incidents(last_seen);
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_severity ON anomaly_incidents(severity);

-- ========================================
-- 3. ANOMALY ALERTS (Regular Table)
-- ========================================
-- Alerts triggered from incidents (routes to Slack, PagerDuty, etc.)
CREATE TABLE IF NOT EXISTS anomaly_alerts (
    id BIGSERIAL PRIMARY KEY,
    alert_id TEXT UNIQUE NOT NULL,
    incident_id TEXT NOT NULL REFERENCES anomaly_incidents(incident_id),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    metric TEXT NOT NULL,
    affected_devices JSONB NOT NULL,
    max_anomaly_score DOUBLE PRECISION NOT NULL,
    message TEXT NOT NULL,
    channels JSONB,                       -- Alert routing metadata
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for alert queries
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_incident_id ON anomaly_alerts(incident_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_severity ON anomaly_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_created_at ON anomaly_alerts(created_at);

-- ========================================
-- COMMENTS & DOCUMENTATION
-- ========================================

COMMENT ON TABLE anomaly_events IS 'TimescaleDB hypertable: Raw anomaly events from edge devices (high-volume time-series). Partitioned by timestamp_ms with 1-day chunks, compressed after 14 days, retained for 90 days.';
COMMENT ON TABLE anomaly_incidents IS 'Regular table: Correlated incidents aggregating multiple events by fingerprint (low-volume). Optimized for dashboard queries.';
COMMENT ON TABLE anomaly_alerts IS 'Regular table: Alert notifications triggered from incidents. Routes to Slack, PagerDuty, email, etc.';

COMMENT ON COLUMN anomaly_events.fingerprint IS 'Stable identifier for anomaly type (hash of metric+method+severity). Used for correlation.';
COMMENT ON COLUMN anomaly_events.baseline IS 'JSONB: {median, mean, stdDev, sampleCount, method, source}. Flexible schema for baseline statistics.';
COMMENT ON COLUMN anomaly_events.expected_range IS 'JSONB: [min, max]. Expected value range from detector.';
COMMENT ON COLUMN anomaly_events.triggered_by IS 'JSONB array: Detection methods that fired (e.g., ["mad", "zscore"]).';
COMMENT ON COLUMN anomaly_events.severity_reason IS 'Explainability: How severity was determined (e.g., "critical: score>=0.85 || deviation>=5.0").';
COMMENT ON COLUMN anomaly_events.window_start_ms IS 'Start of statistical window used for detection. Enables correlation analysis.';
COMMENT ON COLUMN anomaly_events.window_end_ms IS 'End of statistical window used for detection. Enables timeline reconstruction.';

COMMENT ON COLUMN anomaly_incidents.affected_devices IS 'JSONB array: Device IDs experiencing this anomaly (e.g., ["device-abc", "device-xyz"]).';
COMMENT ON COLUMN anomaly_incidents.status IS 'Incident lifecycle: open=new, active=ongoing, resolved=cleared.';

COMMENT ON COLUMN anomaly_alerts.channels IS 'JSONB: Alert routing metadata (e.g., {"slack": true, "pagerduty": false}).';

-- ========================================
-- QUERY OPTIMIZATION NOTES
-- ========================================
-- 
-- High-Performance Correlation Queries:
-- 
-- 1. Group by fingerprint (incident detection):
--    SELECT fingerprint, count(*), max(anomaly_score)
--    FROM anomaly_events
--    WHERE timestamp_ms > NOW() - INTERVAL '5 minutes'
--    GROUP BY fingerprint;
--    → Fast: Uses idx_anomaly_events_fingerprint + chunk exclusion
-- 
-- 2. Device-specific events (device dashboard):
--    SELECT * FROM anomaly_events
--    WHERE device_id = 'abc123'
--      AND timestamp_ms > NOW() - INTERVAL '24 hours'
--    ORDER BY timestamp_ms DESC;
--    → Fast: Uses idx_anomaly_events_device_id + chunk exclusion
-- 
-- 3. Cross-device correlation (multi-device incidents):
--    SELECT device_id, metric, count(*)
--    FROM anomaly_events
--    WHERE fingerprint = 'abc123def456'
--      AND timestamp_ms > NOW() - INTERVAL '1 hour'
--    GROUP BY device_id, metric;
--    → Fast: Uses idx_anomaly_events_fingerprint + segmentby compression
-- 
-- 4. Severity-based filtering (alert dashboard):
--    SELECT * FROM anomaly_events
--    WHERE severity = 'critical'
--      AND timestamp_ms > NOW() - INTERVAL '7 days'
--    ORDER BY timestamp_ms DESC
--    LIMIT 100;
--    → Fast: Uses idx_anomaly_events_severity + chunk exclusion
-- 
-- ========================================
-- MAINTENANCE TASKS
-- ========================================
-- 
-- Monitor chunk compression:
--   SELECT chunk_name, compression_status
--   FROM timescaledb_information.chunks
--   WHERE hypertable_name = 'anomaly_events'
--   ORDER BY range_start DESC;
-- 
-- Check storage usage:
--   SELECT pg_size_pretty(pg_total_relation_size('anomaly_events'));
-- 
-- Manual compression (if needed):
--   SELECT compress_chunk(i)
--   FROM show_chunks('anomaly_events', older_than => INTERVAL '14 days') i;
-- 
-- Adjust retention policy:
--   SELECT remove_retention_policy('anomaly_events');
--   SELECT add_retention_policy('anomaly_events', INTERVAL '180 days');
-- 
-- ========================================
