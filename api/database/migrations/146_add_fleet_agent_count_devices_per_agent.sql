-- ============================================================================
-- Migration: Add agent_count and devices_per_agent to fleets table
-- ============================================================================
-- Description: Adds columns to track fleet configuration for resource quota
--              calculation and virtual agent deployment
-- Author: System
-- Date: 2026-02-15
-- ============================================================================

-- Add agent_count column (how many virtual agents in this fleet)
ALTER TABLE fleets 
ADD COLUMN IF NOT EXISTS agent_count INTEGER NOT NULL DEFAULT 1;

-- Add devices_per_agent column (how many devices each agent manages)
ALTER TABLE fleets 
ADD COLUMN IF NOT EXISTS devices_per_agent INTEGER NOT NULL DEFAULT 3;

-- Add check constraints to ensure valid values
ALTER TABLE fleets 
ADD CONSTRAINT valid_agent_count CHECK (agent_count >= 1 AND agent_count <= 100);

ALTER TABLE fleets 
ADD CONSTRAINT valid_devices_per_agent CHECK (devices_per_agent >= 1 AND devices_per_agent <= 50);

-- Add comment for documentation
COMMENT ON COLUMN fleets.agent_count IS 'Number of virtual agents deployed in this fleet (used for K8s resource quota calculation)';
COMMENT ON COLUMN fleets.devices_per_agent IS 'Number of devices each agent can manage (used for capacity planning)';
