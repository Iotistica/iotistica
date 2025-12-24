-- Migration: Add Device Tags System
-- Description: Implement tag-based device grouping for bulk operations
-- Author: System
-- Date: 2025-11-05
-- Feature: Device Tags for flexible grouping and querying

-- ============================================================================
-- STEP 0: Enable required extensions
-- ============================================================================

-- Note: pg_trgm extension blocked by Azure PostgreSQL
-- Trigram indexes are optional - migration creates conditional index below

-- ============================================================================
-- OVERVIEW
-- ============================================================================
-- This migration introduces a tag-based device organization system inspired by
-- Azure IoT Hub Device Twins and Kubernetes labels. Tags enable:
-- - Flexible device grouping without explicit group management
-- - Multi-dimensional categorization (environment, location, hardware, etc.)
-- - Query-based targeting for bulk deployments and job execution
-- - Self-documenting device organization
--
-- Example tags:
--   { "environment": "production", "location": "us-east-1", "hardware": "pi4" }
--
-- Benefits over explicit groups:
--   - No membership management required
--   - Infinite organizational dimensions
--   - Industry-standard approach (AWS, Azure, Kubernetes)
--   - Dynamic querying at deployment time

-- ============================================================================
-- STEP 1: Create device_tags table
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_tags (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure one value per key per device
    UNIQUE(device_uuid, key),
    
    -- Validation constraints
    CONSTRAINT device_tags_key_format CHECK (
        key ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$' AND
        LENGTH(key) >= 2 AND
        LENGTH(key) <= 100
    ),
    CONSTRAINT device_tags_value_not_empty CHECK (
        LENGTH(TRIM(value)) > 0 AND
        LENGTH(value) <= 255
    )
);

-- ============================================================================
-- STEP 2: Create tag_definitions table (optional - for governance)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tag_definitions (
    id SERIAL PRIMARY KEY,
    key VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    allowed_values TEXT[], -- NULL = any value allowed
    is_required BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Validation constraints
    CONSTRAINT tag_definitions_key_format CHECK (
        key ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$' AND
        LENGTH(key) >= 2 AND
        LENGTH(key) <= 100
    )
);

-- ============================================================================
-- STEP 3: Create indexes for performance
-- ============================================================================

-- Index for finding all tags of a device (primary access pattern)
CREATE INDEX idx_device_tags_device_uuid ON device_tags(device_uuid);

-- Composite index for tag key-value queries (find devices by tags)
CREATE INDEX idx_device_tags_key_value ON device_tags(key, value);

-- Index for finding all devices with a specific tag key
CREATE INDEX idx_device_tags_key ON device_tags(key);

-- Index for full-text search on tag values (optional, for fuzzy matching)
-- Only create if pg_trgm extension is available
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX idx_device_tags_value_trgm ON device_tags USING gin(value gin_trgm_ops);
        RAISE NOTICE 'Created trigram index on device_tags.value for fuzzy search';
    ELSE
        RAISE NOTICE 'Skipped trigram index (pg_trgm extension not available)';
    END IF;
END $$;

-- Index for tag definition lookups
CREATE INDEX idx_tag_definitions_key ON tag_definitions(key);

-- ============================================================================
-- STEP 4: Create triggers for updated_at timestamps
-- ============================================================================

CREATE OR REPLACE FUNCTION update_device_tags_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_device_tags_updated_at
    BEFORE UPDATE ON device_tags
    FOR EACH ROW
    EXECUTE FUNCTION update_device_tags_timestamp();

CREATE OR REPLACE FUNCTION update_tag_definitions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_tag_definitions_updated_at
    BEFORE UPDATE ON tag_definitions
    FOR EACH ROW
    EXECUTE FUNCTION update_tag_definitions_timestamp();

-- ============================================================================
-- STEP 5: Create validation trigger for tag values against definitions
-- ============================================================================

CREATE OR REPLACE FUNCTION validate_device_tag_value()
RETURNS TRIGGER AS $$
DECLARE
    tag_def RECORD;
BEGIN
    -- Check if tag definition exists
    SELECT * INTO tag_def FROM tag_definitions WHERE key = NEW.key;
    
    IF FOUND THEN
        -- If allowed_values is defined, validate against it
        IF tag_def.allowed_values IS NOT NULL AND array_length(tag_def.allowed_values, 1) > 0 THEN
            IF NOT (NEW.value = ANY(tag_def.allowed_values)) THEN
                RAISE EXCEPTION 'Tag value "%" not allowed for key "%". Allowed values: %', 
                    NEW.value, NEW.key, array_to_string(tag_def.allowed_values, ', ');
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_validate_device_tag_value
    BEFORE INSERT OR UPDATE ON device_tags
    FOR EACH ROW
    EXECUTE FUNCTION validate_device_tag_value();

-- ============================================================================
-- STEP 6: Create helper functions for tag operations
-- ============================================================================

-- Function: Get all tags for a device as JSON object
CREATE OR REPLACE FUNCTION get_device_tags_json(p_device_uuid UUID)
RETURNS JSONB AS $$
    SELECT COALESCE(
        jsonb_object_agg(key, value),
        '{}'::jsonb
    )
    FROM device_tags
    WHERE device_uuid = p_device_uuid;
$$ LANGUAGE SQL STABLE;

-- Function: Find devices by tag selectors (AND logic)
-- Example: SELECT * FROM find_devices_by_tags('{"environment": "production", "location": "us-east-1"}');
CREATE OR REPLACE FUNCTION find_devices_by_tags(p_tag_selectors JSONB)
RETURNS TABLE(device_uuid UUID) AS $$
DECLARE
    tag_key TEXT;
    tag_value TEXT;
    conditions TEXT[] := ARRAY[]::TEXT[];
    query TEXT;
BEGIN
    -- Build EXISTS clauses for each required tag
    FOR tag_key, tag_value IN SELECT * FROM jsonb_each_text(p_tag_selectors)
    LOOP
        conditions := conditions || format(
            'EXISTS (SELECT 1 FROM device_tags WHERE device_uuid = d.uuid AND key = %L AND value = %L)',
            tag_key, tag_value
        );
    END LOOP;
    
    -- If no selectors provided, return all devices
    IF array_length(conditions, 1) IS NULL THEN
        RETURN QUERY SELECT d.uuid FROM devices d;
        RETURN;
    END IF;
    
    -- Build and execute dynamic query
    query := format('SELECT d.uuid FROM devices d WHERE %s', array_to_string(conditions, ' AND '));
    RETURN QUERY EXECUTE query;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function: Count devices matching tag selectors
CREATE OR REPLACE FUNCTION count_devices_by_tags(p_tag_selectors JSONB)
RETURNS INTEGER AS $$
    SELECT COUNT(*)::INTEGER FROM find_devices_by_tags(p_tag_selectors);
$$ LANGUAGE SQL STABLE;

-- ============================================================================
-- STEP 7: Add comments for documentation
-- ============================================================================

COMMENT ON TABLE device_tags IS 'Key-value tags for flexible device organization and querying';
COMMENT ON COLUMN device_tags.device_uuid IS 'Device this tag belongs to';
COMMENT ON COLUMN device_tags.key IS 'Tag key (e.g., environment, location, hardware)';
COMMENT ON COLUMN device_tags.value IS 'Tag value (e.g., production, us-east-1, pi4)';
COMMENT ON COLUMN device_tags.created_by IS 'User who created this tag';

COMMENT ON TABLE tag_definitions IS 'Optional tag governance - defines allowed keys and values';
COMMENT ON COLUMN tag_definitions.key IS 'Tag key name';
COMMENT ON COLUMN tag_definitions.allowed_values IS 'Whitelist of allowed values (NULL = any value allowed)';
COMMENT ON COLUMN tag_definitions.is_required IS 'Whether this tag must exist on all devices';

COMMENT ON FUNCTION get_device_tags_json(UUID) IS 'Get all tags for a device as JSON object';
COMMENT ON FUNCTION find_devices_by_tags(JSONB) IS 'Find devices matching all specified tags (AND logic)';
COMMENT ON FUNCTION count_devices_by_tags(JSONB) IS 'Count devices matching tag selectors';

-- ============================================================================
-- STEP 8: Insert default tag definitions (examples)
-- ============================================================================

INSERT INTO tag_definitions (key, description, allowed_values, is_required) VALUES
    ('environment', 'Deployment environment', ARRAY['development', 'staging', 'production'], false),
    ('location', 'Physical or cloud region', NULL, false),
    ('hardware', 'Device hardware type', ARRAY['pi3', 'pi4', 'pi5', 'x86'], false),
    ('role', 'Device functional role', ARRAY['gateway', 'sensor', 'edge-processor'], false),
    ('customer', 'Customer or tenant identifier', NULL, false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- STEP 9: Grant permissions
-- ============================================================================

-- Note: Azure PostgreSQL user already has full permissions
-- GRANT statements not needed for cloud-managed instances

-- Grant basic CRUD on device_tags to application role (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON device_tags TO postgres;
-- GRANT USAGE, SELECT ON SEQUENCE device_tags_id_seq TO postgres;

-- Grant read access to tag_definitions
-- GRANT SELECT ON tag_definitions TO postgres;
-- GRANT USAGE, SELECT ON SEQUENCE tag_definitions_id_seq TO postgres;

-- Grant execute on helper functions
-- GRANT EXECUTE ON FUNCTION get_device_tags_json(UUID) TO postgres;
-- GRANT EXECUTE ON FUNCTION find_devices_by_tags(JSONB) TO postgres;
-- GRANT EXECUTE ON FUNCTION count_devices_by_tags(JSONB) TO postgres;

-- ============================================================================
-- COMPLETION
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Migration complete: Device tags system created successfully';
    RAISE NOTICE '   Tables created:';
    RAISE NOTICE '     - device_tags (key-value tags for devices)';
    RAISE NOTICE '     - tag_definitions (optional tag governance)';
    RAISE NOTICE '   Indexes created:';
    RAISE NOTICE '     - idx_device_tags_device_uuid (find device tags)';
    RAISE NOTICE '     - idx_device_tags_key_value (query devices by tags)';
    RAISE NOTICE '     - idx_device_tags_key (list all devices with tag key)';
    RAISE NOTICE '   Functions created:';
    RAISE NOTICE '     - get_device_tags_json(uuid) - Get device tags as JSON';
    RAISE NOTICE '     - find_devices_by_tags(jsonb) - Query devices by tags';
    RAISE NOTICE '     - count_devices_by_tags(jsonb) - Count matching devices';
    RAISE NOTICE '';
    RAISE NOTICE '   Example usage:';
    RAISE NOTICE '     -- Add tags to a device';
    RAISE NOTICE '     INSERT INTO device_tags (device_uuid, key, value) VALUES';
    RAISE NOTICE '       (''123e4567-e89b-12d3-a456-426614174000'', ''environment'', ''production''),';
    RAISE NOTICE '       (''123e4567-e89b-12d3-a456-426614174000'', ''location'', ''us-east-1'');';
    RAISE NOTICE '';
    RAISE NOTICE '     -- Find production devices in us-east-1';
    RAISE NOTICE '     SELECT * FROM find_devices_by_tags(''{"environment": "production", "location": "us-east-1"}'');';
    RAISE NOTICE '';
    RAISE NOTICE '     -- Get all tags for a device';
    RAISE NOTICE '     SELECT get_device_tags_json(''123e4567-e89b-12d3-a456-426614174000'');';
END $$;
