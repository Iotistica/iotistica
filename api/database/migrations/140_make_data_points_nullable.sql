-- Migration: Make data_points nullable for OPC UA auto-discovery
-- Date: 2026-02-13
-- Description: Allow null/empty data_points for OPC UA devices that use auto-discovery

-- Remove NOT NULL constraint and set default to empty array
ALTER TABLE device_sensors 
  ALTER COLUMN data_points DROP NOT NULL;

-- Keep default as empty array for backward compatibility
ALTER TABLE device_sensors 
  ALTER COLUMN data_points SET DEFAULT '[]'::jsonb;

COMMENT ON COLUMN device_sensors.data_points IS 'JSONB array of data point definitions. Can be empty for OPC UA devices using auto-discovery.';
