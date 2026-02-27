-- Migration: Add protocol-aware enum tables for Phase 7 extended compression
-- Purpose: Support protocol-namespaced metrics and devices enums for 47%+ compression gains
-- Relates to: agent/src/db/migrations/20260104000004_add_protocol_aware_enums.js

-- ============================================================================
-- ENUM OBSERVATIONS: Track value frequency for promotion threshold detection
-- ============================================================================
CREATE TABLE IF NOT EXISTS dictionary_enum_observations (
  id BIGSERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  category VARCHAR(32) NOT NULL,  -- 'qualityCode', 'metric', 'device', 'unit'
  namespace VARCHAR(32),           -- Protocol name for metrics/devices (null for qualityCode/unit)
  value VARCHAR(255) NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  unique_value_count INTEGER,      -- Track cardinality
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ,         -- When promoted to enum
  is_promoted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE (device_uuid, category, namespace, value)
);

CREATE INDEX idx_enum_observations_device ON dictionary_enum_observations(device_uuid);
CREATE INDEX idx_enum_observations_promoted ON dictionary_enum_observations(device_uuid, category, is_promoted);
CREATE INDEX idx_enum_observations_namespace ON dictionary_enum_observations(device_uuid, namespace);
CREATE INDEX idx_enum_observations_category ON dictionary_enum_observations(device_uuid, category);

COMMENT ON TABLE dictionary_enum_observations IS 'Track observation frequency for enum promotion threshold detection';
COMMENT ON COLUMN dictionary_enum_observations.category IS 'Type of enum: qualityCode (global), metric/device (protocol-namespaced), unit (global)';
COMMENT ON COLUMN dictionary_enum_observations.namespace IS 'Protocol (modbus, snmp, opcua, mqtt, bacnet) - null for global enums';
COMMENT ON COLUMN dictionary_enum_observations.observation_count IS 'Times this value appeared';
COMMENT ON COLUMN dictionary_enum_observations.unique_value_count IS 'Cardinality check (promote only if ≤ max unique values)';
COMMENT ON COLUMN dictionary_enum_observations.is_promoted IS 'True when threshold reached and enum index assigned';

-- ============================================================================
-- ENUM METRICS: Protocol-namespaced metric name enums (engine_rpm, sysUpTime, etc)
-- ============================================================================
CREATE TABLE IF NOT EXISTS dictionary_enum_metrics (
  id BIGSERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  protocol VARCHAR(32) NOT NULL,   -- modbus, snmp, opcua, mqtt, bacnet
  metric_name VARCHAR(255) NOT NULL,
  enum_index INTEGER NOT NULL,     -- Immutable index (never reused for this device)
  observation_count INTEGER NOT NULL DEFAULT 0,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inactive BOOLEAN NOT NULL DEFAULT FALSE,  -- Soft delete (preserve for historical decoding)
  
  UNIQUE (device_uuid, protocol, metric_name),
  UNIQUE (device_uuid, protocol, enum_index)
);

CREATE INDEX idx_enum_metrics_device ON dictionary_enum_metrics(device_uuid);
CREATE INDEX idx_enum_metrics_protocol ON dictionary_enum_metrics(device_uuid, protocol);
CREATE INDEX idx_enum_metrics_active ON dictionary_enum_metrics(device_uuid, protocol, inactive);
CREATE INDEX idx_enum_metrics_index ON dictionary_enum_metrics(device_uuid, protocol, enum_index);

COMMENT ON TABLE dictionary_enum_metrics IS 'Protocol-namespaced metric name enums for compression (separates modbus.engine_rpm from snmp.sysUpTime)';
COMMENT ON COLUMN dictionary_enum_metrics.enum_index IS 'Immutable numeric index for this metric in this protocol (never recycled)';
COMMENT ON COLUMN dictionary_enum_metrics.observation_count IS 'Times this metric appeared (used for promotion threshold of 100)';
COMMENT ON COLUMN dictionary_enum_metrics.inactive IS 'Soft delete - keep for historical payload decoding';

-- ============================================================================
-- ENUM DEVICES: Protocol-namespaced device name enums
-- ============================================================================
CREATE TABLE IF NOT EXISTS dictionary_enum_devices (
  id BIGSERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  protocol VARCHAR(32) NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  enum_index INTEGER NOT NULL,     -- Immutable index
  observation_count INTEGER NOT NULL DEFAULT 0,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inactive BOOLEAN NOT NULL DEFAULT FALSE,
  
  UNIQUE (device_uuid, protocol, device_name),
  UNIQUE (device_uuid, protocol, enum_index)
);

CREATE INDEX idx_enum_devices_device ON dictionary_enum_devices(device_uuid);
CREATE INDEX idx_enum_devices_protocol ON dictionary_enum_devices(device_uuid, protocol);
CREATE INDEX idx_enum_devices_active ON dictionary_enum_devices(device_uuid, protocol, inactive);
CREATE INDEX idx_enum_devices_index ON dictionary_enum_devices(device_uuid, protocol, enum_index);

COMMENT ON TABLE dictionary_enum_devices IS 'Protocol-namespaced device name enums (separates modbus_slave_3 from snmp_device_60)';
COMMENT ON COLUMN dictionary_enum_devices.enum_index IS 'Immutable numeric index (promotion threshold: 10 observations per protocol)';
COMMENT ON COLUMN dictionary_enum_devices.observation_count IS 'Times this device appeared';
COMMENT ON COLUMN dictionary_enum_devices.inactive IS 'Soft delete - preserve for historical decoding';

-- ============================================================================
-- ENUM QUALITY CODES: Global (non-namespaced) quality code enum
-- ============================================================================
CREATE TABLE IF NOT EXISTS dictionary_enum_quality_codes (
  id BIGSERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  code_value VARCHAR(64) NOT NULL,  -- 'OK', 'TIMEOUT', 'DEVICE_OFFLINE', 'READ_ERROR'
  enum_index INTEGER NOT NULL,      -- Immutable index
  observation_count INTEGER NOT NULL DEFAULT 0,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inactive BOOLEAN NOT NULL DEFAULT FALSE,
  
  UNIQUE (device_uuid, code_value),
  UNIQUE (device_uuid, enum_index)
);

CREATE INDEX idx_enum_quality_codes_device ON dictionary_enum_quality_codes(device_uuid);
CREATE INDEX idx_enum_quality_codes_active ON dictionary_enum_quality_codes(device_uuid, inactive);
CREATE INDEX idx_enum_quality_codes_index ON dictionary_enum_quality_codes(device_uuid, enum_index);

COMMENT ON TABLE dictionary_enum_quality_codes IS 'Global quality code enum (promotion threshold: 20 observations)';
COMMENT ON COLUMN dictionary_enum_quality_codes.enum_index IS 'Immutable numeric index for this device';
COMMENT ON COLUMN dictionary_enum_quality_codes.inactive IS 'Soft delete - preserve for historical decoding';

-- ============================================================================
-- ENUM UNITS: Global (non-namespaced) unit value enum
-- ============================================================================
CREATE TABLE IF NOT EXISTS dictionary_enum_units (
  id BIGSERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  unit_value VARCHAR(64) NOT NULL,  -- 'RPM', 'V', '°C', 'timeticks'
  enum_index INTEGER NOT NULL,      -- Immutable index
  observation_count INTEGER NOT NULL DEFAULT 0,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inactive BOOLEAN NOT NULL DEFAULT FALSE,
  
  UNIQUE (device_uuid, unit_value),
  UNIQUE (device_uuid, enum_index)
);

CREATE INDEX idx_enum_units_device ON dictionary_enum_units(device_uuid);
CREATE INDEX idx_enum_units_active ON dictionary_enum_units(device_uuid, inactive);
CREATE INDEX idx_enum_units_index ON dictionary_enum_units(device_uuid, enum_index);

COMMENT ON TABLE dictionary_enum_units IS 'Global unit value enum (promotion threshold: 50 observations)';
COMMENT ON COLUMN dictionary_enum_units.enum_index IS 'Immutable numeric index';
COMMENT ON COLUMN dictionary_enum_units.inactive IS 'Soft delete - preserve for historical decoding';

-- ============================================================================
-- EXTENDED DICTIONARY METADATA
-- ============================================================================
-- Add columns to device_dictionary_metadata for Phase 7 tracking
ALTER TABLE IF EXISTS device_dictionary_metadata
  ADD COLUMN IF NOT EXISTS format_version INTEGER DEFAULT 1,  -- 1=old (fieldsByDomain), 2=new (keys+enums+metrics+devices)
  ADD COLUMN IF NOT EXISTS quality_code_enum_frozen BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS unit_enum_frozen BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_enum_promotion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_metrics_promoted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_devices_promoted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_quality_codes_promoted INTEGER DEFAULT 0;

COMMENT ON COLUMN device_dictionary_metadata.format_version IS '1=legacy fieldsByDomain, 2=new protocol-aware format (Phase 7)';
COMMENT ON COLUMN device_dictionary_metadata.quality_code_enum_frozen IS 'True after first promotion (enum is stable)';
COMMENT ON COLUMN device_dictionary_metadata.unit_enum_frozen IS 'True after threshold met (no new units)';
COMMENT ON COLUMN device_dictionary_metadata.last_enum_promotion IS 'Timestamp of most recent enum promotion';
COMMENT ON COLUMN device_dictionary_metadata.total_metrics_promoted IS 'Count of metrics promoted to enums across all protocols';
COMMENT ON COLUMN device_dictionary_metadata.total_devices_promoted IS 'Count of devices promoted to enums across all protocols';
COMMENT ON COLUMN device_dictionary_metadata.total_quality_codes_promoted IS 'Count of quality codes promoted to enums';

-- ============================================================================
-- MATERIALIZED VIEW: Enum Promotion Summary (for analytics)
-- ============================================================================
CREATE OR REPLACE VIEW dictionary_enum_summary AS
SELECT
  device_uuid,
  'metric' AS enum_type,
  protocol,
  COUNT(*) AS total_promoted,
  SUM(observation_count) AS total_observations,
  AVG(observation_count) AS avg_observations,
  MAX(promoted_at) AS last_promoted
FROM dictionary_enum_metrics
WHERE NOT inactive
GROUP BY device_uuid, protocol
UNION ALL
SELECT
  device_uuid,
  'device' AS enum_type,
  protocol,
  COUNT(*) AS total_promoted,
  SUM(observation_count) AS total_observations,
  AVG(observation_count) AS avg_observations,
  MAX(promoted_at) AS last_promoted
FROM dictionary_enum_devices
WHERE NOT inactive
GROUP BY device_uuid, protocol
UNION ALL
SELECT
  device_uuid,
  'qualityCode' AS enum_type,
  NULL AS protocol,
  COUNT(*) AS total_promoted,
  SUM(observation_count) AS total_observations,
  AVG(observation_count) AS avg_observations,
  MAX(promoted_at) AS last_promoted
FROM dictionary_enum_quality_codes
WHERE NOT inactive
GROUP BY device_uuid
UNION ALL
SELECT
  device_uuid,
  'unit' AS enum_type,
  NULL AS protocol,
  COUNT(*) AS total_promoted,
  SUM(observation_count) AS total_observations,
  AVG(observation_count) AS avg_observations,
  MAX(promoted_at) AS last_promoted
FROM dictionary_enum_units
WHERE NOT inactive
GROUP BY device_uuid;

COMMENT ON VIEW dictionary_enum_summary IS 'Analytics view: Enum promotion summary by device, type, and protocol';

-- ============================================================================
-- Rollback instructions (if needed)
-- ============================================================================
-- DROP VIEW IF EXISTS dictionary_enum_summary;
-- DROP TABLE IF EXISTS dictionary_enum_quality_codes;
-- DROP TABLE IF EXISTS dictionary_enum_units;
-- DROP TABLE IF EXISTS dictionary_enum_devices;
-- DROP TABLE IF EXISTS dictionary_enum_metrics;
-- DROP TABLE IF EXISTS dictionary_enum_observations;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS format_version;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS quality_code_enum_frozen;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS unit_enum_frozen;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS last_enum_promotion;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS total_metrics_promoted;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS total_devices_promoted;
-- ALTER TABLE device_dictionary_metadata DROP COLUMN IF EXISTS total_quality_codes_promoted;
