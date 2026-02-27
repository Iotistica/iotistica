-- Migration: Add device dictionary tables for key compaction persistence
-- Purpose: Store MQTT message dictionaries in PostgreSQL for durability and multi-API support

-- Device dictionary entries (field name → index mapping)
CREATE TABLE IF NOT EXISTS device_dictionary_entries (
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  field_index INTEGER NOT NULL,
  version_added INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  PRIMARY KEY (device_uuid, field_name),
  UNIQUE (device_uuid, field_index)
);

CREATE INDEX idx_device_dictionary_device ON device_dictionary_entries(device_uuid);
CREATE INDEX idx_device_dictionary_version ON device_dictionary_entries(device_uuid, version_added);

COMMENT ON TABLE device_dictionary_entries IS 'Device-specific field dictionaries for MQTT key compaction';
COMMENT ON COLUMN device_dictionary_entries.field_name IS 'Full field path (e.g., messages[].readings[].value)';
COMMENT ON COLUMN device_dictionary_entries.field_index IS 'Numeric index assigned by device (0-based)';
COMMENT ON COLUMN device_dictionary_entries.version_added IS 'Dictionary version when field was added';

-- Device dictionary metadata (version tracking, sync status)
CREATE TABLE IF NOT EXISTS device_dictionary_metadata (
  device_uuid UUID NOT NULL PRIMARY KEY REFERENCES devices(uuid) ON DELETE CASCADE,
  current_version INTEGER NOT NULL DEFAULT 1,
  last_full_sync TIMESTAMPTZ,
  last_delta_sync TIMESTAMPTZ,
  dictionary_hash TEXT,  -- SHA-256 hash for integrity verification
  total_fields INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_dictionary_meta_version ON device_dictionary_metadata(device_uuid, current_version);

COMMENT ON TABLE device_dictionary_metadata IS 'Device dictionary version and sync tracking';
COMMENT ON COLUMN device_dictionary_metadata.current_version IS 'Latest dictionary version from device';
COMMENT ON COLUMN device_dictionary_metadata.dictionary_hash IS 'SHA-256 hash of sorted field names for integrity';
