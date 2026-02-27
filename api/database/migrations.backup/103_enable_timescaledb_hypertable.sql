-- Migration: Enable TimescaleDB extension
-- Created: 2025-12-06
-- Purpose: Install TimescaleDB extension for high-performance time-series data
-- Azure Setup: Run this first to allowlist TimescaleDB:
--   az postgres flexible-server parameter set \
--     --resource-group <your-rg> \
--     --server-name aksdemopgdb \
--     --name azure.extensions \
--     --value timescaledb

-- Azure PostgreSQL: Increase statement timeout for extension installation
SET statement_timeout = '300s'; -- 5 minutes for CREATE EXTENSION
SET lock_timeout = '60s';       -- 1 minute for locks

DO $$
DECLARE
    timescaledb_installed BOOLEAN;
    timescaledb_available BOOLEAN;
BEGIN
    -- Check if TimescaleDB is already installed
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
    ) INTO timescaledb_installed;

    IF timescaledb_installed THEN
        RAISE NOTICE 'TimescaleDB extension already enabled';
    ELSE
        -- Check if TimescaleDB is available (whitelisted in azure.extensions)
        SELECT EXISTS (
            SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
        ) INTO timescaledb_available;
        
        IF NOT timescaledb_available THEN
            RAISE WARNING E'TimescaleDB extension not available in Azure.\n\nEnable it via Azure CLI:\n  az postgres flexible-server parameter set \\\n    --resource-group <your-rg> \\\n    --server-name aksdemopgdb \\\n    --name azure.extensions \\\n    --value timescaledb\n\nThen restart server and re-run migrations.';
            RAISE NOTICE 'Skipping TimescaleDB installation - not available';
        ELSE
            -- Try to enable TimescaleDB
            BEGIN
                RAISE NOTICE 'Enabling TimescaleDB extension (may take 30-60 seconds on Azure)...';
                CREATE EXTENSION IF NOT EXISTS timescaledb;

                RAISE NOTICE '✅ TimescaleDB extension successfully enabled';
                RAISE NOTICE 'For time-series tables, use: SELECT create_hypertable(''table_name'', ''timestamp_column'');';
            EXCEPTION
                WHEN insufficient_privilege THEN
                    RAISE EXCEPTION 'Cannot enable TimescaleDB: insufficient privileges. Contact your database administrator.';
                WHEN OTHERS THEN
                    RAISE EXCEPTION 'Failed to enable TimescaleDB: % (%)', SQLERRM, SQLSTATE;
            END;
        END IF;
    END IF;
END $$;

-- Reset timeouts to defaults
RESET statement_timeout;
RESET lock_timeout;
