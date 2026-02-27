-- Migration: Add missing message_rate column to mqtt_topic_metrics
-- Created: 2025-10-23
-- Purpose: Fix mqtt_topic_metrics table to include message_rate column expected by MQTT monitor service

-- Add missing message_rate column
ALTER TABLE mqtt_topic_metrics ADD COLUMN IF NOT EXISTS message_rate DECIMAL(10,2) DEFAULT 0;

COMMENT ON COLUMN mqtt_topic_metrics.message_rate IS 'Messages per second for this topic';
