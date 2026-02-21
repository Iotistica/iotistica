-- Migration: Create fleet_namespaces table for pre-provisioned fleet namespace discovery
-- Purpose: Cache Kubernetes namespace metadata for fast lookups and capacity tracking
-- Related: FleetNamespaceManager service, Helm fleet-namespaces.yaml template

-- ============================================================================
-- TABLE: fleet_namespaces
-- ============================================================================
-- Stores metadata about pre-provisioned fleet namespaces from Kubernetes
-- Populated by FleetNamespaceManager.syncNamespacesToDatabase()
-- Used by API to show users available namespaces and recommend best namespace
--
-- Architecture Pattern:
--   1. Admin deploys Helm with fleetNamespaces config (creates fleet-test, fleet-pool-01)
--   2. Namespaces labeled with iotistica.com/fleet-namespace=true
--   3. API discovers namespaces via K8s client
--   4. Data cached here for fast Dashboard queries
--   5. Periodic sync keeps data fresh (every 5 minutes)

CREATE TABLE IF NOT EXISTS fleet_namespaces (
  -- Primary key: Kubernetes namespace name (max 63 chars per K8s spec)
  name VARCHAR(63) PRIMARY KEY,
  
  -- Capacity limits (from namespace labels or ResourceQuota)
  max_agents INTEGER NOT NULL,
  max_devices INTEGER NOT NULL,
  
  -- Current utilization (calculated from deployed fleets)
  current_agents INTEGER NOT NULL DEFAULT 0,
  current_devices INTEGER NOT NULL DEFAULT 0,
  
  -- Resource quotas (from ResourceQuota status)
  cpu_quota_request VARCHAR(20),      -- e.g., "600m" (300m × 2 agents)
  memory_quota_request VARCHAR(20),   -- e.g., "960Mi" (480Mi × 2 agents)
  cpu_quota_used VARCHAR(20),         -- Current CPU usage
  memory_quota_used VARCHAR(20),      -- Current memory usage
  
  -- Availability flags
  available BOOLEAN NOT NULL DEFAULT true,  -- false if at capacity
  utilization_percent NUMERIC(5,2),         -- % of max_agents used (0-100)
  
  -- Sync tracking
  last_synced TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT fleet_namespaces_max_agents_positive CHECK (max_agents > 0),
  CONSTRAINT fleet_namespaces_max_devices_positive CHECK (max_devices > 0),
  CONSTRAINT fleet_namespaces_current_agents_valid CHECK (current_agents >= 0 AND current_agents <= max_agents),
  CONSTRAINT fleet_namespaces_current_devices_valid CHECK (current_devices >= 0 AND current_devices <= max_devices),
  CONSTRAINT fleet_namespaces_utilization_valid CHECK (utilization_percent >= 0 AND utilization_percent <= 100)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Fast lookup for available namespaces with capacity
-- Used by FleetNamespaceManager.findAvailableNamespace()
-- Query pattern: WHERE available = true ORDER BY utilization_percent ASC
CREATE INDEX idx_fleet_namespaces_available_utilization 
  ON fleet_namespaces(available, utilization_percent ASC)
  WHERE available = true;

-- Fast lookup for stale records needing sync
-- Query pattern: WHERE last_synced < NOW() - INTERVAL '5 minutes'
CREATE INDEX idx_fleet_namespaces_last_synced 
  ON fleet_namespaces(last_synced DESC);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE fleet_namespaces IS 
  'Cache of pre-provisioned fleet namespaces from Kubernetes. Synced by FleetNamespaceManager every 5 minutes.';

COMMENT ON COLUMN fleet_namespaces.name IS 
  'Kubernetes namespace name (e.g., fleet-test, fleet-pool-01). Must match namespace with label iotistica.com/fleet-namespace=true';

COMMENT ON COLUMN fleet_namespaces.max_agents IS 
  'Maximum number of virtual agents allowed in this namespace. From namespace label iotistica.com/max-agents or ResourceQuota.';

COMMENT ON COLUMN fleet_namespaces.max_devices IS 
  'Maximum number of devices that can be managed in this namespace (max_agents × devices_per_agent). From namespace label iotistica.com/max-devices.';

COMMENT ON COLUMN fleet_namespaces.current_agents IS 
  'Current number of virtual agent deployments in this namespace. Calculated from fleets table WHERE k8s_namespace = this.name.';

COMMENT ON COLUMN fleet_namespaces.current_devices IS 
  'Current number of devices managed in this namespace. Calculated from SUM(devices_per_agent) for fleets in this namespace.';

COMMENT ON COLUMN fleet_namespaces.cpu_quota_request IS 
  'CPU resource quota request (e.g., "600m" for 2 agents × 300m). From ResourceQuota hard limits.';

COMMENT ON COLUMN fleet_namespaces.memory_quota_request IS 
  'Memory resource quota request (e.g., "960Mi" for 2 agents × 480Mi). From ResourceQuota hard limits.';

COMMENT ON COLUMN fleet_namespaces.available IS 
  'Whether namespace has capacity for more agents. False when current_agents >= max_agents.';

COMMENT ON COLUMN fleet_namespaces.utilization_percent IS 
  'Percentage of namespace capacity used. Calculated as (current_agents / max_agents) × 100.';

COMMENT ON COLUMN fleet_namespaces.last_synced IS 
  'Last time namespace metadata was synced from Kubernetes. Used to trigger periodic re-sync.';

-- ============================================================================
-- SAMPLE DATA (for local development - remove in production)
-- ============================================================================

-- Uncomment for local dev environment to test without K8s cluster
-- INSERT INTO fleet_namespaces (name, max_agents, max_devices, cpu_quota_request, memory_quota_request, available, utilization_percent)
-- VALUES 
--   ('fleet-test', 2, 32, '600m', '960Mi', true, 0),
--   ('fleet-pool-01', 2, 32, '600m', '960Mi', true, 0),
--   ('fleet-pool-02', 2, 32, '600m', '960Mi', true, 0)
-- ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- MIGRATION VERIFICATION
-- ============================================================================

-- Verify table created
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'fleet_namespaces'
  ) THEN
    RAISE EXCEPTION 'Migration failed: fleet_namespaces table not created';
  END IF;
  
  RAISE NOTICE 'Migration 158 completed: fleet_namespaces table created';
END $$;
