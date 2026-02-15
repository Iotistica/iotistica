-- Migration: 142_add_fleet_views_and_functions.sql
-- Purpose: Fleet management views and helper functions
-- Date: 2026-02-14
-- Phase: 2 of 3 - Views & Functions

BEGIN;

-- ============================================================================
-- PHASE 2: Fleet Summary View (Real-time Statistics)
-- ============================================================================

CREATE OR REPLACE VIEW fleet_summary AS
SELECT 
    f.id,
    f.fleet_id,
    f.fleet_name,
    f.customer_id,
    f.fleet_type,
    f.status,
    f.billing_enabled,
    f.current_cost,
    f.budget_limit,
    f.environment,
    f.location,
    f.created_at,
    f.updated_at,
    
    -- Device statistics
    COUNT(d.uuid) as total_devices,
    COUNT(d.uuid) FILTER (WHERE d.is_online = true) as online_devices,
    COUNT(d.uuid) FILTER (WHERE d.is_online = false) as offline_devices,
    COUNT(d.uuid) FILTER (WHERE d.device_type = 'virtual') as virtual_devices,
    COUNT(d.uuid) FILTER (WHERE d.device_type != 'virtual' OR d.device_type IS NULL) as physical_devices,
    
    -- Resource usage (for virtual devices)
    COALESCE(ROUND(AVG(d.cpu_usage)::numeric, 2), 0) as avg_cpu_usage,
    COALESCE(SUM(d.memory_usage), 0) as total_memory_usage,
    COALESCE(SUM(d.memory_total), 0) as total_memory_capacity,
    
    -- Calculate memory usage percentage
    CASE 
        WHEN SUM(d.memory_total) > 0 THEN 
            ROUND((SUM(d.memory_usage)::decimal / SUM(d.memory_total) * 100)::numeric, 2)
        ELSE 0 
    END as avg_memory_percent,
    
    -- Endpoint count (devices being monitored by each agent)
    (
        SELECT COUNT(*) 
        FROM device_sensors ds 
        WHERE ds.device_uuid IN (SELECT d2.uuid FROM devices d2 WHERE d2.fleet_id = f.fleet_id)
    ) as total_endpoints

FROM fleets f
LEFT JOIN devices d ON d.fleet_id = f.fleet_id
GROUP BY f.id, f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, 
         f.status, f.billing_enabled, f.current_cost, f.budget_limit,
         f.environment, f.location, f.created_at, f.updated_at;

-- ============================================================================
-- PHASE 2: Billing Summary View (Active Fleets with Billing)
-- ============================================================================

CREATE OR REPLACE VIEW fleet_billing_summary AS
SELECT 
    f.fleet_id,
    f.fleet_name,
    f.customer_id,
    f.fleet_type,
    f.billing_mode,
    f.cost_per_hour,
    f.cost_per_month,
    f.total_running_hours,
    f.current_cost,
    f.budget_limit,
    f.budget_alert_threshold,
    f.last_metered_at,
    f.started_at,
    
    -- Budget status
    CASE 
        WHEN f.budget_limit IS NOT NULL AND f.budget_limit > 0 THEN 
            ROUND((f.current_cost / f.budget_limit * 100)::numeric, 2)
        ELSE NULL
    END as budget_used_percent,
    
    -- Budget alerts
    CASE 
        WHEN f.budget_limit IS NOT NULL AND f.budget_limit > 0 THEN
            f.current_cost >= (f.budget_limit * f.budget_alert_threshold / 100)
        ELSE false
    END as budget_alert_triggered,
    
    -- Projected costs
    CASE 
        WHEN f.billing_mode = 'hourly' AND f.cost_per_hour IS NOT NULL THEN 
            ROUND((f.cost_per_hour * 730)::numeric, 2)  -- 730 hours/month average
        ELSE f.cost_per_month
    END as projected_monthly_cost,
    
    -- Runtime since last start
    CASE 
        WHEN f.status = 'active' AND f.started_at IS NOT NULL THEN
            ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - f.started_at)) / 3600::numeric, 2)
        ELSE 0
    END as current_session_hours,
    
    -- Device counts
    COUNT(d.uuid) as device_count,
    COUNT(d.uuid) FILTER (WHERE d.is_online = true) as running_devices,
    
    -- Total endpoints being monitored
    (
        SELECT COUNT(*) 
        FROM device_sensors ds 
        WHERE ds.device_uuid IN (SELECT d2.uuid FROM devices d2 WHERE d2.fleet_id = f.fleet_id)
    ) as total_endpoints

FROM fleets f
LEFT JOIN devices d ON d.fleet_id = f.fleet_id
WHERE f.billing_enabled = true
  AND f.status IN ('active', 'stopped')
GROUP BY f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, f.billing_mode,
         f.cost_per_hour, f.cost_per_month, f.total_running_hours, f.current_cost,
         f.budget_limit, f.budget_alert_threshold, f.last_metered_at, f.started_at,
         f.status;

-- ============================================================================
-- PHASE 2: Helper Function - Get Fleet Statistics
-- ============================================================================

CREATE OR REPLACE FUNCTION get_fleet_stats(p_fleet_id VARCHAR(100))
RETURNS TABLE (
    fleet_name VARCHAR(255),
    fleet_type VARCHAR(20),
    status VARCHAR(50),
    total_devices BIGINT,
    online_devices BIGINT,
    offline_devices BIGINT,
    virtual_devices BIGINT,
    physical_devices BIGINT,
    total_endpoints BIGINT,
    avg_cpu_usage DECIMAL(5,2),
    avg_memory_usage_percent DECIMAL(5,2),
    total_memory_gb DECIMAL(10,2),
    billing_enabled BOOLEAN,
    current_cost DECIMAL(10,2),
    budget_remaining DECIMAL(10,2)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.fleet_name,
        f.fleet_type,
        f.status,
        COUNT(d.uuid) as total_devices,
        COUNT(d.uuid) FILTER (WHERE d.is_online = true) as online_devices,
        COUNT(d.uuid) FILTER (WHERE d.is_online = false) as offline_devices,
        COUNT(d.uuid) FILTER (WHERE d.device_type = 'virtual') as virtual_devices,
        COUNT(d.uuid) FILTER (WHERE d.device_type != 'virtual' OR d.device_type IS NULL) as physical_devices,
        COALESCE((
            SELECT COUNT(*) 
            FROM device_sensors ds 
            WHERE ds.device_uuid IN (SELECT d2.uuid FROM devices d2 WHERE d2.fleet_id = f.fleet_id)
        ), 0) as total_endpoints,
        ROUND(COALESCE(AVG(d.cpu_usage), 0)::numeric, 2) as avg_cpu_usage,
        ROUND(COALESCE(AVG(
            CASE 
                WHEN d.memory_total > 0 THEN (d.memory_usage::decimal / d.memory_total * 100)
                ELSE 0 
            END
        ), 0)::numeric, 2) as avg_memory_usage_percent,
        ROUND((COALESCE(SUM(d.memory_total), 0) / 1073741824.0)::numeric, 2) as total_memory_gb,  -- Convert bytes to GB
        f.billing_enabled,
        COALESCE(f.current_cost, 0) as current_cost,
        CASE 
            WHEN f.budget_limit IS NOT NULL THEN f.budget_limit - COALESCE(f.current_cost, 0)
            ELSE NULL
        END as budget_remaining
    FROM fleets f
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.fleet_id = p_fleet_id
    GROUP BY f.fleet_name, f.fleet_type, f.status, f.billing_enabled, 
             f.current_cost, f.budget_limit, f.fleet_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 2: Helper Function - List Customer Fleets
-- ============================================================================

CREATE OR REPLACE FUNCTION get_customer_fleets(p_customer_id UUID)
RETURNS TABLE (
    fleet_id VARCHAR(100),
    fleet_name VARCHAR(255),
    fleet_type VARCHAR(20),
    status VARCHAR(50),
    environment VARCHAR(50),
    device_count BIGINT,
    online_count BIGINT,
    billing_enabled BOOLEAN,
    current_cost DECIMAL(10,2),
    created_at TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.fleet_id,
        f.fleet_name,
        f.fleet_type,
        f.status,
        f.environment,
        COUNT(d.uuid) as device_count,
        COUNT(d.uuid) FILTER (WHERE d.is_online = true) as online_count,
        f.billing_enabled,
        f.current_cost,
        f.created_at
    FROM fleets f
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.customer_id = p_customer_id
      AND f.status != 'deleted'
    GROUP BY f.fleet_id, f.fleet_name, f.fleet_type, f.status, 
             f.environment, f.billing_enabled, f.current_cost, f.created_at
    ORDER BY f.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 2: Helper Function - Calculate Fleet Cost
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_fleet_cost(
    p_agent_count INTEGER,
    p_devices_per_agent INTEGER,
    p_billing_mode VARCHAR(20) DEFAULT 'hourly'
)
RETURNS TABLE (
    resource_tier VARCHAR(20),
    cost_per_hour DECIMAL(10,4),
    cost_per_month DECIMAL(10,2),
    total_monthly_cost DECIMAL(10,2)
) AS $$
DECLARE
    v_tier VARCHAR(20);
    v_hourly_rate DECIMAL(10,4);
    v_monthly_rate DECIMAL(10,2);
BEGIN
    -- Determine resource tier based on devices per agent
    v_tier := CASE 
        WHEN p_devices_per_agent <= 5 THEN 'small'
        WHEN p_devices_per_agent <= 15 THEN 'medium'
        WHEN p_devices_per_agent <= 30 THEN 'large'
        ELSE 'xlarge'
    END;
    
    -- Set pricing based on tier (adjust these values based on actual cloud costs + markup)
    v_hourly_rate := CASE v_tier
        WHEN 'small' THEN 0.007    -- $5.00/month
        WHEN 'medium' THEN 0.012   -- $8.50/month
        WHEN 'large' THEN 0.021    -- $15.00/month
        WHEN 'xlarge' THEN 0.035   -- $25.00/month
    END;
    
    v_monthly_rate := v_hourly_rate * 730;  -- 730 hours/month average
    
    RETURN QUERY
    SELECT 
        v_tier,
        v_hourly_rate,
        v_monthly_rate,
        (v_monthly_rate * p_agent_count)::DECIMAL(10,2) as total_monthly_cost;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 2: Comments
-- ============================================================================

COMMENT ON VIEW fleet_summary IS 'Real-time fleet statistics with device counts and resource usage';
COMMENT ON VIEW fleet_billing_summary IS 'Billing overview for active fleets with cost projections and budget alerts';

COMMENT ON FUNCTION get_fleet_stats(VARCHAR) IS 'Get detailed statistics for a specific fleet including resource usage';
COMMENT ON FUNCTION get_customer_fleets(UUID) IS 'List all fleets for a customer with device counts and costs';
COMMENT ON FUNCTION calculate_fleet_cost(INTEGER, INTEGER, VARCHAR) IS 'Calculate estimated costs for a virtual fleet configuration';

-- ============================================================================
-- PHASE 2: Completion
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Migration 142 Phase 2 complete: Views and functions added';
    RAISE NOTICE '   Views: fleet_summary, fleet_billing_summary';
    RAISE NOTICE '   Functions: get_fleet_stats(), get_customer_fleets(), calculate_fleet_cost()';
    RAISE NOTICE '   Next: Phase 3 will add billing history and usage analytics';
END
$$;

COMMIT;
