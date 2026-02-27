-- Migration: 149_add_fleet_uuid.sql
-- Purpose: Add fleet_uuid to fleets and update fleet views/functions
-- Date: 2026-02-16

BEGIN;

-- Add UUID column for fleet routing identifiers
ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS fleet_uuid UUID;

UPDATE fleets
SET fleet_uuid = gen_random_uuid()
WHERE fleet_uuid IS NULL;

ALTER TABLE fleets
  ALTER COLUMN fleet_uuid SET DEFAULT gen_random_uuid();

ALTER TABLE fleets
  ALTER COLUMN fleet_uuid SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fleets_fleet_uuid ON fleets(fleet_uuid);

-- Drop existing views and functions to avoid column/return type change issues
DROP VIEW IF EXISTS fleet_summary CASCADE;
DROP VIEW IF EXISTS fleet_billing_summary CASCADE;
DROP FUNCTION IF EXISTS get_fleet_stats(VARCHAR);
DROP FUNCTION IF EXISTS get_customer_fleets(UUID);

-- Create views with fleet_uuid included
CREATE VIEW fleet_summary AS
SELECT 
    f.id,
    f.fleet_uuid,
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
GROUP BY f.id, f.fleet_uuid, f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, 
         f.status, f.billing_enabled, f.current_cost, f.budget_limit,
         f.environment, f.location, f.created_at, f.updated_at;

CREATE VIEW fleet_billing_summary AS
SELECT 
    f.fleet_uuid,
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
            ROUND((f.cost_per_hour * 730)::numeric, 2)
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
GROUP BY f.fleet_uuid, f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, f.billing_mode,
         f.cost_per_hour, f.cost_per_month, f.total_running_hours, f.current_cost,
         f.budget_limit, f.budget_alert_threshold, f.last_metered_at, f.started_at,
         f.status;

-- Create helper functions to accept fleet_id or fleet_uuid
CREATE FUNCTION get_fleet_stats(p_fleet_identifier VARCHAR(100))
RETURNS TABLE (
    fleet_uuid UUID,
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
        f.fleet_uuid,
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
        ROUND((COALESCE(SUM(d.memory_total), 0) / 1073741824.0)::numeric, 2) as total_memory_gb,
        f.billing_enabled,
        COALESCE(f.current_cost, 0) as current_cost,
        CASE 
            WHEN f.budget_limit IS NOT NULL THEN f.budget_limit - COALESCE(f.current_cost, 0)
            ELSE NULL
        END as budget_remaining
    FROM fleets f
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.fleet_id = p_fleet_identifier OR f.fleet_uuid::text = p_fleet_identifier
    GROUP BY f.fleet_uuid, f.fleet_name, f.fleet_type, f.status, f.billing_enabled, 
             f.current_cost, f.budget_limit, f.fleet_id;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION get_customer_fleets(p_customer_id UUID)
RETURNS TABLE (
    fleet_uuid UUID,
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
        f.fleet_uuid,
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
    GROUP BY f.fleet_uuid, f.fleet_id, f.fleet_name, f.fleet_type, f.status, 
             f.environment, f.billing_enabled, f.current_cost, f.created_at
    ORDER BY f.created_at DESC;
END;
$$ LANGUAGE plpgsql;

COMMIT;
