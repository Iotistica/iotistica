-- Migration: Add virtual agent deployment fields to devices table
-- Purpose: Support Kubernetes-deployed virtual agents with deployment tracking
-- Date: 2026-02-06

BEGIN;

-- ============================================================================
-- Add virtual agent (K8s deployment) fields to devices table
-- ============================================================================
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(50); -- 'pending', 'deploying', 'running', 'failed', 'terminated'
ALTER TABLE devices ADD COLUMN IF NOT EXISTS k8s_namespace VARCHAR(255); -- Kubernetes namespace where agent is deployed
ALTER TABLE devices ADD COLUMN IF NOT EXISTS k8s_pod_name VARCHAR(255); -- Name of the running pod
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helm_release_name VARCHAR(255); -- Helm release name (or deployment name)

-- ============================================================================
-- Create indexes for efficient virtual agent queries
-- ============================================================================
-- Index for querying virtual agents by deployment status
CREATE INDEX IF NOT EXISTS idx_devices_virtual_deployment 
  ON devices(device_type, deployment_status) 
  WHERE device_type = 'virtual';

-- Index for querying virtual agents by namespace
CREATE INDEX IF NOT EXISTS idx_devices_k8s_namespace 
  ON devices(k8s_namespace) 
  WHERE k8s_namespace IS NOT NULL;

-- Index for dashboard queries (virtual agents overview)
CREATE INDEX IF NOT EXISTS idx_devices_virtual_status 
  ON devices(device_type, deployment_status, status) 
  WHERE device_type = 'virtual';

-- ============================================================================
-- Add comments for documentation
-- ============================================================================
COMMENT ON COLUMN devices.deployment_status IS 'Kubernetes deployment status for virtual agents: pending, deploying, running, failed, terminated';
COMMENT ON COLUMN devices.k8s_namespace IS 'Kubernetes namespace where the virtual agent pod is deployed';
COMMENT ON COLUMN devices.k8s_pod_name IS 'Name of the running Kubernetes pod for this virtual agent';
COMMENT ON COLUMN devices.helm_release_name IS 'Helm release name or Kubernetes deployment name for this virtual agent';

COMMIT;
