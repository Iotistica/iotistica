-- Migration: Enable TimescaleDB extension
-- Created: 2025-12-06
-- Purpose: Install TimescaleDB extension for high-performance time-series data
-- Azure Setup: Run this first to allowlist TimescaleDB:
--   az postgres flexible-server parameter set \
--     --resource-group <your-rg> \
--     --server-name aksdemopgdb \
--     --name azure.extensions \
--     --value timescaledb

DO $$
DECLARE
    timescaledb_installed BOOLEAN;
BEGIN
    -- Check if TimescaleDB is already installed
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
    ) INTO timescaledb_installed;

    IF timescaledb_installed THEN
        RAISE NOTICE 'TimescaleDB extension already enabled';
    ELSE
        -- Try to enable TimescaleDB
        BEGIN
            RAISE NOTICE 'Enabling TimescaleDB extension...';
            CREATE EXTENSION IF NOT EXISTS timescaledb;

            RAISE NOTICE '✅ TimescaleDB extension successfully enabled';
            RAISE NOTICE 'For time-series tables, use: SELECT create_hypertable(''table_name'', ''timestamp_column'');';
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE EXCEPTION 'Cannot enable TimescaleDB: insufficient privileges. Contact your database administrator.';
            WHEN undefined_file THEN
                RAISE EXCEPTION E'TimescaleDB extension not available.\n\nFor Azure PostgreSQL Flexible Server, enable it via:\n  az postgres flexible-server parameter set \\\n    --resource-group <your-rg> \\\n    --server-name aksdemopgdb \\\n    --name azure.extensions \\\n    --value timescaledb\n\nThen restart the server and re-run migrations.';
            WHEN OTHERS THEN
                RAISE EXCEPTION 'Failed to enable TimescaleDB: % (%)', SQLERRM, SQLSTATE;
        END;
    END IF;
END $$;
