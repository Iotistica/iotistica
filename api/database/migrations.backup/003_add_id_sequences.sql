-- Migration: Add ID sequences and registry for app/service management
-- Purpose: Provide centralized ID generation for apps and services defined in device state JSON
-- Created: 2025-10-16

-- Global sequence for app IDs (start at 1000 to distinguish from system IDs)
CREATE SEQUENCE IF NOT EXISTS global_app_id_seq START 1000;

-- Global sequence for service IDs (start at 1)
CREATE SEQUENCE IF NOT EXISTS global_service_id_seq START 1;

-- Registry table to track all app and service IDs
-- This provides auditability and allows querying what apps/services exist
-- without parsing JSONB from device_target_state
CREATE TABLE IF NOT EXISTS app_service_ids (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('app', 'service')),
  entity_id INTEGER NOT NULL,
  entity_name VARCHAR(255) NOT NULL,
  created_by VARCHAR(255), -- User/admin who created it
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB DEFAULT '{}', -- Store additional info (image, default config, etc.)
  UNIQUE(entity_type, entity_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_app_service_ids_type_id ON app_service_ids(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_app_service_ids_name ON app_service_ids(entity_name);
CREATE INDEX IF NOT EXISTS idx_app_service_ids_type ON app_service_ids(entity_type);

-- Comments for documentation
COMMENT ON TABLE app_service_ids IS 'Registry of all app and service IDs used across devices';
COMMENT ON COLUMN app_service_ids.entity_type IS 'Type: app or service';
COMMENT ON COLUMN app_service_ids.entity_id IS 'Unique ID (from sequence)';
COMMENT ON COLUMN app_service_ids.entity_name IS 'Human-readable name';
COMMENT ON COLUMN app_service_ids.metadata IS 'Additional metadata (image name, default config, etc.)';

-- Example usage:
-- Get next app ID: SELECT nextval('global_app_id_seq');
-- Get next service ID: SELECT nextval('global_service_id_seq');
-- Register app: INSERT INTO app_service_ids (entity_type, entity_id, entity_name) VALUES ('app', 1001, 'monitoring');
