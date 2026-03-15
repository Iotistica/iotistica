-- Migration: Add last_telemetry_at to device_sensors
-- Purpose: Track when a sensor endpoint last produced actual telemetry data,
--          independent of MQTT connectivity events (last_connectivity_event).
--          This decouples "are readings flowing?" from "is the agent connected?"
--          so degraded MQTT heartbeats don't mask whether data is arriving.

ALTER TABLE public.device_sensors
  ADD COLUMN IF NOT EXISTS last_telemetry_at timestamp with time zone;

COMMENT ON COLUMN public.device_sensors.last_telemetry_at IS
  'When this endpoint last produced a reading that reached the ingestion pipeline. Updated by the readings worker after bulk insert. Independent of MQTT connectivity.';

CREATE INDEX IF NOT EXISTS idx_device_sensors_last_telemetry
  ON public.device_sensors (device_uuid, last_telemetry_at DESC)
  WHERE last_telemetry_at IS NOT NULL;
