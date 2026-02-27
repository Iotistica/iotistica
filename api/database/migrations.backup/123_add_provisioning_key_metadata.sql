-- Migration: Add metadata columns to provisioning_keys table
-- Description: Adds deployment_type, simulator_config, and metadata columns to support K8s fleet provisioning
-- Author: System
-- Date: 2026-01-10

-- Add metadata columns to existing provisioning_keys table
ALTER TABLE provisioning_keys 
  ADD COLUMN IF NOT EXISTS deployment_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS simulator_config JSONB,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Add comments for documentation
COMMENT ON COLUMN provisioning_keys.deployment_type IS 'Deployment type: k8s-fleet, edge-device, or standalone';
COMMENT ON COLUMN provisioning_keys.simulator_config IS 'JSON configuration for simulators (Modbus, OPC-UA, SNMP) used in K8s fleet deployments';
COMMENT ON COLUMN provisioning_keys.metadata IS 'Additional metadata about the deployment (pod name, index, etc.)';

-- Add index for faster deployment type queries
CREATE INDEX IF NOT EXISTS idx_provisioning_keys_deployment_type 
  ON provisioning_keys(deployment_type);

-- Add index for querying by simulator config (GIN index for JSONB)
CREATE INDEX IF NOT EXISTS idx_provisioning_keys_simulator_config 
  ON provisioning_keys USING GIN (simulator_config);
