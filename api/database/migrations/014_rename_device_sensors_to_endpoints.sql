-- Migration 014: Rename device_sensors table → endpoints
--
-- Changes:
--   1. Table:   device_sensors          → endpoints
--   2. Column:  endpoints.device_uuid   → endpoints.agent_uuid   (FK to devices.uuid)
--   3. Indexes: idx_device_sensors_*    → idx_endpoints_*
--   4. FK:      device_sensors_device_uuid_fkey → endpoints_agent_uuid_fkey
--   5. PK/UQ:   device_sensors_pkey     → endpoints_pkey
--              device_sensors_uuid_key  → endpoints_uuid_key
--              uq_device_sensor_name    → uq_endpoint_name
--   6. Sequence: device_sensors_id_seq  → endpoints_id_seq
--   7. Triggers: renamed to match new table name
--
-- No data migration required — pure schema rename.

BEGIN;

-- ============================================================================
-- 1. Rename the table
-- ============================================================================

ALTER TABLE public.device_sensors RENAME TO endpoints;

-- ============================================================================
-- 2. Rename the FK column: device_uuid → agent_uuid
--    (this is the FK to devices.uuid — "which agent owns this endpoint")
-- ============================================================================

ALTER TABLE public.endpoints RENAME COLUMN device_uuid TO agent_uuid;

-- ============================================================================
-- 3. Rename indexes (idx_device_sensors_* → idx_endpoints_*)
-- ============================================================================

ALTER INDEX IF EXISTS idx_device_sensors_config_id          RENAME TO idx_endpoints_config_id;
ALTER INDEX IF EXISTS idx_device_sensors_deployment_status  RENAME TO idx_endpoints_deployment_status;
ALTER INDEX IF EXISTS idx_device_sensors_device_protocol    RENAME TO idx_endpoints_agent_protocol;
ALTER INDEX IF EXISTS idx_device_sensors_device_status      RENAME TO idx_endpoints_agent_status;
ALTER INDEX IF EXISTS idx_device_sensors_device_uuid        RENAME TO idx_endpoints_agent_uuid;
ALTER INDEX IF EXISTS idx_device_sensors_enabled            RENAME TO idx_endpoints_enabled;
ALTER INDEX IF EXISTS idx_device_sensors_health_dashboard   RENAME TO idx_endpoints_health_dashboard;
ALTER INDEX IF EXISTS idx_device_sensors_health_status      RENAME TO idx_endpoints_health_status;
ALTER INDEX IF EXISTS idx_device_sensors_health_updated     RENAME TO idx_endpoints_health_updated;
ALTER INDEX IF EXISTS idx_device_sensors_last_telemetry     RENAME TO idx_endpoints_last_telemetry;
ALTER INDEX IF EXISTS idx_device_sensors_location           RENAME TO idx_endpoints_location;
ALTER INDEX IF EXISTS idx_device_sensors_protocol           RENAME TO idx_endpoints_protocol;
ALTER INDEX IF EXISTS idx_device_sensors_sync               RENAME TO idx_endpoints_sync;
ALTER INDEX IF EXISTS idx_device_sensors_uuid               RENAME TO idx_endpoints_uuid;

-- ============================================================================
-- 4. Rename PK / unique constraint indexes
-- ============================================================================

ALTER INDEX IF EXISTS device_sensors_pkey       RENAME TO endpoints_pkey;
ALTER INDEX IF EXISTS device_sensors_uuid_key   RENAME TO endpoints_uuid_key;
ALTER INDEX IF EXISTS uq_device_sensor_name     RENAME TO uq_endpoint_name;

-- ============================================================================
-- 5. Rename FK and other constraints
-- ============================================================================

ALTER TABLE public.endpoints
  RENAME CONSTRAINT device_sensors_device_uuid_fkey TO endpoints_agent_uuid_fkey;

-- ============================================================================
-- 6. Rename sequence
-- ============================================================================

ALTER SEQUENCE IF EXISTS public.device_sensors_id_seq RENAME TO endpoints_id_seq;

-- ============================================================================
-- 7. Rename triggers
-- ============================================================================

ALTER TRIGGER trg_update_device_sensor_timestamp
  ON public.endpoints
  RENAME TO trg_update_endpoint_timestamp;

ALTER TRIGGER trg_update_sensor_deployment_timestamp
  ON public.endpoints
  RENAME TO trg_update_endpoint_deployment_timestamp;

COMMIT;
