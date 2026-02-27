-- Migration: Add device shadow history tracking
-- Created: 2025-10-18
-- Purpose: Store historical snapshots of device shadows for time-series analysis and anomaly detection

-- Device shadow history table
CREATE TABLE IF NOT EXISTS device_shadow_history (
    id BIGSERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    shadow_name VARCHAR(255) NOT NULL DEFAULT 'device-state',
    reported_state JSONB NOT NULL,  -- Complete shadow state snapshot
    version INTEGER DEFAULT 0,       -- Shadow version at time of snapshot
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient time-series queries
CREATE INDEX IF NOT EXISTS idx_shadow_history_device_uuid ON device_shadow_history(device_uuid);
CREATE INDEX IF NOT EXISTS idx_shadow_history_timestamp ON device_shadow_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_history_device_time ON device_shadow_history(device_uuid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_history_shadow_name ON device_shadow_history(shadow_name);

-- Composite index for common queries (device + shadow + time range)
CREATE INDEX IF NOT EXISTS idx_shadow_history_query ON device_shadow_history(device_uuid, shadow_name, timestamp DESC);

-- GIN index for JSONB queries (e.g., filtering by health status in history)
CREATE INDEX IF NOT EXISTS idx_shadow_history_state ON device_shadow_history USING GIN (reported_state);

COMMENT ON TABLE device_shadow_history IS 'Historical snapshots of device shadow state for time-series analysis';
COMMENT ON COLUMN device_shadow_history.reported_state IS 'Complete shadow state at this point in time';
COMMENT ON COLUMN device_shadow_history.shadow_name IS 'Shadow identifier (default: device-state)';
COMMENT ON COLUMN device_shadow_history.timestamp IS 'When this shadow state was recorded';

-- Optional: Partitioning for large-scale deployments
-- Partition by month for better query performance and easier archival
-- Uncomment and adjust if you expect high volume:
/*
-- Convert to partitioned table
ALTER TABLE device_shadow_history RENAME TO device_shadow_history_old;

CREATE TABLE device_shadow_history (
    id BIGSERIAL,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    shadow_name VARCHAR(255) NOT NULL DEFAULT 'device-state',
    reported_state JSONB NOT NULL,
    version INTEGER DEFAULT 0,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create partitions for current and next 3 months
CREATE TABLE device_shadow_history_2025_10 PARTITION OF device_shadow_history
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

CREATE TABLE device_shadow_history_2025_11 PARTITION OF device_shadow_history
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');

CREATE TABLE device_shadow_history_2025_12 PARTITION OF device_shadow_history
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE device_shadow_history_2026_01 PARTITION OF device_shadow_history
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- Migrate old data
INSERT INTO device_shadow_history SELECT * FROM device_shadow_history_old;
DROP TABLE device_shadow_history_old;
*/

-- Data retention policy
-- This should be run by a scheduled job (see Phase 4 retention job implementation)
-- Default retention: 90 days
COMMENT ON TABLE device_shadow_history IS 'Retention policy: Delete records older than 90 days via scheduled job';

-- Example retention query (will be implemented as scheduled job):
/*
DELETE FROM device_shadow_history 
WHERE timestamp < NOW() - INTERVAL '90 days';
*/

-- Trigger to automatically capture shadow changes (optional alternative to application-level insert)
-- Uncomment if you want automatic history capture via database trigger instead of application code:
/*
CREATE OR REPLACE FUNCTION capture_shadow_history()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO device_shadow_history (device_uuid, shadow_name, reported_state, version, timestamp)
    VALUES (NEW.device_uuid, 'device-state', NEW.reported, NEW.version, NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shadow_change_history
AFTER INSERT OR UPDATE ON device_shadows
FOR EACH ROW
EXECUTE FUNCTION capture_shadow_history();
*/
