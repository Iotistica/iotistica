-- Migration: Add MQTT message storage tables
-- Created: 2025-10-18
-- Purpose: Store sensor data, device shadows, and logs from MQTT messages

-- Sensor data table (time-series data from sensor-publish feature)
CREATE TABLE IF NOT EXISTS sensor_data (
    id BIGSERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    sensor_name VARCHAR(255) NOT NULL,
    data JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sensor_data_device_uuid ON sensor_data(device_uuid);
CREATE INDEX IF NOT EXISTS idx_sensor_data_sensor_name ON sensor_data(sensor_name);
CREATE INDEX IF NOT EXISTS idx_sensor_data_timestamp ON sensor_data(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_data_device_sensor ON sensor_data(device_uuid, sensor_name, timestamp DESC);

-- Unique constraint to prevent duplicate sensor readings (optional)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_data_unique ON sensor_data(device_uuid, sensor_name, timestamp);

COMMENT ON TABLE sensor_data IS 'Time-series sensor data from devices';
COMMENT ON COLUMN sensor_data.data IS 'Sensor reading data (flexible JSONB format)';
COMMENT ON COLUMN sensor_data.metadata IS 'Additional metadata about the sensor reading';

-- Device shadows table (AWS IoT-style shadow pattern)
CREATE TABLE IF NOT EXISTS device_shadows (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL UNIQUE REFERENCES devices(uuid) ON DELETE CASCADE,
    reported JSONB DEFAULT '{}',  -- State reported by device
    desired JSONB DEFAULT '{}',   -- Desired state from cloud
    version INTEGER DEFAULT 0,    -- Version number for conflict resolution
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_shadows_device_uuid ON device_shadows(device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_shadows_updated_at ON device_shadows(updated_at DESC);

COMMENT ON TABLE device_shadows IS 'Device shadow state (AWS IoT pattern)';
COMMENT ON COLUMN device_shadows.reported IS 'State reported by the device';
COMMENT ON COLUMN device_shadows.desired IS 'Desired state from cloud/admin';
COMMENT ON COLUMN device_shadows.version IS 'Version number for optimistic locking';

-- Device logs table (from MQTT log streaming)
-- Note: Table might already exist with different structure, so we handle both cases
DO $$
BEGIN
    -- Create table if it doesn't exist
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'device_logs') THEN
        CREATE TABLE device_logs (
            id BIGSERIAL PRIMARY KEY,
            device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
            container_id VARCHAR(255),
            container_name VARCHAR(255),
            message TEXT NOT NULL,
            level VARCHAR(50) DEFAULT 'info',
            stream VARCHAR(10) DEFAULT 'stdout',
            timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    ELSE
        -- Table exists, add missing columns if needed
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'device_logs' AND column_name = 'container_id') THEN
            ALTER TABLE device_logs ADD COLUMN container_id VARCHAR(255);
        END IF;
        
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'device_logs' AND column_name = 'container_name') THEN
            ALTER TABLE device_logs ADD COLUMN container_name VARCHAR(255);
        END IF;
        
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'device_logs' AND column_name = 'level') THEN
            ALTER TABLE device_logs ADD COLUMN level VARCHAR(50) DEFAULT 'info';
        END IF;
        
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'device_logs' AND column_name = 'stream') THEN
            ALTER TABLE device_logs ADD COLUMN stream VARCHAR(10) DEFAULT 'stdout';
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_logs_device_uuid ON device_logs(device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_logs_timestamp ON device_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_level ON device_logs(level);
CREATE INDEX IF NOT EXISTS idx_device_logs_container ON device_logs(device_uuid, container_id, timestamp DESC);

COMMENT ON TABLE device_logs IS 'Container logs streamed from devices via MQTT';
COMMENT ON COLUMN device_logs.stream IS 'Output stream: stdout or stderr';

-- Partitioning for device_logs (optional, for large deployments)
-- Partition by month for better query performance and easier archival
-- Uncomment if you expect high log volume:
/*
CREATE TABLE device_logs_2025_01 PARTITION OF device_logs
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE device_logs_2025_02 PARTITION OF device_logs
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
*/

-- Log retention policy (delete logs older than 30 days)
-- Run this as a cron job or scheduled task:
/*
DELETE FROM device_logs 
WHERE timestamp < NOW() - INTERVAL '30 days';
*/

-- Sensor data retention policy (optional)
/*
DELETE FROM sensor_data 
WHERE timestamp < NOW() - INTERVAL '90 days';
*/
