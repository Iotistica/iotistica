

SET check_function_bodies = off;

--
-- Name: anomaly_events_integer_now(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.anomaly_events_integer_now() RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000;
$$;


--
-- Name: archive_agent_api_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.archive_agent_api_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only archive if:
    -- 1. Key actually changed
    -- 2. Old key is NOT NULL (avoid constraint violation on first provisioning)
    IF OLD.device_api_key_hash IS DISTINCT FROM NEW.device_api_key_hash 
       AND OLD.device_api_key_hash IS NOT NULL THEN
        INSERT INTO agent_api_key_history (
            device_uuid,
            key_hash,
            issued_at,
            expires_at,
            is_active
        ) VALUES (
            OLD.uuid,
            OLD.device_api_key_hash,
            OLD.api_key_last_rotated_at,
            OLD.api_key_expires_at,
            false  -- Old key is no longer active
        );
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: calculate_fleet_cost(integer, integer, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_fleet_cost(p_agent_count integer, p_devices_per_agent integer, p_billing_mode character varying DEFAULT 'hourly'::character varying) RETURNS TABLE(resource_tier character varying, cost_per_hour numeric, cost_per_month numeric, total_monthly_cost numeric)
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_tier VARCHAR(20);
    v_hourly_rate DECIMAL(10,4);
    v_monthly_rate DECIMAL(10,2);
BEGIN
    -- Determine resource tier based on agents per agent
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
$_$;


--
-- Name: cleanup_old_housekeeper_runs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_housekeeper_runs(retention_days integer DEFAULT 30) RETURNS TABLE(deleted_count bigint)
    LANGUAGE plpgsql
    AS $$
DECLARE
  rows_deleted BIGINT;
BEGIN
  DELETE FROM housekeeper_runs
  WHERE started_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  
  RETURN QUERY SELECT rows_deleted;
END;
$$;


--
-- Name: cleanup_old_traffic_stats(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_traffic_stats(retention_days integer DEFAULT 90) RETURNS integer
    LANGUAGE plpgsql
    AS $$
    DECLARE
      deleted_count INTEGER;
    BEGIN
      DELETE FROM agent_traffic_stats
      WHERE time_bucket < NOW() - (retention_days || ' days')::INTERVAL;
      
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      
      RETURN deleted_count;
    END;
    $$;


--
-- Name: close_fleet_billing_period(character varying, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_fleet_billing_period(p_fleet_id character varying, p_period_end timestamp without time zone DEFAULT CURRENT_TIMESTAMP) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
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
    LEFT JOIN agents d ON d.fleet_id = f.fleet_id
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
$$;


--
-- Name: compare_deployment_versions(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compare_deployment_versions(p_device_uuid uuid, p_from_version integer, p_to_version integer) RETURNS jsonb
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


--
-- Name: find_devices_by_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_devices_by_tags(p_tag_selectors jsonb) RETURNS TABLE(device_uuid uuid)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    tag_key TEXT;
    tag_value TEXT;
    conditions TEXT[] := ARRAY[]::TEXT[];
    query TEXT;
BEGIN
    -- Build EXISTS clauses for each required tag
    FOR tag_key, tag_value IN SELECT * FROM jsonb_each_text(p_tag_selectors)
    LOOP
        conditions := conditions || format(
            'EXISTS (SELECT 1 FROM agent_tags WHERE device_uuid = d.uuid AND key = %L AND value = %L)',
            tag_key, tag_value
        );
    END LOOP;
    
    -- If no selectors provided, return all agents
    IF array_length(conditions, 1) IS NULL THEN
        RETURN QUERY SELECT d.uuid FROM agents d;
        RETURN;
    END IF;
    
    -- Build and execute dynamic query
    query := format('SELECT d.uuid FROM agents d WHERE %s', array_to_string(conditions, ' AND '));
    RETURN QUERY EXECUTE query;
END;
$$;


--
-- Name: count_devices_by_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_devices_by_tags(p_tag_selectors jsonb) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    SELECT COUNT(*)::INTEGER FROM find_devices_by_tags(p_tag_selectors);
$$;


--
-- Name: create_agent_logs_partition(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_agent_logs_partition(partition_date date) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    -- Use first day of month for partition boundaries
    start_date := DATE_TRUNC('month', partition_date)::DATE;
    end_date := (DATE_TRUNC('month', partition_date) + INTERVAL '1 month')::DATE;
    partition_name := 'device_logs_' || TO_CHAR(start_date, 'YYYY_MM');
    
    -- Check if partition already exists
    IF EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public'
        AND tablename = partition_name
    ) THEN
        RETURN 'EXISTS: ' || partition_name;
    END IF;
    
    -- Create the partition
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF agent_logs 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$;


--
-- Name: create_agent_logs_partitions_range(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_agent_logs_partitions_range(start_months_ago integer, end_months_ahead integer) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_month DATE;
    i INTEGER;
BEGIN
    FOR i IN start_months_ago..end_months_ahead LOOP
        current_month := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL)::DATE;
        RETURN QUERY SELECT create_agent_logs_partition(current_month);
    END LOOP;
END;
$$;


--
-- Name: create_agent_metrics_partition(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_agent_metrics_partition(partition_date date) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    partition_name := 'device_metrics_' || TO_CHAR(partition_date, 'YYYY_MM_DD');
    start_date := partition_date;
    end_date := partition_date + INTERVAL '1 day';
    
    -- Check if partition already exists
    IF EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public'
        AND tablename = partition_name
    ) THEN
        RETURN 'EXISTS: ' || partition_name;
    END IF;
    
    -- Create the partition
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF agent_metrics 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$;


--
-- Name: create_agent_metrics_partitions_range(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_agent_metrics_partitions_range(start_days_ago integer, end_days_ahead integer) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_day DATE;
    i INTEGER;
BEGIN
    FOR i IN start_days_ago..end_days_ahead LOOP
        current_day := CURRENT_DATE + (i || ' days')::INTERVAL;
        RETURN QUERY SELECT create_agent_metrics_partition(current_day);
    END LOOP;
END;
$$;


--
-- Name: create_current_state_history_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_current_state_history_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' OR (
        NEW.apps IS DISTINCT FROM OLD.apps OR
        NEW.config IS DISTINCT FROM OLD.config OR
        NEW.version IS DISTINCT FROM OLD.version
    ) THEN
        INSERT INTO public.agent_current_state_history (
            agent_uuid,
            version,
            apps,
            config,
            system_info,
            reported_at,
            metadata
        ) VALUES (
            NEW.agent_uuid,
            COALESCE(NEW.version, 0),
            COALESCE(NEW.apps, '{}'::jsonb),
            COALESCE(NEW.config, '{}'::jsonb),
            COALESCE(NEW.system_info, '{}'::jsonb),
            COALESCE(NEW.reported_at, now()),
            jsonb_build_object(
                'trigger_op', TG_OP,
                'captured_from', 'agent_current_state'
            )
        );
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: create_deployment_history_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_deployment_history_snapshot() RETURNS trigger
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



--
-- Name: create_state_snapshot(uuid, character varying, jsonb, character varying, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_state_snapshot(p_device_uuid uuid, p_state_type character varying, p_state jsonb, p_source character varying DEFAULT 'system'::character varying, p_notes text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_version INTEGER;
    v_checksum VARCHAR(64);
    v_snapshot_id INTEGER;
BEGIN
    -- Get next version number
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_version
    FROM state_snapshots
    WHERE device_uuid = p_device_uuid AND state_type = p_state_type;
    
    -- Calculate checksum (SHA256)
    v_checksum := encode(sha256(p_state::text::bytea), 'hex');
    
    -- Check if state actually changed (compare with last snapshot)
    IF EXISTS (
        SELECT 1 FROM state_snapshots
        WHERE device_uuid = p_device_uuid 
        AND state_type = p_state_type
        AND checksum = v_checksum
        ORDER BY version DESC
        LIMIT 1
    ) THEN
        -- State hasn't changed, return existing snapshot
        SELECT id INTO v_snapshot_id
        FROM state_snapshots
        WHERE device_uuid = p_device_uuid 
        AND state_type = p_state_type
        ORDER BY version DESC
        LIMIT 1;
        
        RETURN v_snapshot_id;
    END IF;
    
    -- Insert new snapshot
    INSERT INTO state_snapshots (
        device_uuid, state_type, state, version, checksum, source, notes
    ) VALUES (
        p_device_uuid, p_state_type, p_state, v_version, v_checksum, p_source, p_notes
    ) RETURNING id INTO v_snapshot_id;
    
    RETURN v_snapshot_id;
END;
$$;


--
-- Name: drop_old_device_logs_partitions(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.drop_old_device_logs_partitions(retention_days integer DEFAULT 30) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $_$
DECLARE
    partition_record RECORD;
    cutoff_date DATE;
    partition_date DATE;
    partition_date_str TEXT;
BEGIN
    cutoff_date := CURRENT_DATE - retention_days;
    
    FOR partition_record IN
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'device_logs_%'
        AND tablename ~ '^device_logs_[0-9]{4}_[0-9]{2}$'
    LOOP
        BEGIN
            -- Extract date from partition name (device_logs_YYYY_MM)
            partition_date_str := SUBSTRING(partition_record.tablename FROM 'device_logs_(.*)');
            partition_date := TO_DATE(partition_date_str || '_01', 'YYYY_MM_DD');
            
            IF partition_date < DATE_TRUNC('month', cutoff_date)::DATE THEN
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_record.tablename);
                RETURN QUERY SELECT 'DROPPED: ' || partition_record.tablename;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT 'ERROR: ' || partition_record.tablename || ' - ' || SQLERRM;
        END;
    END LOOP;
    
    -- Return message if no partitions dropped
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'No old partitions to drop (retention: ' || retention_days || ' days)';
    END IF;
END;
$_$;


--
-- Name: drop_old_device_metrics_partitions(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.drop_old_device_metrics_partitions(retention_days integer DEFAULT 30) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $_$
DECLARE
    partition_record RECORD;
    cutoff_date DATE;
    partition_date DATE;
    partition_date_str TEXT;
BEGIN
    cutoff_date := CURRENT_DATE - retention_days;
    
    FOR partition_record IN
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'device_metrics_%'
        AND tablename ~ '^device_metrics_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    LOOP
        BEGIN
            -- Extract date from partition name (device_metrics_YYYY_MM_DD)
            partition_date_str := SUBSTRING(partition_record.tablename FROM 'device_metrics_(.*)');
            partition_date := TO_DATE(partition_date_str, 'YYYY_MM_DD');
            
            IF partition_date < cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', partition_record.tablename);
                RETURN QUERY SELECT 'DROPPED: ' || partition_record.tablename;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT 'ERROR: ' || partition_record.tablename || ' - ' || SQLERRM;
        END;
    END LOOP;
    
    -- Return count if no partitions dropped
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'No old partitions to drop (retention: ' || retention_days || ' days)';
    END IF;
END;
$_$;


--
-- Name: ensure_one_default_broker(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_one_default_broker() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.is_default = true THEN
        -- Unset is_default on all other brokers
        UPDATE mqtt_broker_config 
        SET is_default = false 
        WHERE id != NEW.id AND is_default = true;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: get_aggregate_events(character varying, character varying, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_aggregate_events(p_aggregate_type character varying, p_aggregate_id character varying, p_since bigint DEFAULT NULL::bigint) RETURNS TABLE(id bigint, event_id uuid, event_type character varying, event_timestamp timestamp without time zone, data jsonb, metadata jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id, e.event_id, e.event_type, e.timestamp, e.data, e.metadata
    FROM events e
    WHERE e.aggregate_type = p_aggregate_type
    AND e.aggregate_id = p_aggregate_id
    AND (p_since IS NULL OR e.id > p_since)
    ORDER BY e.timestamp ASC;
END;
$$;


--
-- Name: get_customer_fleets(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_customer_fleets(p_customer_id uuid) RETURNS TABLE(fleet_uuid uuid, fleet_id character varying, fleet_name character varying, fleet_type character varying, status character varying, environment character varying, device_count bigint, online_count bigint, billing_enabled boolean, current_cost numeric, created_at timestamp without time zone)
    LANGUAGE plpgsql
    AS $$
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
    LEFT JOIN agents d ON d.fleet_id = f.fleet_id
    WHERE f.customer_id = p_customer_id
      AND f.status != 'deleted'
    GROUP BY f.fleet_uuid, f.fleet_id, f.fleet_name, f.fleet_type, f.status, 
             f.environment, f.billing_enabled, f.current_cost, f.created_at
    ORDER BY f.created_at DESC;
END;
$$;


--
-- Name: get_deployment_history(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_deployment_history(p_device_uuid uuid, p_limit integer DEFAULT 20) RETURNS TABLE(version integer, deployed_at timestamp without time zone, deployed_by character varying, apps_count integer, services_count integer, is_rollback boolean, changes_summary text)
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


--
-- Name: get_deployment_stats(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_deployment_stats(p_device_uuid uuid DEFAULT NULL::uuid, p_days_back integer DEFAULT 30) RETURNS TABLE(total_deployments bigint, rollback_count bigint, unique_deployers bigint, avg_time_between_deployments interval, most_active_deployer character varying)
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


--
-- Name: get_deployment_version(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_deployment_version(p_device_uuid uuid, p_version integer) RETURNS TABLE(apps jsonb, config jsonb, deployed_at timestamp without time zone, deployed_by character varying)
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


--
-- Name: get_device_latest_update(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_device_latest_update(p_device_uuid uuid) RETURNS TABLE(id bigint, target_version character varying, status character varying, started_at timestamp without time zone, completed_at timestamp without time zone, error_message text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        au.id,
        au.target_version::VARCHAR,
        au.status::VARCHAR,
        au.started_at,
        au.completed_at,
        au.error_message
    FROM agent_updates au
    WHERE au.device_uuid = p_device_uuid
    ORDER BY au.created_at DESC
    LIMIT 1;
END;
$$;


--
-- Name: get_device_logs_partition_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_device_logs_partition_stats() RETURNS TABLE(partition_name text, partition_month date, row_count bigint, size text, age_days integer)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY
    SELECT 
        pt.tablename::TEXT as partition_name,
        TO_DATE(SUBSTRING(pt.tablename FROM 'device_logs_(.*)') || '_01', 'YYYY_MM_DD') as partition_month,
        COALESCE((
            SELECT n_live_tup 
            FROM pg_stat_user_tables 
            WHERE schemaname = 'public' 
            AND relname = pt.tablename
        ), 0) as row_count,
        pg_size_pretty(pg_total_relation_size('public.' || pt.tablename)) as size,
        (CURRENT_DATE - TO_DATE(SUBSTRING(pt.tablename FROM 'device_logs_(.*)') || '_01', 'YYYY_MM_DD'))::INTEGER as age_days
    FROM pg_tables pt
    WHERE pt.schemaname = 'public'
    AND pt.tablename LIKE 'device_logs_%'
    AND pt.tablename ~ '^device_logs_[0-9]{4}_[0-9]{2}$'
    ORDER BY partition_month DESC;
END;
$_$;


--
-- Name: get_device_metrics_partition_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_device_metrics_partition_stats() RETURNS TABLE(partition_name text, partition_date date, row_count bigint, size text, age_days integer)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY
    SELECT 
        pt.tablename::TEXT as partition_name,
        TO_DATE(SUBSTRING(pt.tablename FROM 'device_metrics_(.*)'), 'YYYY_MM_DD') as partition_date,
        COALESCE((
            SELECT n_live_tup 
            FROM pg_stat_user_tables 
            WHERE schemaname = 'public' 
            AND relname = pt.tablename
        ), 0) as row_count,
        pg_size_pretty(pg_total_relation_size('public.' || pt.tablename)) as size,
        (CURRENT_DATE - TO_DATE(SUBSTRING(pt.tablename FROM 'device_metrics_(.*)'), 'YYYY_MM_DD'))::INTEGER as age_days
    FROM pg_tables pt
    WHERE pt.schemaname = 'public'
    AND pt.tablename LIKE 'device_metrics_%'
    AND pt.tablename ~ '^device_metrics_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    ORDER BY partition_date DESC;
END;
$_$;


--
-- Name: get_device_tags_json(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_device_tags_json(p_device_uuid uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        jsonb_object_agg(key, value),
        '{}'::jsonb
    )
    FROM agent_tags
    WHERE device_uuid = p_device_uuid;
$$;


--
-- Name: get_event_chain(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_event_chain(p_correlation_id uuid) RETURNS TABLE(id bigint, event_id uuid, event_type character varying, aggregate_type character varying, aggregate_id character varying, event_timestamp timestamp without time zone, data jsonb, causation_id uuid)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id, e.event_id, e.event_type, 
        e.aggregate_type, e.aggregate_id,
        e.timestamp, e.data, e.causation_id
    FROM events e
    WHERE e.correlation_id = p_correlation_id
    ORDER BY e.timestamp ASC;
END;
$$;


--
-- Name: get_event_retention_days(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_event_retention_days(p_event_type character varying) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_retention_days INTEGER;
BEGIN
  SELECT retention_days INTO v_retention_days
  FROM event_types
  WHERE event_type = p_event_type;
  
  RETURN COALESCE(v_retention_days, 90); -- Default to 90 days if not found
END;
$$;


--
-- Name: get_event_stats(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_event_stats(p_days_back integer DEFAULT 7) RETURNS TABLE(event_type character varying, aggregate_type character varying, event_count bigint, first_seen timestamp without time zone, last_seen timestamp without time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.event_type::VARCHAR,
        e.aggregate_type::VARCHAR,
        COUNT(*)::BIGINT as count,
        MIN(e.timestamp) as first_seen,
        MAX(e.timestamp) as last_seen
    FROM events e
    WHERE e.timestamp > NOW() - (p_days_back || ' days')::INTERVAL
    GROUP BY e.event_type, e.aggregate_type
    ORDER BY count DESC;
END;
$$;


--
-- Name: get_fleet_stats(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_fleet_stats(p_fleet_identifier character varying) RETURNS TABLE(fleet_uuid uuid, fleet_name character varying, fleet_type character varying, status character varying, total_devices bigint, online_devices bigint, offline_devices bigint, virtual_devices bigint, physical_devices bigint, total_endpoints bigint, avg_cpu_usage numeric, avg_memory_usage_percent numeric, total_memory_gb numeric, billing_enabled boolean, current_cost numeric, budget_remaining numeric)
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
        COUNT(d.uuid) FILTER (WHERE d.device_type = 'virtual') as virtual_devices,
        COUNT(d.uuid) FILTER (WHERE d.device_type != 'virtual' OR d.device_type IS NULL) as physical_devices,
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


--
-- Name: get_housekeeper_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_housekeeper_stats() RETURNS TABLE(task_name character varying, total_runs bigint, success_count bigint, error_count bigint, avg_duration_ms numeric, last_run_at timestamp without time zone, last_status character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    hr.task_name,
    COUNT(*) AS total_runs,
    COUNT(*) FILTER (WHERE hr.status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE hr.status = 'error') AS error_count,
    ROUND(AVG(hr.duration_ms)::NUMERIC, 2) AS avg_duration_ms,
    MAX(hr.started_at) AS last_run_at,
    (
      SELECT hr2.status 
      FROM housekeeper_runs hr2 
      WHERE hr2.task_name = hr.task_name 
      ORDER BY hr2.started_at DESC 
      LIMIT 1
    ) AS last_status
  FROM housekeeper_runs hr
  WHERE hr.started_at > NOW() - INTERVAL '30 days'
  GROUP BY hr.task_name
  ORDER BY hr.task_name;
END;
$$;


--
-- Name: get_pending_updates(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pending_updates(p_timeout_minutes integer DEFAULT 30) RETURNS TABLE(device_uuid uuid, target_version character varying, status character varying, created_at timestamp without time zone, minutes_elapsed integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        au.device_uuid,
        au.target_version::VARCHAR,
        au.status::VARCHAR,
        au.created_at,
        EXTRACT(EPOCH FROM (NOW() - au.created_at))::INTEGER / 60 as minutes_elapsed
    FROM agent_updates au
    WHERE au.status IN ('pending', 'acknowledged', 'in_progress')
    AND au.created_at < NOW() - (p_timeout_minutes || ' minutes')::INTERVAL
    ORDER BY au.created_at ASC;
END;
$$;


--
-- Name: get_reconciliation_summary(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_reconciliation_summary(p_device_uuid uuid, p_days_back integer DEFAULT 7) RETURNS TABLE(date date, total_reconciliations integer, successful integer, failed integer, avg_duration_ms numeric)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        started_at::DATE as date,
        COUNT(*)::INTEGER as total_reconciliations,
        COUNT(*) FILTER (WHERE status = 'success')::INTEGER as successful,
        COUNT(*) FILTER (WHERE status = 'failed')::INTEGER as failed,
        AVG(duration_ms)::NUMERIC as avg_duration_ms
    FROM reconciliation_history
    WHERE device_uuid = p_device_uuid
    AND started_at > NOW() - (p_days_back || ' days')::INTERVAL
    GROUP BY started_at::DATE
    ORDER BY date DESC;
END;
$$;


--
-- Name: get_state_diff(uuid, character varying, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_state_diff(p_device_uuid uuid, p_state_type character varying, p_from_version integer, p_to_version integer DEFAULT NULL::integer) RETURNS TABLE(change_type character varying, entity_type character varying, entity_id character varying, field_path text, old_value jsonb, new_value jsonb, change_timestamp timestamp without time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF p_to_version IS NULL THEN
        -- Get latest version
        SELECT MAX(version) INTO p_to_version
        FROM state_snapshots
        WHERE device_uuid = p_device_uuid AND state_type = p_state_type;
    END IF;
    
    RETURN QUERY
    SELECT 
        sc.change_type::VARCHAR,
        sc.entity_type::VARCHAR,
        sc.entity_id::VARCHAR,
        sc.field_path,
        sc.old_value,
        sc.new_value,
        sc.timestamp AS change_timestamp
    FROM state_changes sc
    WHERE sc.device_uuid = p_device_uuid
    AND sc.state_type = p_state_type
    AND sc.parent_snapshot_id IN (
        SELECT id FROM state_snapshots
        WHERE device_uuid = p_device_uuid
        AND state_type = p_state_type
        AND version > p_from_version
        AND version <= p_to_version
    )
    ORDER BY sc.timestamp ASC;
END;
$$;


--
-- Name: get_topic_id(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_topic_id(topic_name character varying) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  result_id UUID;
BEGIN
  SELECT topic_id INTO result_id FROM mqtt_topics WHERE topic = topic_name;
  RETURN result_id;
END;
$$;


--
-- Name: get_topic_name(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_topic_name(tid uuid) RETURNS character varying
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  result_name VARCHAR;
BEGIN
  SELECT topic INTO result_name FROM mqtt_topics WHERE topic_id = tid;
  RETURN result_name;
END;
$$;


--
-- Name: log_state_change(uuid, character varying, character varying, character varying, character varying, text, jsonb, jsonb, character varying, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_state_change(p_device_uuid uuid, p_state_type character varying, p_change_type character varying, p_entity_type character varying, p_entity_id character varying, p_field_path text, p_old_value jsonb, p_new_value jsonb, p_triggered_by character varying, p_correlation_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT NULL::jsonb) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_change_id INTEGER;
    v_snapshot_id INTEGER;
BEGIN
    -- Get current snapshot ID
    SELECT id INTO v_snapshot_id
    FROM state_snapshots
    WHERE device_uuid = p_device_uuid AND state_type = p_state_type
    ORDER BY version DESC
    LIMIT 1;
    
    -- Insert change record
    INSERT INTO state_changes (
        device_uuid, state_type, change_type,
        entity_type, entity_id, field_path,
        old_value, new_value,
        triggered_by, correlation_id, parent_snapshot_id, metadata
    ) VALUES (
        p_device_uuid, p_state_type, p_change_type,
        p_entity_type, p_entity_id, p_field_path,
        p_old_value, p_new_value,
        p_triggered_by, p_correlation_id, v_snapshot_id, p_metadata
    ) RETURNING id INTO v_change_id;
    
    RETURN v_change_id;
END;
$$;


--
-- Name: publish_event(character varying, character varying, character varying, jsonb, character varying, uuid, uuid, jsonb, character varying, character varying, character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_event(p_event_type character varying, p_aggregate_type character varying, p_aggregate_id character varying, p_data jsonb, p_source character varying DEFAULT 'system'::character varying, p_correlation_id uuid DEFAULT NULL::uuid, p_causation_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT NULL::jsonb, p_actor_type character varying DEFAULT NULL::character varying, p_actor_id character varying DEFAULT NULL::character varying, p_severity character varying DEFAULT NULL::character varying, p_impact character varying DEFAULT NULL::character varying) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_event_id UUID;
    v_checksum VARCHAR(64);
    v_correlation_id UUID;
BEGIN
    -- Generate correlation ID if not provided
    v_correlation_id := COALESCE(p_correlation_id, gen_random_uuid());
    
    -- Calculate checksum
    v_checksum := encode(sha256(p_data::text::bytea), 'hex');
    
    -- Insert event with metadata enrichment
    INSERT INTO events (
        event_type, aggregate_type, aggregate_id,
        data, metadata, source,
        correlation_id, causation_id, checksum,
        actor_type, actor_id, severity, impact
    ) VALUES (
        p_event_type, p_aggregate_type, p_aggregate_id,
        p_data, p_metadata, p_source,
        v_correlation_id, p_causation_id, v_checksum,
        p_actor_type, p_actor_id, p_severity, p_impact
    ) RETURNING event_id INTO v_event_id;
    
    -- Notify listeners (for real-time event processing)
    PERFORM pg_notify('events', json_build_object(
        'event_id', v_event_id,
        'event_type', p_event_type,
        'aggregate_type', p_aggregate_type,
        'aggregate_id', p_aggregate_id,
        'severity', p_severity
    )::text);
    
    RETURN v_event_id;
END;
$$;


--
-- Name: rebuild_device_state(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_device_state(p_device_uuid uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_state JSONB := '{}'::jsonb;
    v_event RECORD;
BEGIN
    -- Replay all events for this device in order
    FOR v_event IN
        SELECT event_type, data, timestamp
        FROM events
        WHERE aggregate_type = 'device'
        AND aggregate_id = p_device_uuid::text
        ORDER BY timestamp ASC
    LOOP
        -- Apply event to state (simplified - you'd have more complex logic)
        CASE v_event.event_type
            WHEN 'target_state.updated' THEN
                v_state := v_event.data;
            
            WHEN 'target_state.app_added' THEN
                v_state := jsonb_set(
                    v_state,
                    ARRAY['apps', v_event.data->>'app_name'],
                    v_event.data->'app_config'
                );
            
            WHEN 'target_state.app_removed' THEN
                v_state := v_state - (v_event.data->>'app_name');
            
            -- Add more event handlers here...
            
            ELSE
                -- Unknown event type, skip
                NULL;
        END CASE;
    END LOOP;
    
    RETURN v_state;
END;
$$;


--
-- Name: record_fleet_usage_event(character varying, character varying, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_fleet_usage_event(p_fleet_id character varying, p_event_type character varying, p_triggered_by character varying DEFAULT 'system'::character varying, p_details jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
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
            (SELECT COUNT(*) FROM endpoints ds WHERE ds.agent_uuid IN (SELECT d2.uuid FROM agents d2 WHERE d2.fleet_id = p_fleet_id)),
        f.current_cost,
        f.total_running_hours
    INTO v_device_count, v_devices_online, v_total_endpoints, v_current_cost, v_total_hours
    FROM fleets f
    LEFT JOIN agents d ON d.fleet_id = f.fleet_id
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
$$;


--
-- Name: refresh_all_catalog_views(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_all_catalog_views() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM refresh_metric_catalog();
  PERFORM refresh_endpoint_devices();
  PERFORM refresh_latest_readings();
END;
$$;


--
-- Name: refresh_all_dashboard_views(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_all_dashboard_views() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM refresh_latest_readings();
  PERFORM refresh_metric_catalog();
  PERFORM refresh_endpoint_devices();
  PERFORM refresh_recent_anomalies();
END;
$$;


--
-- Name: refresh_endpoint_devices(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_endpoint_devices() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
END;
$$;


--
-- Name: refresh_latest_readings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_latest_readings() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY latest_readings;
END;
$$;


--
-- Name: refresh_metric_catalog(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_metric_catalog() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY metric_catalog;
END;
$$;


--
-- Name: refresh_recent_anomalies(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_recent_anomalies() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY recent_anomalies;
END;
$$;


--
-- Name: update_dashboard_layouts_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_dashboard_layouts_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$;


--
-- Name: update_device_sensor_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_device_sensor_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_device_tags_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_device_tags_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_fleet_billing_history_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_fleet_billing_history_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_fleet_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_fleet_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_job_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_job_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_modified_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_modified_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.modified_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_mqtt_topics_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_mqtt_topics_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_nodered_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_nodered_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_profile_configs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_profile_configs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


--
-- Name: update_sensor_deployment_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_sensor_deployment_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.deployment_status = 'deployed' AND 
       (OLD.deployment_status IS NULL OR OLD.deployment_status != 'deployed') THEN
        NEW.last_deployed_at = NOW();
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: update_tag_definitions_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_tag_definitions_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


--
-- Name: update_traffic_stats_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_traffic_stats_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_metrics (
    id bigint NOT NULL,
    agent_uuid uuid NOT NULL,
    cpu_usage numeric,
    cpu_temp numeric,
    memory_usage bigint,
    memory_total bigint,
    storage_usage bigint,
    storage_total bigint,
    top_processes jsonb DEFAULT '[]'::jsonb,
    recorded_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_logs (
    id bigint NOT NULL,
    agent_uuid uuid NOT NULL,
    service_name character varying(255),
    message text NOT NULL,
    level character varying(50) DEFAULT 'info'::character varying,
    is_system boolean DEFAULT false,
    is_stderr boolean DEFAULT false,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    meta jsonb
);


--
-- Name: mqtt_broker_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_broker_stats (
    id integer NOT NULL,
    connected_clients integer DEFAULT 0,
    disconnected_clients integer DEFAULT 0,
    total_clients integer DEFAULT 0,
    subscriptions integer DEFAULT 0,
    retained_messages bigint DEFAULT 0,
    messages_sent bigint DEFAULT 0,
    messages_received bigint DEFAULT 0,
    messages_published bigint DEFAULT 0,
    messages_dropped bigint DEFAULT 0,
    bytes_sent bigint DEFAULT 0,
    bytes_received bigint DEFAULT 0,
    message_rate_published numeric(10,2) DEFAULT 0,
    message_rate_received numeric(10,2) DEFAULT 0,
    throughput_inbound bigint DEFAULT 0,
    throughput_outbound bigint DEFAULT 0,
    sys_data jsonb,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: mqtt_topic_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_topic_metrics (
    id bigint NOT NULL,
    topic character varying(512) NOT NULL,
    message_count bigint DEFAULT 0,
    bytes_received bigint DEFAULT 0,
    avg_message_size integer,
    qos_0_count bigint DEFAULT 0,
    qos_1_count bigint DEFAULT 0,
    qos_2_count bigint DEFAULT 0,
    retained_count bigint DEFAULT 0,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    message_rate numeric(10,2) DEFAULT 0,
    topic_id uuid
);


--
-- Name: readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.readings (
    "time" timestamp with time zone NOT NULL,
    agent_uuid uuid NOT NULL,
    metric_name text NOT NULL,
    value double precision,
    quality text DEFAULT 'good'::text,
    unit text,
    protocol text NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb,
    anomaly_score real,
    anomaly_threshold real,
    baseline_samples integer,
    detection_methods jsonb
);


--
-- Name: anomaly_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anomaly_events (
    id bigint NOT NULL,
    msg_id text NOT NULL,
    agent_uuid text NOT NULL,
    metric text NOT NULL,
    timestamp_ms bigint NOT NULL,
    window_start_ms bigint NOT NULL,
    window_end_ms bigint NOT NULL,
    observed_value double precision NOT NULL,
    anomaly_score double precision NOT NULL,
    confidence double precision NOT NULL,
    severity text NOT NULL,
    severity_reason text,
    fingerprint text NOT NULL,
    consecutive_count integer NOT NULL,
    event_count integer NOT NULL,
    triggered_by jsonb NOT NULL,
    baseline jsonb,
    expected_range jsonb,
    deviation double precision NOT NULL,
    cooldown_sec integer NOT NULL,
    first_seen bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    device_name text DEFAULT 'Unknown'::text NOT NULL,
    device_type text,
    device_uuid text,
    CONSTRAINT anomaly_events_device_type_check CHECK ((device_type = ANY (ARRAY['modbus'::text, 'opcua'::text, 'bacnet'::text, 'mqtt'::text, 'system'::text]))),
    CONSTRAINT anomaly_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);


--
-- Name: agent_api_key_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_api_key_history (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    key_hash character varying(255) NOT NULL,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    revoked_reason character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: agent_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_api_keys (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    key_hash character varying(255) NOT NULL,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL,
    revoked boolean DEFAULT false,
    revoked_at timestamp without time zone,
    revoked_reason character varying(255),
    last_used_at timestamp without time zone
);


--
-- Name: agent_current_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_current_state (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    apps jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    system_info jsonb DEFAULT '{}'::jsonb,
    reported_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    version integer DEFAULT 0
);


--
-- Name: agent_current_state_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_current_state_history (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    apps jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    system_info jsonb DEFAULT '{}'::jsonb,
    reported_at timestamp without time zone NOT NULL,
    captured_at timestamp without time zone DEFAULT now() NOT NULL,
    metadata jsonb
);


--
-- Name: agent_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_flows (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    subflow_id character varying(64) NOT NULL,
    subflow_name character varying(255),
    flows jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb,
    modules jsonb DEFAULT '[]'::jsonb,
    hash character varying(64) NOT NULL,
    version integer DEFAULT 1,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deployed_at timestamp with time zone
);


--
-- Name: agent_job_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_job_status (
    id integer NOT NULL,
    job_id character varying(255) NOT NULL,
    agent_uuid uuid NOT NULL,
    status character varying(50) DEFAULT 'QUEUED'::character varying,
    execution_number integer DEFAULT 1,
    version_number integer DEFAULT 1,
    queued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    last_updated_at timestamp without time zone,
    completed_at timestamp without time zone,
    exit_code integer,
    stdout text,
    stderr text,
    reason text,
    executed_steps integer,
    failed_step character varying(255),
    status_details jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: agent_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_metrics_id_seq OWNED BY public.agent_metrics.id;


--
-- Name: agent_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tags (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    key character varying(100) NOT NULL,
    value character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT device_tags_key_format CHECK ((((key)::text ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$'::text) AND (length((key)::text) >= 2) AND (length((key)::text) <= 100))),
    CONSTRAINT device_tags_value_not_empty CHECK (((length(TRIM(BOTH FROM value)) > 0) AND (length((value)::text) <= 255)))
);


--
-- Name: agent_target_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_target_state (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    apps jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    version integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    needs_deployment boolean DEFAULT false,
    last_deployed_at timestamp without time zone,
    deployed_by character varying(255)
);


--
-- Name: agent_target_state_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_target_state_history (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    version integer NOT NULL,
    apps jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    deployed_at timestamp without time zone DEFAULT now() NOT NULL,
    deployed_by character varying(255) NOT NULL,
    changes_summary text,
    apps_count integer,
    services_count integer,
    is_rollback boolean DEFAULT false,
    rollback_from_version integer,
    deployment_notes text,
    metadata jsonb
);


--
-- Name: agent_traffic_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_traffic_stats (
    id integer NOT NULL,
    device_id uuid NOT NULL,
    endpoint character varying(500) NOT NULL,
    method character varying(10) NOT NULL,
    time_bucket timestamp without time zone NOT NULL,
    request_count integer DEFAULT 0,
    total_bytes bigint DEFAULT 0,
    total_time double precision DEFAULT 0,
    success_count integer DEFAULT 0,
    failed_count integer DEFAULT 0,
    status_codes jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_updates (
    id bigint NOT NULL,
    agent_uuid uuid NOT NULL,
    target_version character varying(100) NOT NULL,
    current_version character varying(100),
    deployment_type character varying(50),
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    scheduled_time timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    timeout_at timestamp without time zone,
    force boolean DEFAULT false,
    retain_data boolean DEFAULT true,
    exit_code integer,
    error_message text,
    update_log text,
    triggered_by character varying(100),
    triggered_by_user_id integer,
    correlation_id uuid,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: agent_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_updates_id_seq OWNED BY public.agent_updates.id;


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    device_name character varying(255),
    device_type character varying(100),
    is_online boolean DEFAULT false,
    is_active boolean DEFAULT true,
    last_connectivity_event timestamp without time zone,
    last_vpn_event timestamp without time zone,
    ip_address inet,
    mac_address character varying(17),
    os_version character varying(100),
    agent_version character varying(100),
    api_heartbeat_state character varying(50) DEFAULT 'online'::character varying,
    memory_usage bigint,
    memory_total bigint,
    storage_usage bigint,
    storage_total bigint,
    cpu_usage numeric(5,2),
    cpu_temp numeric(5,2),
    cpu_id character varying(100),
    is_undervolted boolean DEFAULT false,
    provisioning_progress integer,
    provisioning_state character varying(50),
    status character varying(50) DEFAULT 'idle'::character varying,
    download_progress integer,
    logs_channel character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    fleet_id character varying(100),
    provisioned_at timestamp without time zone,
    provisioned_by_key_id uuid,
    device_api_key_hash character varying(255),
    api_key_expires_at timestamp without time zone,
    api_key_last_rotated_at timestamp without time zone,
    api_key_rotation_enabled boolean DEFAULT true,
    api_key_rotation_days integer DEFAULT 90,
    top_processes jsonb DEFAULT '[]'::jsonb,
    mqtt_username character varying(255),
    mqtt_client_id character varying(255),
    mqtt_broker_id integer,
    network_interfaces jsonb,
    vpn_enabled boolean DEFAULT false,
    vpn_username character varying(255),
    vpn_password_hash character varying(255),
    vpn_last_connected_at timestamp without time zone,
    vpn_ip_address inet,
    vpn_bytes_sent bigint DEFAULT 0,
    vpn_bytes_received bigint DEFAULT 0,
    vpn_config_id integer,
    device_public_key text,
    pop_verified boolean DEFAULT false,
    pop_verified_at timestamp without time zone,
    last_challenge text,
    last_challenge_expires_at timestamp without time zone,
    last_auth_method character varying(10),
    last_auth_at timestamp without time zone,
    deployment_status character varying(50),
    k8s_namespace character varying(255),
    k8s_pod_name character varying(255),
    helm_release_name character varying(255),
    location text,
    fleet_uuid uuid,
    CONSTRAINT devices_last_auth_method_check CHECK (((last_auth_method)::text = ANY (ARRAY[('pop'::character varying)::text, ('bcrypt'::character varying)::text])))
);


--
-- Name: anomaly_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anomaly_alerts (
    id bigint NOT NULL,
    alert_id text NOT NULL,
    incident_id text NOT NULL,
    severity text NOT NULL,
    metric text NOT NULL,
    affected_devices jsonb NOT NULL,
    max_anomaly_score double precision NOT NULL,
    message text NOT NULL,
    channels jsonb,
    created_at timestamp with time zone DEFAULT now(),
    device_name text DEFAULT 'Unknown'::text NOT NULL,
    device_uuid text,
    CONSTRAINT anomaly_alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);


--
-- Name: anomaly_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anomaly_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anomaly_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anomaly_alerts_id_seq OWNED BY public.anomaly_alerts.id;


--
-- Name: anomaly_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anomaly_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anomaly_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anomaly_events_id_seq OWNED BY public.anomaly_events.id;


--
-- Name: anomaly_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anomaly_incidents (
    id bigint NOT NULL,
    incident_id text NOT NULL,
    fingerprint text NOT NULL,
    metric text NOT NULL,
    severity text NOT NULL,
    affected_devices jsonb NOT NULL,
    first_seen bigint NOT NULL,
    last_seen bigint NOT NULL,
    max_anomaly_score double precision NOT NULL,
    max_confidence double precision NOT NULL,
    event_count integer NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    feedback character varying(20),
    feedback_reason text,
    feedback_by character varying(255),
    feedback_at timestamp with time zone,
    device_name text DEFAULT 'Unknown'::text NOT NULL,
    device_type text,
    affected_agents jsonb,
    acknowledged_at timestamp with time zone,
    acknowledged_by text,
    resolution_notes text,
    agent_uuid text,
    CONSTRAINT anomaly_incidents_feedback_check CHECK (((feedback)::text = ANY (ARRAY[('confirmed'::character varying)::text, ('false_positive'::character varying)::text, ('expected'::character varying)::text, ('ignored'::character varying)::text]))),
    CONSTRAINT anomaly_incidents_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT anomaly_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'active'::text, 'resolved'::text])))
);


--
-- Name: anomaly_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anomaly_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anomaly_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anomaly_incidents_id_seq OWNED BY public.anomaly_incidents.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    key character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_used_at timestamp without time zone
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: app_service_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_service_ids (
    id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    entity_name character varying(255) NOT NULL,
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT app_service_ids_entity_type_check CHECK (((entity_type)::text = ANY (ARRAY[('app'::character varying)::text, ('service'::character varying)::text])))
);


--
-- Name: app_service_ids_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_service_ids_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_service_ids_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_service_ids_id_seq OWNED BY public.app_service_ids.id;


--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id integer NOT NULL,
    app_name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    description text,
    is_host boolean DEFAULT false,
    should_track_latest_release boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    default_config jsonb DEFAULT '{}'::jsonb
);


--
-- Name: applications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.applications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: applications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.applications_id_seq OWNED BY public.applications.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    event_type character varying(100) NOT NULL,
    agent_uuid uuid,
    user_id character varying(255),
    ip_address inet,
    user_agent text,
    details jsonb,
    severity character varying(20) DEFAULT 'info'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: dashboard_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_layouts (
    id integer NOT NULL,
    user_id integer,
    device_uuid uuid,
    layout_name character varying(255) DEFAULT 'Default'::character varying,
    widgets jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    share_token uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_key character varying(255) NOT NULL
);


--
-- Name: dashboard_layouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dashboard_layouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dashboard_layouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dashboard_layouts_id_seq OWNED BY public.dashboard_layouts.id;


--
-- Name: device_api_key_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_api_key_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_api_key_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_api_key_history_id_seq OWNED BY public.agent_api_key_history.id;


--
-- Name: device_api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_api_keys_id_seq OWNED BY public.agent_api_keys.id;


--
-- Name: device_current_state_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_current_state_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_current_state_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_current_state_history_id_seq OWNED BY public.agent_current_state_history.id;


--
-- Name: device_current_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_current_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_current_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_current_state_id_seq OWNED BY public.agent_current_state.id;


--
-- Name: fleets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleets (
    id integer NOT NULL,
    fleet_id character varying(100),
    fleet_name character varying(255) NOT NULL,
    customer_id uuid NOT NULL,
    fleet_type character varying(20) DEFAULT 'physical'::character varying NOT NULL,
    description text,
    target_device_count integer,
    deployment_config jsonb DEFAULT '{}'::jsonb,
    billing_enabled boolean DEFAULT false,
    billing_mode character varying(20),
    cost_per_hour numeric(10,4),
    cost_per_month numeric(10,2),
    total_running_hours numeric(10,2) DEFAULT 0,
    current_cost numeric(10,2) DEFAULT 0,
    last_metered_at timestamp without time zone,
    budget_limit numeric(10,2),
    budget_alert_threshold numeric(5,2) DEFAULT 80,
    status character varying(50) DEFAULT 'active'::character varying,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    stopped_at timestamp without time zone,
    tags jsonb DEFAULT '{}'::jsonb,
    environment character varying(50),
    location character varying(255),
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    k8s_namespace character varying(63),
    agent_count integer DEFAULT 1 NOT NULL,
    devices_per_agent integer DEFAULT 3 NOT NULL,
    fleet_uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT valid_agent_count CHECK (((agent_count >= 1) AND (agent_count <= 100))),
    CONSTRAINT valid_billing_mode CHECK (((billing_mode IS NULL) OR ((billing_mode)::text = ANY (ARRAY[('hourly'::character varying)::text, ('monthly'::character varying)::text])))),
    CONSTRAINT valid_budget_threshold CHECK (((budget_alert_threshold >= (0)::numeric) AND (budget_alert_threshold <= (100)::numeric))),
    CONSTRAINT valid_devices_per_agent CHECK (((devices_per_agent >= 1) AND (devices_per_agent <= 50))),
    CONSTRAINT valid_fleet_type CHECK (((fleet_type)::text = ANY (ARRAY[('virtual'::character varying)::text, ('physical'::character varying)::text, ('mixed'::character varying)::text]))),
    CONSTRAINT valid_status CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('stopped'::character varying)::text, ('deleted'::character varying)::text, ('provisioning'::character varying)::text])))
);


--
-- Name: device_flows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_flows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_flows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_flows_id_seq OWNED BY public.agent_flows.id;


--
-- Name: device_job_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_job_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_job_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_job_status_id_seq OWNED BY public.agent_job_status.id;


--
-- Name: device_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_logs_id_seq OWNED BY public.agent_logs.id;


--
-- Name: device_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_tags_id_seq OWNED BY public.agent_tags.id;


--
-- Name: device_target_state_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_target_state_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_target_state_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_target_state_history_id_seq OWNED BY public.agent_target_state_history.id;


--
-- Name: device_target_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_target_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_target_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_target_state_id_seq OWNED BY public.agent_target_state.id;


--
-- Name: device_traffic_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_traffic_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_traffic_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_traffic_stats_id_seq OWNED BY public.agent_traffic_stats.id;


--
-- Name: devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devices_id_seq OWNED BY public.agents.id;


--
-- Name: dictionary_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_entries (
    device_uuid uuid NOT NULL,
    field_name text NOT NULL,
    field_index integer NOT NULL,
    version_added integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dictionary_enum_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_enum_devices (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    protocol character varying(32) NOT NULL,
    device_name character varying(255) NOT NULL,
    enum_index integer NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    promoted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    inactive boolean DEFAULT false NOT NULL
);


--
-- Name: dictionary_enum_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dictionary_enum_devices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dictionary_enum_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dictionary_enum_devices_id_seq OWNED BY public.dictionary_enum_devices.id;


--
-- Name: dictionary_enum_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_enum_metrics (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    protocol character varying(32) NOT NULL,
    metric_name character varying(255) NOT NULL,
    enum_index integer NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    promoted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    inactive boolean DEFAULT false NOT NULL
);


--
-- Name: dictionary_enum_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dictionary_enum_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dictionary_enum_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dictionary_enum_metrics_id_seq OWNED BY public.dictionary_enum_metrics.id;


--
-- Name: dictionary_enum_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_enum_observations (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    category character varying(32) NOT NULL,
    namespace character varying(32),
    value character varying(255) NOT NULL,
    observation_count integer DEFAULT 1 NOT NULL,
    unique_value_count integer,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    promoted_at timestamp with time zone,
    is_promoted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dictionary_enum_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dictionary_enum_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dictionary_enum_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dictionary_enum_observations_id_seq OWNED BY public.dictionary_enum_observations.id;


--
-- Name: dictionary_enum_quality_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_enum_quality_codes (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    code_value character varying(64) NOT NULL,
    enum_index integer NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    promoted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    inactive boolean DEFAULT false NOT NULL
);


--
-- Name: dictionary_enum_quality_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dictionary_enum_quality_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dictionary_enum_quality_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dictionary_enum_quality_codes_id_seq OWNED BY public.dictionary_enum_quality_codes.id;


--
-- Name: dictionary_enum_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_enum_units (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    unit_value character varying(64) NOT NULL,
    enum_index integer NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    promoted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    inactive boolean DEFAULT false NOT NULL
);


--
-- Name: dictionary_enum_units_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dictionary_enum_units_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dictionary_enum_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dictionary_enum_units_id_seq OWNED BY public.dictionary_enum_units.id;


--
-- Name: dictionary_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_metadata (
    device_uuid uuid NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    last_full_sync timestamp with time zone,
    last_delta_sync timestamp with time zone,
    dictionary_hash text,
    total_fields integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    format_version integer DEFAULT 1,
    quality_code_enum_frozen boolean DEFAULT false,
    unit_enum_frozen boolean DEFAULT false,
    last_enum_promotion timestamp with time zone,
    total_metrics_promoted integer DEFAULT 0,
    total_devices_promoted integer DEFAULT 0,
    total_quality_codes_promoted integer DEFAULT 0
);


--
-- Name: email_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_logs (
    id integer NOT NULL,
    job_id character varying(255),
    user_email character varying(255) NOT NULL,
    user_name character varying(255),
    template_name character varying(100) NOT NULL,
    context jsonb,
    status character varying(50) DEFAULT 'queued'::character varying NOT NULL,
    sent_at timestamp without time zone,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: email_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_logs_id_seq OWNED BY public.email_logs.id;


--
-- Name: endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.endpoints (
    id integer NOT NULL,
    agent_uuid uuid NOT NULL,
    name character varying(255) NOT NULL,
    protocol character varying(50) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    poll_interval integer DEFAULT 5000 NOT NULL,
    connection jsonb NOT NULL,
    data_points jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying(255),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    synced_to_config boolean DEFAULT true NOT NULL,
    config_version integer,
    deployment_status character varying(20) DEFAULT 'pending'::character varying,
    last_deployed_at timestamp with time zone,
    deployment_error text,
    deployment_attempts integer DEFAULT 0,
    config_id uuid,
    uuid uuid NOT NULL,
    health_status character varying(50),
    health_connected boolean,
    health_last_poll timestamp with time zone,
    health_error_count integer DEFAULT 0,
    health_last_error text,
    health_updated_at timestamp with time zone,
    location text,
    last_telemetry_at timestamp with time zone,
    CONSTRAINT chk_deployment_status CHECK (((deployment_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('deployed'::character varying)::text, ('failed'::character varying)::text, ('pending_deletion'::character varying)::text, ('virtual'::character varying)::text, ('draft'::character varying)::text, ('deleted'::character varying)::text])))
);


--
-- Name: endpoints_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.endpoints_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: endpoints_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.endpoints_id_seq OWNED BY public.endpoints.id;


--
-- Name: event_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_cursors (
    processor_name character varying(100) NOT NULL,
    last_event_id bigint NOT NULL,
    last_processed_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: event_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_types (
    event_type character varying(100) NOT NULL,
    description text,
    schema jsonb,
    aggregate_type character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    retention_tier character varying(20) DEFAULT 'standard'::character varying,
    retention_days integer DEFAULT 90
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type character varying(100) NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    aggregate_type character varying(50) NOT NULL,
    aggregate_id character varying(255) NOT NULL,
    data jsonb NOT NULL,
    metadata jsonb,
    correlation_id uuid,
    causation_id uuid,
    source character varying(100),
    checksum character varying(64) NOT NULL,
    actor_type character varying(50),
    actor_id character varying(255),
    severity character varying(20),
    impact character varying(20)
);

--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;



--
-- Name: fleet_billing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_billing_history (
    id bigint NOT NULL,
    fleet_id character varying(100) NOT NULL,
    period_start timestamp without time zone NOT NULL,
    period_end timestamp without time zone NOT NULL,
    billing_month character varying(7) NOT NULL,
    hours_running numeric(10,2) DEFAULT 0 NOT NULL,
    device_count integer DEFAULT 0 NOT NULL,
    avg_devices_online numeric(5,2),
    total_endpoints integer DEFAULT 0,
    base_cost numeric(10,2) DEFAULT 0 NOT NULL,
    overage_cost numeric(10,2) DEFAULT 0,
    discount_amount numeric(10,2) DEFAULT 0,
    total_cost numeric(10,2) DEFAULT 0 NOT NULL,
    billing_mode character varying(20) NOT NULL,
    cost_per_hour numeric(10,4),
    budget_limit numeric(10,2),
    budget_exceeded boolean DEFAULT false,
    invoice_id character varying(255),
    invoice_status character varying(50),
    invoice_date date,
    paid_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_invoice_status CHECK (((invoice_status IS NULL) OR ((invoice_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('paid'::character varying)::text, ('overdue'::character varying)::text, ('cancelled'::character varying)::text])))),
    CONSTRAINT valid_period CHECK ((period_end > period_start))
);


--
-- Name: fleet_billing_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fleet_billing_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fleet_billing_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fleet_billing_history_id_seq OWNED BY public.fleet_billing_history.id;


--
-- Name: fleet_namespaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_namespaces (
    name character varying(63) NOT NULL,
    max_agents integer NOT NULL,
    max_devices integer NOT NULL,
    current_agents integer DEFAULT 0 NOT NULL,
    current_devices integer DEFAULT 0 NOT NULL,
    cpu_quota_request character varying(20),
    memory_quota_request character varying(20),
    cpu_quota_used character varying(20),
    memory_quota_used character varying(20),
    available boolean DEFAULT true NOT NULL,
    utilization_percent numeric(5,2),
    last_synced timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT fleet_namespaces_current_agents_valid CHECK (((current_agents >= 0) AND (current_agents <= max_agents))),
    CONSTRAINT fleet_namespaces_current_devices_valid CHECK (((current_devices >= 0) AND (current_devices <= max_devices))),
    CONSTRAINT fleet_namespaces_max_agents_positive CHECK ((max_agents > 0)),
    CONSTRAINT fleet_namespaces_max_devices_positive CHECK ((max_devices > 0)),
    CONSTRAINT fleet_namespaces_utilization_valid CHECK (((utilization_percent >= (0)::numeric) AND (utilization_percent <= (100)::numeric)))
);


--
-- Name: fleet_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_usage_events (
    id bigint NOT NULL,
    fleet_id character varying(100) NOT NULL,
    event_type character varying(50) NOT NULL,
    event_timestamp timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    device_count integer,
    devices_online integer,
    total_endpoints integer,
    cost_snapshot numeric(10,2),
    total_hours numeric(10,2),
    triggered_by character varying(255),
    details jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_event_type CHECK (((event_type)::text = ANY (ARRAY[('fleet_created'::character varying)::text, ('started'::character varying)::text, ('stopped'::character varying)::text, ('cost_updated'::character varying)::text, ('budget_alert'::character varying)::text, ('budget_exceeded'::character varying)::text, ('device_added'::character varying)::text, ('device_removed'::character varying)::text, ('deployment_complete'::character varying)::text, ('deployment_failed'::character varying)::text])))
);


--
-- Name: fleet_usage_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fleet_usage_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fleet_usage_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fleet_usage_events_id_seq OWNED BY public.fleet_usage_events.id;


--
-- Name: fleets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fleets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fleets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fleets_id_seq OWNED BY public.fleets.id;


--
-- Name: global_app_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.global_app_id_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: global_service_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.global_service_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeper_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeper_config (
    task_name character varying(255) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    schedule character varying(100),
    last_modified_at timestamp without time zone DEFAULT now() NOT NULL,
    last_modified_by character varying(255)
);


--
-- Name: housekeeper_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeper_runs (
    id integer NOT NULL,
    task_name character varying(255) NOT NULL,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    status character varying(50) DEFAULT 'running'::character varying NOT NULL,
    duration_ms integer,
    output text,
    error text,
    triggered_by character varying(50) DEFAULT 'scheduler'::character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: housekeeper_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.housekeeper_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeper_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.housekeeper_runs_id_seq OWNED BY public.housekeeper_runs.id;


--
-- Name: image_approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_approval_requests (
    id integer NOT NULL,
    image_name character varying(255) NOT NULL,
    registry character varying(100) DEFAULT 'docker.io'::character varying,
    requested_by character varying(100),
    requested_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(20) DEFAULT 'pending'::character varying,
    reviewed_by character varying(100),
    reviewed_at timestamp without time zone,
    notes text,
    rejection_reason text,
    image_id integer,
    tag_name character varying(100),
    metadata jsonb
);


--
-- Name: image_approval_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_approval_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_approval_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_approval_requests_id_seq OWNED BY public.image_approval_requests.id;


--
-- Name: image_rollouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_rollouts (
    id integer NOT NULL,
    rollout_id character varying(255) NOT NULL,
    image_name character varying(255) NOT NULL,
    old_tag character varying(100),
    new_tag character varying(100) NOT NULL,
    registry character varying(255) DEFAULT 'hub.docker.com'::character varying,
    policy_id integer,
    strategy character varying(50) NOT NULL,
    total_devices integer NOT NULL,
    batch_sizes jsonb,
    status character varying(50) DEFAULT 'pending'::character varying,
    current_batch integer DEFAULT 0,
    updated_devices integer DEFAULT 0,
    failed_devices integer DEFAULT 0,
    healthy_devices integer DEFAULT 0,
    rolled_back_devices integer DEFAULT 0,
    failure_rate numeric(5,4) DEFAULT 0,
    auto_paused boolean DEFAULT false,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    paused_at timestamp without time zone,
    resumed_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    triggered_by character varying(100),
    webhook_payload jsonb,
    filters_applied jsonb,
    error_message text,
    notes text,
    CONSTRAINT image_rollouts_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('scheduled'::character varying)::text, ('in_progress'::character varying)::text, ('paused'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('rolled_back'::character varying)::text]))),
    CONSTRAINT image_rollouts_strategy_check CHECK (((strategy)::text = ANY (ARRAY[('auto'::character varying)::text, ('staged'::character varying)::text, ('manual'::character varying)::text, ('scheduled'::character varying)::text])))
);


--
-- Name: image_rollouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_rollouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_rollouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_rollouts_id_seq OWNED BY public.image_rollouts.id;


--
-- Name: image_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_tags (
    id integer NOT NULL,
    image_id integer NOT NULL,
    tag character varying(100) NOT NULL,
    digest character varying(255),
    size_bytes bigint,
    architecture character varying(50) DEFAULT 'amd64'::character varying,
    os character varying(50) DEFAULT 'linux'::character varying,
    pushed_at timestamp without time zone,
    is_recommended boolean DEFAULT false,
    is_deprecated boolean DEFAULT false,
    security_scan_status character varying(20),
    vulnerabilities_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb,
    last_updated timestamp without time zone
);


--
-- Name: image_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_tags_id_seq OWNED BY public.image_tags.id;


--
-- Name: image_update_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_update_policies (
    id integer NOT NULL,
    image_pattern character varying(255) NOT NULL,
    update_strategy character varying(50) NOT NULL,
    staged_batches integer DEFAULT 3,
    batch_delay_minutes integer DEFAULT 30,
    health_check_enabled boolean DEFAULT true,
    health_check_timeout_seconds integer DEFAULT 300,
    auto_rollback boolean DEFAULT true,
    health_check_config jsonb,
    maintenance_window_start time without time zone,
    maintenance_window_end time without time zone,
    fleet_id character varying(255),
    agent_tags jsonb,
    device_uuids text[],
    enabled boolean DEFAULT true,
    priority integer DEFAULT 100,
    description text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT image_update_policies_update_strategy_check CHECK (((update_strategy)::text = ANY (ARRAY[('auto'::character varying)::text, ('staged'::character varying)::text, ('manual'::character varying)::text, ('scheduled'::character varying)::text])))
);


--
-- Name: image_update_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_update_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_update_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_update_policies_id_seq OWNED BY public.image_update_policies.id;


--
-- Name: images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.images (
    id integer NOT NULL,
    image_name character varying(255) NOT NULL,
    registry character varying(100) DEFAULT 'docker.io'::character varying,
    namespace character varying(100),
    description text,
    category character varying(50),
    is_official boolean DEFAULT false,
    approval_status character varying(20) DEFAULT 'pending'::character varying,
    approved_by character varying(100),
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    watch_for_updates boolean DEFAULT true,
    last_checked_at timestamp without time zone,
    next_check_at timestamp without time zone
);


--
-- Name: images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.images_id_seq OWNED BY public.images.id;


--
-- Name: job_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_executions (
    id integer NOT NULL,
    job_id character varying(255) NOT NULL,
    template_id integer,
    job_name character varying(255) NOT NULL,
    job_document jsonb NOT NULL,
    target_type character varying(50) NOT NULL,
    target_devices uuid[],
    target_filter jsonb,
    execution_type character varying(50) DEFAULT 'oneTime'::character varying,
    schedule jsonb,
    max_executions integer,
    timeout_minutes integer DEFAULT 60,
    status character varying(50) DEFAULT 'QUEUED'::character varying,
    queued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    total_devices integer DEFAULT 0,
    succeeded_devices integer DEFAULT 0,
    failed_devices integer DEFAULT 0,
    in_progress_devices integer DEFAULT 0,
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: job_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_executions_id_seq OWNED BY public.job_executions.id;


--
-- Name: job_handlers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_handlers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    script_type character varying(50) DEFAULT 'bash'::character varying,
    script_content text NOT NULL,
    permissions character varying(10) DEFAULT '700'::character varying,
    default_args jsonb DEFAULT '[]'::jsonb,
    created_by character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: job_handlers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_handlers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_handlers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_handlers_id_seq OWNED BY public.job_handlers.id;


--
-- Name: job_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_templates (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    category character varying(100),
    job_document jsonb NOT NULL,
    created_by character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: job_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_templates_id_seq OWNED BY public.job_templates.id;


--
-- Name: log_alert_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_alert_rules (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    device_uuid uuid,
    pattern character varying(1000) NOT NULL,
    pattern_type character varying(20) DEFAULT 'regex'::character varying,
    service_name character varying(255),
    level character varying(50),
    trigger_type character varying(50) DEFAULT 'count'::character varying NOT NULL,
    threshold integer DEFAULT 1,
    time_window integer DEFAULT 300,
    severity character varying(20) DEFAULT 'warning'::character varying,
    notify_email boolean DEFAULT false,
    notify_webhook boolean DEFAULT false,
    notify_dashboard boolean DEFAULT true,
    is_enabled boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: log_alert_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.log_alert_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: log_alert_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.log_alert_rules_id_seq OWNED BY public.log_alert_rules.id;


--
-- Name: log_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_alerts (
    id bigint NOT NULL,
    rule_id integer,
    device_uuid uuid NOT NULL,
    matched_log_ids bigint[],
    message text NOT NULL,
    count integer DEFAULT 1,
    status character varying(20) DEFAULT 'active'::character varying,
    severity character varying(20) NOT NULL,
    first_seen timestamp without time zone NOT NULL,
    last_seen timestamp without time zone NOT NULL,
    acknowledged_at timestamp without time zone,
    acknowledged_by character varying(255),
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: log_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.log_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: log_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.log_alerts_id_seq OWNED BY public.log_alerts.id;


--
-- Name: mqtt_acls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_acls (
    id integer NOT NULL,
    username character varying(255),
    clientid character varying(255),
    topic character varying(255) NOT NULL,
    access integer NOT NULL,
    priority integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_access CHECK (((access >= 1) AND (access <= 7)))
);
ALTER TABLE ONLY public.mqtt_acls ALTER COLUMN username SET STATISTICS 1000;
ALTER TABLE ONLY public.mqtt_acls ALTER COLUMN topic SET STATISTICS 1000;


--
-- Name: mqtt_acls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_acls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_acls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_acls_id_seq OWNED BY public.mqtt_acls.id;


--
-- Name: mqtt_broker_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_broker_config (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    protocol character varying(10) DEFAULT 'mqtt'::character varying NOT NULL,
    host character varying(255) NOT NULL,
    port integer NOT NULL,
    username character varying(255),
    password_hash character varying(255),
    use_tls boolean DEFAULT false,
    ca_cert text,
    client_cert text,
    client_key text,
    verify_certificate boolean DEFAULT true,
    client_id_prefix character varying(100) DEFAULT 'Iotistic'::character varying,
    keep_alive integer DEFAULT 60,
    clean_session boolean DEFAULT true,
    reconnect_period integer DEFAULT 1000,
    connect_timeout integer DEFAULT 30000,
    is_active boolean DEFAULT true,
    is_default boolean DEFAULT false,
    broker_type character varying(50) DEFAULT 'local'::character varying,
    extra_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_connected_at timestamp without time zone,
    CONSTRAINT valid_broker_type CHECK (((broker_type)::text = ANY (ARRAY[('local'::character varying)::text, ('cloud'::character varying)::text, ('edge'::character varying)::text, ('test'::character varying)::text]))),
    CONSTRAINT valid_keep_alive CHECK ((keep_alive > 0)),
    CONSTRAINT valid_port CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT valid_protocol CHECK (((protocol)::text = ANY (ARRAY[('mqtt'::character varying)::text, ('mqtts'::character varying)::text, ('ws'::character varying)::text, ('wss'::character varying)::text])))
);


--
-- Name: mqtt_broker_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_broker_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_broker_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_broker_config_id_seq OWNED BY public.mqtt_broker_config.id;


--
-- Name: mqtt_broker_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_broker_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_broker_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_broker_stats_id_seq OWNED BY public.mqtt_broker_stats.id;


--
-- Name: mqtt_schema_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_schema_history (
    id integer NOT NULL,
    topic character varying(512) NOT NULL,
    schema jsonb NOT NULL,
    schema_hash character varying(64) NOT NULL,
    sample_message jsonb,
    detected_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    topic_id uuid
);


--
-- Name: mqtt_schema_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_schema_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_schema_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_schema_history_id_seq OWNED BY public.mqtt_schema_history.id;


--
-- Name: mqtt_topic_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_topic_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_topic_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_topic_metrics_id_seq OWNED BY public.mqtt_topic_metrics.id;


--
-- Name: mqtt_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_topics (
    id integer NOT NULL,
    topic character varying(512) NOT NULL,
    message_type character varying(100),
    schema jsonb,
    last_message text,
    message_count bigint DEFAULT 0,
    qos integer,
    retain boolean,
    first_seen timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_seen timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    topic_id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_topics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_topics_id_seq OWNED BY public.mqtt_topics.id;


--
-- Name: mqtt_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_users (
    id integer NOT NULL,
    username character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    is_superuser boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ONLY public.mqtt_users ALTER COLUMN username SET STATISTICS 1000;


--
-- Name: mqtt_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_users_id_seq OWNED BY public.mqtt_users.id;


--
-- Name: nodered_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodered_credentials (
    id integer DEFAULT 1 NOT NULL,
    credentials jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);


--
-- Name: nodered_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodered_flows (
    id integer DEFAULT 1 NOT NULL,
    flows jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);


--
-- Name: nodered_library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodered_library (
    id integer NOT NULL,
    type character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb,
    body text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: nodered_library_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nodered_library_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nodered_library_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nodered_library_id_seq OWNED BY public.nodered_library.id;


--
-- Name: nodered_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodered_sessions (
    id integer DEFAULT 1 NOT NULL,
    sessions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);


--
-- Name: nodered_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodered_settings (
    id integer DEFAULT 1 NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);


--
-- Name: profile_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_configs (
    id integer NOT NULL,
    profile_name character varying(100) NOT NULL,
    protocol character varying(50) DEFAULT 'modbus'::character varying NOT NULL,
    data_points jsonb NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: provisioning_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_attempts (
    id bigint NOT NULL,
    ip_address inet NOT NULL,
    agent_uuid uuid,
    provisioning_key_id uuid,
    success boolean NOT NULL,
    error_message text,
    user_agent text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: provisioning_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.provisioning_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provisioning_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.provisioning_attempts_id_seq OWNED BY public.provisioning_attempts.id;


--
-- Name: provisioning_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisioning_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_hash character varying(255) NOT NULL,
    fleet_id character varying(100),
    description text,
    max_agents integer DEFAULT 100,
    agents_provisioned integer DEFAULT 0,
    expires_at timestamp without time zone NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by character varying(255),
    last_used_at timestamp without time zone,
    key_hash_fast character varying(64),
    deployment_type character varying(50),
    simulator_config jsonb,
    metadata jsonb,
    fleet_uuid uuid,
    CONSTRAINT agents_not_exceeded CHECK ((agents_provisioned <= max_agents))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(255) NOT NULL,
    device_info text,
    ip_address inet,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_used_at timestamp without time zone,
    revoked boolean DEFAULT false,
    revoked_at timestamp without time zone
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;


--
-- Name: releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.releases (
    id integer NOT NULL,
    application_id integer NOT NULL,
    commit character varying(255) NOT NULL,
    composition jsonb NOT NULL,
    status character varying(50) DEFAULT 'success'::character varying,
    source character varying(255),
    build_log text,
    is_invalidated boolean DEFAULT false,
    start_timestamp timestamp without time zone,
    end_timestamp timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: releases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: releases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.releases_id_seq OWNED BY public.releases.id;


--
-- Name: rollout_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rollout_events (
    id integer NOT NULL,
    rollout_id character varying(255) NOT NULL,
    device_uuid uuid,
    event_type character varying(50) NOT NULL,
    event_data jsonb,
    message text,
    "timestamp" timestamp without time zone DEFAULT now(),
    CONSTRAINT rollout_events_event_type_check CHECK (((event_type)::text = ANY (ARRAY[('rollout_created'::character varying)::text, ('rollout_started'::character varying)::text, ('batch_started'::character varying)::text, ('batch_completed'::character varying)::text, ('device_scheduled'::character varying)::text, ('device_updated'::character varying)::text, ('device_failed'::character varying)::text, ('health_check_passed'::character varying)::text, ('health_check_failed'::character varying)::text, ('rollback_triggered'::character varying)::text, ('rollout_paused'::character varying)::text, ('rollout_resumed'::character varying)::text, ('rollout_completed'::character varying)::text, ('rollout_failed'::character varying)::text])))
);


--
-- Name: rollout_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rollout_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rollout_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rollout_events_id_seq OWNED BY public.rollout_events.id;


--
-- Name: scheduled_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_jobs (
    id integer NOT NULL,
    schedule_id character varying(255) NOT NULL,
    job_name character varying(255) NOT NULL,
    description text,
    job_document jsonb NOT NULL,
    target_type character varying(50) NOT NULL,
    target_devices uuid[],
    target_filter jsonb,
    schedule_type character varying(50) NOT NULL,
    cron_expression character varying(255),
    interval_minutes integer,
    max_executions integer,
    timeout_minutes integer DEFAULT 60,
    is_active boolean DEFAULT true,
    execution_count integer DEFAULT 0,
    last_execution_at timestamp without time zone,
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_cron_or_interval CHECK (((((schedule_type)::text = 'cron'::text) AND (cron_expression IS NOT NULL)) OR (((schedule_type)::text = 'interval'::text) AND (interval_minutes IS NOT NULL)))),
    CONSTRAINT chk_schedule_type CHECK (((schedule_type)::text = ANY (ARRAY[('cron'::character varying)::text, ('interval'::character varying)::text]))),
    CONSTRAINT chk_target_type CHECK (((target_type)::text = ANY (ARRAY[('device'::character varying)::text, ('group'::character varying)::text, ('all'::character varying)::text])))
);


--
-- Name: scheduled_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scheduled_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheduled_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scheduled_jobs_id_seq OWNED BY public.scheduled_jobs.id;


--
-- Name: shell_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shell_audit_log (
    id integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    device_uuid uuid NOT NULL,
    session_id uuid NOT NULL,
    command text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shell_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shell_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shell_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shell_audit_log_id_seq OWNED BY public.shell_audit_log.id;


--
-- Name: shell_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shell_sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_uuid uuid NOT NULL,
    user_id character varying(255),
    status character varying(20) DEFAULT 'creating'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_activity timestamp with time zone DEFAULT now(),
    terminated_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT valid_status CHECK (((status)::text = ANY (ARRAY[('creating'::character varying)::text, ('starting'::character varying)::text, ('active'::character varying)::text, ('detached'::character varying)::text, ('agent-timeout'::character varying)::text, ('terminated'::character varying)::text])))
);


--
-- Name: state_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_changes (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    state_type character varying(20) NOT NULL,
    change_type character varying(50) NOT NULL,
    entity_type character varying(50),
    entity_id character varying(255),
    field_path text,
    old_value jsonb,
    new_value jsonb,
    triggered_by character varying(50) NOT NULL,
    correlation_id uuid,
    parent_snapshot_id integer,
    metadata jsonb,
    CONSTRAINT state_changes_state_type_check CHECK (((state_type)::text = ANY (ARRAY[('target'::character varying)::text, ('current'::character varying)::text])))
);


--
-- Name: state_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.state_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: state_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.state_changes_id_seq OWNED BY public.state_changes.id;


--
-- Name: state_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_projections (
    device_uuid uuid NOT NULL,
    target_state jsonb,
    current_state jsonb,
    target_version bigint,
    current_version bigint,
    last_reconciliation_at timestamp without time zone,
    in_sync boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    key character varying(255) NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tag_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tag_definitions (
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    description text,
    allowed_values text[],
    is_required boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tag_definitions_key_format CHECK ((((key)::text ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$'::text) AND (length((key)::text) >= 2) AND (length((key)::text) <= 100)))
);


--
-- Name: tag_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tag_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tag_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tag_definitions_id_seq OWNED BY public.tag_definitions.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    session_token character varying(255) NOT NULL,
    ip_address inet,
    user_agent text,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_activity_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(255),
    role character varying(50) DEFAULT 'user'::character varying NOT NULL,
    is_active boolean DEFAULT true,
    email_verified boolean DEFAULT false,
    last_login_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    mqtt_username character varying(255),
    must_change_password boolean DEFAULT false NOT NULL,
    password_last_changed_at timestamp without time zone,
    CONSTRAINT valid_role CHECK (((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('manager'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vendor_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_configs_id_seq OWNED BY public.profile_configs.id;


--
-- Name: wg_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wg_config (
    id integer NOT NULL,
    interface_name character varying(50) DEFAULT 'wg0'::character varying NOT NULL,
    listen_port integer DEFAULT 51820 NOT NULL,
    private_key character varying(255) NOT NULL,
    public_key character varying(255) NOT NULL,
    address character varying(100) DEFAULT '10.8.0.1/24'::character varying NOT NULL,
    dns character varying(255),
    mtu integer DEFAULT 1420,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: wg_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wg_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wg_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wg_config_id_seq OWNED BY public.wg_config.id;


--
-- Name: wg_ip_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wg_ip_pool (
    id integer NOT NULL,
    ip_address character varying(45) NOT NULL,
    assigned_to character varying(255),
    assigned_at timestamp without time zone,
    is_available boolean DEFAULT true
);


--
-- Name: wg_ip_pool_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wg_ip_pool_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wg_ip_pool_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wg_ip_pool_id_seq OWNED BY public.wg_ip_pool.id;


--
-- Name: wg_peers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wg_peers (
    id integer NOT NULL,
    peer_id character varying(255) NOT NULL,
    public_key character varying(255) NOT NULL,
    private_key character varying(255) NOT NULL,
    preshared_key character varying(255),
    ip_address character varying(45) NOT NULL,
    allowed_ips text DEFAULT '0.0.0.0/0, ::/0'::text NOT NULL,
    endpoint character varying(255),
    persistent_keepalive integer DEFAULT 25,
    device_id character varying(255),
    device_name character varying(255),
    notes text,
    enabled boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    last_handshake timestamp without time zone,
    rx_bytes bigint DEFAULT 0,
    tx_bytes bigint DEFAULT 0
);


--
-- Name: wg_peers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wg_peers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wg_peers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wg_peers_id_seq OWNED BY public.wg_peers.id;


--
-- Name: agent_api_key_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_key_history ALTER COLUMN id SET DEFAULT nextval('public.device_api_key_history_id_seq'::regclass);


--
-- Name: agent_api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_keys ALTER COLUMN id SET DEFAULT nextval('public.device_api_keys_id_seq'::regclass);


--
-- Name: agent_current_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state ALTER COLUMN id SET DEFAULT nextval('public.device_current_state_id_seq'::regclass);


--
-- Name: agent_current_state_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state_history ALTER COLUMN id SET DEFAULT nextval('public.device_current_state_history_id_seq'::regclass);


--
-- Name: agent_flows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_flows ALTER COLUMN id SET DEFAULT nextval('public.device_flows_id_seq'::regclass);


--
-- Name: agent_job_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_job_status ALTER COLUMN id SET DEFAULT nextval('public.device_job_status_id_seq'::regclass);


--
-- Name: agent_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: agent_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_metrics ALTER COLUMN id SET DEFAULT nextval('public.agent_metrics_id_seq'::regclass);


--
-- Name: agent_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tags ALTER COLUMN id SET DEFAULT nextval('public.device_tags_id_seq'::regclass);


--
-- Name: agent_target_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state ALTER COLUMN id SET DEFAULT nextval('public.device_target_state_id_seq'::regclass);


--
-- Name: agent_target_state_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state_history ALTER COLUMN id SET DEFAULT nextval('public.device_target_state_history_id_seq'::regclass);


--
-- Name: agent_traffic_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_traffic_stats ALTER COLUMN id SET DEFAULT nextval('public.device_traffic_stats_id_seq'::regclass);


--
-- Name: agent_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_updates ALTER COLUMN id SET DEFAULT nextval('public.agent_updates_id_seq'::regclass);


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.devices_id_seq'::regclass);


--
-- Name: anomaly_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_alerts ALTER COLUMN id SET DEFAULT nextval('public.anomaly_alerts_id_seq'::regclass);


--
-- Name: anomaly_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_events ALTER COLUMN id SET DEFAULT nextval('public.anomaly_events_id_seq'::regclass);


--
-- Name: anomaly_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_incidents ALTER COLUMN id SET DEFAULT nextval('public.anomaly_incidents_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: app_service_ids id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_service_ids ALTER COLUMN id SET DEFAULT nextval('public.app_service_ids_id_seq'::regclass);


--
-- Name: applications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications ALTER COLUMN id SET DEFAULT nextval('public.applications_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: dashboard_layouts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts ALTER COLUMN id SET DEFAULT nextval('public.dashboard_layouts_id_seq'::regclass);


--
-- Name: dictionary_enum_devices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_devices ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_devices_id_seq'::regclass);


--
-- Name: dictionary_enum_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_metrics ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_metrics_id_seq'::regclass);


--
-- Name: dictionary_enum_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_observations ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_observations_id_seq'::regclass);


--
-- Name: dictionary_enum_quality_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_quality_codes_id_seq'::regclass);


--
-- Name: dictionary_enum_units id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_units ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_units_id_seq'::regclass);


--
-- Name: email_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_logs ALTER COLUMN id SET DEFAULT nextval('public.email_logs_id_seq'::regclass);


--
-- Name: endpoints id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints ALTER COLUMN id SET DEFAULT nextval('public.endpoints_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: fleet_billing_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_billing_history ALTER COLUMN id SET DEFAULT nextval('public.fleet_billing_history_id_seq'::regclass);


--
-- Name: fleet_usage_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_usage_events ALTER COLUMN id SET DEFAULT nextval('public.fleet_usage_events_id_seq'::regclass);


--
-- Name: fleets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleets ALTER COLUMN id SET DEFAULT nextval('public.fleets_id_seq'::regclass);


--
-- Name: housekeeper_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeper_runs ALTER COLUMN id SET DEFAULT nextval('public.housekeeper_runs_id_seq'::regclass);


--
-- Name: image_approval_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_approval_requests ALTER COLUMN id SET DEFAULT nextval('public.image_approval_requests_id_seq'::regclass);


--
-- Name: image_rollouts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_rollouts ALTER COLUMN id SET DEFAULT nextval('public.image_rollouts_id_seq'::regclass);


--
-- Name: image_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_tags ALTER COLUMN id SET DEFAULT nextval('public.image_tags_id_seq'::regclass);


--
-- Name: image_update_policies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_update_policies ALTER COLUMN id SET DEFAULT nextval('public.image_update_policies_id_seq'::regclass);


--
-- Name: images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.images ALTER COLUMN id SET DEFAULT nextval('public.images_id_seq'::regclass);


--
-- Name: job_executions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions ALTER COLUMN id SET DEFAULT nextval('public.job_executions_id_seq'::regclass);


--
-- Name: job_handlers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_handlers ALTER COLUMN id SET DEFAULT nextval('public.job_handlers_id_seq'::regclass);


--
-- Name: job_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_templates ALTER COLUMN id SET DEFAULT nextval('public.job_templates_id_seq'::regclass);


--
-- Name: log_alert_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alert_rules ALTER COLUMN id SET DEFAULT nextval('public.log_alert_rules_id_seq'::regclass);


--
-- Name: log_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alerts ALTER COLUMN id SET DEFAULT nextval('public.log_alerts_id_seq'::regclass);


--
-- Name: mqtt_acls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_acls ALTER COLUMN id SET DEFAULT nextval('public.mqtt_acls_id_seq'::regclass);


--
-- Name: mqtt_broker_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_broker_config ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_config_id_seq'::regclass);


--
-- Name: mqtt_broker_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_broker_stats ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_stats_id_seq'::regclass);


--
-- Name: mqtt_schema_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_schema_history ALTER COLUMN id SET DEFAULT nextval('public.mqtt_schema_history_id_seq'::regclass);


--
-- Name: mqtt_topic_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topic_metrics ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topic_metrics_id_seq'::regclass);


--
-- Name: mqtt_topics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topics_id_seq'::regclass);


--
-- Name: mqtt_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_users ALTER COLUMN id SET DEFAULT nextval('public.mqtt_users_id_seq'::regclass);


--
-- Name: nodered_library id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_library ALTER COLUMN id SET DEFAULT nextval('public.nodered_library_id_seq'::regclass);


--
-- Name: profile_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_configs ALTER COLUMN id SET DEFAULT nextval('public.vendor_configs_id_seq'::regclass);


--
-- Name: provisioning_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_attempts ALTER COLUMN id SET DEFAULT nextval('public.provisioning_attempts_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);


--
-- Name: releases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases ALTER COLUMN id SET DEFAULT nextval('public.releases_id_seq'::regclass);


--
-- Name: rollout_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollout_events ALTER COLUMN id SET DEFAULT nextval('public.rollout_events_id_seq'::regclass);


--
-- Name: scheduled_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_jobs ALTER COLUMN id SET DEFAULT nextval('public.scheduled_jobs_id_seq'::regclass);


--
-- Name: shell_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shell_audit_log ALTER COLUMN id SET DEFAULT nextval('public.shell_audit_log_id_seq'::regclass);


--
-- Name: state_changes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_changes ALTER COLUMN id SET DEFAULT nextval('public.state_changes_id_seq'::regclass);


--
-- Name: tag_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_definitions ALTER COLUMN id SET DEFAULT nextval('public.tag_definitions_id_seq'::regclass);


--
-- Name: user_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: wg_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_config ALTER COLUMN id SET DEFAULT nextval('public.wg_config_id_seq'::regclass);


--
-- Name: wg_ip_pool id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_ip_pool ALTER COLUMN id SET DEFAULT nextval('public.wg_ip_pool_id_seq'::regclass);


--
-- Name: wg_peers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_peers ALTER COLUMN id SET DEFAULT nextval('public.wg_peers_id_seq'::regclass);


--
-- Name: agent_api_keys agent_api_keys_agent_uuid_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_keys
    ADD CONSTRAINT agent_api_keys_agent_uuid_key_hash_key UNIQUE (agent_uuid, key_hash);


--
-- Name: agent_current_state agent_current_state_agent_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state
    ADD CONSTRAINT agent_current_state_agent_uuid_key UNIQUE (agent_uuid);


--
-- Name: agent_job_status agent_job_status_job_id_agent_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_job_status
    ADD CONSTRAINT agent_job_status_job_id_agent_uuid_key UNIQUE (job_id, agent_uuid);


--
-- Name: agent_metrics agent_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_metrics
    ADD CONSTRAINT agent_metrics_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: agent_tags agent_tags_agent_uuid_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tags
    ADD CONSTRAINT agent_tags_agent_uuid_key_key UNIQUE (agent_uuid, key);


--
-- Name: agent_target_state agent_target_state_agent_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state
    ADD CONSTRAINT agent_target_state_agent_uuid_key UNIQUE (agent_uuid);


--
-- Name: agent_updates agent_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_updates
    ADD CONSTRAINT agent_updates_pkey PRIMARY KEY (id);


--
-- Name: anomaly_alerts anomaly_alerts_alert_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_alert_id_key UNIQUE (alert_id);


--
-- Name: anomaly_alerts anomaly_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_pkey PRIMARY KEY (id);


--
-- Name: anomaly_events anomaly_events_msg_id_timestamp_ms_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT anomaly_events_msg_id_timestamp_ms_key UNIQUE (msg_id, timestamp_ms);


--
-- Name: anomaly_events anomaly_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT anomaly_events_pkey PRIMARY KEY (id, timestamp_ms);


--
-- Name: anomaly_incidents anomaly_incidents_incident_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_incidents
    ADD CONSTRAINT anomaly_incidents_incident_id_key UNIQUE (incident_id);


--
-- Name: anomaly_incidents anomaly_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_incidents
    ADD CONSTRAINT anomaly_incidents_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_key UNIQUE (key);


--
-- Name: api_keys api_keys_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_name_key UNIQUE (name);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_service_ids app_service_ids_entity_type_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_service_ids
    ADD CONSTRAINT app_service_ids_entity_type_entity_id_key UNIQUE (entity_type, entity_id);


--
-- Name: app_service_ids app_service_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_service_ids
    ADD CONSTRAINT app_service_ids_pkey PRIMARY KEY (id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: applications applications_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_slug_key UNIQUE (slug);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: dashboard_layouts dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_pkey PRIMARY KEY (id);


--
-- Name: agent_api_key_history device_api_key_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_key_history
    ADD CONSTRAINT device_api_key_history_pkey PRIMARY KEY (id);


--
-- Name: agent_api_keys device_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_keys
    ADD CONSTRAINT device_api_keys_pkey PRIMARY KEY (id);


--
-- Name: agent_current_state_history device_current_state_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state_history
    ADD CONSTRAINT device_current_state_history_pkey PRIMARY KEY (id);


--
-- Name: agent_current_state device_current_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state
    ADD CONSTRAINT device_current_state_pkey PRIMARY KEY (id);


--
-- Name: dictionary_entries device_dictionary_entries_device_uuid_field_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_device_uuid_field_index_key UNIQUE (device_uuid, field_index);


--
-- Name: dictionary_entries device_dictionary_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_pkey PRIMARY KEY (device_uuid, field_name);


--
-- Name: dictionary_metadata device_dictionary_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_metadata
    ADD CONSTRAINT device_dictionary_metadata_pkey PRIMARY KEY (device_uuid);


--
-- Name: agent_flows device_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_flows
    ADD CONSTRAINT device_flows_pkey PRIMARY KEY (id);


--
-- Name: agent_job_status device_job_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_job_status
    ADD CONSTRAINT device_job_status_pkey PRIMARY KEY (id);


--
-- Name: agent_logs device_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs
    ADD CONSTRAINT device_logs_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: agent_tags device_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tags
    ADD CONSTRAINT device_tags_pkey PRIMARY KEY (id);


--
-- Name: agent_target_state_history device_target_state_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state_history
    ADD CONSTRAINT device_target_state_history_pkey PRIMARY KEY (id);


--
-- Name: agent_target_state device_target_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state
    ADD CONSTRAINT device_target_state_pkey PRIMARY KEY (id);


--
-- Name: agent_traffic_stats device_traffic_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_traffic_stats
    ADD CONSTRAINT device_traffic_stats_pkey PRIMARY KEY (id);


--
-- Name: agents devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: agents devices_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT devices_uuid_key UNIQUE (uuid);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_protocol_device_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_protocol_device_name_key UNIQUE (device_uuid, protocol, device_name);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_protocol_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_protocol_enum_index_key UNIQUE (device_uuid, protocol, enum_index);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_protocol_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_protocol_enum_index_key UNIQUE (device_uuid, protocol, enum_index);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_protocol_metric_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_protocol_metric_name_key UNIQUE (device_uuid, protocol, metric_name);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_observations dictionary_enum_observations_device_uuid_category_namespace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_device_uuid_category_namespace_key UNIQUE (device_uuid, category, namespace, value);


--
-- Name: dictionary_enum_observations dictionary_enum_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_code_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_code_value_key UNIQUE (device_uuid, code_value);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_enum_index_key UNIQUE (device_uuid, enum_index);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_enum_index_key UNIQUE (device_uuid, enum_index);


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_unit_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_unit_value_key UNIQUE (device_uuid, unit_value);


--
-- Name: dictionary_enum_units dictionary_enum_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_pkey PRIMARY KEY (id);


--
-- Name: email_logs email_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_pkey PRIMARY KEY (id);


--
-- Name: endpoints endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_pkey PRIMARY KEY (id);


--
-- Name: endpoints endpoints_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_uuid_key UNIQUE (uuid);


--
-- Name: event_cursors event_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_cursors
    ADD CONSTRAINT event_cursors_pkey PRIMARY KEY (processor_name);


--
-- Name: event_types event_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_types
    ADD CONSTRAINT event_types_pkey PRIMARY KEY (event_type);


--
-- Name: events events_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_event_id_key UNIQUE (event_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--

ALTER TABLE ONLY public.fleet_billing_history
    ADD CONSTRAINT fleet_billing_history_fleet_id_billing_month_key UNIQUE (fleet_id, billing_month);


--
-- Name: fleet_billing_history fleet_billing_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_billing_history
    ADD CONSTRAINT fleet_billing_history_pkey PRIMARY KEY (id);


--
-- Name: fleet_namespaces fleet_namespaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_namespaces
    ADD CONSTRAINT fleet_namespaces_pkey PRIMARY KEY (name);


--
-- Name: fleet_usage_events fleet_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_usage_events
    ADD CONSTRAINT fleet_usage_events_pkey PRIMARY KEY (id);


--
-- Name: fleets fleets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleets
    ADD CONSTRAINT fleets_pkey PRIMARY KEY (id);


--
-- Name: housekeeper_config housekeeper_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeper_config
    ADD CONSTRAINT housekeeper_config_pkey PRIMARY KEY (task_name);


--
-- Name: housekeeper_runs housekeeper_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeper_runs
    ADD CONSTRAINT housekeeper_runs_pkey PRIMARY KEY (id);


--
-- Name: image_approval_requests image_approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_approval_requests
    ADD CONSTRAINT image_approval_requests_pkey PRIMARY KEY (id);


--
-- Name: image_rollouts image_rollouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_pkey PRIMARY KEY (id);


--
-- Name: image_rollouts image_rollouts_rollout_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_rollout_id_key UNIQUE (rollout_id);


--
-- Name: image_tags image_tags_image_id_tag_architecture_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_image_id_tag_architecture_key UNIQUE (image_id, tag, architecture);


--
-- Name: image_tags image_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_pkey PRIMARY KEY (id);


--
-- Name: image_update_policies image_update_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_update_policies
    ADD CONSTRAINT image_update_policies_pkey PRIMARY KEY (id);


--
-- Name: images images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_pkey PRIMARY KEY (id);


--
-- Name: images images_registry_image_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_registry_image_name_key UNIQUE (registry, image_name);


--
-- Name: job_executions job_executions_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_job_id_key UNIQUE (job_id);


--
-- Name: job_executions job_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_pkey PRIMARY KEY (id);


--
-- Name: job_handlers job_handlers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_handlers
    ADD CONSTRAINT job_handlers_name_key UNIQUE (name);


--
-- Name: job_handlers job_handlers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_handlers
    ADD CONSTRAINT job_handlers_pkey PRIMARY KEY (id);


--
-- Name: job_templates job_templates_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_templates
    ADD CONSTRAINT job_templates_name_key UNIQUE (name);


--
-- Name: job_templates job_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_templates
    ADD CONSTRAINT job_templates_pkey PRIMARY KEY (id);


--
-- Name: log_alert_rules log_alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alert_rules
    ADD CONSTRAINT log_alert_rules_pkey PRIMARY KEY (id);


--
-- Name: log_alerts log_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_pkey PRIMARY KEY (id);


--
-- Name: mqtt_acls mqtt_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_acls
    ADD CONSTRAINT mqtt_acls_pkey PRIMARY KEY (id);


--
-- Name: mqtt_broker_config mqtt_broker_config_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_broker_config
    ADD CONSTRAINT mqtt_broker_config_name_key UNIQUE (name);


--
-- Name: mqtt_broker_config mqtt_broker_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_broker_config
    ADD CONSTRAINT mqtt_broker_config_pkey PRIMARY KEY (id);


--
-- Name: mqtt_schema_history mqtt_schema_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_schema_history
    ADD CONSTRAINT mqtt_schema_history_pkey PRIMARY KEY (id);


--
-- Name: mqtt_topics mqtt_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_pkey PRIMARY KEY (id);


--
-- Name: mqtt_topics mqtt_topics_topic_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_topic_key UNIQUE (topic);


--
-- Name: mqtt_users mqtt_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_users
    ADD CONSTRAINT mqtt_users_pkey PRIMARY KEY (id);


--
-- Name: mqtt_users mqtt_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_users
    ADD CONSTRAINT mqtt_users_username_key UNIQUE (username);


--
-- Name: nodered_credentials nodered_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_credentials
    ADD CONSTRAINT nodered_credentials_pkey PRIMARY KEY (id);


--
-- Name: nodered_flows nodered_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_flows
    ADD CONSTRAINT nodered_flows_pkey PRIMARY KEY (id);


--
-- Name: nodered_library nodered_library_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_library
    ADD CONSTRAINT nodered_library_pkey PRIMARY KEY (id);


--
-- Name: nodered_library nodered_library_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_library
    ADD CONSTRAINT nodered_library_type_name_key UNIQUE (type, name);


--
-- Name: nodered_sessions nodered_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_sessions
    ADD CONSTRAINT nodered_sessions_pkey PRIMARY KEY (id);


--
-- Name: nodered_settings nodered_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodered_settings
    ADD CONSTRAINT nodered_settings_pkey PRIMARY KEY (id);


--
-- Name: profile_configs profile_configs_profile_name_protocol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_configs
    ADD CONSTRAINT profile_configs_profile_name_protocol_key UNIQUE (profile_name, protocol);


--
-- Name: provisioning_attempts provisioning_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_attempts
    ADD CONSTRAINT provisioning_attempts_pkey PRIMARY KEY (id);


--
-- Name: provisioning_keys provisioning_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_keys
    ADD CONSTRAINT provisioning_keys_pkey PRIMARY KEY (id);


--
-- Name: readings readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readings
    ADD CONSTRAINT readings_pkey PRIMARY KEY (agent_uuid, metric_name, "time");


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: releases releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);


--
-- Name: rollout_events rollout_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rollout_events
    ADD CONSTRAINT rollout_events_pkey PRIMARY KEY (id);


--
-- Name: scheduled_jobs scheduled_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (id);


--
-- Name: scheduled_jobs scheduled_jobs_schedule_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_schedule_id_key UNIQUE (schedule_id);


--
-- Name: shell_audit_log shell_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shell_audit_log
    ADD CONSTRAINT shell_audit_log_pkey PRIMARY KEY (id);


--
-- Name: shell_sessions shell_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shell_sessions
    ADD CONSTRAINT shell_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: state_changes state_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_changes
    ADD CONSTRAINT state_changes_pkey PRIMARY KEY (id);


--
-- Name: state_projections state_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_projections
    ADD CONSTRAINT state_projections_pkey PRIMARY KEY (device_uuid);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: tag_definitions tag_definitions_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_key_key UNIQUE (key);


--
-- Name: tag_definitions tag_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_pkey PRIMARY KEY (id);


--
-- Name: agent_flows unique_agent_subflow; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_flows
    ADD CONSTRAINT unique_agent_subflow UNIQUE (agent_uuid, subflow_id);


--
-- Name: agent_target_state_history unique_agent_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state_history
    ADD CONSTRAINT unique_agent_version UNIQUE (agent_uuid, version);


--
-- Name: dashboard_layouts unique_share_token; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT unique_share_token UNIQUE (share_token);


--
-- Name: mqtt_schema_history unique_topic_schema; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_schema_history
    ADD CONSTRAINT unique_topic_schema UNIQUE (topic, schema_hash);


--
-- Name: agent_traffic_stats unique_traffic_entry; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_traffic_stats
    ADD CONSTRAINT unique_traffic_entry UNIQUE (device_id, endpoint, method, time_bucket);


--
-- Name: endpoints uq_endpoint_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT uq_endpoint_name UNIQUE (agent_uuid, name);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: profile_configs vendor_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_configs
    ADD CONSTRAINT vendor_configs_pkey PRIMARY KEY (id);


--
-- Name: wg_config wg_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_config
    ADD CONSTRAINT wg_config_pkey PRIMARY KEY (id);


--
-- Name: wg_ip_pool wg_ip_pool_ip_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_ip_pool
    ADD CONSTRAINT wg_ip_pool_ip_address_key UNIQUE (ip_address);


--
-- Name: wg_ip_pool wg_ip_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_ip_pool
    ADD CONSTRAINT wg_ip_pool_pkey PRIMARY KEY (id);


--
-- Name: wg_peers wg_peers_peer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_peer_id_key UNIQUE (peer_id);


--
-- Name: wg_peers wg_peers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_pkey PRIMARY KEY (id);


--
-- Name: wg_peers wg_peers_public_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_public_key_key UNIQUE (public_key);


--
-- Name: agent_metrics_recorded_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_metrics_recorded_at_idx ON public.agent_metrics USING btree (recorded_at DESC);


--
-- Name: anomaly_events_timestamp_ms_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anomaly_events_timestamp_ms_idx ON public.anomaly_events USING btree (timestamp_ms DESC);


--
-- Name: device_logs_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_logs_timestamp_idx ON public.agent_logs USING btree ("timestamp" DESC);




--
-- Name: idx_agent_api_keys_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_api_keys_agent_uuid ON public.agent_api_keys USING btree (agent_uuid);


--
-- Name: idx_agent_current_state_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_current_state_agent_uuid ON public.agent_current_state USING btree (agent_uuid);


--
-- Name: idx_agent_flows_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_flows_agent_uuid ON public.agent_flows USING btree (agent_uuid);


--
-- Name: idx_agent_job_status_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_job_status_agent_uuid ON public.agent_job_status USING btree (agent_uuid);


--
-- Name: idx_agent_key_history_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_key_history_agent_uuid ON public.agent_api_key_history USING btree (agent_uuid);


--
-- Name: idx_agent_logs_agent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_logs_agent_time ON public.agent_logs USING btree (agent_uuid, "timestamp" DESC);


--
-- Name: idx_agent_logs_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_logs_agent_uuid ON public.agent_logs USING btree (agent_uuid);


--
-- Name: idx_agent_logs_error_logs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_logs_error_logs ON public.agent_logs USING btree (agent_uuid, is_stderr) WHERE (is_stderr = true);


--
-- Name: idx_agent_logs_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_logs_service ON public.agent_logs USING btree (agent_uuid, service_name, "timestamp" DESC);


--
-- Name: idx_agent_metrics_agent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_metrics_agent_time ON public.agent_metrics USING btree (agent_uuid, recorded_at DESC);


--
-- Name: idx_agent_tags_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tags_agent_uuid ON public.agent_tags USING btree (agent_uuid);


--
-- Name: idx_agent_target_state_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_target_state_agent_uuid ON public.agent_target_state USING btree (agent_uuid);


--
-- Name: idx_agent_updates_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_updates_agent_status ON public.agent_updates USING btree (agent_uuid, status);


--
-- Name: idx_agent_updates_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_updates_agent_uuid ON public.agent_updates USING btree (agent_uuid);


--
-- Name: idx_agent_updates_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_updates_created_at ON public.agent_updates USING btree (created_at DESC);


--
-- Name: idx_agent_updates_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_updates_scheduled ON public.agent_updates USING btree (scheduled_time) WHERE (scheduled_time IS NOT NULL);


--
-- Name: idx_agent_updates_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_updates_status ON public.agent_updates USING btree (status);


--
-- Name: idx_agents_mqtt_broker_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_mqtt_broker_id ON public.agents USING btree (mqtt_broker_id);


--
-- Name: idx_alert_rules_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_rules_device ON public.log_alert_rules USING btree (device_uuid);


--
-- Name: idx_alert_rules_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_rules_enabled ON public.log_alert_rules USING btree (is_enabled);


--
-- Name: idx_alert_rules_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_rules_severity ON public.log_alert_rules USING btree (severity);


--
-- Name: idx_alerts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_created_at ON public.log_alerts USING btree (created_at DESC);


--
-- Name: idx_alerts_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_device ON public.log_alerts USING btree (device_uuid);


--
-- Name: idx_alerts_first_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_first_seen ON public.log_alerts USING btree (first_seen DESC);


--
-- Name: idx_alerts_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_last_seen ON public.log_alerts USING btree (last_seen DESC);


--
-- Name: idx_alerts_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_rule ON public.log_alerts USING btree (rule_id);


--
-- Name: idx_alerts_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_severity ON public.log_alerts USING btree (severity);


--
-- Name: idx_alerts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alerts_status ON public.log_alerts USING btree (status);


--
-- Name: idx_anomaly_alerts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_alerts_created_at ON public.anomaly_alerts USING btree (created_at);


--
-- Name: idx_anomaly_alerts_device_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_alerts_device_uuid ON public.anomaly_alerts USING btree (device_uuid) WHERE (device_uuid IS NOT NULL);


--
-- Name: idx_anomaly_alerts_incident_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_alerts_incident_id ON public.anomaly_alerts USING btree (incident_id);


--
-- Name: idx_anomaly_alerts_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_alerts_severity ON public.anomaly_alerts USING btree (severity);


--
-- Name: idx_anomaly_events_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_agent_uuid ON public.anomaly_events USING btree (agent_uuid, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_device_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_device_name ON public.anomaly_events USING btree (device_name, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_device_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_device_type ON public.anomaly_events USING btree (device_type, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_device_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_device_uuid ON public.anomaly_events USING btree (device_uuid, timestamp_ms DESC) WHERE (device_uuid IS NOT NULL);


--
-- Name: idx_anomaly_events_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_fingerprint ON public.anomaly_events USING btree (fingerprint, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_metric; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_metric ON public.anomaly_events USING btree (metric, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_events_severity ON public.anomaly_events USING btree (severity, timestamp_ms DESC);


--
-- Name: idx_anomaly_incidents_acknowledged_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_acknowledged_at ON public.anomaly_incidents USING btree (acknowledged_at);


--
-- Name: idx_anomaly_incidents_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_agent_uuid ON public.anomaly_incidents USING btree (agent_uuid) WHERE (agent_uuid IS NOT NULL);


--
-- Name: idx_anomaly_incidents_device_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_device_name ON public.anomaly_incidents USING btree (device_name);


--
-- Name: idx_anomaly_incidents_feedback; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_feedback ON public.anomaly_incidents USING btree (feedback) WHERE (feedback IS NOT NULL);


--
-- Name: idx_anomaly_incidents_feedback_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_feedback_at ON public.anomaly_incidents USING btree (feedback_at DESC) WHERE (feedback_at IS NOT NULL);


--
-- Name: idx_anomaly_incidents_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_fingerprint ON public.anomaly_incidents USING btree (fingerprint);


--
-- Name: idx_anomaly_incidents_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_last_seen ON public.anomaly_incidents USING btree (last_seen);


--
-- Name: idx_anomaly_incidents_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_severity ON public.anomaly_incidents USING btree (severity);


--
-- Name: idx_anomaly_incidents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anomaly_incidents_status ON public.anomaly_incidents USING btree (status);


--
-- Name: idx_app_service_ids_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_service_ids_name ON public.app_service_ids USING btree (entity_name);


--
-- Name: idx_app_service_ids_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_service_ids_type ON public.app_service_ids USING btree (entity_type);


--
-- Name: idx_app_service_ids_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_service_ids_type_id ON public.app_service_ids USING btree (entity_type, entity_id);


--
-- Name: idx_applications_app_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_app_name ON public.applications USING btree (app_name);


--
-- Name: idx_applications_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_slug ON public.applications USING btree (slug);


--
-- Name: idx_approval_requests_image_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_requests_image_tag ON public.image_approval_requests USING btree (image_id, tag_name) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_approval_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_requests_status ON public.image_approval_requests USING btree (status);


--
-- Name: idx_audit_logs_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_agent_uuid ON public.audit_logs USING btree (agent_uuid);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_logs_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_event_type ON public.audit_logs USING btree (event_type);


--
-- Name: idx_audit_logs_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_severity ON public.audit_logs USING btree (severity);


--
-- Name: idx_audit_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_current_history_agent_reported_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_current_history_agent_reported_at ON public.agent_current_state_history USING btree (agent_uuid, reported_at DESC);


--
-- Name: idx_current_history_agent_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_current_history_agent_version ON public.agent_current_state_history USING btree (agent_uuid, version DESC);


--
-- Name: idx_dashboard_layouts_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_device ON public.dashboard_layouts USING btree (device_uuid);


--
-- Name: idx_dashboard_layouts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_owner ON public.dashboard_layouts USING btree (owner_key);


--
-- Name: idx_dashboard_layouts_owner_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_owner_device ON public.dashboard_layouts USING btree (owner_key, device_uuid) WHERE (device_uuid IS NOT NULL);


--
-- Name: idx_dashboard_layouts_owner_global; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_owner_global ON public.dashboard_layouts USING btree (owner_key) WHERE (device_uuid IS NULL);


--
-- Name: idx_dashboard_layouts_owner_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dashboard_layouts_owner_one_default ON public.dashboard_layouts USING btree (owner_key, COALESCE((device_uuid)::text, 'global'::text)) WHERE (is_default = true);


--
-- Name: idx_dashboard_layouts_owner_unique_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dashboard_layouts_owner_unique_name ON public.dashboard_layouts USING btree (owner_key, COALESCE((device_uuid)::text, 'global'::text), layout_name);


--
-- Name: idx_dashboard_layouts_share_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_share_token ON public.dashboard_layouts USING btree (share_token);


--
-- Name: idx_dashboard_layouts_widgets; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dashboard_layouts_widgets ON public.dashboard_layouts USING gin (widgets);


--
-- Name: idx_device_api_keys_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_api_keys_expires_at ON public.agent_api_keys USING btree (expires_at);


--
-- Name: idx_device_api_keys_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_api_keys_revoked ON public.agent_api_keys USING btree (revoked);


--
-- Name: idx_device_current_state_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_current_state_version ON public.agent_current_state USING btree (version);


--
-- Name: idx_device_flows_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_flows_active ON public.agent_flows USING btree (is_active);


--
-- Name: idx_device_flows_deployed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_flows_deployed_at ON public.agent_flows USING btree (deployed_at);


--
-- Name: idx_device_flows_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_flows_hash ON public.agent_flows USING btree (hash);


--
-- Name: idx_device_flows_subflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_flows_subflow_id ON public.agent_flows USING btree (subflow_id);


--
-- Name: idx_device_job_status_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_job_status_job_id ON public.agent_job_status USING btree (job_id);


--
-- Name: idx_device_job_status_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_job_status_status ON public.agent_job_status USING btree (status);


--
-- Name: idx_device_key_history_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_key_history_is_active ON public.agent_api_key_history USING btree (is_active);


--
-- Name: idx_device_key_history_issued_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_key_history_issued_at ON public.agent_api_key_history USING btree (issued_at DESC);


--
-- Name: idx_device_logs_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_logs_level ON public.agent_logs USING btree (level);


--
-- Name: idx_device_logs_service_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_logs_service_time ON public.agent_logs USING btree (service_name, "timestamp" DESC);


--
-- Name: idx_device_logs_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_logs_timestamp ON public.agent_logs USING btree ("timestamp" DESC);


--
-- Name: idx_device_metrics_top_processes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_metrics_top_processes ON public.agent_metrics USING gin (top_processes);


--
-- Name: idx_device_tags_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_tags_key ON public.agent_tags USING btree (key);


--
-- Name: idx_device_tags_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_tags_key_value ON public.agent_tags USING btree (key, value);


--
-- Name: idx_device_target_state_deployed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_target_state_deployed_at ON public.agent_target_state USING btree (last_deployed_at DESC);


--
-- Name: idx_device_target_state_needs_deployment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_target_state_needs_deployment ON public.agent_target_state USING btree (needs_deployment) WHERE (needs_deployment = true);


--
-- Name: idx_devices_api_key_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_api_key_expires_at ON public.agents USING btree (api_key_expires_at) WHERE ((api_key_expires_at IS NOT NULL) AND (is_active = true));


--
-- Name: idx_devices_challenge_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_challenge_expires ON public.agents USING btree (last_challenge_expires_at) WHERE (last_challenge_expires_at IS NOT NULL);


--
-- Name: idx_devices_fleet_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_fleet_id ON public.agents USING btree (fleet_id);


--
-- Name: idx_devices_fleet_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_fleet_uuid ON public.agents USING btree (fleet_uuid);


--
-- Name: idx_devices_fleet_uuid_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_fleet_uuid_status ON public.agents USING btree (fleet_uuid, is_online, is_active) WHERE (fleet_uuid IS NOT NULL);


--
-- Name: idx_devices_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_is_active ON public.agents USING btree (is_active);


--
-- Name: idx_devices_is_online; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_is_online ON public.agents USING btree (is_online);


--
-- Name: idx_devices_k8s_namespace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_k8s_namespace ON public.agents USING btree (k8s_namespace) WHERE (k8s_namespace IS NOT NULL);


--
-- Name: idx_devices_last_auth_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_last_auth_method ON public.agents USING btree (last_auth_method) WHERE (((last_auth_method)::text = 'bcrypt'::text) AND (is_active = true));


--
-- Name: idx_devices_last_auth_pop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_last_auth_pop ON public.agents USING btree (last_auth_method, last_auth_at) WHERE (((last_auth_method)::text = 'pop'::text) AND (is_active = true));


--
-- Name: idx_devices_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_location ON public.agents USING btree (location) WHERE (location IS NOT NULL);


--
-- Name: idx_devices_mqtt_broker_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_mqtt_broker_id ON public.agents USING btree (mqtt_broker_id);


--
-- Name: idx_devices_mqtt_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_mqtt_username ON public.agents USING btree (mqtt_username);


--
-- Name: idx_devices_network_interfaces; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_network_interfaces ON public.agents USING gin (network_interfaces);


--
-- Name: idx_devices_pop_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_pop_verified ON public.agents USING btree (pop_verified) WHERE (pop_verified = false);


--
-- Name: idx_devices_top_processes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_top_processes ON public.agents USING gin (top_processes);


--
-- Name: idx_devices_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_uuid ON public.agents USING btree (uuid);


--
-- Name: idx_devices_virtual_deployment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_virtual_deployment ON public.agents USING btree (device_type, deployment_status) WHERE ((device_type)::text = 'virtual'::text);


--
-- Name: idx_devices_virtual_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_virtual_status ON public.agents USING btree (device_type, deployment_status, status) WHERE ((device_type)::text = 'virtual'::text);


--
-- Name: idx_devices_vpn_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_vpn_config ON public.agents USING btree (vpn_config_id);


--
-- Name: idx_devices_vpn_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_vpn_enabled ON public.agents USING btree (vpn_enabled) WHERE (vpn_enabled = true);


--
-- Name: idx_devices_vpn_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_vpn_username ON public.agents USING btree (vpn_username) WHERE (vpn_username IS NOT NULL);


--
-- Name: idx_dictionary_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dictionary_device ON public.dictionary_entries USING btree (device_uuid);


--
-- Name: idx_dictionary_meta_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dictionary_meta_version ON public.dictionary_metadata USING btree (device_uuid, current_version);


--
-- Name: idx_dictionary_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dictionary_version ON public.dictionary_entries USING btree (device_uuid, version_added);


--
-- Name: idx_email_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_created_at ON public.email_logs USING btree (created_at);


--
-- Name: idx_email_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_job_id ON public.email_logs USING btree (job_id);


--
-- Name: idx_email_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_status ON public.email_logs USING btree (status);


--
-- Name: idx_email_logs_template_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_template_name ON public.email_logs USING btree (template_name);


--
-- Name: idx_email_logs_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_logs_user_email ON public.email_logs USING btree (user_email);


--
-- Name: idx_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enabled ON public.image_update_policies USING btree (enabled);


--
-- Name: idx_endpoints_agent_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_agent_protocol ON public.endpoints USING btree (agent_uuid, protocol);


--
-- Name: idx_endpoints_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_agent_status ON public.endpoints USING btree (agent_uuid, deployment_status);


--
-- Name: idx_endpoints_agent_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_agent_uuid ON public.endpoints USING btree (agent_uuid);


--
-- Name: idx_endpoints_config_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_config_id ON public.endpoints USING btree (config_id);


--
-- Name: idx_endpoints_deployment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_deployment_status ON public.endpoints USING btree (deployment_status);


--
-- Name: idx_endpoints_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_enabled ON public.endpoints USING btree (enabled);


--
-- Name: idx_endpoints_health_dashboard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_health_dashboard ON public.endpoints USING btree (agent_uuid, protocol, health_status) WHERE (health_status IS NOT NULL);


--
-- Name: idx_endpoints_health_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_health_status ON public.endpoints USING btree (health_status) WHERE (health_status IS NOT NULL);


--
-- Name: idx_endpoints_health_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_health_updated ON public.endpoints USING btree (agent_uuid, health_updated_at DESC) WHERE (health_updated_at IS NOT NULL);


--
-- Name: idx_endpoints_last_telemetry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_last_telemetry ON public.endpoints USING btree (agent_uuid, last_telemetry_at DESC) WHERE (last_telemetry_at IS NOT NULL);


--
-- Name: idx_endpoints_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_location ON public.endpoints USING btree (location) WHERE (location IS NOT NULL);


--
-- Name: idx_endpoints_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_protocol ON public.endpoints USING btree (protocol);


--
-- Name: idx_endpoints_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_sync ON public.endpoints USING btree (synced_to_config);


--
-- Name: idx_endpoints_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_endpoints_uuid ON public.endpoints USING btree (uuid);


--
-- Name: idx_enum_devices_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_devices_active ON public.dictionary_enum_devices USING btree (device_uuid, protocol, inactive);


--
-- Name: idx_enum_devices_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_devices_device ON public.dictionary_enum_devices USING btree (device_uuid);


--
-- Name: idx_enum_devices_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_devices_index ON public.dictionary_enum_devices USING btree (device_uuid, protocol, enum_index);


--
-- Name: idx_enum_devices_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_devices_protocol ON public.dictionary_enum_devices USING btree (device_uuid, protocol);


--
-- Name: idx_enum_metrics_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_metrics_active ON public.dictionary_enum_metrics USING btree (device_uuid, protocol, inactive);


--
-- Name: idx_enum_metrics_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_metrics_device ON public.dictionary_enum_metrics USING btree (device_uuid);


--
-- Name: idx_enum_metrics_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_metrics_index ON public.dictionary_enum_metrics USING btree (device_uuid, protocol, enum_index);


--
-- Name: idx_enum_metrics_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_metrics_protocol ON public.dictionary_enum_metrics USING btree (device_uuid, protocol);


--
-- Name: idx_enum_observations_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_observations_category ON public.dictionary_enum_observations USING btree (device_uuid, category);


--
-- Name: idx_enum_observations_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_observations_device ON public.dictionary_enum_observations USING btree (device_uuid);


--
-- Name: idx_enum_observations_namespace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_observations_namespace ON public.dictionary_enum_observations USING btree (device_uuid, namespace);


--
-- Name: idx_enum_observations_promoted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_observations_promoted ON public.dictionary_enum_observations USING btree (device_uuid, category, is_promoted);


--
-- Name: idx_enum_quality_codes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_quality_codes_active ON public.dictionary_enum_quality_codes USING btree (device_uuid, inactive);


--
-- Name: idx_enum_quality_codes_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_quality_codes_device ON public.dictionary_enum_quality_codes USING btree (device_uuid);


--
-- Name: idx_enum_quality_codes_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_quality_codes_index ON public.dictionary_enum_quality_codes USING btree (device_uuid, enum_index);


--
-- Name: idx_enum_units_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_units_active ON public.dictionary_enum_units USING btree (device_uuid, inactive);


--
-- Name: idx_enum_units_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_units_device ON public.dictionary_enum_units USING btree (device_uuid);


--
-- Name: idx_enum_units_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enum_units_index ON public.dictionary_enum_units USING btree (device_uuid, enum_index);


--
-- Name: idx_events_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_actor ON public.events USING btree (actor_type, actor_id);


--
-- Name: idx_events_aggregate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_aggregate ON public.events USING btree (aggregate_type, aggregate_id);


--
-- Name: idx_events_checksum; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_checksum ON public.events USING btree (checksum);


--
-- Name: idx_events_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_correlation_id ON public.events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_events_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_severity ON public.events USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: idx_events_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_source ON public.events USING btree (source) WHERE (source IS NOT NULL);


--
-- Name: idx_events_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_timestamp ON public.events USING btree ("timestamp" DESC);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.events USING btree (event_type);


--
-- Name: idx_fleet_billing_history_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_billing_history_fleet ON public.fleet_billing_history USING btree (fleet_id);


--
-- Name: idx_fleet_billing_history_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_billing_history_invoice ON public.fleet_billing_history USING btree (invoice_status) WHERE ((invoice_status)::text = 'pending'::text);


--
-- Name: idx_fleet_billing_history_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_billing_history_month ON public.fleet_billing_history USING btree (billing_month);


--
-- Name: idx_fleet_billing_history_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_billing_history_period ON public.fleet_billing_history USING btree (period_start, period_end);


--
-- Name: idx_fleet_namespaces_available_utilization; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_namespaces_available_utilization ON public.fleet_namespaces USING btree (available, utilization_percent) WHERE (available = true);


--
-- Name: idx_fleet_namespaces_last_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_namespaces_last_synced ON public.fleet_namespaces USING btree (last_synced DESC);


--
-- Name: idx_fleet_usage_events_fleet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_usage_events_fleet ON public.fleet_usage_events USING btree (fleet_id);


--
-- Name: idx_fleet_usage_events_fleet_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_usage_events_fleet_type ON public.fleet_usage_events USING btree (fleet_id, event_type);


--
-- Name: idx_fleet_usage_events_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_usage_events_timestamp ON public.fleet_usage_events USING btree (event_timestamp DESC);


--
-- Name: idx_fleet_usage_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_usage_events_type ON public.fleet_usage_events USING btree (event_type);


--
-- Name: idx_fleets_billing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_billing ON public.fleets USING btree (customer_id, billing_enabled) WHERE (billing_enabled = true);


--
-- Name: idx_fleets_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_customer ON public.fleets USING btree (customer_id);


--
-- Name: idx_fleets_environment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_environment ON public.fleets USING btree (customer_id, environment);


--
-- Name: idx_fleets_fleet_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_fleet_id ON public.fleets USING btree (fleet_id);


--
-- Name: idx_fleets_fleet_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fleets_fleet_uuid ON public.fleets USING btree (fleet_uuid);


--
-- Name: idx_fleets_k8s_namespace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_k8s_namespace ON public.fleets USING btree (k8s_namespace) WHERE (k8s_namespace IS NOT NULL);


--
-- Name: idx_fleets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_status ON public.fleets USING btree (customer_id, status);


--
-- Name: idx_fleets_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleets_type ON public.fleets USING btree (fleet_type);


--
-- Name: idx_housekeeper_runs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeper_runs_started_at ON public.housekeeper_runs USING btree (started_at DESC);


--
-- Name: idx_housekeeper_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeper_runs_status ON public.housekeeper_runs USING btree (status);


--
-- Name: idx_housekeeper_runs_task_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeper_runs_task_name ON public.housekeeper_runs USING btree (task_name);


--
-- Name: idx_image_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_pattern ON public.image_update_policies USING btree (image_pattern);


--
-- Name: idx_image_tags_image_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_tags_image_id ON public.image_tags USING btree (image_id);


--
-- Name: idx_image_tags_last_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_tags_last_updated ON public.image_tags USING btree (last_updated DESC);


--
-- Name: idx_image_tags_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_tags_metadata ON public.image_tags USING gin (metadata);


--
-- Name: idx_image_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_tags_tag ON public.image_tags USING btree (tag);


--
-- Name: idx_images_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_images_name ON public.images USING btree (image_name);


--
-- Name: idx_images_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_images_status ON public.images USING btree (approval_status);


--
-- Name: idx_images_watch_updates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_images_watch_updates ON public.images USING btree (watch_for_updates, approval_status) WHERE ((watch_for_updates = true) AND ((approval_status)::text = 'approved'::text));


--
-- Name: idx_job_executions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_executions_created_at ON public.job_executions USING btree (created_at DESC);


--
-- Name: idx_job_executions_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_executions_job_id ON public.job_executions USING btree (job_id);


--
-- Name: idx_job_executions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_executions_status ON public.job_executions USING btree (status);


--
-- Name: idx_job_templates_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_templates_category ON public.job_templates USING btree (category);


--
-- Name: idx_job_templates_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_templates_is_active ON public.job_templates USING btree (is_active);


--
-- Name: idx_mqtt_acls_clientid_access_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_acls_clientid_access_topic ON public.mqtt_acls USING btree (clientid, access, topic);


--
-- Name: idx_mqtt_acls_global_rules; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_acls_global_rules ON public.mqtt_acls USING btree (access, topic, priority) WHERE (username IS NULL);


--
-- Name: idx_mqtt_acls_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_acls_priority ON public.mqtt_acls USING btree (priority DESC);


--
-- Name: idx_mqtt_acls_topic_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_acls_topic_pattern ON public.mqtt_acls USING btree (topic text_pattern_ops);


--
-- Name: idx_mqtt_acls_username_access_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_acls_username_access_topic ON public.mqtt_acls USING btree (username, access, topic);


--
-- Name: idx_mqtt_broker_config_broker_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_broker_config_broker_type ON public.mqtt_broker_config USING btree (broker_type);


--
-- Name: idx_mqtt_broker_config_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_broker_config_is_active ON public.mqtt_broker_config USING btree (is_active);


--
-- Name: idx_mqtt_broker_config_is_default; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_broker_config_is_default ON public.mqtt_broker_config USING btree (is_default);


--
-- Name: idx_mqtt_broker_config_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_broker_config_name ON public.mqtt_broker_config USING btree (name);


--
-- Name: idx_mqtt_broker_stats_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_broker_stats_timestamp ON public.mqtt_broker_stats USING btree ("timestamp" DESC);


--
-- Name: idx_mqtt_schema_history_detected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_schema_history_detected ON public.mqtt_schema_history USING btree (detected_at DESC);


--
-- Name: idx_mqtt_schema_history_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_schema_history_topic ON public.mqtt_schema_history USING btree (topic);


--
-- Name: idx_mqtt_schema_history_topic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_schema_history_topic_id ON public.mqtt_schema_history USING btree (topic_id);


--
-- Name: idx_mqtt_topic_metrics_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topic_metrics_timestamp ON public.mqtt_topic_metrics USING btree ("timestamp" DESC);


--
-- Name: idx_mqtt_topic_metrics_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topic_metrics_topic ON public.mqtt_topic_metrics USING btree (topic);


--
-- Name: idx_mqtt_topic_metrics_topic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topic_metrics_topic_id ON public.mqtt_topic_metrics USING btree (topic_id);


--
-- Name: idx_mqtt_topic_metrics_topic_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topic_metrics_topic_time ON public.mqtt_topic_metrics USING btree (topic, "timestamp" DESC);


--
-- Name: idx_mqtt_topic_metrics_topic_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topic_metrics_topic_timestamp ON public.mqtt_topic_metrics USING btree (topic, "timestamp" DESC);


--
-- Name: idx_mqtt_topics_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topics_last_seen ON public.mqtt_topics USING btree (last_seen DESC);


--
-- Name: idx_mqtt_topics_message_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topics_message_type ON public.mqtt_topics USING btree (message_type);


--
-- Name: idx_mqtt_topics_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_topics_topic ON public.mqtt_topics USING btree (topic);


--
-- Name: idx_mqtt_topics_topic_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mqtt_topics_topic_id ON public.mqtt_topics USING btree (topic_id);


--
-- Name: idx_mqtt_users_auth_covering; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_users_auth_covering ON public.mqtt_users USING btree (username) INCLUDE (password_hash, is_superuser, is_active);


--
-- Name: idx_mqtt_users_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_users_is_active ON public.mqtt_users USING btree (is_active);


--
-- Name: idx_mqtt_users_superuser; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_users_superuser ON public.mqtt_users USING btree (username, is_superuser) WHERE (is_superuser = true);


--
-- Name: idx_mqtt_users_username_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_users_username_active ON public.mqtt_users USING btree (username, is_active) WHERE (is_active = true);


--
-- Name: idx_nodered_library_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodered_library_lookup ON public.nodered_library USING btree (type, name);


--
-- Name: idx_nodered_library_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodered_library_type ON public.nodered_library USING btree (type);


--
-- Name: idx_profile_configs_profile_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_configs_profile_name ON public.profile_configs USING btree (profile_name);


--
-- Name: idx_profile_configs_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profile_configs_protocol ON public.profile_configs USING btree (protocol);


--
-- Name: idx_provisioning_attempts_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_attempts_ip ON public.provisioning_attempts USING btree (ip_address, created_at);


--
-- Name: idx_provisioning_attempts_success; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_attempts_success ON public.provisioning_attempts USING btree (success);


--
-- Name: idx_provisioning_keys_deployment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_deployment_type ON public.provisioning_keys USING btree (deployment_type);


--
-- Name: idx_provisioning_keys_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_expires_at ON public.provisioning_keys USING btree (expires_at);


--
-- Name: idx_provisioning_keys_fast_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_fast_hash ON public.provisioning_keys USING btree (key_hash_fast);


--
-- Name: idx_provisioning_keys_fleet_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_fleet_id ON public.provisioning_keys USING btree (fleet_id);


--
-- Name: idx_provisioning_keys_fleet_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_fleet_uuid ON public.provisioning_keys USING btree (fleet_uuid);


--
-- Name: idx_provisioning_keys_fleet_uuid_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_fleet_uuid_active ON public.provisioning_keys USING btree (fleet_uuid, is_active) WHERE (fleet_uuid IS NOT NULL);


--
-- Name: idx_provisioning_keys_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_is_active ON public.provisioning_keys USING btree (is_active);


--
-- Name: idx_provisioning_keys_simulator_config; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisioning_keys_simulator_config ON public.provisioning_keys USING gin (simulator_config);


--
-- Name: idx_readings_agent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_agent_time ON public.readings USING btree (agent_uuid, "time" DESC);


--
-- Name: idx_readings_anomaly_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_anomaly_score ON public.readings USING btree (agent_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: idx_readings_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_device_time ON public.readings USING btree (agent_uuid, "time" DESC);


--
-- Name: idx_readings_extra; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_extra ON public.readings USING gin (extra);


--
-- Name: idx_readings_metric_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_metric_time ON public.readings USING btree (metric_name, "time" DESC);


--
-- Name: idx_readings_protocol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readings_protocol ON public.readings USING btree (protocol, "time" DESC);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_revoked ON public.refresh_tokens USING btree (revoked);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_releases_application_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_releases_application_id ON public.releases USING btree (application_id);


--
-- Name: idx_rollout_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_created ON public.image_rollouts USING btree (created_at);


--
-- Name: idx_rollout_events_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_events_device ON public.rollout_events USING btree (device_uuid);


--
-- Name: idx_rollout_events_rollout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_events_rollout ON public.rollout_events USING btree (rollout_id);


--
-- Name: idx_rollout_events_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_events_timestamp ON public.rollout_events USING btree ("timestamp");


--
-- Name: idx_rollout_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_events_type ON public.rollout_events USING btree (event_type);


--
-- Name: idx_rollout_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_id ON public.image_rollouts USING btree (rollout_id);


--
-- Name: idx_rollout_image; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_image ON public.image_rollouts USING btree (image_name, new_tag);


--
-- Name: idx_rollout_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollout_status ON public.image_rollouts USING btree (status);


--
-- Name: idx_scheduled_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_jobs_created_at ON public.scheduled_jobs USING btree (created_at DESC);


--
-- Name: idx_scheduled_jobs_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_jobs_is_active ON public.scheduled_jobs USING btree (is_active);


--
-- Name: idx_scheduled_jobs_schedule_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_jobs_schedule_id ON public.scheduled_jobs USING btree (schedule_id);


--
-- Name: idx_shell_audit_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_audit_device ON public.shell_audit_log USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_shell_audit_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_audit_session ON public.shell_audit_log USING btree (session_id);


--
-- Name: idx_shell_audit_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_audit_timestamp ON public.shell_audit_log USING btree ("timestamp" DESC);


--
-- Name: idx_shell_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_audit_user ON public.shell_audit_log USING btree (user_id, "timestamp" DESC);


--
-- Name: idx_shell_sessions_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_sessions_device ON public.shell_sessions USING btree (agent_uuid);


--
-- Name: idx_shell_sessions_device_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_sessions_device_status ON public.shell_sessions USING btree (agent_uuid, status);


--
-- Name: idx_shell_sessions_last_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_sessions_last_activity ON public.shell_sessions USING btree (last_activity);


--
-- Name: idx_shell_sessions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shell_sessions_status ON public.shell_sessions USING btree (status);


--
-- Name: idx_state_changes_correlation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_changes_correlation ON public.state_changes USING btree (correlation_id);


--
-- Name: idx_state_changes_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_changes_device_time ON public.state_changes USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_state_changes_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_changes_entity ON public.state_changes USING btree (entity_type, entity_id);


--
-- Name: idx_state_changes_triggered_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_changes_triggered_by ON public.state_changes USING btree (triggered_by);


--
-- Name: idx_system_config_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_config_key ON public.system_config USING btree (key);


--
-- Name: idx_tag_definitions_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tag_definitions_key ON public.tag_definitions USING btree (key);


--
-- Name: idx_target_history_agent_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_target_history_agent_version ON public.agent_target_state_history USING btree (agent_uuid, version DESC);


--
-- Name: idx_target_history_deployed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_target_history_deployed_at ON public.agent_target_state_history USING btree (agent_uuid, deployed_at DESC);


--
-- Name: idx_target_history_deployed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_target_history_deployed_by ON public.agent_target_state_history USING btree (deployed_by);


--
-- Name: idx_target_history_rollback; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_target_history_rollback ON public.agent_target_state_history USING btree (agent_uuid, is_rollback) WHERE (is_rollback = true);


--
-- Name: idx_traffic_device_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_device_endpoint ON public.agent_traffic_stats USING btree (device_id, endpoint);


--
-- Name: idx_traffic_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_device_time ON public.agent_traffic_stats USING btree (device_id, time_bucket DESC);


--
-- Name: idx_traffic_status_codes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_status_codes ON public.agent_traffic_stats USING gin (status_codes);


--
-- Name: idx_traffic_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traffic_time ON public.agent_traffic_stats USING btree (time_bucket DESC);


--
-- Name: idx_update_strategy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_update_strategy ON public.image_update_policies USING btree (update_strategy);


--
-- Name: idx_user_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_expires_at ON public.user_sessions USING btree (expires_at);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_is_active ON public.users USING btree (is_active);


--
-- Name: idx_users_mqtt_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_mqtt_username ON public.users USING btree (mqtt_username);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: idx_users_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_username ON public.users USING btree (username);


--
-- Name: idx_wg_ip_pool_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wg_ip_pool_available ON public.wg_ip_pool USING btree (is_available);


--
-- Name: idx_wg_peers_device_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wg_peers_device_id ON public.wg_peers USING btree (device_id);


--
-- Name: idx_wg_peers_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wg_peers_enabled ON public.wg_peers USING btree (enabled);


--
-- Name: readings_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX readings_time_idx ON public.readings USING btree ("time" DESC);


--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
--



--
-- Name: dashboard_layouts dashboard_layouts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dashboard_layouts_updated_at BEFORE UPDATE ON public.dashboard_layouts FOR EACH ROW EXECUTE FUNCTION public.update_dashboard_layouts_updated_at();


--
-- Name: agent_job_status device_job_status_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER device_job_status_updated_at BEFORE UPDATE ON public.agent_job_status FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_executions job_executions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_executions_updated_at BEFORE UPDATE ON public.job_executions FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_handlers job_handlers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_handlers_updated_at BEFORE UPDATE ON public.job_handlers FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_templates job_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER job_templates_updated_at BEFORE UPDATE ON public.job_templates FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: mqtt_topics mqtt_topics_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mqtt_topics_updated_at BEFORE UPDATE ON public.mqtt_topics FOR EACH ROW EXECUTE FUNCTION public.update_mqtt_topics_updated_at();


--
-- Name: scheduled_jobs scheduled_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scheduled_jobs_updated_at BEFORE UPDATE ON public.scheduled_jobs FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: agent_traffic_stats traffic_stats_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER traffic_stats_updated_at BEFORE UPDATE ON public.agent_traffic_stats FOR EACH ROW EXECUTE FUNCTION public.update_traffic_stats_updated_at();


--
-- Name: endpoints trg_update_endpoint_deployment_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_endpoint_deployment_timestamp BEFORE UPDATE ON public.endpoints FOR EACH ROW EXECUTE FUNCTION public.update_sensor_deployment_timestamp();


--
-- Name: endpoints trg_update_endpoint_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_endpoint_timestamp BEFORE UPDATE ON public.endpoints FOR EACH ROW EXECUTE FUNCTION public.update_device_sensor_timestamp();


--
-- Name: agents trigger_archive_agent_api_key; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_archive_agent_api_key BEFORE UPDATE OF device_api_key_hash ON public.agents FOR EACH ROW WHEN (((old.device_api_key_hash)::text IS DISTINCT FROM (new.device_api_key_hash)::text)) EXECUTE FUNCTION public.archive_agent_api_key();


--
-- Name: agent_current_state trigger_current_state_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_current_state_history AFTER INSERT OR UPDATE ON public.agent_current_state FOR EACH ROW EXECUTE FUNCTION public.create_current_state_history_snapshot();


--
-- Name: agent_target_state trigger_deployment_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_deployment_history AFTER INSERT OR UPDATE ON public.agent_target_state FOR EACH ROW EXECUTE FUNCTION public.create_deployment_history_snapshot();


--
-- Name: agent_flows trigger_device_flows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_device_flows_updated_at BEFORE UPDATE ON public.agent_flows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: agent_tags trigger_device_tags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_device_tags_updated_at BEFORE UPDATE ON public.agent_tags FOR EACH ROW EXECUTE FUNCTION public.update_device_tags_timestamp();


--
-- Name: mqtt_broker_config trigger_ensure_one_default_broker; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_ensure_one_default_broker BEFORE INSERT OR UPDATE OF is_default ON public.mqtt_broker_config FOR EACH ROW WHEN ((new.is_default = true)) EXECUTE FUNCTION public.ensure_one_default_broker();


--
-- Name: fleet_billing_history trigger_fleet_billing_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_fleet_billing_history_updated_at BEFORE UPDATE ON public.fleet_billing_history FOR EACH ROW EXECUTE FUNCTION public.update_fleet_billing_history_timestamp();


--
-- Name: fleets trigger_fleets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_fleets_updated_at BEFORE UPDATE ON public.fleets FOR EACH ROW EXECUTE FUNCTION public.update_fleet_timestamp();


--
-- Name: mqtt_broker_config trigger_mqtt_broker_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_mqtt_broker_config_updated_at BEFORE UPDATE ON public.mqtt_broker_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: nodered_credentials trigger_nodered_credentials_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_nodered_credentials_updated_at BEFORE UPDATE ON public.nodered_credentials FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_flows trigger_nodered_flows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_nodered_flows_updated_at BEFORE UPDATE ON public.nodered_flows FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_library trigger_nodered_library_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_nodered_library_updated_at BEFORE UPDATE ON public.nodered_library FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_sessions trigger_nodered_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_nodered_sessions_updated_at BEFORE UPDATE ON public.nodered_sessions FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_settings trigger_nodered_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_nodered_settings_updated_at BEFORE UPDATE ON public.nodered_settings FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: profile_configs trigger_profile_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_profile_configs_updated_at BEFORE UPDATE ON public.profile_configs FOR EACH ROW EXECUTE FUNCTION public.update_profile_configs_updated_at();


--
-- Name: tag_definitions trigger_tag_definitions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_tag_definitions_updated_at BEFORE UPDATE ON public.tag_definitions FOR EACH ROW EXECUTE FUNCTION public.update_tag_definitions_timestamp();


--
-- Name: agent_updates update_agent_updates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_agent_updates_updated_at BEFORE UPDATE ON public.agent_updates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: applications update_applications_modified_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_applications_modified_at BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: agents update_devices_modified_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_devices_modified_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: image_rollouts update_image_rollouts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_image_rollouts_updated_at BEFORE UPDATE ON public.image_rollouts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: image_update_policies update_image_update_policies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_image_update_policies_updated_at BEFORE UPDATE ON public.image_update_policies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: log_alert_rules update_log_alert_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_log_alert_rules_updated_at BEFORE UPDATE ON public.log_alert_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: log_alerts update_log_alerts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_log_alerts_updated_at BEFORE UPDATE ON public.log_alerts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: releases update_releases_modified_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_releases_modified_at BEFORE UPDATE ON public.releases FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: agent_api_key_history agent_api_key_history_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_key_history
    ADD CONSTRAINT agent_api_key_history_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_api_keys agent_api_keys_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_api_keys
    ADD CONSTRAINT agent_api_keys_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_current_state agent_current_state_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_current_state
    ADD CONSTRAINT agent_current_state_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_flows agent_flows_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_flows
    ADD CONSTRAINT agent_flows_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_job_status agent_job_status_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_job_status
    ADD CONSTRAINT agent_job_status_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_tags agent_tags_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tags
    ADD CONSTRAINT agent_tags_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_target_state agent_target_state_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state
    ADD CONSTRAINT agent_target_state_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_target_state_history agent_target_state_history_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_target_state_history
    ADD CONSTRAINT agent_target_state_history_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_updates agent_updates_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_updates
    ADD CONSTRAINT agent_updates_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: anomaly_alerts anomaly_alerts_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.anomaly_incidents(incident_id);


--
-- Name: audit_logs audit_logs_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE SET NULL;


--
-- Name: dashboard_layouts dashboard_layouts_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_entries device_dictionary_entries_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_metadata device_dictionary_metadata_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_metadata
    ADD CONSTRAINT device_dictionary_metadata_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_job_status device_job_status_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_job_status
    ADD CONSTRAINT device_job_status_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.job_executions(job_id) ON DELETE CASCADE;


--
-- Name: agent_tags device_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tags
    ADD CONSTRAINT device_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agents devices_provisioned_by_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT devices_provisioned_by_key_id_fkey FOREIGN KEY (provisioned_by_key_id) REFERENCES public.provisioning_keys(id) ON DELETE SET NULL;


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_observations dictionary_enum_observations_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: endpoints endpoints_agent_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_agent_uuid_fkey FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: agent_logs fk_agent_logs_agent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_logs
    ADD CONSTRAINT fk_agent_logs_agent FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: shell_sessions fk_shell_sessions_device; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shell_sessions
    ADD CONSTRAINT fk_shell_sessions_device FOREIGN KEY (agent_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: image_approval_requests image_approval_requests_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_approval_requests
    ADD CONSTRAINT image_approval_requests_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: image_rollouts image_rollouts_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.image_update_policies(id) ON DELETE SET NULL;


--
-- Name: image_tags image_tags_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: job_executions job_executions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.job_templates(id) ON DELETE SET NULL;


--
-- Name: log_alert_rules log_alert_rules_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alert_rules
    ADD CONSTRAINT log_alert_rules_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: log_alerts log_alerts_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: log_alerts log_alerts_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.log_alert_rules(id) ON DELETE CASCADE;


--
-- Name: provisioning_attempts provisioning_attempts_provisioning_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioning_attempts
    ADD CONSTRAINT provisioning_attempts_provisioning_key_id_fkey FOREIGN KEY (provisioning_key_id) REFERENCES public.provisioning_keys(id) ON DELETE SET NULL;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: releases releases_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: shell_audit_log shell_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shell_audit_log
    ADD CONSTRAINT shell_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: state_changes state_changes_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_changes
    ADD CONSTRAINT state_changes_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.agents(uuid) ON DELETE CASCADE;


--
-- Name: tag_definitions tag_definitions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

