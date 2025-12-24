-- Migration 044: Add dashboard layouts table for persistent user dashboard configurations
-- Created: 2025-11-03
-- Description: Stores custom dashboard layouts per user/device with JSON widget configurations

DO $$
BEGIN
    CREATE TABLE IF NOT EXISTS dashboard_layouts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
        layout_name VARCHAR(255) DEFAULT 'Default',
        widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        -- Ensure unique layout names per user/device
        CONSTRAINT unique_layout_name UNIQUE (user_id, device_uuid, layout_name)
    );

    -- Partial unique index to ensure only one default layout per user/device
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_one_default 
        ON dashboard_layouts(user_id, device_uuid) 
        WHERE is_default = true;

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_user_device ON dashboard_layouts(user_id, device_uuid);
    CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_device ON dashboard_layouts(device_uuid);
    CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_user ON dashboard_layouts(user_id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_widgets ON dashboard_layouts USING GIN (widgets);

    RAISE NOTICE 'dashboard_layouts table and indexes created successfully';

EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE WARNING 'Cannot create dashboard_layouts: insufficient privileges. Skipping this migration.';
    WHEN OTHERS THEN
        RAISE WARNING 'Failed to create dashboard_layouts: % (%). Skipping this migration.', SQLERRM, SQLSTATE;
END $$;

-- Trigger to update updated_at timestamp
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dashboard_layouts') THEN
        CREATE OR REPLACE FUNCTION update_dashboard_layouts_updated_at()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS dashboard_layouts_updated_at ON dashboard_layouts;

        CREATE TRIGGER dashboard_layouts_updated_at
            BEFORE UPDATE ON dashboard_layouts
            FOR EACH ROW
            EXECUTE FUNCTION update_dashboard_layouts_updated_at();
            
        RAISE NOTICE 'Created update trigger for dashboard_layouts';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Failed to create trigger for dashboard_layouts: % (%)', SQLERRM, SQLSTATE;
END $$;

-- Grant permissions (adjust role as needed)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dashboard_layouts') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_layouts TO postgres;
        GRANT USAGE, SELECT ON SEQUENCE dashboard_layouts_id_seq TO postgres;
        
        RAISE NOTICE 'Granted permissions on dashboard_layouts';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Failed to grant permissions on dashboard_layouts: % (%)', SQLERRM, SQLSTATE;
END $$;

-- Add comment
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dashboard_layouts') THEN
        COMMENT ON TABLE dashboard_layouts IS 'Stores custom dashboard widget layouts per user and device';
        COMMENT ON COLUMN dashboard_layouts.widgets IS 'JSON array of widget configurations with type, position, size';
        COMMENT ON COLUMN dashboard_layouts.is_default IS 'Marks the default layout to load for this user/device combination';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Failed to add comments to dashboard_layouts: % (%)', SQLERRM, SQLSTATE;
END $$;
