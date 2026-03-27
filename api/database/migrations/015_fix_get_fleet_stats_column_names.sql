BEGIN;

CREATE OR REPLACE FUNCTION public.get_fleet_stats(p_fleet_identifier character varying)
RETURNS TABLE(
    fleet_uuid uuid,
    fleet_name character varying,
    fleet_type character varying,
    status character varying,
    total_devices bigint,
    online_devices bigint,
    offline_devices bigint,
    virtual_devices bigint,
    physical_devices bigint,
    total_endpoints bigint,
    avg_cpu_usage numeric,
    avg_memory_usage_percent numeric,
    total_memory_gb numeric,
    billing_enabled boolean,
    current_cost numeric,
    budget_remaining numeric
)
LANGUAGE plpgsql
AS $$
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
        COUNT(d.uuid) FILTER (WHERE d.type = 'virtual') as virtual_devices,
        COUNT(d.uuid) FILTER (WHERE d.type != 'virtual' OR d.type IS NULL) as physical_devices,
        COALESCE((
            SELECT COUNT(*) 
            FROM endpoints ds 
            WHERE ds.agent_uuid IN (SELECT d2.uuid FROM agents d2 WHERE d2.fleet_id = f.fleet_id)
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
    LEFT JOIN agents d ON d.fleet_id = f.fleet_id
    WHERE f.fleet_id = p_fleet_identifier OR f.fleet_uuid::text = p_fleet_identifier
    GROUP BY f.fleet_uuid, f.fleet_name, f.fleet_type, f.status, f.billing_enabled, 
             f.current_cost, f.budget_limit, f.fleet_id;
END;
$$;

COMMIT;
