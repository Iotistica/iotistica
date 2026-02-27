-- Migration: Add Node-RED storage tables for single-instance deployment
-- Description: Tables to store Node-RED flows, credentials, settings, sessions, and library
-- Created: 2025-11-21

-- Node-RED flows storage (single instance)
CREATE TABLE IF NOT EXISTS nodered_flows (
    id INTEGER PRIMARY KEY DEFAULT 1,
    flows JSONB NOT NULL DEFAULT '[]'::jsonb,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Node-RED credentials storage (encrypted credentials)
CREATE TABLE IF NOT EXISTS nodered_credentials (
    id INTEGER PRIMARY KEY DEFAULT 1,
    credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Node-RED settings storage (runtime settings)
CREATE TABLE IF NOT EXISTS nodered_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Node-RED sessions storage (user sessions)
CREATE TABLE IF NOT EXISTS nodered_sessions (
    id INTEGER PRIMARY KEY DEFAULT 1,
    sessions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Node-RED library storage (reusable flows/functions)
CREATE TABLE IF NOT EXISTS nodered_library (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL, -- 'flows', 'functions', etc.
    name VARCHAR(255) NOT NULL,
    meta JSONB DEFAULT '{}'::jsonb,
    body TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (type, name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_nodered_library_type ON nodered_library(type);
CREATE INDEX IF NOT EXISTS idx_nodered_library_lookup ON nodered_library(type, name);

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_nodered_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_nodered_flows_updated_at
    BEFORE UPDATE ON nodered_flows
    FOR EACH ROW
    EXECUTE FUNCTION update_nodered_updated_at();

CREATE TRIGGER trigger_nodered_credentials_updated_at
    BEFORE UPDATE ON nodered_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_nodered_updated_at();

CREATE TRIGGER trigger_nodered_settings_updated_at
    BEFORE UPDATE ON nodered_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_nodered_updated_at();

CREATE TRIGGER trigger_nodered_sessions_updated_at
    BEFORE UPDATE ON nodered_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_nodered_updated_at();

CREATE TRIGGER trigger_nodered_library_updated_at
    BEFORE UPDATE ON nodered_library
    FOR EACH ROW
    EXECUTE FUNCTION update_nodered_updated_at();

-- Grant permissions to application user (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iotistic_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON nodered_flows TO iotistic_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON nodered_credentials TO iotistic_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON nodered_settings TO iotistic_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON nodered_sessions TO iotistic_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON nodered_library TO iotistic_app;
        GRANT USAGE, SELECT ON SEQUENCE nodered_library_id_seq TO iotistic_app;
    END IF;
END
$$;

-- Comments for documentation
COMMENT ON TABLE nodered_flows IS 'Node-RED flow configurations (single instance)';
COMMENT ON TABLE nodered_credentials IS 'Node-RED encrypted credentials (single instance)';
COMMENT ON TABLE nodered_settings IS 'Node-RED runtime settings (single instance)';
COMMENT ON TABLE nodered_sessions IS 'Node-RED user sessions (single instance)';
COMMENT ON TABLE nodered_library IS 'Node-RED library entries (reusable flows/functions)';
COMMENT ON COLUMN nodered_flows.revision IS 'Revision counter for optimistic locking';
COMMENT ON COLUMN nodered_credentials.revision IS 'Revision counter for optimistic locking';
