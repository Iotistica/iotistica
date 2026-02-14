-- Migration: 143_add_fleet_billing_history.sql
-- Purpose: Fleet billing history and usage analytics
-- Date: 2026-02-14
-- Phase: 3 of 3 - Billing History & Analytics

BEGIN;

-- ============================================================================
-- PHASE 3: Fleet Billing History Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS fleet_billing_history (
    id BIGSERIAL PRIMARY KEY,
    fleet_id VARCHAR(100) NOT NULL REFERENCES fleets(fleet_id) ON DELETE CASCADE,
    
    -- Billing period
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    billing_month VARCHAR(7) NOT NULL,              -- Format: YYYY-MM
    
    -- Usage metrics
    hours_running DECIMAL(10,2) NOT NULL DEFAULT 0,
    device_count INTEGER NOT NULL DEFAULT 0,
    avg_devices_online DECIMAL(5,2),
    total_endpoints INTEGER DEFAULT 0,
    
    -- Cost breakdown
    base_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
    overage_cost DECIMAL(10,2) DEFAULT 0,
    discount_amount DECIMAL(10,2) DEFAULT 0,
    total_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
    
    -- Billing details
    billing_mode VARCHAR(20) NOT NULL,
    cost_per_hour DECIMAL(10,4),
    budget_limit DECIMAL(10,2),
    budget_exceeded BOOLEAN DEFAULT false,
    
    -- Invoice tracking
    invoice_id VARCHAR(255),
    invoice_status VARCHAR(50),                      -- 'pending', 'paid', 'overdue', 'cancelled'
    invoice_date DATE,
    paid_at TIMESTAMP,
    
    -- Metadata
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT valid_period CHECK (period_end > period_start),
    CONSTRAINT valid_invoice_status CHECK (invoice_status IS NULL OR invoice_status IN ('pending', 'paid', 'overdue', 'cancelled')),
    UNIQUE(fleet_id, billing_month)
);

-- ============================================================================
-- PHASE 3: Fleet Usage Events Table (Detailed Tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS fleet_usage_events (
    id BIGSERIAL PRIMARY KEY,
    fleet_id VARCHAR(100) NOT NULL REFERENCES fleets(fleet_id) ON DELETE CASCADE,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL,                -- 'started', 'stopped', 'cost_updated', 'budget_alert', 'device_added', 'device_removed'
    event_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Snapshot of state at event time
    device_count INTEGER,
    devices_online INTEGER,
    total_endpoints INTEGER,
    
    -- Cost tracking
    cost_snapshot DECIMAL(10,2),
    total_hours DECIMAL(10,2),
    
    -- Event metadata
    triggered_by VARCHAR(255),                       -- User ID or 'system'
    details JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT valid_event_type CHECK (event_type IN ('started', 'stopped', 'cost_updated', 'budget_alert', 'budget_exceeded', 'device_added', 'device_removed', 'deployment_complete', 'deployment_failed'))
);

-- ============================================================================
-- PHASE 3: Indexes for Performance
-- ============================================================================

-- Billing history indexes
CREATE INDEX IF NOT EXISTS idx_fleet_billing_history_fleet ON fleet_billing_history(fleet_id);
CREATE INDEX IF NOT EXISTS idx_fleet_billing_history_month ON fleet_billing_history(billing_month);
CREATE INDEX IF NOT EXISTS idx_fleet_billing_history_invoice ON fleet_billing_history(invoice_status) WHERE invoice_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_fleet_billing_history_period ON fleet_billing_history(period_start, period_end);

-- Usage events indexes
CREATE INDEX IF NOT EXISTS idx_fleet_usage_events_fleet ON fleet_usage_events(fleet_id);
CREATE INDEX IF NOT EXISTS idx_fleet_usage_events_type ON fleet_usage_events(event_type);
CREATE INDEX IF NOT EXISTS idx_fleet_usage_events_timestamp ON fleet_usage_events(event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_usage_events_fleet_type ON fleet_usage_events(fleet_id, event_type);

-- ============================================================================
-- PHASE 3: Update Trigger for Billing History
-- ============================================================================

CREATE OR REPLACE FUNCTION update_fleet_billing_history_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_fleet_billing_history_updated_at
    BEFORE UPDATE ON fleet_billing_history
    FOR EACH ROW
    EXECUTE FUNCTION update_fleet_billing_history_timestamp();

-- ============================================================================
-- PHASE 3: Helper Function - Record Usage Event
-- ============================================================================

CREATE OR REPLACE FUNCTION record_fleet_usage_event(
    p_fleet_id VARCHAR(100),
    p_event_type VARCHAR(50),
    p_triggered_by VARCHAR(255) DEFAULT 'system',
    p_details JSONB DEFAULT '{}'
)
RETURNS BIGINT AS $$
DECLARE
    v_event_id BIGINT;
    v_device_count INTEGER;
    v_devices_online INTEGER;
    v_total_endpoints INTEGER;
    v_current_cost DECIMAL(10,2);
    v_total_hours DECIMAL(10,2);
BEGIN
    -- Get current fleet state
    SELECT 
        COUNT(d.uuid),
        COUNT(d.uuid) FILTER (WHERE d.is_online = true),
        (SELECT COUNT(*) FROM device_sensors ds WHERE ds.device_uuid IN (SELECT d2.uuid FROM devices d2 WHERE d2.fleet_id = p_fleet_id)),
        f.current_cost,
        f.total_running_hours
    INTO v_device_count, v_devices_online, v_total_endpoints, v_current_cost, v_total_hours
    FROM fleets f
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.fleet_id = p_fleet_id
    GROUP BY f.fleet_id, f.current_cost, f.total_running_hours;
    
    -- Insert event
    INSERT INTO fleet_usage_events (
        fleet_id, event_type, device_count, devices_online, 
        total_endpoints, cost_snapshot, total_hours, triggered_by, details
    ) VALUES (
        p_fleet_id, p_event_type, v_device_count, v_devices_online,
        v_total_endpoints, v_current_cost, v_total_hours, p_triggered_by, p_details
    ) RETURNING id INTO v_event_id;
    
    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 3: Helper Function - Close Billing Period
-- ============================================================================

CREATE OR REPLACE FUNCTION close_fleet_billing_period(
    p_fleet_id VARCHAR(100),
    p_period_end TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
RETURNS BIGINT AS $$
DECLARE
    v_billing_id BIGINT;
    v_period_start TIMESTAMP;
    v_hours_running DECIMAL(10,2);
    v_device_count INTEGER;
    v_total_cost DECIMAL(10,2);
    v_billing_mode VARCHAR(20);
    v_budget_limit DECIMAL(10,2);
    v_billing_month VARCHAR(7);
BEGIN
    -- Get fleet details
    SELECT 
        f.started_at,
        f.total_running_hours,
        COUNT(d.uuid),
        f.current_cost,
        f.billing_mode,
        f.budget_limit,
        TO_CHAR(p_period_end, 'YYYY-MM')
    INTO v_period_start, v_hours_running, v_device_count, v_total_cost, 
         v_billing_mode, v_budget_limit, v_billing_month
    FROM fleets f
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.fleet_id = p_fleet_id
    GROUP BY f.fleet_id, f.started_at, f.total_running_hours, 
             f.current_cost, f.billing_mode, f.budget_limit;
    
    -- Insert billing history record
    INSERT INTO fleet_billing_history (
        fleet_id, period_start, period_end, billing_month,
        hours_running, device_count, total_cost, base_cost,
        billing_mode, cost_per_hour, budget_limit,
        budget_exceeded, invoice_status
    )
    VALUES (
        p_fleet_id,
        COALESCE(v_period_start, p_period_end - INTERVAL '1 month'),
        p_period_end,
        v_billing_month,
        v_hours_running,
        v_device_count,
        v_total_cost,
        v_total_cost,  -- base_cost = total_cost for now
        v_billing_mode,
        (SELECT cost_per_hour FROM fleets WHERE fleet_id = p_fleet_id),
        v_budget_limit,
        CASE WHEN v_budget_limit IS NOT NULL THEN v_total_cost > v_budget_limit ELSE false END,
        'pending'
    )
    ON CONFLICT (fleet_id, billing_month) 
    DO UPDATE SET
        period_end = p_period_end,
        hours_running = v_hours_running,
        device_count = v_device_count,
        total_cost = v_total_cost,
        base_cost = v_total_cost,
        budget_exceeded = CASE WHEN v_budget_limit IS NOT NULL THEN v_total_cost > v_budget_limit ELSE false END,
        updated_at = CURRENT_TIMESTAMP
    RETURNING id INTO v_billing_id;
    
    -- Reset current_cost for new period (typically done monthly)
    -- UPDATE fleets SET current_cost = 0, last_metered_at = p_period_end WHERE fleet_id = p_fleet_id;
    
    RETURN v_billing_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 3: Analytics View - Monthly Costs by Customer
-- ============================================================================

CREATE OR REPLACE VIEW fleet_monthly_costs AS
SELECT 
    f.customer_id,
    fbh.billing_month,
    COUNT(DISTINCT fbh.fleet_id) as fleet_count,
    SUM(fbh.total_cost) as total_monthly_cost,
    SUM(fbh.hours_running) as total_hours,
    AVG(fbh.device_count) as avg_device_count,
    SUM(fbh.overage_cost) as total_overage,
    COUNT(*) FILTER (WHERE fbh.budget_exceeded = true) as fleets_over_budget
FROM fleet_billing_history fbh
JOIN fleets f ON f.fleet_id = fbh.fleet_id
GROUP BY f.customer_id, fbh.billing_month
ORDER BY fbh.billing_month DESC, total_monthly_cost DESC;

-- ============================================================================
-- PHASE 3: Comments
-- ============================================================================

COMMENT ON TABLE fleet_billing_history IS 'Monthly billing history for fleets with usage metrics and invoice tracking';
COMMENT ON TABLE fleet_usage_events IS 'Detailed event log for fleet lifecycle (start, stop, cost updates, alerts)';

COMMENT ON COLUMN fleet_billing_history.billing_month IS 'Format: YYYY-MM for grouping monthly charges';
COMMENT ON COLUMN fleet_billing_history.hours_running IS 'Total hours fleet was active during billing period';
COMMENT ON COLUMN fleet_billing_history.budget_exceeded IS 'True if total_cost exceeded budget_limit during period';

COMMENT ON FUNCTION record_fleet_usage_event(VARCHAR, VARCHAR, VARCHAR, JSONB) IS 'Record a fleet lifecycle event with current state snapshot';
COMMENT ON FUNCTION close_fleet_billing_period(VARCHAR, TIMESTAMP) IS 'Finalize billing period and create invoice record';

COMMENT ON VIEW fleet_monthly_costs IS 'Aggregate monthly costs by customer for billing reports';

-- ============================================================================
-- PHASE 3: Completion
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Migration 143 Phase 3 complete: Billing history and analytics added';
    RAISE NOTICE '   Tables: fleet_billing_history, fleet_usage_events';
    RAISE NOTICE '   Functions: record_fleet_usage_event(), close_fleet_billing_period()';
    RAISE NOTICE '   Views: fleet_monthly_costs';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 Fleet Management System complete! All 3 phases deployed.';
    RAISE NOTICE '   Phase 1: Core fleet table (141)';
    RAISE NOTICE '   Phase 2: Views and functions (142)';
    RAISE NOTICE '   Phase 3: Billing history and analytics (143)';
    RAISE NOTICE '';
    RAISE NOTICE '📊 Usage:';
    RAISE NOTICE '   - View all fleets: SELECT * FROM fleet_summary;';
    RAISE NOTICE '   - Billing report: SELECT * FROM fleet_billing_summary;';
    RAISE NOTICE '   - Monthly costs: SELECT * FROM fleet_monthly_costs;';
    RAISE NOTICE '   - Fleet stats: SELECT * FROM get_fleet_stats(''fleet-id'');';
END
$$;

COMMIT;
