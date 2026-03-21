-- Migration 010: Fix deployment stored functions to use agent_uuid column
--
-- The agent_target_state and agent_target_state_history tables were renamed
-- from device_target_state* and the device_uuid column was renamed to agent_uuid,
-- but the stored functions still referenced the old column name. This migration
-- recreates all affected functions with the correct agent_uuid column references.

CREATE OR REPLACE FUNCTION public.create_deployment_history_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only create snapshot when version increments (deployment happens)
    IF (TG_OP = 'UPDATE' AND NEW.version > OLD.version) OR 
       (TG_OP = 'INSERT' AND NEW.version > 1) THEN
        
        -- Insert snapshot into history
        INSERT INTO agent_target_state_history (
            agent_uuid,
            version,
            apps,
            config,
            deployed_at,
            deployed_by,
            apps_count,
            services_count
        ) VALUES (
            NEW.agent_uuid,
            NEW.version,
            NEW.apps,
            NEW.config,
            COALESCE(NEW.last_deployed_at, NOW()),
            COALESCE(NEW.deployed_by, 'system'),
            -- Count apps
            (SELECT COUNT(*) FROM jsonb_object_keys(NEW.apps)),
            -- Count total services across all apps
            (SELECT SUM(jsonb_array_length(app.value->'services'))::INTEGER
             FROM jsonb_each(NEW.apps) app
             WHERE jsonb_typeof(app.value->'services') = 'array')
        );
    END IF;
    
    RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.compare_deployment_versions(p_device_uuid uuid, p_from_version integer, p_to_version integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_from_apps JSONB;
    v_to_apps JSONB;
    v_result JSONB;
BEGIN
    -- Get apps from both versions
    SELECT apps INTO v_from_apps
    FROM agent_target_state_history
    WHERE agent_uuid = p_device_uuid AND version = p_from_version;
    
    SELECT apps INTO v_to_apps
    FROM agent_target_state_history
    WHERE agent_uuid = p_device_uuid AND version = p_to_version;
    
    -- Build comparison result
    v_result := jsonb_build_object(
        'from_version', p_from_version,
        'to_version', p_to_version,
        'from_apps', v_from_apps,
        'to_apps', v_to_apps,
        'apps_added', (
            SELECT jsonb_agg(key)
            FROM jsonb_object_keys(v_to_apps) key
            WHERE NOT v_from_apps ? key
        ),
        'apps_removed', (
            SELECT jsonb_agg(key)
            FROM jsonb_object_keys(v_from_apps) key
            WHERE NOT v_to_apps ? key
        ),
        'apps_modified', (
            SELECT jsonb_agg(key)
            FROM jsonb_object_keys(v_to_apps) key
            WHERE v_from_apps ? key 
              AND v_from_apps->key != v_to_apps->key
        )
    );
    
    RETURN v_result;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_deployment_history(p_device_uuid uuid, p_limit integer DEFAULT 20) RETURNS TABLE(version integer, deployed_at timestamp without time zone, deployed_by character varying, apps_count integer, services_count integer, is_rollback boolean, changes_summary text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        h.version,
        h.deployed_at,
        h.deployed_by,
        h.apps_count,
        h.services_count,
        h.is_rollback,
        h.changes_summary
    FROM agent_target_state_history h
    WHERE h.agent_uuid = p_device_uuid
    ORDER BY h.version DESC
    LIMIT p_limit;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_deployment_stats(p_device_uuid uuid DEFAULT NULL::uuid, p_days_back integer DEFAULT 30) RETURNS TABLE(total_deployments bigint, rollback_count bigint, unique_deployers bigint, avg_time_between_deployments interval, most_active_deployer character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH stats AS (
        SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE is_rollback = true) as rollbacks,
            COUNT(DISTINCT deployed_by) as deployers,
            MAX(deployed_by) as top_deployer
        FROM agent_target_state_history h
        WHERE (p_device_uuid IS NULL OR h.agent_uuid = p_device_uuid)
          AND h.deployed_at > NOW() - (p_days_back || ' days')::INTERVAL
    ),
    timing AS (
        SELECT AVG(deployed_at - LAG(deployed_at) OVER (PARTITION BY agent_uuid ORDER BY version)) as avg_interval
        FROM agent_target_state_history h
        WHERE (p_device_uuid IS NULL OR h.agent_uuid = p_device_uuid)
          AND h.deployed_at > NOW() - (p_days_back || ' days')::INTERVAL
    )
    SELECT 
        s.total,
        s.rollbacks,
        s.deployers,
        t.avg_interval,
        s.top_deployer
    FROM stats s, timing t;
END;
$$;


CREATE OR REPLACE FUNCTION public.get_deployment_version(p_device_uuid uuid, p_version integer) RETURNS TABLE(apps jsonb, config jsonb, deployed_at timestamp without time zone, deployed_by character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        h.apps,
        h.config,
        h.deployed_at,
        h.deployed_by
    FROM agent_target_state_history h
    WHERE h.agent_uuid = p_device_uuid
      AND h.version = p_version;
END;
$$;
