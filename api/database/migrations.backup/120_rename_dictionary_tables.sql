-- Migration: Rename device_dictionary_* tables to dictionary_* for naming consistency
-- Purpose: Align with dictionary_enum_* naming convention from migration 118

-- Rename tables
ALTER TABLE IF EXISTS device_dictionary_entries RENAME TO dictionary_entries;
ALTER TABLE IF EXISTS device_dictionary_metadata RENAME TO dictionary_metadata;

-- Rename indexes for dictionary_entries
ALTER INDEX IF EXISTS idx_device_dictionary_device RENAME TO idx_dictionary_device;
ALTER INDEX IF EXISTS idx_device_dictionary_version RENAME TO idx_dictionary_version;

-- Rename indexes for dictionary_metadata
ALTER INDEX IF EXISTS idx_device_dictionary_meta_version RENAME TO idx_dictionary_meta_version;

-- Update table comments
COMMENT ON TABLE dictionary_entries IS 'Device-specific field dictionaries for MQTT key compaction';
COMMENT ON TABLE dictionary_metadata IS 'Device dictionary version and sync tracking';
