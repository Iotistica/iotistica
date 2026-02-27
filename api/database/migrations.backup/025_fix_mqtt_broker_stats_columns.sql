-- Migration: Fix MQTT broker stats table columns
-- Created: 2025-10-23
-- Purpose: Add missing columns that the MQTT monitor service expects

-- Drop the old table structure and recreate with correct columns
DROP TABLE IF EXISTS mqtt_broker_stats CASCADE;

CREATE TABLE mqtt_broker_stats (
    id SERIAL PRIMARY KEY,
    connected_clients INTEGER DEFAULT 0,
    disconnected_clients INTEGER DEFAULT 0,
    total_clients INTEGER DEFAULT 0,
    subscriptions INTEGER DEFAULT 0,
    retained_messages BIGINT DEFAULT 0,
    messages_sent BIGINT DEFAULT 0,
    messages_received BIGINT DEFAULT 0,
    messages_published BIGINT DEFAULT 0,
    messages_dropped BIGINT DEFAULT 0,
    bytes_sent BIGINT DEFAULT 0,
    bytes_received BIGINT DEFAULT 0,
    message_rate_published DECIMAL(10,2) DEFAULT 0,
    message_rate_received DECIMAL(10,2) DEFAULT 0,
    throughput_inbound BIGINT DEFAULT 0,
    throughput_outbound BIGINT DEFAULT 0,
    sys_data JSONB,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mqtt_broker_stats_timestamp ON mqtt_broker_stats(timestamp DESC);

COMMENT ON TABLE mqtt_broker_stats IS 'Time-series statistics for MQTT broker';
COMMENT ON COLUMN mqtt_broker_stats.connected_clients IS 'Number of currently connected clients';
COMMENT ON COLUMN mqtt_broker_stats.disconnected_clients IS 'Number of disconnected clients';
COMMENT ON COLUMN mqtt_broker_stats.total_clients IS 'Total number of clients (connected + disconnected)';
COMMENT ON COLUMN mqtt_broker_stats.message_rate_published IS 'Messages published per second';
COMMENT ON COLUMN mqtt_broker_stats.message_rate_received IS 'Messages received per second';
COMMENT ON COLUMN mqtt_broker_stats.throughput_inbound IS 'Inbound throughput in bytes per second';
COMMENT ON COLUMN mqtt_broker_stats.throughput_outbound IS 'Outbound throughput in bytes per second';
COMMENT ON COLUMN mqtt_broker_stats.sys_data IS 'Raw $SYS topic data from broker';

-- Fix mqtt_topic_metrics table to add missing message_rate column
ALTER TABLE mqtt_topic_metrics ADD COLUMN IF NOT EXISTS message_rate DECIMAL(10,2) DEFAULT 0;

COMMENT ON COLUMN mqtt_topic_metrics.message_rate IS 'Messages per second for this topic';
