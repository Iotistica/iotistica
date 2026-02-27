-- Migration: Add MQTT monitoring tables for mqtt-monitor service
-- Created: 2025-10-23
-- Description: Tables required by MQTTDatabaseService for topic tracking, schema history, broker stats, and metrics

-- MQTT Topics table - tracks all MQTT topics discovered by the monitor
CREATE TABLE IF NOT EXISTS mqtt_topics (
    id SERIAL PRIMARY KEY,
    topic VARCHAR(512) NOT NULL UNIQUE,
    message_type VARCHAR(100),  -- e.g., 'json', 'xml', 'string', 'binary'
    schema JSONB,  -- JSON schema of the message structure
    last_message TEXT,  -- Last message payload sample
    message_count BIGINT DEFAULT 0,
    qos INTEGER,  -- Quality of Service level
    retain BOOLEAN,  -- Whether messages are retained
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mqtt_topics_topic ON mqtt_topics(topic);
CREATE INDEX IF NOT EXISTS idx_mqtt_topics_last_seen ON mqtt_topics(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_topics_message_type ON mqtt_topics(message_type);

COMMENT ON TABLE mqtt_topics IS 'Discovered MQTT topics and their metadata';
COMMENT ON COLUMN mqtt_topics.schema IS 'Inferred JSON schema from message samples';

-- MQTT Schema History - tracks schema changes over time
CREATE TABLE IF NOT EXISTS mqtt_schema_history (
    id SERIAL PRIMARY KEY,
    topic VARCHAR(512) NOT NULL,
    schema JSONB NOT NULL,
    schema_hash VARCHAR(64) NOT NULL,  -- Hash of schema for quick comparison
    sample_message JSONB,  -- Sample message that generated this schema
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_topic_schema UNIQUE (topic, schema_hash)
);

CREATE INDEX IF NOT EXISTS idx_mqtt_schema_history_topic ON mqtt_schema_history(topic);
CREATE INDEX IF NOT EXISTS idx_mqtt_schema_history_detected ON mqtt_schema_history(detected_at DESC);

COMMENT ON TABLE mqtt_schema_history IS 'History of schema changes for MQTT topics';
COMMENT ON COLUMN mqtt_schema_history.schema_hash IS 'MD5 hash of schema for deduplication';

-- MQTT Broker Stats - overall broker statistics
CREATE TABLE IF NOT EXISTS mqtt_broker_stats (
    id SERIAL PRIMARY KEY,
    clients_connected INTEGER DEFAULT 0,
    clients_total INTEGER DEFAULT 0,
    messages_received BIGINT DEFAULT 0,
    messages_sent BIGINT DEFAULT 0,
    messages_publish BIGINT DEFAULT 0,
    messages_retained BIGINT DEFAULT 0,
    bytes_received BIGINT DEFAULT 0,
    bytes_sent BIGINT DEFAULT 0,
    subscriptions_count INTEGER DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mqtt_broker_stats_timestamp ON mqtt_broker_stats(timestamp DESC);

COMMENT ON TABLE mqtt_broker_stats IS 'Time-series statistics for MQTT broker';

-- MQTT Topic Metrics - per-topic metrics over time
CREATE TABLE IF NOT EXISTS mqtt_topic_metrics (
    id BIGSERIAL PRIMARY KEY,
    topic VARCHAR(512) NOT NULL,
    message_count BIGINT DEFAULT 0,
    bytes_received BIGINT DEFAULT 0,
    avg_message_size INTEGER,
    qos_0_count BIGINT DEFAULT 0,
    qos_1_count BIGINT DEFAULT 0,
    qos_2_count BIGINT DEFAULT 0,
    retained_count BIGINT DEFAULT 0,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_topic ON mqtt_topic_metrics(topic);
CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_timestamp ON mqtt_topic_metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_topic_timestamp ON mqtt_topic_metrics(topic, timestamp DESC);

COMMENT ON TABLE mqtt_topic_metrics IS 'Time-series metrics per MQTT topic';
COMMENT ON COLUMN mqtt_topic_metrics.avg_message_size IS 'Average message size in bytes';

-- Trigger to update updated_at on mqtt_topics
CREATE OR REPLACE FUNCTION update_mqtt_topics_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mqtt_topics_updated_at ON mqtt_topics;
CREATE TRIGGER mqtt_topics_updated_at
    BEFORE UPDATE ON mqtt_topics
    FOR EACH ROW
    EXECUTE FUNCTION update_mqtt_topics_updated_at();
