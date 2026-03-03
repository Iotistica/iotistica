-- Migration: Add db_provider column to track which provisioning backend was used
-- Date: 2026-03-03
--
-- Supported values:
--   'tigerdata'  - Managed TimescaleDB via TigerData/Timescale Cloud API (existing default)
--   'postgres'   - Self-hosted PostgreSQL via direct DDL (new option)
--
-- Default is 'tigerdata' for backward compatibility with existing rows.

ALTER TABLE customers
ADD COLUMN IF NOT EXISTS db_provider VARCHAR(50) DEFAULT 'tigerdata';

COMMENT ON COLUMN customers.db_provider IS 'Database provisioning provider: tigerdata (Timescale Cloud) or postgres (self-hosted PostgreSQL)';

-- Backfill: any row that already has a db_service_id was provisioned via TigerData
UPDATE customers
   SET db_provider = 'tigerdata'
 WHERE db_service_id IS NOT NULL
   AND db_provider IS NULL;
