-- Migration: Optimize metrics queries with TimescaleDB continuous aggregates
-- This migration adds indexes to continuous aggregate views from migration 108
-- to improve query performance when selecting historical metrics

DO $$
BEGIN
    -- Only create indexes if the continuous aggregate views exist
    
    -- Add index to 5-minute continuous aggregate for 6-hour queries
    IF EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'device_metrics_5min'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_device_metrics_5min_device_time 
          ON device_metrics_5min (device_uuid, bucket DESC);
        RAISE NOTICE 'Index created on device_metrics_5min';
    ELSE
        RAISE NOTICE 'Skipping device_metrics_5min index - view does not exist';
    END IF;
    
    -- Add index to hourly continuous aggregate for 12h/24h queries
    IF EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'device_metrics_hourly'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_device_metrics_hourly_device_time
          ON device_metrics_hourly (device_uuid, bucket DESC);
        RAISE NOTICE 'Index created on device_metrics_hourly';
    ELSE
        RAISE NOTICE 'Skipping device_metrics_hourly index - view does not exist';
    END IF;
    
    -- Add index to daily continuous aggregate for long-term queries
    IF EXISTS (
        SELECT 1 FROM pg_matviews WHERE matviewname = 'device_metrics_daily'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_device_metrics_daily_device_time
          ON device_metrics_daily (device_uuid, bucket DESC);
        RAISE NOTICE 'Index created on device_metrics_daily';
    ELSE
        RAISE NOTICE 'Skipping device_metrics_daily index - view does not exist';
    END IF;
    
END $$;
