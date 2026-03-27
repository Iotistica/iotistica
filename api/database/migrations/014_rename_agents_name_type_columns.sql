-- Migration 014: Rename agents table columns device_name → name, device_type → type
--
-- Rationale: Remove the redundant 'device_' prefix from these two columns.
-- The 'agents' table context already implies these are agent/device properties.
--
-- PostgreSQL automatically updates dependent views (both regular and materialized)
-- when a column is renamed, so no manual view recreation is needed.

BEGIN;

ALTER TABLE agents RENAME COLUMN device_name TO name;
ALTER TABLE agents RENAME COLUMN device_type TO type;

COMMIT;
