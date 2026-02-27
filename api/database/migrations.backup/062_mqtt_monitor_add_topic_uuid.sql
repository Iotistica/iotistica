-- Migration: Add UUID-based topic identifiers for mqtt-monitor
-- Created: 2025-11-20
-- Description: Add topic_id UUID column to mqtt_topics and related tables for cleaner API endpoints

-- Add topic_id UUID column to mqtt_topics
ALTER TABLE mqtt_topics 
  ADD COLUMN IF NOT EXISTS topic_id UUID DEFAULT gen_random_uuid() NOT NULL;

-- Create unique index on topic_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_topics_topic_id ON mqtt_topics(topic_id);

-- Update existing rows to have UUIDs (idempotent)
UPDATE mqtt_topics SET topic_id = gen_random_uuid() WHERE topic_id IS NULL;

-- Add topic_id to mqtt_schema_history for easier lookups
ALTER TABLE mqtt_schema_history 
  ADD COLUMN IF NOT EXISTS topic_id UUID;

-- Create index for schema history lookups by topic_id
CREATE INDEX IF NOT EXISTS idx_mqtt_schema_history_topic_id ON mqtt_schema_history(topic_id);

-- Add topic_id to mqtt_topic_metrics for easier joins
ALTER TABLE mqtt_topic_metrics 
  ADD COLUMN IF NOT EXISTS topic_id UUID;

-- Create index for metrics lookups by topic_id
CREATE INDEX IF NOT EXISTS idx_mqtt_topic_metrics_topic_id ON mqtt_topic_metrics(topic_id);

-- Add helpful comment
COMMENT ON COLUMN mqtt_topics.topic_id IS 'Stable UUID identifier for topic, used in API endpoints';
COMMENT ON COLUMN mqtt_schema_history.topic_id IS 'Reference to mqtt_topics.topic_id';
COMMENT ON COLUMN mqtt_topic_metrics.topic_id IS 'Reference to mqtt_topics.topic_id';

-- Function to lookup topic_id by topic name
CREATE OR REPLACE FUNCTION get_topic_id(topic_name VARCHAR)
RETURNS UUID AS $$
DECLARE
  result_id UUID;
BEGIN
  SELECT topic_id INTO result_id FROM mqtt_topics WHERE topic = topic_name;
  RETURN result_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to lookup topic name by topic_id
CREATE OR REPLACE FUNCTION get_topic_name(tid UUID)
RETURNS VARCHAR AS $$
DECLARE
  result_name VARCHAR;
BEGIN
  SELECT topic INTO result_name FROM mqtt_topics WHERE topic_id = tid;
  RETURN result_name;
END;
$$ LANGUAGE plpgsql STABLE;
