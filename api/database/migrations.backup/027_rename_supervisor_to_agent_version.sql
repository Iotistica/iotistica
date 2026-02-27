-- Migration: Rename supervisor_version to agent_version
-- Purpose: Refactor naming to reflect that this is the agent version, not supervisor
-- Date: 2025-01-15

-- Rename column in devices table
ALTER TABLE devices 
RENAME COLUMN supervisor_version TO agent_version;

-- Note: No backwards compatibility - clean rename only
