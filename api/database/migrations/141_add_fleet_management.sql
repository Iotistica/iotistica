-- Migration: 141_add_fleet_management.sql
-- Purpose: Unified fleet management for both virtual and physical devices
-- Date: 2026-02-14
-- Phase: 1 of 3 - Core Schema

BEGIN;

-- ============================================================================
-- PHASE 1: Core Fleet Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS fleets (
    id SERIAL PRIMARY KEY,
    fleet_id VARCHAR(100) NOT NULL UNIQUE,          -- Links to devices.fleet_id
    fleet_name VARCHAR(255) NOT NULL,
    customer_id UUID NOT NULL,                      -- Owner of this fleet
    
    -- Fleet type and purpose
    fleet_type VARCHAR(20) NOT NULL DEFAULT 'physical',  
    -- Options: 'virtual' (K8s-deployed agents), 'physical' (customer hardware), 'mixed'
    description TEXT,
    
    -- Device configuration (primarily for virtual fleets)
    target_device_count INTEGER,                    -- Expected number of devices
    deployment_config JSONB DEFAULT '{}',           -- Virtual agent deployment settings
    
    -- Billing (primarily for virtual fleets, optional for physical)
    billing_enabled BOOLEAN DEFAULT false,
    billing_mode VARCHAR(20),                       -- 'hourly', 'monthly', null
    cost_per_hour DECIMAL(10,4),                   -- Calculated hourly cost
    cost_per_month DECIMAL(10,2),                  -- Calculated monthly cost
    
    -- Usage tracking
    total_running_hours DECIMAL(10,2) DEFAULT 0,   -- Cumulative runtime
    current_cost DECIMAL(10,2) DEFAULT 0,          -- Running total (current billing period)
    last_metered_at TIMESTAMP,                     -- Last metering timestamp
    budget_limit DECIMAL(10,2),                    -- Optional spending cap
    budget_alert_threshold DECIMAL(5,2) DEFAULT 80, -- Alert at 80% of budget
    
    -- State management
    status VARCHAR(50) DEFAULT 'active',            -- 'active', 'stopped', 'deleted', 'provisioning'
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    stopped_at TIMESTAMP,
    
    -- Metadata and organization
    tags JSONB DEFAULT '{}',                        -- Flexible key-value tags
    environment VARCHAR(50),                        -- 'production', 'staging', 'development', 'testing'
    location VARCHAR(255),                          -- Physical location or cloud region
    
    -- Audit fields
    created_by VARCHAR(255),                        -- User who created fleet
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT valid_fleet_type CHECK (fleet_type IN ('virtual', 'physical', 'mixed')),
    CONSTRAINT valid_status CHECK (status IN ('active', 'stopped', 'deleted', 'provisioning')),
    CONSTRAINT valid_billing_mode CHECK (billing_mode IS NULL OR billing_mode IN ('hourly', 'monthly')),
    CONSTRAINT valid_budget_threshold CHECK (budget_alert_threshold >= 0 AND budget_alert_threshold <= 100)
);

-- ============================================================================
-- PHASE 1: Indexes for Performance
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_fleets_customer ON fleets(customer_id);
CREATE INDEX IF NOT EXISTS idx_fleets_status ON fleets(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_fleets_fleet_id ON fleets(fleet_id);
CREATE INDEX IF NOT EXISTS idx_fleets_type ON fleets(fleet_type);
CREATE INDEX IF NOT EXISTS idx_fleets_billing ON fleets(customer_id, billing_enabled) WHERE billing_enabled = true;
CREATE INDEX IF NOT EXISTS idx_fleets_environment ON fleets(customer_id, environment);

-- ============================================================================
-- PHASE 1: Update Trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_fleet_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_fleets_updated_at
    BEFORE UPDATE ON fleets
    FOR EACH ROW
    EXECUTE FUNCTION update_fleet_timestamp();

-- ============================================================================
-- PHASE 1: Comments
-- ============================================================================

COMMENT ON TABLE fleets IS 'Unified fleet management for virtual and physical devices. Phase 1: Core schema.';
COMMENT ON COLUMN fleets.fleet_id IS 'Unique fleet identifier, links to devices.fleet_id';
COMMENT ON COLUMN fleets.fleet_type IS 'virtual: K8s-deployed agents; physical: customer-owned hardware; mixed: both';
COMMENT ON COLUMN fleets.billing_enabled IS 'True for virtual fleets (usage-based billing), typically false for physical fleets';
COMMENT ON COLUMN fleets.deployment_config IS 'JSONB: {agentCount, devicesPerAgent, resourceTier, etc.}';
COMMENT ON COLUMN fleets.current_cost IS 'Running total cost for current billing period (resets monthly)';
COMMENT ON COLUMN fleets.total_running_hours IS 'Cumulative lifetime running hours for billing';
COMMENT ON COLUMN fleets.tags IS 'JSONB key-value pairs for flexible metadata (department, cost-center, etc.)';

-- ============================================================================
-- PHASE 1: Completion
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Migration 141 Phase 1 complete: Core fleet table created';
    RAISE NOTICE '   Table: fleets';
    RAISE NOTICE '   Indexes: 6 created for performance';
    RAISE NOTICE '   Next: Phase 2 will add views and helper functions';
    RAISE NOTICE '   Next: Phase 3 will add billing history and analytics';
END
$$;

COMMIT;
