-- ============================================================================
-- SQUASHED INITIAL SCHEMA MIGRATION
-- ============================================================================
-- This migration consolidates all 161 previous migrations into a single
-- schema snapshot for faster deployments (especially useful for new customer
-- instances in the multi-tenant Kubernetes environment).
--
-- Generated: 2026-02-26 20:04:41
-- Purpose: Replace migrations 001-161 with this single snapshot
-- ============================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: timescaledb; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;


--
-- Name: EXTENSION timescaledb; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION timescaledb IS 'Enables scalable inserts and complex queries for time-series data (Community Edition)';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: anomaly_events_integer_now(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.anomaly_events_integer_now() RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  SELECT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000;
$$;


--
-- Name: archive_device_api_key(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.archive_device_api_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only archive if:
    -- 1. Key actually changed
    -- 2. Old key is NOT NULL (avoid constraint violation on first provisioning)
    IF OLD.device_api_key_hash IS DISTINCT FROM NEW.device_api_key_hash 
       AND OLD.device_api_key_hash IS NOT NULL THEN
        INSERT INTO device_api_key_history (
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
-- Name: FUNCTION archive_device_api_key(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.archive_device_api_key() IS 'Archives old device API key when changed (skips if old key is NULL)';


--
-- Name: calculate_fleet_cost(integer, integer, character varying); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.calculate_fleet_cost(p_agent_count integer, p_devices_per_agent integer, p_billing_mode character varying DEFAULT 'hourly'::character varying) RETURNS TABLE(resource_tier character varying, cost_per_hour numeric, cost_per_month numeric, total_monthly_cost numeric)
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: FUNCTION calculate_fleet_cost(p_agent_count integer, p_devices_per_agent integer, p_billing_mode character varying); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.calculate_fleet_cost(p_agent_count integer, p_devices_per_agent integer, p_billing_mode character varying) IS 'Calculate estimated costs for a virtual fleet configuration';


--
-- Name: cleanup_old_housekeeper_runs(integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: cleanup_old_traffic_stats(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.cleanup_old_traffic_stats(retention_days integer DEFAULT 90) RETURNS integer
    LANGUAGE plpgsql
    AS $$
    DECLARE
      deleted_count INTEGER;
    BEGIN
      DELETE FROM device_traffic_stats
      WHERE time_bucket < NOW() - (retention_days || ' days')::INTERVAL;
      
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      
      RETURN deleted_count;
    END;
    $$;


--
-- Name: FUNCTION cleanup_old_traffic_stats(retention_days integer); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.cleanup_old_traffic_stats(retention_days integer) IS 'Deletes traffic stats older than specified days (default 90). Returns count of deleted rows.';


--
-- Name: close_fleet_billing_period(character varying, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: postgres
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
$$;


--
-- Name: FUNCTION close_fleet_billing_period(p_fleet_id character varying, p_period_end timestamp without time zone); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.close_fleet_billing_period(p_fleet_id character varying, p_period_end timestamp without time zone) IS 'Finalize billing period and create invoice record';


--
-- Name: compare_deployment_versions(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
    FROM device_target_state_history
    WHERE device_uuid = p_device_uuid AND version = p_from_version;
    
    SELECT apps INTO v_to_apps
    FROM device_target_state_history
    WHERE device_uuid = p_device_uuid AND version = p_to_version;
    
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
-- Name: count_devices_by_tags(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.count_devices_by_tags(p_tag_selectors jsonb) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    SELECT COUNT(*)::INTEGER FROM find_devices_by_tags(p_tag_selectors);
$$;


--
-- Name: FUNCTION count_devices_by_tags(p_tag_selectors jsonb); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.count_devices_by_tags(p_tag_selectors jsonb) IS 'Count devices matching tag selectors';


--
-- Name: create_deployment_history_snapshot(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_deployment_history_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only create snapshot when version increments (deployment happens)
    IF (TG_OP = 'UPDATE' AND NEW.version > OLD.version) OR 
       (TG_OP = 'INSERT' AND NEW.version > 1) THEN
        
        -- Insert snapshot into history
        INSERT INTO device_target_state_history (
            device_uuid,
            version,
            apps,
            config,
            deployed_at,
            deployed_by,
            apps_count,
            services_count
        ) VALUES (
            NEW.device_uuid,
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
-- Name: create_device_logs_partition(date); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_device_logs_partition(partition_date date) RETURNS text
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
        'CREATE TABLE %I PARTITION OF device_logs 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$;


--
-- Name: create_device_logs_partitions_range(integer, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_device_logs_partitions_range(start_months_ago integer, end_months_ahead integer) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_month DATE;
    i INTEGER;
BEGIN
    FOR i IN start_months_ago..end_months_ahead LOOP
        current_month := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL)::DATE;
        RETURN QUERY SELECT create_device_logs_partition(current_month);
    END LOOP;
END;
$$;


--
-- Name: create_device_metrics_partition(date); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_device_metrics_partition(partition_date date) RETURNS text
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
        'CREATE TABLE %I PARTITION OF device_metrics 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        start_date,
        end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$;


--
-- Name: create_device_metrics_partitions_range(integer, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_device_metrics_partitions_range(start_days_ago integer, end_days_ahead integer) RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    current_day DATE;
    i INTEGER;
BEGIN
    FOR i IN start_days_ago..end_days_ahead LOOP
        current_day := CURRENT_DATE + (i || ' days')::INTERVAL;
        RETURN QUERY SELECT create_device_metrics_partition(current_day);
    END LOOP;
END;
$$;


--
-- Name: create_events_partition(date); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_events_partition(partition_date date) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    partition_name := 'events_' || TO_CHAR(partition_date, 'YYYY_MM_DD');
    start_date := partition_date;
    end_date := partition_date + INTERVAL '1 day';
    
    IF EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public' AND tablename = partition_name
    ) THEN
        RETURN 'EXISTS: ' || partition_name;
    END IF;
    
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF events 
         FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );
    
    RETURN 'CREATED: ' || partition_name;
END;
$$;


--
-- Name: create_state_snapshot(uuid, character varying, jsonb, character varying, text); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: drop_old_device_logs_partitions(integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: drop_old_device_metrics_partitions(integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: drop_old_event_partitions(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.drop_old_event_partitions() RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE
  partition_record RECORD;
  partition_date DATE;
  min_retention_days INTEGER;
BEGIN
  -- Get the minimum retention days across all event types
  -- (we keep partitions based on the longest retention requirement)
  SELECT MIN(retention_days) INTO min_retention_days FROM event_types;
  
  -- Default to 90 days if no retention policies set
  min_retention_days := COALESCE(min_retention_days, 90);
  
  FOR partition_record IN 
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename LIKE 'events_%'
    AND tablename ~ '^events_\d{4}_\d{2}_\d{2}$'
  LOOP
    -- Extract date from partition name (format: events_YYYY_MM_DD)
    partition_date := TO_DATE(
      SUBSTRING(partition_record.tablename FROM 8), 
      'YYYY_MM_DD'
    );
    
    -- Drop partition if older than minimum retention period
    IF partition_date < CURRENT_DATE - min_retention_days THEN
      EXECUTE FORMAT('DROP TABLE IF EXISTS %I', partition_record.tablename);
      RAISE NOTICE 'Dropped old partition: %', partition_record.tablename;
    END IF;
  END LOOP;
END;
$_$;


--
-- Name: FUNCTION drop_old_event_partitions(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.drop_old_event_partitions() IS 'Drop event partitions older than the minimum retention period across all event types';


--
-- Name: ensure_device_logs_partitions(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.ensure_device_logs_partitions() RETURNS TABLE(result text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Create partitions for current month + next 3 months
    RETURN QUERY SELECT * FROM create_device_logs_partitions_range(0, 3);
END;
$$;


--
-- Name: ensure_one_default_broker(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: find_devices_by_tags(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
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
            'EXISTS (SELECT 1 FROM device_tags WHERE device_uuid = d.uuid AND key = %L AND value = %L)',
            tag_key, tag_value
        );
    END LOOP;
    
    -- If no selectors provided, return all devices
    IF array_length(conditions, 1) IS NULL THEN
        RETURN QUERY SELECT d.uuid FROM devices d;
        RETURN;
    END IF;
    
    -- Build and execute dynamic query
    query := format('SELECT d.uuid FROM devices d WHERE %s', array_to_string(conditions, ' AND '));
    RETURN QUERY EXECUTE query;
END;
$$;


--
-- Name: FUNCTION find_devices_by_tags(p_tag_selectors jsonb); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.find_devices_by_tags(p_tag_selectors jsonb) IS 'Find devices matching all specified tags (AND logic)';


--
-- Name: get_aggregate_events(character varying, character varying, bigint); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_customer_fleets(uuid); Type: FUNCTION; Schema: public; Owner: postgres
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
    LEFT JOIN devices d ON d.fleet_id = f.fleet_id
    WHERE f.customer_id = p_customer_id
      AND f.status != 'deleted'
    GROUP BY f.fleet_uuid, f.fleet_id, f.fleet_name, f.fleet_type, f.status, 
             f.environment, f.billing_enabled, f.current_cost, f.created_at
    ORDER BY f.created_at DESC;
END;
$$;


--
-- Name: get_deployment_history(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
    FROM device_target_state_history h
    WHERE h.device_uuid = p_device_uuid
    ORDER BY h.version DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: get_deployment_stats(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
        FROM device_target_state_history h
        WHERE (p_device_uuid IS NULL OR h.device_uuid = p_device_uuid)
          AND h.deployed_at > NOW() - (p_days_back || ' days')::INTERVAL
    ),
    timing AS (
        SELECT AVG(deployed_at - LAG(deployed_at) OVER (PARTITION BY device_uuid ORDER BY version)) as avg_interval
        FROM device_target_state_history h
        WHERE (p_device_uuid IS NULL OR h.device_uuid = p_device_uuid)
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
-- Name: get_deployment_version(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
    FROM device_target_state_history h
    WHERE h.device_uuid = p_device_uuid
      AND h.version = p_version;
END;
$$;


--
-- Name: get_device_latest_update(uuid); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_device_logs_partition_stats(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_device_metrics_partition_stats(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_device_tags_json(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_device_tags_json(p_device_uuid uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        jsonb_object_agg(key, value),
        '{}'::jsonb
    )
    FROM device_tags
    WHERE device_uuid = p_device_uuid;
$$;


--
-- Name: FUNCTION get_device_tags_json(p_device_uuid uuid); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.get_device_tags_json(p_device_uuid uuid) IS 'Get all tags for a device as JSON object';


--
-- Name: get_event_chain(uuid); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_event_retention_days(character varying); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: FUNCTION get_event_retention_days(p_event_type character varying); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.get_event_retention_days(p_event_type character varying) IS 'Get retention period in days for a given event type';


--
-- Name: get_event_stats(integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_fleet_stats(character varying); Type: FUNCTION; Schema: public; Owner: postgres
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
$$;


--
-- Name: get_housekeeper_stats(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: FUNCTION get_housekeeper_stats(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.get_housekeeper_stats() IS 'Returns summarized stats for housekeeper tasks (fixed ambiguous alias issue)';


--
-- Name: get_pending_updates(integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_reconciliation_summary(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_state_diff(uuid, character varying, integer, integer); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_topic_id(character varying); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: get_topic_name(uuid); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: log_state_change(uuid, character varying, character varying, character varying, character varying, text, jsonb, jsonb, character varying, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: publish_event(character varying, character varying, character varying, jsonb, character varying, uuid, uuid, jsonb, character varying, character varying, character varying, character varying); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: FUNCTION publish_event(p_event_type character varying, p_aggregate_type character varying, p_aggregate_id character varying, p_data jsonb, p_source character varying, p_correlation_id uuid, p_causation_id uuid, p_metadata jsonb, p_actor_type character varying, p_actor_id character varying, p_severity character varying, p_impact character varying); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.publish_event(p_event_type character varying, p_aggregate_type character varying, p_aggregate_id character varying, p_data jsonb, p_source character varying, p_correlation_id uuid, p_causation_id uuid, p_metadata jsonb, p_actor_type character varying, p_actor_id character varying, p_severity character varying, p_impact character varying) IS 'Publish event with metadata enrichment (actor, severity, impact)';


--
-- Name: rebuild_device_state(uuid); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: record_fleet_usage_event(character varying, character varying, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
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
$$;


--
-- Name: FUNCTION record_fleet_usage_event(p_fleet_id character varying, p_event_type character varying, p_triggered_by character varying, p_details jsonb); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.record_fleet_usage_event(p_fleet_id character varying, p_event_type character varying, p_triggered_by character varying, p_details jsonb) IS 'Record a fleet lifecycle event with current state snapshot';


--
-- Name: refresh_all_catalog_views(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: FUNCTION refresh_all_catalog_views(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_all_catalog_views() IS 'Refresh all metric catalog views. Call this periodically (e.g., every 30 seconds via cron).';


--
-- Name: refresh_all_dashboard_views(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: FUNCTION refresh_all_dashboard_views(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_all_dashboard_views() IS 'Refresh all metrics dashboard materialized views. Call this periodically (e.g., every 30 seconds via cron).';


--
-- Name: refresh_endpoint_devices(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_endpoint_devices() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY endpoint_devices;
END;
$$;


--
-- Name: FUNCTION refresh_endpoint_devices(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_endpoint_devices() IS 'Refresh endpoint_devices materialized view. Call periodically (e.g., every 5 minutes).';


--
-- Name: refresh_latest_readings(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_latest_readings() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY latest_readings;
END;
$$;


--
-- Name: FUNCTION refresh_latest_readings(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_latest_readings() IS 'Refresh latest_readings materialized view. Call frequently (e.g., every 30 seconds).';


--
-- Name: refresh_metric_catalog(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_metric_catalog() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY metric_catalog;
END;
$$;


--
-- Name: FUNCTION refresh_metric_catalog(); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.refresh_metric_catalog() IS 'Refresh metric_catalog materialized view. Call periodically (e.g., every 5 minutes).';


--
-- Name: refresh_recent_anomalies(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.refresh_recent_anomalies() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY recent_anomalies;
END;
$$;


--
-- Name: update_dashboard_layouts_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_device_sensor_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_device_tags_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_fleet_billing_history_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_fleet_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_job_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_modified_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_mqtt_topics_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_nodered_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_profile_configs_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_sensor_deployment_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_tag_definitions_timestamp(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_traffic_stats_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
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
-- Name: _compressed_hypertable_16; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_16 (
);



--
-- Name: _compressed_hypertable_2; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_2 (
);



--
-- Name: _compressed_hypertable_24; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_24 (
);



--
-- Name: _compressed_hypertable_26; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_26 (
);



--
-- Name: _compressed_hypertable_6; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._compressed_hypertable_6 (
);



--
-- Name: device_metrics; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_metrics (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: _direct_view_10; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_10 AS
 SELECT public.time_bucket('00:05:00'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('00:05:00'::interval, recorded_at)), device_uuid;



--
-- Name: _direct_view_11; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_11 AS
 SELECT public.time_bucket('01:00:00'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('01:00:00'::interval, recorded_at)), device_uuid;



--
-- Name: _direct_view_12; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_12 AS
 SELECT public.time_bucket('1 day'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('1 day'::interval, recorded_at)), device_uuid;



--
-- Name: readings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.readings (
    "time" timestamp with time zone NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: TABLE readings; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.readings IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 96%+';


--
-- Name: COLUMN readings.metric_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.metric_name IS 'Modbus register, OPC UA NodeId, MQTT topic, or sensor name';


--
-- Name: COLUMN readings.quality; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.quality IS 'Data quality: good, bad, uncertain';


--
-- Name: COLUMN readings.extra; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.extra IS 'Extra metadata JSONB field. Can include: deviceName (endpoint device name), location (endpoint device location), and other protocol-specific metadata';


--
-- Name: COLUMN readings.anomaly_score; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.anomaly_score IS 'Anomaly score from edge AI (0-1, higher = more anomalous)';


--
-- Name: COLUMN readings.anomaly_threshold; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.anomaly_threshold IS 'Threshold used for anomaly detection';


--
-- Name: COLUMN readings.baseline_samples; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.baseline_samples IS 'Number of baseline samples used for detection';


--
-- Name: COLUMN readings.detection_methods; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.readings.detection_methods IS 'Array of detection methods applied';


--
-- Name: _direct_view_13; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_13 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(anomaly_score) AS avg_anomaly_score,
    min(anomaly_score) AS min_anomaly_score,
    max(anomaly_score) AS max_anomaly_score,
    stddev(anomaly_score) AS stddev_anomaly_score,
    count(*) FILTER (WHERE (anomaly_score IS NOT NULL)) AS scored_count,
    count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)) AS high_anomaly_count,
    (((count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS high_anomaly_percent,
    public.last(anomaly_score, "time") AS last_anomaly_score,
    public.last("time", "time") AS last_scored_time,
    avg(anomaly_threshold) AS avg_threshold,
    avg(baseline_samples) AS avg_baseline_samples
   FROM public.readings
  WHERE (anomaly_score IS NOT NULL)
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _direct_view_14; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_14 AS
 SELECT public.time_bucket('1 day'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(anomaly_score) AS avg_anomaly_score,
    min(anomaly_score) AS min_anomaly_score,
    max(anomaly_score) AS max_anomaly_score,
    stddev(anomaly_score) AS stddev_anomaly_score,
    count(*) FILTER (WHERE (anomaly_score IS NOT NULL)) AS scored_count,
    count(*) FILTER (WHERE (anomaly_score > (0.9)::double precision)) AS critical_count,
    count(*) FILTER (WHERE ((anomaly_score > (0.7)::double precision) AND (anomaly_score <= (0.9)::double precision))) AS high_count,
    count(*) FILTER (WHERE ((anomaly_score > (0.5)::double precision) AND (anomaly_score <= (0.7)::double precision))) AS medium_count,
    count(*) FILTER (WHERE (anomaly_score <= (0.5)::double precision)) AS low_count,
    (((count(*) FILTER (WHERE (anomaly_score > (0.9)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS critical_percent,
    (((count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS high_plus_percent,
    avg(anomaly_threshold) AS avg_threshold,
    avg(baseline_samples) AS avg_baseline_samples
   FROM public.readings
  WHERE (anomaly_score IS NOT NULL)
  GROUP BY (public.time_bucket('1 day'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _direct_view_17; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_17 AS
 SELECT public.time_bucket('00:01:00'::interval, "time") AS bucket,
    device_uuid AS agent_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    protocol,
    metric_name,
    unit,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    count(*) AS sample_count,
    ((sum(
        CASE
            WHEN (quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) AS quality_ratio,
    max(anomaly_score) AS max_anomaly_score,
    avg(anomaly_score) FILTER (WHERE (anomaly_score IS NOT NULL)) AS avg_anomaly_score
   FROM public.readings
  GROUP BY (public.time_bucket('00:01:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), protocol, metric_name, unit;



--
-- Name: _direct_view_18; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_18 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid AS agent_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    protocol,
    metric_name,
    unit,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    ((sum(
        CASE
            WHEN (quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), protocol, metric_name, unit;



--
-- Name: _direct_view_21; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_21 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    public.first(value, "time") AS first_value,
    public.last(value, "time") AS last_value,
    public.last("time", "time") AS last_time,
    ((sum(
        CASE
            WHEN (quality = 'GOOD'::text) THEN 1
            ELSE 0
        END))::double precision / (count(*))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _direct_view_22; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_22 AS
 SELECT public.time_bucket('1 day'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    public.first(value, "time") AS first_value,
    public.last(value, "time") AS last_value,
    public.last("time", "time") AS last_time,
    ((sum(
        CASE
            WHEN (quality = 'GOOD'::text) THEN 1
            ELSE 0
        END))::double precision / (count(*))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('1 day'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: device_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_logs (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    service_name character varying(255),
    message text NOT NULL,
    level character varying(50) DEFAULT 'info'::character varying,
    is_system boolean DEFAULT false,
    is_stderr boolean DEFAULT false,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE device_logs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_logs IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 98%+';


--
-- Name: _direct_view_3; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_3 AS
 SELECT device_uuid,
    service_name,
    public.time_bucket('00:05:00'::interval, "timestamp") AS bucket,
    count(*) AS total_count,
    count(*) FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_count,
    count(*) FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warn_count,
    count(*) FILTER (WHERE (message ~* 'info|\[info\]'::text)) AS info_count,
    count(*) FILTER (WHERE (message ~* 'debug|trace|\[debug\]'::text)) AS debug_count,
    public.first(message, "timestamp") AS first_message,
    public.last(message, "timestamp") AS last_message,
    array_agg(json_build_object('timestamp', "timestamp", 'message', "left"(message, 500)) ORDER BY "timestamp") FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_samples,
    array_agg(json_build_object('timestamp', "timestamp", 'message', "left"(message, 500)) ORDER BY "timestamp") FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warning_samples,
    min("timestamp") AS bucket_start,
    max("timestamp") AS bucket_end
   FROM public.device_logs
  GROUP BY device_uuid, service_name, (public.time_bucket('00:05:00'::interval, "timestamp"));



--
-- Name: _direct_view_4; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._direct_view_4 AS
 SELECT device_uuid,
    service_name,
    public.time_bucket('01:00:00'::interval, "timestamp") AS bucket,
    count(*) AS total_count,
    count(*) FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_count,
    count(*) FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warn_count,
    count(*) FILTER (WHERE (message ~* 'info|\[info\]'::text)) AS info_count,
    count(*) FILTER (WHERE (message ~* 'debug|trace|\[debug\]'::text)) AS debug_count,
    min("timestamp") AS bucket_start,
    max("timestamp") AS bucket_end
   FROM public.device_logs
  GROUP BY device_uuid, service_name, (public.time_bucket('01:00:00'::interval, "timestamp"));



--
-- Name: _materialized_hypertable_10; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_10 (
    bucket timestamp without time zone NOT NULL,
    device_uuid uuid,
    avg_cpu_usage numeric,
    max_cpu_usage numeric,
    min_cpu_usage numeric,
    avg_cpu_temp numeric,
    max_cpu_temp numeric,
    avg_memory_usage numeric,
    max_memory_usage bigint,
    avg_memory_total numeric,
    avg_storage_usage numeric,
    max_storage_usage bigint,
    avg_storage_total numeric,
    sample_count bigint
);



--
-- Name: _hyper_10_2_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_10_2_chunk (
    CONSTRAINT constraint_2 CHECK (((bucket >= '2025-12-18 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_10);



--
-- Name: _hyper_10_89_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_10_89_chunk (
    CONSTRAINT constraint_81 CHECK (((bucket >= '2026-02-26 00:00:00'::timestamp without time zone) AND (bucket < '2026-05-07 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_10);



--
-- Name: _materialized_hypertable_11; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_11 (
    bucket timestamp without time zone NOT NULL,
    device_uuid uuid,
    avg_cpu_usage numeric,
    max_cpu_usage numeric,
    min_cpu_usage numeric,
    avg_cpu_temp numeric,
    max_cpu_temp numeric,
    avg_memory_usage numeric,
    max_memory_usage bigint,
    avg_memory_total numeric,
    avg_storage_usage numeric,
    max_storage_usage bigint,
    avg_storage_total numeric,
    sample_count bigint
);



--
-- Name: _hyper_11_3_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_11_3_chunk (
    CONSTRAINT constraint_3 CHECK (((bucket >= '2025-12-18 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_11);



--
-- Name: _hyper_11_90_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_11_90_chunk (
    CONSTRAINT constraint_82 CHECK (((bucket >= '2026-02-26 00:00:00'::timestamp without time zone) AND (bucket < '2026-05-07 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_11);



--
-- Name: _materialized_hypertable_12; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_12 (
    bucket timestamp without time zone NOT NULL,
    device_uuid uuid,
    avg_cpu_usage numeric,
    max_cpu_usage numeric,
    min_cpu_usage numeric,
    avg_cpu_temp numeric,
    max_cpu_temp numeric,
    avg_memory_usage numeric,
    max_memory_usage bigint,
    avg_memory_total numeric,
    avg_storage_usage numeric,
    max_storage_usage bigint,
    avg_storage_total numeric,
    sample_count bigint
);



--
-- Name: _hyper_12_47_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_12_47_chunk (
    CONSTRAINT constraint_47 CHECK (((bucket >= '2025-12-18 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_12);



--
-- Name: _materialized_hypertable_13; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_13 (
    bucket timestamp with time zone NOT NULL,
    device_uuid uuid,
    device_name text,
    metric_name text,
    protocol text,
    avg_anomaly_score double precision,
    min_anomaly_score real,
    max_anomaly_score real,
    stddev_anomaly_score double precision,
    scored_count bigint,
    high_anomaly_count bigint,
    high_anomaly_percent double precision,
    last_anomaly_score real,
    last_scored_time timestamp with time zone,
    avg_threshold double precision,
    avg_baseline_samples numeric
);



--
-- Name: _hyper_13_74_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_13_74_chunk (
    CONSTRAINT constraint_67 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_13);



--
-- Name: _materialized_hypertable_14; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_14 (
    bucket timestamp with time zone NOT NULL,
    device_uuid uuid,
    device_name text,
    metric_name text,
    protocol text,
    avg_anomaly_score double precision,
    min_anomaly_score real,
    max_anomaly_score real,
    stddev_anomaly_score double precision,
    scored_count bigint,
    critical_count bigint,
    high_count bigint,
    medium_count bigint,
    low_count bigint,
    critical_percent double precision,
    high_plus_percent double precision,
    avg_threshold double precision,
    avg_baseline_samples numeric
);



--
-- Name: _hyper_14_79_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_14_79_chunk (
    CONSTRAINT constraint_72 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_14);



--
-- Name: anomaly_events; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT anomaly_events_device_type_check CHECK ((device_type = ANY (ARRAY['modbus'::text, 'opcua'::text, 'bacnet'::text, 'mqtt'::text, 'system'::text]))),
    CONSTRAINT anomaly_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);



--
-- Name: TABLE anomaly_events; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.anomaly_events IS 'TimescaleDB hypertable: Raw anomaly events from edge devices (high-volume time-series). Partitioned by timestamp_ms with 1-day chunks, compressed after 14 days, retained for 90 days.';


--
-- Name: COLUMN anomaly_events.window_start_ms; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.window_start_ms IS 'Start of statistical window used for detection. Enables correlation analysis.';


--
-- Name: COLUMN anomaly_events.window_end_ms; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.window_end_ms IS 'End of statistical window used for detection. Enables timeline reconstruction.';


--
-- Name: COLUMN anomaly_events.severity_reason; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.severity_reason IS 'Explainability: How severity was determined (e.g., "critical: score>=0.85 || deviation>=5.0").';


--
-- Name: COLUMN anomaly_events.fingerprint; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.fingerprint IS 'Hash of device+metric+method+severity for correlation. NOTE: Old fingerprints (without device) will not correlate with new ones.';


--
-- Name: COLUMN anomaly_events.triggered_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.triggered_by IS 'JSONB array: Detection methods that fired (e.g., ["mad", "zscore"]).';


--
-- Name: COLUMN anomaly_events.baseline; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.baseline IS 'JSONB: {median, mean, stdDev, sampleCount, method, source}. Flexible schema for baseline statistics.';


--
-- Name: COLUMN anomaly_events.expected_range; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.expected_range IS 'JSONB: [min, max]. Expected value range from detector.';


--
-- Name: COLUMN anomaly_events.device_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_events.device_type IS 'Protocol/source type: modbus, opcua, bacnet, mqtt, system';


--
-- Name: _hyper_15_113_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_15_113_chunk (
    CONSTRAINT constraint_105 CHECK (((timestamp_ms >= '1772064000000'::bigint) AND (timestamp_ms < '1772150400000'::bigint)))
)
INHERITS (public.anomaly_events);



--
-- Name: _hyper_15_114_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_15_114_chunk (
    CONSTRAINT constraint_106 CHECK (((timestamp_ms >= '1772150400000'::bigint) AND (timestamp_ms < '1772236800000'::bigint)))
)
INHERITS (public.anomaly_events);



--
-- Name: _materialized_hypertable_17; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_17 (
    bucket timestamp with time zone NOT NULL,
    agent_uuid uuid,
    device_name text,
    protocol text,
    metric_name text,
    unit text,
    avg_value double precision,
    min_value double precision,
    max_value double precision,
    sample_count bigint,
    quality_ratio double precision,
    max_anomaly_score real,
    avg_anomaly_score double precision
);



--
-- Name: _hyper_17_41_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_17_41_chunk (
    CONSTRAINT constraint_41 CHECK (((bucket >= '2026-02-06 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-16 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_17);



--
-- Name: _hyper_17_50_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_17_50_chunk (
    CONSTRAINT constraint_50 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_17);



--
-- Name: _hyper_17_88_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_17_88_chunk (
    CONSTRAINT constraint_80 CHECK (((bucket >= '2026-02-26 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-03-08 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_17);



--
-- Name: _materialized_hypertable_18; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_18 (
    bucket timestamp with time zone NOT NULL,
    agent_uuid uuid,
    device_name text,
    protocol text,
    metric_name text,
    unit text,
    avg_value double precision,
    min_value double precision,
    max_value double precision,
    stddev_value double precision,
    sample_count bigint,
    quality_ratio double precision
);



--
-- Name: _hyper_18_42_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_18_42_chunk (
    CONSTRAINT constraint_42 CHECK (((bucket >= '2026-02-06 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-16 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_18);



--
-- Name: _hyper_18_51_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_18_51_chunk (
    CONSTRAINT constraint_51 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_18);



--
-- Name: _hyper_18_91_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_18_91_chunk (
    CONSTRAINT constraint_83 CHECK (((bucket >= '2026-02-26 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-03-08 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_18);



--
-- Name: _hyper_1_115_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_115_chunk (
    CONSTRAINT constraint_107 CHECK ((("timestamp" >= '2026-02-27 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-28 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_62_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_62_chunk (
    CONSTRAINT constraint_60 CHECK ((("timestamp" >= '2026-02-19 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-20 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_72_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_72_chunk (
    CONSTRAINT constraint_65 CHECK ((("timestamp" >= '2026-02-22 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-23 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_75_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_75_chunk (
    CONSTRAINT constraint_68 CHECK ((("timestamp" >= '2026-02-23 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-24 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_77_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_77_chunk (
    CONSTRAINT constraint_70 CHECK ((("timestamp" >= '2026-02-24 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-25 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_80_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_80_chunk (
    CONSTRAINT constraint_73 CHECK ((("timestamp" >= '2026-02-25 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _hyper_1_82_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_1_82_chunk (
    CONSTRAINT constraint_75 CHECK ((("timestamp" >= '2026-02-26 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-27 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_logs);



--
-- Name: _materialized_hypertable_21; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_21 (
    bucket timestamp with time zone NOT NULL,
    device_uuid uuid,
    device_name text,
    metric_name text,
    protocol text,
    avg_value double precision,
    min_value double precision,
    max_value double precision,
    stddev_value double precision,
    sample_count bigint,
    first_value double precision,
    last_value double precision,
    last_time timestamp with time zone,
    quality_ratio double precision
);



--
-- Name: _hyper_21_64_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_21_64_chunk (
    CONSTRAINT constraint_62 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_21);



--
-- Name: _materialized_hypertable_22; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_22 (
    bucket timestamp with time zone NOT NULL,
    device_uuid uuid,
    device_name text,
    metric_name text,
    protocol text,
    avg_value double precision,
    min_value double precision,
    max_value double precision,
    stddev_value double precision,
    sample_count bigint,
    first_value double precision,
    last_value double precision,
    last_time timestamp with time zone,
    quality_ratio double precision
);



--
-- Name: _hyper_22_71_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_22_71_chunk (
    CONSTRAINT constraint_64 CHECK (((bucket >= '2026-02-16 00:00:00+00'::timestamp with time zone) AND (bucket < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_22);



--
-- Name: mqtt_topic_metrics; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE mqtt_topic_metrics; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.mqtt_topic_metrics IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 98%+';


--
-- Name: COLUMN mqtt_topic_metrics.avg_message_size; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_topic_metrics.avg_message_size IS 'Average message size in bytes';


--
-- Name: COLUMN mqtt_topic_metrics.message_rate; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_topic_metrics.message_rate IS 'Messages per second for this topic';


--
-- Name: COLUMN mqtt_topic_metrics.topic_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_topic_metrics.topic_id IS 'Reference to mqtt_topics.topic_id';


--
-- Name: _hyper_23_52_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_23_52_chunk (
    CONSTRAINT constraint_52 CHECK ((("timestamp" >= '2026-02-05 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-12 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_topic_metrics);



--
-- Name: _hyper_23_53_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_23_53_chunk (
    CONSTRAINT constraint_53 CHECK ((("timestamp" >= '2026-02-12 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-19 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_topic_metrics);



--
-- Name: _hyper_23_59_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_23_59_chunk (
    CONSTRAINT constraint_57 CHECK ((("timestamp" >= '2026-02-19 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_topic_metrics);



--
-- Name: mqtt_broker_stats; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE mqtt_broker_stats; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.mqtt_broker_stats IS 'Hypertable with compression enabled. Compresses chunks older than 1 day. Expected compression ratio: 90%+';


--
-- Name: COLUMN mqtt_broker_stats.connected_clients; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.connected_clients IS 'Number of currently connected clients';


--
-- Name: COLUMN mqtt_broker_stats.disconnected_clients; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.disconnected_clients IS 'Number of disconnected clients';


--
-- Name: COLUMN mqtt_broker_stats.total_clients; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.total_clients IS 'Total number of clients (connected + disconnected)';


--
-- Name: COLUMN mqtt_broker_stats.message_rate_published; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.message_rate_published IS 'Messages published per second';


--
-- Name: COLUMN mqtt_broker_stats.message_rate_received; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.message_rate_received IS 'Messages received per second';


--
-- Name: COLUMN mqtt_broker_stats.throughput_inbound; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.throughput_inbound IS 'Inbound throughput in bytes per second';


--
-- Name: COLUMN mqtt_broker_stats.throughput_outbound; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.throughput_outbound IS 'Outbound throughput in bytes per second';


--
-- Name: COLUMN mqtt_broker_stats.sys_data; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_stats.sys_data IS 'Raw $SYS topic data from broker';


--
-- Name: _hyper_25_54_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_25_54_chunk (
    CONSTRAINT constraint_54 CHECK ((("timestamp" >= '2026-02-05 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-12 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_broker_stats);



--
-- Name: _hyper_25_55_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_25_55_chunk (
    CONSTRAINT constraint_55 CHECK ((("timestamp" >= '2026-02-12 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-19 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_broker_stats);



--
-- Name: _hyper_25_58_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_25_58_chunk (
    CONSTRAINT constraint_56 CHECK ((("timestamp" >= '2026-02-19 00:00:00'::timestamp without time zone) AND ("timestamp" < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (public.mqtt_broker_stats);



--
-- Name: _materialized_hypertable_3; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_3 (
    device_uuid uuid,
    service_name character varying(255),
    bucket timestamp without time zone NOT NULL,
    total_count bigint,
    error_count bigint,
    warn_count bigint,
    info_count bigint,
    debug_count bigint,
    first_message text,
    last_message text,
    error_samples json[],
    warning_samples json[],
    bucket_start timestamp without time zone,
    bucket_end timestamp without time zone
);



--
-- Name: _hyper_3_5_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_3_5_chunk (
    CONSTRAINT constraint_5 CHECK (((bucket >= '2026-02-06 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-16 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_3);



--
-- Name: _hyper_3_63_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_3_63_chunk (
    CONSTRAINT constraint_61 CHECK (((bucket >= '2026-02-16 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_3);



--
-- Name: _hyper_3_83_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_3_83_chunk (
    CONSTRAINT constraint_76 CHECK (((bucket >= '2026-02-26 00:00:00'::timestamp without time zone) AND (bucket < '2026-03-08 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_3);



--
-- Name: _materialized_hypertable_4; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._materialized_hypertable_4 (
    device_uuid uuid,
    service_name character varying(255),
    bucket timestamp without time zone NOT NULL,
    total_count bigint,
    error_count bigint,
    warn_count bigint,
    info_count bigint,
    debug_count bigint,
    bucket_start timestamp without time zone,
    bucket_end timestamp without time zone
);



--
-- Name: _hyper_4_66_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_4_66_chunk (
    CONSTRAINT constraint_63 CHECK (((bucket >= '2026-02-16 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_4);



--
-- Name: _hyper_4_6_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_4_6_chunk (
    CONSTRAINT constraint_6 CHECK (((bucket >= '2026-02-06 00:00:00'::timestamp without time zone) AND (bucket < '2026-02-16 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_4);



--
-- Name: _hyper_4_84_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_4_84_chunk (
    CONSTRAINT constraint_77 CHECK (((bucket >= '2026-02-26 00:00:00'::timestamp without time zone) AND (bucket < '2026-03-08 00:00:00'::timestamp without time zone)))
)
INHERITS (_timescaledb_internal._materialized_hypertable_4);



--
-- Name: _hyper_5_116_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_116_chunk (
    CONSTRAINT constraint_108 CHECK ((("time" >= '2026-02-27 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-28 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_40_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_40_chunk (
    CONSTRAINT constraint_40 CHECK ((("time" >= '2026-02-11 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-12 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_43_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_43_chunk (
    CONSTRAINT constraint_43 CHECK ((("time" >= '2026-02-12 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-13 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_49_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_49_chunk (
    CONSTRAINT constraint_49 CHECK ((("time" >= '2026-02-18 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-19 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_60_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_60_chunk (
    CONSTRAINT constraint_58 CHECK ((("time" >= '2026-02-19 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-20 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_73_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_73_chunk (
    CONSTRAINT constraint_66 CHECK ((("time" >= '2026-02-22 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-23 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_76_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_76_chunk (
    CONSTRAINT constraint_69 CHECK ((("time" >= '2026-02-23 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-24 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_78_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_78_chunk (
    CONSTRAINT constraint_71 CHECK ((("time" >= '2026-02-24 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-25 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_81_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_81_chunk (
    CONSTRAINT constraint_74 CHECK ((("time" >= '2026-02-25 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-26 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_5_87_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_5_87_chunk (
    CONSTRAINT constraint_79 CHECK ((("time" >= '2026-02-26 00:00:00+00'::timestamp with time zone) AND ("time" < '2026-02-27 00:00:00+00'::timestamp with time zone)))
)
INHERITS (public.readings);



--
-- Name: _hyper_9_1_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_9_1_chunk (
    CONSTRAINT constraint_1 CHECK (((recorded_at >= '2026-02-05 00:00:00'::timestamp without time zone) AND (recorded_at < '2026-02-12 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_metrics);



--
-- Name: _hyper_9_44_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_9_44_chunk (
    CONSTRAINT constraint_44 CHECK (((recorded_at >= '2026-02-12 00:00:00'::timestamp without time zone) AND (recorded_at < '2026-02-19 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_metrics);



--
-- Name: _hyper_9_61_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_9_61_chunk (
    CONSTRAINT constraint_59 CHECK (((recorded_at >= '2026-02-19 00:00:00'::timestamp without time zone) AND (recorded_at < '2026-02-26 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_metrics);



--
-- Name: _hyper_9_86_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal._hyper_9_86_chunk (
    CONSTRAINT constraint_78 CHECK (((recorded_at >= '2026-02-26 00:00:00'::timestamp without time zone) AND (recorded_at < '2026-03-05 00:00:00'::timestamp without time zone)))
)
INHERITS (public.device_metrics);



--
-- Name: _partial_view_10; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_10 AS
 SELECT public.time_bucket('00:05:00'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('00:05:00'::interval, recorded_at)), device_uuid;



--
-- Name: _partial_view_11; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_11 AS
 SELECT public.time_bucket('01:00:00'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('01:00:00'::interval, recorded_at)), device_uuid;



--
-- Name: _partial_view_12; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_12 AS
 SELECT public.time_bucket('1 day'::interval, recorded_at) AS bucket,
    device_uuid,
    avg(cpu_usage) AS avg_cpu_usage,
    max(cpu_usage) AS max_cpu_usage,
    min(cpu_usage) AS min_cpu_usage,
    avg(cpu_temp) AS avg_cpu_temp,
    max(cpu_temp) AS max_cpu_temp,
    avg(memory_usage) AS avg_memory_usage,
    max(memory_usage) AS max_memory_usage,
    avg(memory_total) AS avg_memory_total,
    avg(storage_usage) AS avg_storage_usage,
    max(storage_usage) AS max_storage_usage,
    avg(storage_total) AS avg_storage_total,
    count(*) AS sample_count
   FROM public.device_metrics
  GROUP BY (public.time_bucket('1 day'::interval, recorded_at)), device_uuid;



--
-- Name: _partial_view_13; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_13 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(anomaly_score) AS avg_anomaly_score,
    min(anomaly_score) AS min_anomaly_score,
    max(anomaly_score) AS max_anomaly_score,
    stddev(anomaly_score) AS stddev_anomaly_score,
    count(*) FILTER (WHERE (anomaly_score IS NOT NULL)) AS scored_count,
    count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)) AS high_anomaly_count,
    (((count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS high_anomaly_percent,
    public.last(anomaly_score, "time") AS last_anomaly_score,
    public.last("time", "time") AS last_scored_time,
    avg(anomaly_threshold) AS avg_threshold,
    avg(baseline_samples) AS avg_baseline_samples
   FROM public.readings
  WHERE (anomaly_score IS NOT NULL)
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _partial_view_14; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_14 AS
 SELECT public.time_bucket('1 day'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(anomaly_score) AS avg_anomaly_score,
    min(anomaly_score) AS min_anomaly_score,
    max(anomaly_score) AS max_anomaly_score,
    stddev(anomaly_score) AS stddev_anomaly_score,
    count(*) FILTER (WHERE (anomaly_score IS NOT NULL)) AS scored_count,
    count(*) FILTER (WHERE (anomaly_score > (0.9)::double precision)) AS critical_count,
    count(*) FILTER (WHERE ((anomaly_score > (0.7)::double precision) AND (anomaly_score <= (0.9)::double precision))) AS high_count,
    count(*) FILTER (WHERE ((anomaly_score > (0.5)::double precision) AND (anomaly_score <= (0.7)::double precision))) AS medium_count,
    count(*) FILTER (WHERE (anomaly_score <= (0.5)::double precision)) AS low_count,
    (((count(*) FILTER (WHERE (anomaly_score > (0.9)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS critical_percent,
    (((count(*) FILTER (WHERE (anomaly_score > (0.7)::double precision)))::double precision / (NULLIF(count(*) FILTER (WHERE (anomaly_score IS NOT NULL)), 0))::double precision) * (100)::double precision) AS high_plus_percent,
    avg(anomaly_threshold) AS avg_threshold,
    avg(baseline_samples) AS avg_baseline_samples
   FROM public.readings
  WHERE (anomaly_score IS NOT NULL)
  GROUP BY (public.time_bucket('1 day'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _partial_view_17; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_17 AS
 SELECT public.time_bucket('00:01:00'::interval, "time") AS bucket,
    device_uuid AS agent_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    protocol,
    metric_name,
    unit,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    count(*) AS sample_count,
    ((sum(
        CASE
            WHEN (quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) AS quality_ratio,
    max(anomaly_score) AS max_anomaly_score,
    avg(anomaly_score) FILTER (WHERE (anomaly_score IS NOT NULL)) AS avg_anomaly_score
   FROM public.readings
  GROUP BY (public.time_bucket('00:01:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), protocol, metric_name, unit;



--
-- Name: _partial_view_18; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_18 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid AS agent_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    protocol,
    metric_name,
    unit,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    ((sum(
        CASE
            WHEN (quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), protocol, metric_name, unit;



--
-- Name: _partial_view_21; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_21 AS
 SELECT public.time_bucket('01:00:00'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    public.first(value, "time") AS first_value,
    public.last(value, "time") AS last_value,
    public.last("time", "time") AS last_time,
    ((sum(
        CASE
            WHEN (quality = 'GOOD'::text) THEN 1
            ELSE 0
        END))::double precision / (count(*))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('01:00:00'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _partial_view_22; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_22 AS
 SELECT public.time_bucket('1 day'::interval, "time") AS bucket,
    device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    metric_name,
    protocol,
    avg(value) AS avg_value,
    min(value) AS min_value,
    max(value) AS max_value,
    stddev(value) AS stddev_value,
    count(*) AS sample_count,
    public.first(value, "time") AS first_value,
    public.last(value, "time") AS last_value,
    public.last("time", "time") AS last_time,
    ((sum(
        CASE
            WHEN (quality = 'GOOD'::text) THEN 1
            ELSE 0
        END))::double precision / (count(*))::double precision) AS quality_ratio
   FROM public.readings
  GROUP BY (public.time_bucket('1 day'::interval, "time")), device_uuid, (extra ->> 'deviceName'::text), metric_name, protocol;



--
-- Name: _partial_view_3; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_3 AS
 SELECT device_uuid,
    service_name,
    public.time_bucket('00:05:00'::interval, "timestamp") AS bucket,
    count(*) AS total_count,
    count(*) FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_count,
    count(*) FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warn_count,
    count(*) FILTER (WHERE (message ~* 'info|\[info\]'::text)) AS info_count,
    count(*) FILTER (WHERE (message ~* 'debug|trace|\[debug\]'::text)) AS debug_count,
    public.first(message, "timestamp") AS first_message,
    public.last(message, "timestamp") AS last_message,
    array_agg(json_build_object('timestamp', "timestamp", 'message', "left"(message, 500)) ORDER BY "timestamp") FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_samples,
    array_agg(json_build_object('timestamp', "timestamp", 'message', "left"(message, 500)) ORDER BY "timestamp") FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warning_samples,
    min("timestamp") AS bucket_start,
    max("timestamp") AS bucket_end
   FROM public.device_logs
  GROUP BY device_uuid, service_name, (public.time_bucket('00:05:00'::interval, "timestamp"));



--
-- Name: _partial_view_4; Type: VIEW; Schema: _timescaledb_internal; Owner: postgres
--

CREATE VIEW _timescaledb_internal._partial_view_4 AS
 SELECT device_uuid,
    service_name,
    public.time_bucket('01:00:00'::interval, "timestamp") AS bucket,
    count(*) AS total_count,
    count(*) FILTER (WHERE (message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]'::text)) AS error_count,
    count(*) FILTER (WHERE (message ~* 'warn|warning|\[warn\]'::text)) AS warn_count,
    count(*) FILTER (WHERE (message ~* 'info|\[info\]'::text)) AS info_count,
    count(*) FILTER (WHERE (message ~* 'debug|trace|\[debug\]'::text)) AS debug_count,
    min("timestamp") AS bucket_start,
    max("timestamp") AS bucket_end
   FROM public.device_logs
  GROUP BY device_uuid, service_name, (public.time_bucket('01:00:00'::interval, "timestamp"));



--
-- Name: compress_hyper_24_57_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_24_57_chunk (
    _ts_meta_count integer,
    topic character varying(512),
    id _timescaledb_internal.compressed_data,
    message_count _timescaledb_internal.compressed_data,
    bytes_received _timescaledb_internal.compressed_data,
    avg_message_size _timescaledb_internal.compressed_data,
    qos_0_count _timescaledb_internal.compressed_data,
    qos_1_count _timescaledb_internal.compressed_data,
    qos_2_count _timescaledb_internal.compressed_data,
    retained_count _timescaledb_internal.compressed_data,
    _ts_meta_min_1 timestamp without time zone,
    _ts_meta_max_1 timestamp without time zone,
    "timestamp" _timescaledb_internal.compressed_data,
    message_rate _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_topic_id _timescaledb_internal.bloom1,
    topic_id _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN topic SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN id SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN message_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN bytes_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN avg_message_size SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN qos_0_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN qos_1_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN qos_2_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN retained_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN "timestamp" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN message_rate SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN message_rate SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN _ts_meta_v2_bloomh_topic_id SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN _ts_meta_v2_bloomh_topic_id SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_57_chunk ALTER COLUMN topic_id SET STATISTICS 0;



--
-- Name: compress_hyper_24_69_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_24_69_chunk (
    _ts_meta_count integer,
    topic character varying(512),
    id _timescaledb_internal.compressed_data,
    message_count _timescaledb_internal.compressed_data,
    bytes_received _timescaledb_internal.compressed_data,
    avg_message_size _timescaledb_internal.compressed_data,
    qos_0_count _timescaledb_internal.compressed_data,
    qos_1_count _timescaledb_internal.compressed_data,
    qos_2_count _timescaledb_internal.compressed_data,
    retained_count _timescaledb_internal.compressed_data,
    _ts_meta_min_1 timestamp without time zone,
    _ts_meta_max_1 timestamp without time zone,
    "timestamp" _timescaledb_internal.compressed_data,
    message_rate _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_topic_id _timescaledb_internal.bloom1,
    topic_id _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN topic SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN id SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN message_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN bytes_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN avg_message_size SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN qos_0_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN qos_1_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN qos_2_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN retained_count SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN "timestamp" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN message_rate SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN message_rate SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN _ts_meta_v2_bloomh_topic_id SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN _ts_meta_v2_bloomh_topic_id SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_24_69_chunk ALTER COLUMN topic_id SET STATISTICS 0;



--
-- Name: compress_hyper_26_56_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_26_56_chunk (
    _ts_meta_count integer,
    id _timescaledb_internal.compressed_data,
    connected_clients _timescaledb_internal.compressed_data,
    disconnected_clients _timescaledb_internal.compressed_data,
    total_clients _timescaledb_internal.compressed_data,
    subscriptions _timescaledb_internal.compressed_data,
    retained_messages _timescaledb_internal.compressed_data,
    messages_sent _timescaledb_internal.compressed_data,
    messages_received _timescaledb_internal.compressed_data,
    messages_published _timescaledb_internal.compressed_data,
    messages_dropped _timescaledb_internal.compressed_data,
    bytes_sent _timescaledb_internal.compressed_data,
    bytes_received _timescaledb_internal.compressed_data,
    message_rate_published _timescaledb_internal.compressed_data,
    message_rate_received _timescaledb_internal.compressed_data,
    throughput_inbound _timescaledb_internal.compressed_data,
    throughput_outbound _timescaledb_internal.compressed_data,
    sys_data _timescaledb_internal.compressed_data,
    _ts_meta_min_1 timestamp without time zone,
    _ts_meta_max_1 timestamp without time zone,
    "timestamp" _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN id SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN connected_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN disconnected_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN total_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN subscriptions SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN retained_messages SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN messages_sent SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN messages_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN messages_published SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN messages_dropped SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN bytes_sent SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN bytes_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN message_rate_published SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN message_rate_published SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN message_rate_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN message_rate_received SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN throughput_inbound SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN throughput_outbound SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN sys_data SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN sys_data SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_56_chunk ALTER COLUMN "timestamp" SET STATISTICS 0;



--
-- Name: compress_hyper_26_68_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_26_68_chunk (
    _ts_meta_count integer,
    id _timescaledb_internal.compressed_data,
    connected_clients _timescaledb_internal.compressed_data,
    disconnected_clients _timescaledb_internal.compressed_data,
    total_clients _timescaledb_internal.compressed_data,
    subscriptions _timescaledb_internal.compressed_data,
    retained_messages _timescaledb_internal.compressed_data,
    messages_sent _timescaledb_internal.compressed_data,
    messages_received _timescaledb_internal.compressed_data,
    messages_published _timescaledb_internal.compressed_data,
    messages_dropped _timescaledb_internal.compressed_data,
    bytes_sent _timescaledb_internal.compressed_data,
    bytes_received _timescaledb_internal.compressed_data,
    message_rate_published _timescaledb_internal.compressed_data,
    message_rate_received _timescaledb_internal.compressed_data,
    throughput_inbound _timescaledb_internal.compressed_data,
    throughput_outbound _timescaledb_internal.compressed_data,
    sys_data _timescaledb_internal.compressed_data,
    _ts_meta_min_1 timestamp without time zone,
    _ts_meta_max_1 timestamp without time zone,
    "timestamp" _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN id SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN connected_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN disconnected_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN total_clients SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN subscriptions SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN retained_messages SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN messages_sent SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN messages_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN messages_published SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN messages_dropped SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN bytes_sent SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN bytes_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN message_rate_published SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN message_rate_published SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN message_rate_received SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN message_rate_received SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN throughput_inbound SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN throughput_outbound SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN sys_data SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN sys_data SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_26_68_chunk ALTER COLUMN "timestamp" SET STATISTICS 0;



--
-- Name: compress_hyper_6_117_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_6_117_chunk (
    _ts_meta_count integer,
    device_uuid uuid,
    metric_name text,
    _ts_meta_min_1 timestamp with time zone,
    _ts_meta_max_1 timestamp with time zone,
    "time" _timescaledb_internal.compressed_data,
    value _timescaledb_internal.compressed_data,
    quality _timescaledb_internal.compressed_data,
    unit _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_protocol _timescaledb_internal.bloom1,
    protocol _timescaledb_internal.compressed_data,
    extra _timescaledb_internal.compressed_data,
    anomaly_score _timescaledb_internal.compressed_data,
    anomaly_threshold _timescaledb_internal.compressed_data,
    baseline_samples _timescaledb_internal.compressed_data,
    detection_methods _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN device_uuid SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN metric_name SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN "time" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN value SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN quality SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN quality SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN unit SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN unit SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN protocol SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN protocol SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN extra SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN extra SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN anomaly_score SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN anomaly_threshold SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN baseline_samples SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN detection_methods SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_117_chunk ALTER COLUMN detection_methods SET STORAGE EXTENDED;



--
-- Name: compress_hyper_6_65_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_6_65_chunk (
    _ts_meta_count integer,
    device_uuid uuid,
    metric_name text,
    _ts_meta_min_1 timestamp with time zone,
    _ts_meta_max_1 timestamp with time zone,
    "time" _timescaledb_internal.compressed_data,
    value _timescaledb_internal.compressed_data,
    quality _timescaledb_internal.compressed_data,
    unit _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_protocol _timescaledb_internal.bloom1,
    protocol _timescaledb_internal.compressed_data,
    extra _timescaledb_internal.compressed_data,
    anomaly_score _timescaledb_internal.compressed_data,
    anomaly_threshold _timescaledb_internal.compressed_data,
    baseline_samples _timescaledb_internal.compressed_data,
    detection_methods _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN device_uuid SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN metric_name SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN "time" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN value SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN quality SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN quality SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN unit SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN unit SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN protocol SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN protocol SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN extra SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN extra SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN anomaly_score SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN anomaly_threshold SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN baseline_samples SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN detection_methods SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_65_chunk ALTER COLUMN detection_methods SET STORAGE EXTENDED;



--
-- Name: compress_hyper_6_70_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_6_70_chunk (
    _ts_meta_count integer,
    device_uuid uuid,
    metric_name text,
    _ts_meta_min_1 timestamp with time zone,
    _ts_meta_max_1 timestamp with time zone,
    "time" _timescaledb_internal.compressed_data,
    value _timescaledb_internal.compressed_data,
    quality _timescaledb_internal.compressed_data,
    unit _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_protocol _timescaledb_internal.bloom1,
    protocol _timescaledb_internal.compressed_data,
    extra _timescaledb_internal.compressed_data,
    anomaly_score _timescaledb_internal.compressed_data,
    anomaly_threshold _timescaledb_internal.compressed_data,
    baseline_samples _timescaledb_internal.compressed_data,
    detection_methods _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN device_uuid SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN metric_name SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN "time" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN value SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN quality SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN quality SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN unit SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN unit SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN protocol SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN protocol SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN extra SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN extra SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN anomaly_score SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN anomaly_threshold SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN baseline_samples SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN detection_methods SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_70_chunk ALTER COLUMN detection_methods SET STORAGE EXTENDED;



--
-- Name: compress_hyper_6_85_chunk; Type: TABLE; Schema: _timescaledb_internal; Owner: postgres
--

CREATE TABLE _timescaledb_internal.compress_hyper_6_85_chunk (
    _ts_meta_count integer,
    device_uuid uuid,
    metric_name text,
    _ts_meta_min_1 timestamp with time zone,
    _ts_meta_max_1 timestamp with time zone,
    "time" _timescaledb_internal.compressed_data,
    value _timescaledb_internal.compressed_data,
    quality _timescaledb_internal.compressed_data,
    unit _timescaledb_internal.compressed_data,
    _ts_meta_v2_bloomh_protocol _timescaledb_internal.bloom1,
    protocol _timescaledb_internal.compressed_data,
    extra _timescaledb_internal.compressed_data,
    anomaly_score _timescaledb_internal.compressed_data,
    anomaly_threshold _timescaledb_internal.compressed_data,
    baseline_samples _timescaledb_internal.compressed_data,
    detection_methods _timescaledb_internal.compressed_data
)
WITH (toast_tuple_target='128');
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN _ts_meta_count SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN device_uuid SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN metric_name SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN _ts_meta_min_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN _ts_meta_max_1 SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN "time" SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN value SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN quality SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN quality SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN unit SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN unit SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STATISTICS 1000;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN _ts_meta_v2_bloomh_protocol SET STORAGE EXTERNAL;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN protocol SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN protocol SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN extra SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN extra SET STORAGE EXTENDED;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN anomaly_score SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN anomaly_threshold SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN baseline_samples SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN detection_methods SET STATISTICS 0;
ALTER TABLE ONLY _timescaledb_internal.compress_hyper_6_85_chunk ALTER COLUMN detection_methods SET STORAGE EXTENDED;



--
-- Name: active_rollouts; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.active_rollouts AS
SELECT
    NULL::integer AS id,
    NULL::character varying(255) AS rollout_id,
    NULL::character varying(255) AS image_name,
    NULL::character varying(100) AS old_tag,
    NULL::character varying(100) AS new_tag,
    NULL::character varying(255) AS registry,
    NULL::integer AS policy_id,
    NULL::character varying(50) AS strategy,
    NULL::integer AS total_devices,
    NULL::jsonb AS batch_sizes,
    NULL::character varying(50) AS status,
    NULL::integer AS current_batch,
    NULL::integer AS updated_devices,
    NULL::integer AS failed_devices,
    NULL::integer AS healthy_devices,
    NULL::integer AS rolled_back_devices,
    NULL::numeric(5,4) AS failure_rate,
    NULL::boolean AS auto_paused,
    NULL::timestamp without time zone AS scheduled_at,
    NULL::timestamp without time zone AS started_at,
    NULL::timestamp without time zone AS paused_at,
    NULL::timestamp without time zone AS resumed_at,
    NULL::timestamp without time zone AS completed_at,
    NULL::timestamp without time zone AS created_at,
    NULL::timestamp without time zone AS updated_at,
    NULL::character varying(100) AS triggered_by,
    NULL::jsonb AS webhook_payload,
    NULL::jsonb AS filters_applied,
    NULL::text AS error_message,
    NULL::text AS notes,
    NULL::character varying(255) AS image_pattern,
    NULL::text AS policy_description,
    NULL::double precision AS progress_percentage,
    NULL::bigint AS devices_completed,
    NULL::bigint AS devices_failed,
    NULL::bigint AS devices_pending;



--
-- Name: VIEW active_rollouts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.active_rollouts IS 'Active rollouts with progress statistics';


--
-- Name: agent_updates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agent_updates (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: agent_update_stats; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.agent_update_stats AS
 SELECT date_trunc('day'::text, created_at) AS date,
    status,
    count(*) AS count,
    avg(EXTRACT(epoch FROM (completed_at - started_at))) AS avg_duration_seconds
   FROM public.agent_updates
  WHERE (created_at > (now() - '30 days'::interval))
  GROUP BY (date_trunc('day'::text, created_at)), status
  ORDER BY (date_trunc('day'::text, created_at)) DESC, status;



--
-- Name: agent_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.agent_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: agent_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.agent_updates_id_seq OWNED BY public.agent_updates.id;


--
-- Name: anomaly_alerts; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT anomaly_alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);



--
-- Name: TABLE anomaly_alerts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.anomaly_alerts IS 'Regular table: Alert notifications triggered from incidents. Routes to Slack, PagerDuty, email, etc.';


--
-- Name: COLUMN anomaly_alerts.affected_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_alerts.affected_devices IS 'JSONB array of monitored device names';


--
-- Name: COLUMN anomaly_alerts.channels; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_alerts.channels IS 'JSONB: Alert routing metadata (e.g., {"slack": true, "pagerduty": false}).';


--
-- Name: COLUMN anomaly_alerts.device_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_alerts.device_name IS 'Primary device name for this alert';


--
-- Name: anomaly_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.anomaly_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: anomaly_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.anomaly_alerts_id_seq OWNED BY public.anomaly_alerts.id;


--
-- Name: anomaly_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.anomaly_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: anomaly_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.anomaly_events_id_seq OWNED BY public.anomaly_events.id;


--
-- Name: anomaly_incidents; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT anomaly_incidents_feedback_check CHECK (((feedback)::text = ANY ((ARRAY['confirmed'::character varying, 'false_positive'::character varying, 'expected'::character varying, 'ignored'::character varying])::text[]))),
    CONSTRAINT anomaly_incidents_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT anomaly_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'active'::text, 'resolved'::text])))
);



--
-- Name: TABLE anomaly_incidents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.anomaly_incidents IS 'Regular table: Correlated incidents aggregating multiple events by fingerprint (low-volume). Optimized for dashboard queries.';


--
-- Name: COLUMN anomaly_incidents.affected_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.affected_devices IS 'JSONB array of monitored device names (e.g., ["COMAP-Main-Controller", "Temp-Sensor-01"])';


--
-- Name: COLUMN anomaly_incidents.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.status IS 'Incident lifecycle: open=new, active=ongoing, resolved=cleared.';


--
-- Name: COLUMN anomaly_incidents.feedback; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.feedback IS 'User feedback on incident quality: confirmed (real issue), false_positive (bad detection), expected (known behavior like maintenance), ignored (user does not care)';


--
-- Name: COLUMN anomaly_incidents.feedback_reason; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.feedback_reason IS 'Optional explanation for the feedback';


--
-- Name: COLUMN anomaly_incidents.feedback_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.feedback_by IS 'User who provided the feedback (username or email)';


--
-- Name: COLUMN anomaly_incidents.feedback_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.feedback_at IS 'Timestamp when feedback was provided';


--
-- Name: COLUMN anomaly_incidents.device_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.device_name IS 'Primary device name for this incident';


--
-- Name: COLUMN anomaly_incidents.device_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.device_type IS 'Device source type: modbus, opcua, bacnet, mqtt-sensor, or agent-system';


--
-- Name: COLUMN anomaly_incidents.affected_agents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.anomaly_incidents.affected_agents IS 'JSONB array of agent UUIDs for infrastructure tracking (e.g., ["agent-abc123", "agent-xyz789"])';


--
-- Name: anomaly_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.anomaly_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: anomaly_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.anomaly_incidents_id_seq OWNED BY public.anomaly_incidents.id;


--
-- Name: anomaly_scores_daily; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.anomaly_scores_daily AS
 SELECT bucket,
    device_uuid,
    device_name,
    metric_name,
    protocol,
    avg_anomaly_score,
    min_anomaly_score,
    max_anomaly_score,
    stddev_anomaly_score,
    scored_count,
    critical_count,
    high_count,
    medium_count,
    low_count,
    critical_percent,
    high_plus_percent,
    avg_threshold,
    avg_baseline_samples
   FROM _timescaledb_internal._materialized_hypertable_14;



--
-- Name: anomaly_scores_hourly; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.anomaly_scores_hourly AS
 SELECT bucket,
    device_uuid,
    device_name,
    metric_name,
    protocol,
    avg_anomaly_score,
    min_anomaly_score,
    max_anomaly_score,
    stddev_anomaly_score,
    scored_count,
    high_anomaly_count,
    high_anomaly_percent,
    last_anomaly_score,
    last_scored_time,
    avg_threshold,
    avg_baseline_samples
   FROM _timescaledb_internal._materialized_hypertable_13;



--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: app_service_ids; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_service_ids (
    id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    entity_name character varying(255) NOT NULL,
    created_by character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT app_service_ids_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['app'::character varying, 'service'::character varying])::text[])))
);



--
-- Name: TABLE app_service_ids; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.app_service_ids IS 'Registry of all app and service IDs used across devices';


--
-- Name: COLUMN app_service_ids.entity_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_service_ids.entity_type IS 'Type: app or service';


--
-- Name: COLUMN app_service_ids.entity_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_service_ids.entity_id IS 'Unique ID (from sequence)';


--
-- Name: COLUMN app_service_ids.entity_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_service_ids.entity_name IS 'Human-readable name';


--
-- Name: COLUMN app_service_ids.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_service_ids.metadata IS 'Additional metadata (image name, default config, etc.)';


--
-- Name: app_service_ids_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.app_service_ids_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: app_service_ids_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.app_service_ids_id_seq OWNED BY public.app_service_ids.id;


--
-- Name: applications; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE applications; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.applications IS 'Application catalog/library - stores docker-compose-like templates that can be deployed to devices with customization';


--
-- Name: COLUMN applications.default_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.applications.default_config IS 'Docker-compose-like template for this application. Contains default services configuration that can be customized per device.';


--
-- Name: applications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.applications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: applications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.applications_id_seq OWNED BY public.applications.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    event_type character varying(100) NOT NULL,
    device_uuid uuid,
    user_id character varying(255),
    ip_address inet,
    user_agent text,
    details jsonb,
    severity character varying(20) DEFAULT 'info'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.audit_logs IS 'Security audit trail for authentication and user management events';


--
-- Name: COLUMN audit_logs.event_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.audit_logs.event_type IS 'Type of event: user_registered, user_login, login_failed, password_changed, etc.';


--
-- Name: COLUMN audit_logs.details; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.audit_logs.details IS 'JSON object with additional event-specific information';


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: dashboard_layouts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dashboard_layouts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    device_uuid uuid,
    layout_name character varying(255) DEFAULT 'Default'::character varying,
    widgets jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    share_token uuid DEFAULT gen_random_uuid() NOT NULL
);



--
-- Name: TABLE dashboard_layouts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dashboard_layouts IS 'Stores custom dashboard widget layouts per user and device';


--
-- Name: COLUMN dashboard_layouts.device_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dashboard_layouts.device_uuid IS 'Device UUID for device-specific dashboards, NULL for global/multi-device dashboards';


--
-- Name: COLUMN dashboard_layouts.widgets; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dashboard_layouts.widgets IS 'JSON array of widget configurations with type, position, size';


--
-- Name: COLUMN dashboard_layouts.is_default; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dashboard_layouts.is_default IS 'Marks the default layout to load for this user/device combination';


--
-- Name: COLUMN dashboard_layouts.share_token; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dashboard_layouts.share_token IS 'UUID token used for secure dashboard sharing via URLs (replaces integer ID to prevent enumeration)';


--
-- Name: dashboard_layouts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dashboard_layouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dashboard_layouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dashboard_layouts_id_seq OWNED BY public.dashboard_layouts.id;


--
-- Name: device_anomaly_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_anomaly_summary AS
 SELECT device_uuid,
    (extra ->> 'deviceName'::text) AS device_name,
    avg(anomaly_score) FILTER (WHERE ("time" > (now() - '24:00:00'::interval))) AS avg_anomaly_24h,
    max(anomaly_score) FILTER (WHERE ("time" > (now() - '24:00:00'::interval))) AS max_anomaly_24h,
    count(*) FILTER (WHERE (("time" > (now() - '24:00:00'::interval)) AND (anomaly_score > (0.7)::double precision))) AS high_anomaly_count_24h,
    ( SELECT readings.anomaly_score
           FROM public.readings
          WHERE ((readings.device_uuid = r.device_uuid) AND (readings.anomaly_score IS NOT NULL))
          ORDER BY readings."time" DESC
         LIMIT 1) AS latest_anomaly_score,
    ( SELECT readings."time"
           FROM public.readings
          WHERE ((readings.device_uuid = r.device_uuid) AND (readings.anomaly_score IS NOT NULL))
          ORDER BY readings."time" DESC
         LIMIT 1) AS latest_scored_time,
    ( SELECT readings.metric_name
           FROM public.readings
          WHERE ((readings.device_uuid = r.device_uuid) AND (readings."time" > (now() - '24:00:00'::interval)) AND (readings.anomaly_score IS NOT NULL))
          GROUP BY readings.metric_name
          ORDER BY (avg(readings.anomaly_score)) DESC
         LIMIT 1) AS most_anomalous_metric,
    count(DISTINCT metric_name) FILTER (WHERE ((anomaly_score IS NOT NULL) AND ("time" > (now() - '24:00:00'::interval)))) AS monitored_metrics_count
   FROM public.readings r
  WHERE ((anomaly_score IS NOT NULL) AND ("time" > (now() - '7 days'::interval)))
  GROUP BY device_uuid, (extra ->> 'deviceName'::text);



--
-- Name: VIEW device_anomaly_summary; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.device_anomaly_summary IS 'Real-time anomaly summary per device (last 24 hours)';


--
-- Name: device_api_key_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_api_key_history (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    key_hash character varying(255) NOT NULL,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    revoked_reason character varying(255),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE device_api_key_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_api_key_history IS 'History of device API keys for rotation tracking and rollback';


--
-- Name: COLUMN device_api_key_history.is_active; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_api_key_history.is_active IS 'Whether this key is currently active (supports grace period)';


--
-- Name: device_api_key_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_api_key_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_api_key_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_api_key_history_id_seq OWNED BY public.device_api_key_history.id;


--
-- Name: device_api_keys; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_api_keys (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    key_hash character varying(255) NOT NULL,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL,
    revoked boolean DEFAULT false,
    revoked_at timestamp without time zone,
    revoked_reason character varying(255),
    last_used_at timestamp without time zone
);



--
-- Name: TABLE device_api_keys; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_api_keys IS 'Device-specific API keys with rotation and revocation support';


--
-- Name: device_api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_api_keys_id_seq OWNED BY public.device_api_keys.id;


--
-- Name: device_current_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_current_state (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    apps jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    system_info jsonb DEFAULT '{}'::jsonb,
    reported_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    version integer DEFAULT 0
);



--
-- Name: COLUMN device_current_state.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_current_state.version IS 'Version of target_state that device has applied';


--
-- Name: device_current_state_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_current_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_current_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_current_state_id_seq OWNED BY public.device_current_state.id;


--
-- Name: device_environment_variable; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_environment_variable (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    name character varying(255) NOT NULL,
    value text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: device_environment_variable_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_environment_variable_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_environment_variable_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_environment_variable_id_seq OWNED BY public.device_environment_variable.id;


--
-- Name: devices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.devices (
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
    CONSTRAINT devices_last_auth_method_check CHECK (((last_auth_method)::text = ANY ((ARRAY['pop'::character varying, 'bcrypt'::character varying])::text[])))
);



--
-- Name: COLUMN devices.api_key_expires_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.api_key_expires_at IS 'When the current API key expires (NULL = never expires)';


--
-- Name: COLUMN devices.api_key_last_rotated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.api_key_last_rotated_at IS 'Timestamp of last successful key rotation';


--
-- Name: COLUMN devices.api_key_rotation_enabled; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.api_key_rotation_enabled IS 'Whether automatic rotation is enabled for this device';


--
-- Name: COLUMN devices.api_key_rotation_days; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.api_key_rotation_days IS 'Number of days before key expires and rotation is needed';


--
-- Name: COLUMN devices.top_processes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.top_processes IS 'Latest snapshot of top 10 processes';


--
-- Name: COLUMN devices.mqtt_broker_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.mqtt_broker_id IS 'MQTT broker configuration for this device (NULL = use default broker)';


--
-- Name: COLUMN devices.network_interfaces; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.network_interfaces IS 'Network interface data reported by agent (name, IP, MAC, type, WiFi signal, etc.)';


--
-- Name: COLUMN devices.vpn_enabled; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_enabled IS 'Whether VPN is enabled for this device';


--
-- Name: COLUMN devices.vpn_username; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_username IS 'VPN username (typically device UUID)';


--
-- Name: COLUMN devices.vpn_password_hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_password_hash IS 'Bcrypt hash of VPN password';


--
-- Name: COLUMN devices.vpn_last_connected_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_last_connected_at IS 'Last VPN connection timestamp';


--
-- Name: COLUMN devices.vpn_ip_address; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_ip_address IS 'Assigned VPN IP address (10.8.x.x)';


--
-- Name: COLUMN devices.vpn_bytes_sent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_bytes_sent IS 'Total bytes sent over VPN';


--
-- Name: COLUMN devices.vpn_bytes_received; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_bytes_received IS 'Total bytes received over VPN';


--
-- Name: COLUMN devices.vpn_config_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.vpn_config_id IS 'VPN configuration ID (maps to system_config key vpn.configs.<id>)';


--
-- Name: COLUMN devices.device_public_key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.device_public_key IS 'Ed25519/P-256 public key for proof-of-possession (PEM format)';


--
-- Name: COLUMN devices.pop_verified; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.pop_verified IS 'Whether device has completed proof-of-possession challenge';


--
-- Name: COLUMN devices.pop_verified_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.pop_verified_at IS 'Timestamp when PoP was verified';


--
-- Name: COLUMN devices.last_challenge; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.last_challenge IS 'Current PoP challenge nonce (cleared after verification)';


--
-- Name: COLUMN devices.last_challenge_expires_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.last_challenge_expires_at IS 'Challenge expiration timestamp (5 min TTL)';


--
-- Name: COLUMN devices.last_auth_method; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.last_auth_method IS 'Authentication method used in last successful key exchange: pop=asymmetric proof-of-possession, bcrypt=symmetric fallback';


--
-- Name: COLUMN devices.last_auth_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.last_auth_at IS 'Timestamp of last successful authentication attempt';


--
-- Name: COLUMN devices.deployment_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.deployment_status IS 'Kubernetes deployment status for virtual agents: pending, deploying, running, failed, terminated';


--
-- Name: COLUMN devices.k8s_namespace; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.k8s_namespace IS 'Kubernetes namespace where the virtual agent pod is deployed';


--
-- Name: COLUMN devices.k8s_pod_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.k8s_pod_name IS 'Name of the running Kubernetes pod for this virtual agent';


--
-- Name: COLUMN devices.helm_release_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.helm_release_name IS 'Helm release name or Kubernetes deployment name for this virtual agent';


--
-- Name: COLUMN devices.location; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.location IS 'Physical or geographic location of the agent (e.g., "Building A, Floor 2, Room 201" or "Toronto Data Center")';


--
-- Name: COLUMN devices.fleet_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.devices.fleet_uuid IS 'UUID reference to fleets.fleet_uuid (preferred over fleet_id)';


--
-- Name: fleets; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT valid_billing_mode CHECK (((billing_mode IS NULL) OR ((billing_mode)::text = ANY ((ARRAY['hourly'::character varying, 'monthly'::character varying])::text[])))),
    CONSTRAINT valid_budget_threshold CHECK (((budget_alert_threshold >= (0)::numeric) AND (budget_alert_threshold <= (100)::numeric))),
    CONSTRAINT valid_devices_per_agent CHECK (((devices_per_agent >= 1) AND (devices_per_agent <= 50))),
    CONSTRAINT valid_fleet_type CHECK (((fleet_type)::text = ANY ((ARRAY['virtual'::character varying, 'physical'::character varying, 'mixed'::character varying])::text[]))),
    CONSTRAINT valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'stopped'::character varying, 'deleted'::character varying, 'provisioning'::character varying])::text[])))
);



--
-- Name: TABLE fleets; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.fleets IS 'Unified fleet management for virtual and physical devices. Phase 1: Core schema.';


--
-- Name: COLUMN fleets.fleet_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.fleet_id IS 'Legacy column - nullable. Use fleet_uuid for all new operations.';


--
-- Name: COLUMN fleets.fleet_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.fleet_type IS 'virtual: K8s-deployed agents; physical: customer-owned hardware; mixed: both';


--
-- Name: COLUMN fleets.deployment_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.deployment_config IS 'JSONB: {agentCount, devicesPerAgent, resourceTier, etc.}';


--
-- Name: COLUMN fleets.billing_enabled; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.billing_enabled IS 'True for virtual fleets (usage-based billing), typically false for physical fleets';


--
-- Name: COLUMN fleets.total_running_hours; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.total_running_hours IS 'Cumulative lifetime running hours for billing';


--
-- Name: COLUMN fleets.current_cost; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.current_cost IS 'Running total cost for current billing period (resets monthly)';


--
-- Name: COLUMN fleets.tags; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.tags IS 'JSONB key-value pairs for flexible metadata (department, cost-center, etc.)';


--
-- Name: COLUMN fleets.k8s_namespace; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.k8s_namespace IS 'Kubernetes namespace for this fleet (virtual fleets only). Format: fleet-{fleet_id}';


--
-- Name: COLUMN fleets.agent_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.agent_count IS 'Number of virtual agents deployed in this fleet (used for K8s resource quota calculation)';


--
-- Name: COLUMN fleets.devices_per_agent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleets.devices_per_agent IS 'Number of devices each agent can manage (used for capacity planning)';


--
-- Name: device_fleet_references; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_fleet_references AS
 SELECT d.uuid AS device_uuid,
    d.device_name,
    d.device_type,
    d.fleet_id AS legacy_fleet_id,
    d.fleet_uuid,
    f.fleet_name,
    f.fleet_type,
        CASE
            WHEN ((d.fleet_uuid IS NULL) AND (d.fleet_id IS NOT NULL)) THEN 'missing_uuid'::text
            WHEN ((d.fleet_uuid IS NOT NULL) AND (d.fleet_id IS NULL)) THEN 'missing_id'::text
            WHEN ((d.fleet_uuid IS NULL) AND (d.fleet_id IS NULL)) THEN 'no_fleet'::text
            WHEN ((d.fleet_uuid IS NOT NULL) AND (d.fleet_id IS NOT NULL) AND (f.fleet_uuid IS NOT NULL)) THEN 'valid'::text
            ELSE 'inconsistent'::text
        END AS reference_status
   FROM (public.devices d
     LEFT JOIN public.fleets f ON ((d.fleet_uuid = f.fleet_uuid)))
  ORDER BY
        CASE
            WHEN ((d.fleet_uuid IS NULL) AND (d.fleet_id IS NOT NULL)) THEN 'missing_uuid'::text
            WHEN ((d.fleet_uuid IS NOT NULL) AND (d.fleet_id IS NULL)) THEN 'missing_id'::text
            WHEN ((d.fleet_uuid IS NULL) AND (d.fleet_id IS NULL)) THEN 'no_fleet'::text
            WHEN ((d.fleet_uuid IS NOT NULL) AND (d.fleet_id IS NOT NULL) AND (f.fleet_uuid IS NOT NULL)) THEN 'valid'::text
            ELSE 'inconsistent'::text
        END, d.device_name;



--
-- Name: VIEW device_fleet_references; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.device_fleet_references IS 'Debug view showing device ΓåÆ fleet relationships during migration from fleet_id to fleet_uuid';


--
-- Name: device_flows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_flows (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: TABLE device_flows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_flows IS 'Device-specific Node-RED subflows extracted from main flows';


--
-- Name: COLUMN device_flows.device_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.device_uuid IS 'Device this subflow is assigned to';


--
-- Name: COLUMN device_flows.subflow_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.subflow_id IS 'Node-RED subflow ID from main flows';


--
-- Name: COLUMN device_flows.subflow_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.subflow_name IS 'Human-readable subflow name';


--
-- Name: COLUMN device_flows.flows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.flows IS 'Array of subflow nodes (subflow + child nodes)';


--
-- Name: COLUMN device_flows.settings; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.settings IS 'Device-specific settings and configuration';


--
-- Name: COLUMN device_flows.modules; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.modules IS 'Required npm modules for this subflow';


--
-- Name: COLUMN device_flows.hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.hash IS 'SHA-256 hash of flows for change detection';


--
-- Name: COLUMN device_flows.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.version IS 'Incremented on each update';


--
-- Name: COLUMN device_flows.deployed_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_flows.deployed_at IS 'Timestamp when last pushed to device via MQTT';


--
-- Name: device_flows_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_flows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_flows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_flows_id_seq OWNED BY public.device_flows.id;


--
-- Name: device_job_status; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_job_status (
    id integer NOT NULL,
    job_id character varying(255) NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: device_job_status_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_job_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_job_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_job_status_id_seq OWNED BY public.device_job_status.id;


--
-- Name: device_logs_5min; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_logs_5min AS
 SELECT device_uuid,
    service_name,
    bucket,
    total_count,
    error_count,
    warn_count,
    info_count,
    debug_count,
    first_message,
    last_message,
    error_samples,
    warning_samples,
    bucket_start,
    bucket_end
   FROM _timescaledb_internal._materialized_hypertable_3;



--
-- Name: device_logs_hourly; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_logs_hourly AS
 SELECT device_uuid,
    service_name,
    bucket,
    total_count,
    error_count,
    warn_count,
    info_count,
    debug_count,
    bucket_start,
    bucket_end
   FROM _timescaledb_internal._materialized_hypertable_4;



--
-- Name: device_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_logs_id_seq OWNED BY public.device_logs.id;


--
-- Name: device_metrics_5min; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_metrics_5min AS
 SELECT bucket,
    device_uuid,
    avg_cpu_usage,
    max_cpu_usage,
    min_cpu_usage,
    avg_cpu_temp,
    max_cpu_temp,
    avg_memory_usage,
    max_memory_usage,
    avg_memory_total,
    avg_storage_usage,
    max_storage_usage,
    avg_storage_total,
    sample_count
   FROM _timescaledb_internal._materialized_hypertable_10;



--
-- Name: device_metrics_daily; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_metrics_daily AS
 SELECT bucket,
    device_uuid,
    avg_cpu_usage,
    max_cpu_usage,
    min_cpu_usage,
    avg_cpu_temp,
    max_cpu_temp,
    avg_memory_usage,
    max_memory_usage,
    avg_memory_total,
    avg_storage_usage,
    max_storage_usage,
    avg_storage_total,
    sample_count
   FROM _timescaledb_internal._materialized_hypertable_12;



--
-- Name: device_metrics_hourly; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.device_metrics_hourly AS
 SELECT bucket,
    device_uuid,
    avg_cpu_usage,
    max_cpu_usage,
    min_cpu_usage,
    avg_cpu_temp,
    max_cpu_temp,
    avg_memory_usage,
    max_memory_usage,
    avg_memory_total,
    avg_storage_usage,
    max_storage_usage,
    avg_storage_total,
    sample_count
   FROM _timescaledb_internal._materialized_hypertable_11;



--
-- Name: device_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_metrics_id_seq OWNED BY public.device_metrics.id;


--
-- Name: device_rollout_status; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_rollout_status (
    id integer NOT NULL,
    rollout_id character varying(255) NOT NULL,
    device_uuid uuid NOT NULL,
    batch_number integer NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    old_image_tag character varying(100),
    new_image_tag character varying(100),
    current_image_tag character varying(100),
    health_check_passed boolean,
    health_check_details jsonb,
    health_check_attempts integer DEFAULT 0,
    scheduled_at timestamp without time zone,
    update_started_at timestamp without time zone,
    image_pulled_at timestamp without time zone,
    container_restarted_at timestamp without time zone,
    health_checked_at timestamp without time zone,
    update_completed_at timestamp without time zone,
    rolled_back_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    error_message text,
    error_details jsonb,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    CONSTRAINT device_rollout_status_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'scheduled'::character varying, 'pulling'::character varying, 'updating'::character varying, 'health_checking'::character varying, 'completed'::character varying, 'failed'::character varying, 'rolled_back'::character varying, 'skipped'::character varying])::text[])))
);



--
-- Name: TABLE device_rollout_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_rollout_status IS 'Per-device status for each rollout';


--
-- Name: device_rollout_status_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_rollout_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_rollout_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_rollout_status_id_seq OWNED BY public.device_rollout_status.id;


--
-- Name: device_sensors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_sensors (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
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
    CONSTRAINT chk_deployment_status CHECK (((deployment_status)::text = ANY ((ARRAY['pending'::character varying, 'deployed'::character varying, 'failed'::character varying, 'pending_deletion'::character varying, 'virtual'::character varying, 'draft'::character varying])::text[])))
);



--
-- Name: TABLE device_sensors; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_sensors IS 'Relational storage of sensor device configurations. Config field in device_target_state remains source of truth for agent deployment.';


--
-- Name: COLUMN device_sensors.data_points; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.data_points IS 'JSONB array of data point definitions. Can be empty for OPC UA devices using auto-discovery.';


--
-- Name: COLUMN device_sensors.synced_to_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.synced_to_config IS 'Tracks whether this record is in sync with device_target_state.config';


--
-- Name: COLUMN device_sensors.config_version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.config_version IS 'Target state version this configuration was synced from';


--
-- Name: COLUMN device_sensors.deployment_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.deployment_status IS 'Deployment lifecycle: draft ΓåÆ pending ΓåÆ deployed/reconciling/failed. Agent sets to deployed/reconciling based on actual state.';


--
-- Name: COLUMN device_sensors.last_deployed_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.last_deployed_at IS 'Timestamp when sensor was last successfully deployed by agent';


--
-- Name: COLUMN device_sensors.deployment_error; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.deployment_error IS 'Last deployment error message if status is failed';


--
-- Name: COLUMN device_sensors.deployment_attempts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.deployment_attempts IS 'Number of deployment attempts (for retry logic)';


--
-- Name: COLUMN device_sensors.config_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.config_id IS 'UUID from config JSON - stable tracking ID from creation through deployment lifecycle. Generated client-side, persists through all states.';


--
-- Name: COLUMN device_sensors.uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.uuid IS 'Stable identifier for cloud/edge sync. Never changes even if name is updated.';


--
-- Name: COLUMN device_sensors.health_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_status IS 'Current connection status: connected, disconnected, error, disabled';


--
-- Name: COLUMN device_sensors.health_connected; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_connected IS 'Boolean connection state from adapter';


--
-- Name: COLUMN device_sensors.health_last_poll; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_last_poll IS 'Timestamp of last successful poll';


--
-- Name: COLUMN device_sensors.health_error_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_error_count IS 'Cumulative error count';


--
-- Name: COLUMN device_sensors.health_last_error; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_last_error IS 'Most recent error message';


--
-- Name: COLUMN device_sensors.health_updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.health_updated_at IS 'When health was last updated by agent';


--
-- Name: COLUMN device_sensors.location; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_sensors.location IS 'Physical or geographic location of the endpoint device (e.g., "Building A, Floor 2, Room 201" or "Production Line 3, Station 5")';


--
-- Name: device_sensors_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_sensors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_sensors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_sensors_id_seq OWNED BY public.device_sensors.id;


--
-- Name: device_services; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_services (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    service_name character varying(255) NOT NULL,
    image_id character varying(255),
    status character varying(50) DEFAULT 'Running'::character varying,
    install_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: device_services_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_services_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_services_id_seq OWNED BY public.device_services.id;


--
-- Name: device_shadow_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_shadow_history (
    id bigint NOT NULL,
    device_uuid uuid NOT NULL,
    shadow_name character varying(255) DEFAULT 'device-state'::character varying NOT NULL,
    reported_state jsonb NOT NULL,
    version integer DEFAULT 0,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE device_shadow_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_shadow_history IS 'Retention policy: Delete records older than 90 days via scheduled job';


--
-- Name: COLUMN device_shadow_history.shadow_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadow_history.shadow_name IS 'Shadow identifier (default: device-state)';


--
-- Name: COLUMN device_shadow_history.reported_state; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadow_history.reported_state IS 'Complete shadow state at this point in time';


--
-- Name: COLUMN device_shadow_history."timestamp"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadow_history."timestamp" IS 'When this shadow state was recorded';


--
-- Name: device_shadow_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_shadow_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_shadow_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_shadow_history_id_seq OWNED BY public.device_shadow_history.id;


--
-- Name: device_shadows; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_shadows (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    reported jsonb DEFAULT '{}'::jsonb,
    desired jsonb DEFAULT '{}'::jsonb,
    version integer DEFAULT 0,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE device_shadows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_shadows IS 'Device shadow state (AWS IoT pattern)';


--
-- Name: COLUMN device_shadows.reported; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadows.reported IS 'State reported by the device';


--
-- Name: COLUMN device_shadows.desired; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadows.desired IS 'Desired state from cloud/admin';


--
-- Name: COLUMN device_shadows.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_shadows.version IS 'Version number for optimistic locking';


--
-- Name: device_shadows_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_shadows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_shadows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_shadows_id_seq OWNED BY public.device_shadows.id;


--
-- Name: device_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_tags (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    key character varying(100) NOT NULL,
    value character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT device_tags_key_format CHECK ((((key)::text ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$'::text) AND (length((key)::text) >= 2) AND (length((key)::text) <= 100))),
    CONSTRAINT device_tags_value_not_empty CHECK (((length(TRIM(BOTH FROM value)) > 0) AND (length((value)::text) <= 255)))
);



--
-- Name: TABLE device_tags; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_tags IS 'Key-value tags for flexible device organization and querying';


--
-- Name: COLUMN device_tags.device_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_tags.device_uuid IS 'Device this tag belongs to';


--
-- Name: COLUMN device_tags.key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_tags.key IS 'Tag key (e.g., environment, location, hardware)';


--
-- Name: COLUMN device_tags.value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_tags.value IS 'Tag value (e.g., production, us-east-1, pi4)';


--
-- Name: COLUMN device_tags.created_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_tags.created_by IS 'User who created this tag';


--
-- Name: device_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_tags_id_seq OWNED BY public.device_tags.id;


--
-- Name: device_target_state; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_target_state (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: COLUMN device_target_state.needs_deployment; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state.needs_deployment IS 'Flag indicating configuration has changed but not deployed to device yet';


--
-- Name: COLUMN device_target_state.last_deployed_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state.last_deployed_at IS 'Timestamp of last deployment (version increment)';


--
-- Name: COLUMN device_target_state.deployed_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state.deployed_by IS 'User/system that triggered the deployment (e.g., dashboard, api, automation)';


--
-- Name: device_target_state_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_target_state_history (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
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
-- Name: TABLE device_target_state_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_target_state_history IS 'Historical snapshots of device target state at each deployment for audit and rollback';


--
-- Name: COLUMN device_target_state_history.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state_history.version IS 'Version number at time of deployment (matches device_target_state.version)';


--
-- Name: COLUMN device_target_state_history.apps; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state_history.apps IS 'Complete apps configuration at this deployment';


--
-- Name: COLUMN device_target_state_history.is_rollback; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state_history.is_rollback IS 'True if this deployment was a rollback to a previous version';


--
-- Name: COLUMN device_target_state_history.rollback_from_version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_target_state_history.rollback_from_version IS 'If rollback, the version we rolled back from';


--
-- Name: device_target_state_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_target_state_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_target_state_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_target_state_history_id_seq OWNED BY public.device_target_state_history.id;


--
-- Name: device_target_state_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_target_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_target_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_target_state_id_seq OWNED BY public.device_target_state.id;


--
-- Name: device_traffic_stats; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.device_traffic_stats (
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
-- Name: TABLE device_traffic_stats; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.device_traffic_stats IS 'Time-series storage for device API traffic metrics, aggregated by hour';


--
-- Name: COLUMN device_traffic_stats.device_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.device_id IS 'UUID of the device making the requests';


--
-- Name: COLUMN device_traffic_stats.endpoint; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.endpoint IS 'API endpoint path (e.g., /api/v1/devices/:uuid/state)';


--
-- Name: COLUMN device_traffic_stats.method; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.method IS 'HTTP method (GET, POST, PUT, DELETE, PATCH)';


--
-- Name: COLUMN device_traffic_stats.time_bucket; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.time_bucket IS 'Hourly time bucket for aggregating metrics (truncated to hour)';


--
-- Name: COLUMN device_traffic_stats.request_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.request_count IS 'Total number of requests in this time bucket';


--
-- Name: COLUMN device_traffic_stats.total_bytes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.total_bytes IS 'Total bytes transferred (response size)';


--
-- Name: COLUMN device_traffic_stats.total_time; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.total_time IS 'Total response time in milliseconds';


--
-- Name: COLUMN device_traffic_stats.success_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.success_count IS 'Number of successful requests (2xx status)';


--
-- Name: COLUMN device_traffic_stats.failed_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.failed_count IS 'Number of failed requests (non-2xx status)';


--
-- Name: COLUMN device_traffic_stats.status_codes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.device_traffic_stats.status_codes IS 'JSON object mapping status codes to counts, e.g., {"200": 15, "304": 5}';


--
-- Name: device_traffic_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.device_traffic_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: device_traffic_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.device_traffic_stats_id_seq OWNED BY public.device_traffic_stats.id;


--
-- Name: devices_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.devices_id_seq OWNED BY public.devices.id;


--
-- Name: devices_needing_rotation; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.devices_needing_rotation AS
 SELECT id,
    uuid,
    device_name,
    api_key_expires_at,
    api_key_last_rotated_at,
    api_key_rotation_days,
    EXTRACT(day FROM ((api_key_expires_at)::timestamp with time zone - now())) AS days_until_expiry
   FROM public.devices d
  WHERE ((is_active = true) AND (api_key_rotation_enabled = true) AND (api_key_expires_at IS NOT NULL) AND (api_key_expires_at <= (now() + '7 days'::interval)))
  ORDER BY api_key_expires_at;



--
-- Name: VIEW devices_needing_rotation; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.devices_needing_rotation IS 'Devices with API keys that need rotation soon (within 7 days)';


--
-- Name: dictionary_entries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.dictionary_entries (
    device_uuid uuid NOT NULL,
    field_name text NOT NULL,
    field_index integer NOT NULL,
    version_added integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: TABLE dictionary_entries; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_entries IS 'Device-specific field dictionaries for MQTT key compaction';


--
-- Name: COLUMN dictionary_entries.field_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_entries.field_name IS 'Full field path (e.g., messages[].readings[].value)';


--
-- Name: COLUMN dictionary_entries.field_index; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_entries.field_index IS 'Numeric index assigned by device (0-based)';


--
-- Name: COLUMN dictionary_entries.version_added; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_entries.version_added IS 'Dictionary version when field was added';


--
-- Name: dictionary_enum_devices; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_enum_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_enum_devices IS 'Protocol-namespaced device name enums (separates modbus_slave_3 from snmp_device_60)';


--
-- Name: COLUMN dictionary_enum_devices.enum_index; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_devices.enum_index IS 'Immutable numeric index (promotion threshold: 10 observations per protocol)';


--
-- Name: COLUMN dictionary_enum_devices.observation_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_devices.observation_count IS 'Times this device appeared';


--
-- Name: COLUMN dictionary_enum_devices.inactive; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_devices.inactive IS 'Soft delete - preserve for historical decoding';


--
-- Name: dictionary_enum_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dictionary_enum_devices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dictionary_enum_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dictionary_enum_devices_id_seq OWNED BY public.dictionary_enum_devices.id;


--
-- Name: dictionary_enum_metrics; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_enum_metrics; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_enum_metrics IS 'Protocol-namespaced metric name enums for compression (separates modbus.engine_rpm from snmp.sysUpTime)';


--
-- Name: COLUMN dictionary_enum_metrics.enum_index; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_metrics.enum_index IS 'Immutable numeric index for this metric in this protocol (never recycled)';


--
-- Name: COLUMN dictionary_enum_metrics.observation_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_metrics.observation_count IS 'Times this metric appeared (used for promotion threshold of 100)';


--
-- Name: COLUMN dictionary_enum_metrics.inactive; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_metrics.inactive IS 'Soft delete - keep for historical payload decoding';


--
-- Name: dictionary_enum_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dictionary_enum_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dictionary_enum_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dictionary_enum_metrics_id_seq OWNED BY public.dictionary_enum_metrics.id;


--
-- Name: dictionary_enum_observations; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_enum_observations; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_enum_observations IS 'Track observation frequency for enum promotion threshold detection';


--
-- Name: COLUMN dictionary_enum_observations.category; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_observations.category IS 'Type of enum: qualityCode (global), metric/device (protocol-namespaced), unit (global)';


--
-- Name: COLUMN dictionary_enum_observations.namespace; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_observations.namespace IS 'Protocol (modbus, snmp, opcua, mqtt, bacnet) - null for global enums';


--
-- Name: COLUMN dictionary_enum_observations.observation_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_observations.observation_count IS 'Times this value appeared';


--
-- Name: COLUMN dictionary_enum_observations.unique_value_count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_observations.unique_value_count IS 'Cardinality check (promote only if Γëñ max unique values)';


--
-- Name: COLUMN dictionary_enum_observations.is_promoted; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_observations.is_promoted IS 'True when threshold reached and enum index assigned';


--
-- Name: dictionary_enum_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dictionary_enum_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dictionary_enum_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dictionary_enum_observations_id_seq OWNED BY public.dictionary_enum_observations.id;


--
-- Name: dictionary_enum_quality_codes; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_enum_quality_codes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_enum_quality_codes IS 'Global quality code enum (promotion threshold: 20 observations)';


--
-- Name: COLUMN dictionary_enum_quality_codes.enum_index; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_quality_codes.enum_index IS 'Immutable numeric index for this device';


--
-- Name: COLUMN dictionary_enum_quality_codes.inactive; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_quality_codes.inactive IS 'Soft delete - preserve for historical decoding';


--
-- Name: dictionary_enum_quality_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dictionary_enum_quality_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dictionary_enum_quality_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dictionary_enum_quality_codes_id_seq OWNED BY public.dictionary_enum_quality_codes.id;


--
-- Name: dictionary_enum_units; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_enum_units; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_enum_units IS 'Global unit value enum (promotion threshold: 50 observations)';


--
-- Name: COLUMN dictionary_enum_units.enum_index; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_units.enum_index IS 'Immutable numeric index';


--
-- Name: COLUMN dictionary_enum_units.inactive; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_enum_units.inactive IS 'Soft delete - preserve for historical decoding';


--
-- Name: dictionary_enum_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.dictionary_enum_summary AS
 SELECT dictionary_enum_metrics.device_uuid,
    'metric'::text AS enum_type,
    dictionary_enum_metrics.protocol,
    count(*) AS total_promoted,
    sum(dictionary_enum_metrics.observation_count) AS total_observations,
    avg(dictionary_enum_metrics.observation_count) AS avg_observations,
    max(dictionary_enum_metrics.promoted_at) AS last_promoted
   FROM public.dictionary_enum_metrics
  WHERE (NOT dictionary_enum_metrics.inactive)
  GROUP BY dictionary_enum_metrics.device_uuid, dictionary_enum_metrics.protocol
UNION ALL
 SELECT dictionary_enum_devices.device_uuid,
    'device'::text AS enum_type,
    dictionary_enum_devices.protocol,
    count(*) AS total_promoted,
    sum(dictionary_enum_devices.observation_count) AS total_observations,
    avg(dictionary_enum_devices.observation_count) AS avg_observations,
    max(dictionary_enum_devices.promoted_at) AS last_promoted
   FROM public.dictionary_enum_devices
  WHERE (NOT dictionary_enum_devices.inactive)
  GROUP BY dictionary_enum_devices.device_uuid, dictionary_enum_devices.protocol
UNION ALL
 SELECT dictionary_enum_quality_codes.device_uuid,
    'qualityCode'::text AS enum_type,
    NULL::character varying AS protocol,
    count(*) AS total_promoted,
    sum(dictionary_enum_quality_codes.observation_count) AS total_observations,
    avg(dictionary_enum_quality_codes.observation_count) AS avg_observations,
    max(dictionary_enum_quality_codes.promoted_at) AS last_promoted
   FROM public.dictionary_enum_quality_codes
  WHERE (NOT dictionary_enum_quality_codes.inactive)
  GROUP BY dictionary_enum_quality_codes.device_uuid
UNION ALL
 SELECT dictionary_enum_units.device_uuid,
    'unit'::text AS enum_type,
    NULL::character varying AS protocol,
    count(*) AS total_promoted,
    sum(dictionary_enum_units.observation_count) AS total_observations,
    avg(dictionary_enum_units.observation_count) AS avg_observations,
    max(dictionary_enum_units.promoted_at) AS last_promoted
   FROM public.dictionary_enum_units
  WHERE (NOT dictionary_enum_units.inactive)
  GROUP BY dictionary_enum_units.device_uuid;



--
-- Name: VIEW dictionary_enum_summary; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.dictionary_enum_summary IS 'Analytics view: Enum promotion summary by device, type, and protocol';


--
-- Name: dictionary_enum_units_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.dictionary_enum_units_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: dictionary_enum_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.dictionary_enum_units_id_seq OWNED BY public.dictionary_enum_units.id;


--
-- Name: dictionary_metadata; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE dictionary_metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.dictionary_metadata IS 'Device dictionary version and sync tracking';


--
-- Name: COLUMN dictionary_metadata.current_version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.current_version IS 'Latest dictionary version from device';


--
-- Name: COLUMN dictionary_metadata.dictionary_hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.dictionary_hash IS 'SHA-256 hash of sorted field names for integrity';


--
-- Name: COLUMN dictionary_metadata.format_version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.format_version IS '1=legacy fieldsByDomain, 2=new protocol-aware format (Phase 7)';


--
-- Name: COLUMN dictionary_metadata.quality_code_enum_frozen; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.quality_code_enum_frozen IS 'True after first promotion (enum is stable)';


--
-- Name: COLUMN dictionary_metadata.unit_enum_frozen; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.unit_enum_frozen IS 'True after threshold met (no new units)';


--
-- Name: COLUMN dictionary_metadata.last_enum_promotion; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.last_enum_promotion IS 'Timestamp of most recent enum promotion';


--
-- Name: COLUMN dictionary_metadata.total_metrics_promoted; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.total_metrics_promoted IS 'Count of metrics promoted to enums across all protocols';


--
-- Name: COLUMN dictionary_metadata.total_devices_promoted; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.total_devices_promoted IS 'Count of devices promoted to enums across all protocols';


--
-- Name: COLUMN dictionary_metadata.total_quality_codes_promoted; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.dictionary_metadata.total_quality_codes_promoted IS 'Count of quality codes promoted to enums';


--
-- Name: email_logs; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE email_logs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.email_logs IS 'Audit trail of all emails sent through PostOffice service';


--
-- Name: COLUMN email_logs.job_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.job_id IS 'Bull queue job ID for correlation';


--
-- Name: COLUMN email_logs.user_email; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.user_email IS 'Recipient email address';


--
-- Name: COLUMN email_logs.user_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.user_name IS 'Recipient name';


--
-- Name: COLUMN email_logs.template_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.template_name IS 'Email template used (e.g., VerifyEmail, UserSuspended)';


--
-- Name: COLUMN email_logs.context; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.context IS 'Template context data (JSON)';


--
-- Name: COLUMN email_logs.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.status IS 'Email status: queued, sent, failed';


--
-- Name: COLUMN email_logs.sent_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.sent_at IS 'Timestamp when email was successfully sent';


--
-- Name: COLUMN email_logs.error; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.email_logs.error IS 'Error message if email failed to send';


--
-- Name: email_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.email_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: email_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.email_logs_id_seq OWNED BY public.email_logs.id;


--
-- Name: endpoint_devices; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.endpoint_devices AS
 SELECT DISTINCT r.device_uuid AS agent_uuid,
    d.device_name AS agent_name,
    d.is_online AS agent_is_online,
    d.location AS agent_location,
    (r.extra ->> 'deviceName'::text) AS device_name,
    (r.extra ->> 'location'::text) AS device_location,
    r.protocol,
    max(r."time") AS last_seen,
    count(DISTINCT r.metric_name) AS metric_count,
    array_agg(DISTINCT r.metric_name ORDER BY r.metric_name) AS available_metrics,
    (((sum(
        CASE
            WHEN (r.quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) * (100)::double precision) AS overall_quality_percentage
   FROM (public.readings r
     LEFT JOIN public.devices d ON ((r.device_uuid = d.uuid)))
  WHERE ((r."time" > (now() - '7 days'::interval)) AND ((r.extra ->> 'deviceName'::text) IS NOT NULL))
  GROUP BY r.device_uuid, d.device_name, d.is_online, d.location, (r.extra ->> 'deviceName'::text), (r.extra ->> 'location'::text), r.protocol
  WITH NO DATA;



--
-- Name: MATERIALIZED VIEW endpoint_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.endpoint_devices IS 'List of actual endpoint devices (from extra.deviceName) with available metrics and location. Used for device discovery and widget selection. Includes both agent location and endpoint device location.';


--
-- Name: event_cursors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.event_cursors (
    processor_name character varying(100) NOT NULL,
    last_event_id bigint NOT NULL,
    last_processed_at timestamp without time zone DEFAULT now() NOT NULL
);



--
-- Name: event_types; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: COLUMN event_types.retention_tier; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.event_types.retention_tier IS 'Retention tier: critical (7 years), important (1 year), standard (90 days), debug (7 days)';


--
-- Name: COLUMN event_types.retention_days; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.event_types.retention_days IS 'Number of days to retain events of this type';


--
-- Name: events; Type: TABLE; Schema: public; Owner: postgres
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
)
PARTITION BY RANGE ("timestamp");



--
-- Name: COLUMN events.actor_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.events.actor_type IS 'Who triggered this event: user, device, system, api, scheduled_job';


--
-- Name: COLUMN events.actor_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.events.actor_id IS 'ID of the actor (user_id, device_uuid, job_id)';


--
-- Name: COLUMN events.severity; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.events.severity IS 'Event severity: debug, info, warning, error, critical';


--
-- Name: COLUMN events.impact; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.events.impact IS 'Business impact: low, medium, high';


--
-- Name: event_retention_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.event_retention_summary AS
 SELECT et.retention_tier,
    et.retention_days,
    count(DISTINCT et.event_type) AS event_type_count,
    count(e.event_id) AS total_events,
    pg_size_pretty((sum(pg_total_relation_size((('events_'::text || to_char(e."timestamp", 'YYYY_MM_DD'::text)))::regclass)))::bigint) AS estimated_storage
   FROM (public.event_types et
     LEFT JOIN public.events e ON (((et.event_type)::text = (e.event_type)::text)))
  GROUP BY et.retention_tier, et.retention_days
  ORDER BY et.retention_days DESC;



--
-- Name: VIEW event_retention_summary; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.event_retention_summary IS 'Summary of events by retention tier with storage estimates';


--
-- Name: event_type_statistics; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.event_type_statistics AS
 SELECT et.event_type,
    et.aggregate_type,
    et.description,
    et.retention_tier,
    et.retention_days,
    count(e.event_id) AS total_events,
    count(e.event_id) FILTER (WHERE (e."timestamp" >= (now() - '24:00:00'::interval))) AS last_24h,
    count(e.event_id) FILTER (WHERE (e."timestamp" >= (now() - '7 days'::interval))) AS last_7d,
    count(e.event_id) FILTER (WHERE (e."timestamp" >= (now() - '30 days'::interval))) AS last_30d,
    max(e."timestamp") AS last_event_time
   FROM (public.event_types et
     LEFT JOIN public.events e ON (((et.event_type)::text = (e.event_type)::text)))
  GROUP BY et.event_type, et.aggregate_type, et.description, et.retention_tier, et.retention_days
  ORDER BY (count(e.event_id)) DESC;



--
-- Name: VIEW event_type_statistics; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.event_type_statistics IS 'Event type usage statistics with retention information';


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: events_2026_01_11; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_11 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_12; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_12 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_13; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_13 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_14; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_14 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_15; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_15 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_16; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_16 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_17; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_17 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_18; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_18 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_19; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_19 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_20; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_20 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_21; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_21 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_22; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_22 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_23; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_23 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_24; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_24 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_25; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_25 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_26; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_26 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_27; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_27 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_28; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_28 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_29; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_29 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_30; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_30 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_01_31; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_01_31 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_01; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_01 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_02; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_02 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_03; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_03 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_04; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_04 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_05; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_05 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_06; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_06 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_07; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_07 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_08; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_08 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_09; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_09 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_10; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_10 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_11; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_11 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_12; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_12 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_13; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_13 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_14; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_14 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_15; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_15 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_16; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_16 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_17; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_17 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_22; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_22 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_23; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_23 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_24; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_24 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_25; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_25 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_26; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_26 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_27; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_27 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_02_28; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_02_28 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_01; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_01 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_02; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_02 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_03; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_03 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_04; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_04 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_05; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_05 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_06; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_06 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_07; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_07 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_08; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_08 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_09; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_09 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_10; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_10 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_11; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_11 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_12; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_12 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_13; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_13 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_14; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_14 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_15; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_15 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_16; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_16 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_17; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_17 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_18; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_18 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_19; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_19 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_20; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_20 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_21; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_21 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_22; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_22 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_23; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_23 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_24; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_24 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: events_2026_03_25; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.events_2026_03_25 (
    id bigint DEFAULT nextval('public.events_id_seq'::regclass) NOT NULL,
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
-- Name: fleet_billing_history; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT valid_invoice_status CHECK (((invoice_status IS NULL) OR ((invoice_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'overdue'::character varying, 'cancelled'::character varying])::text[])))),
    CONSTRAINT valid_period CHECK ((period_end > period_start))
);



--
-- Name: TABLE fleet_billing_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.fleet_billing_history IS 'Monthly billing history for fleets with usage metrics and invoice tracking';


--
-- Name: COLUMN fleet_billing_history.billing_month; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_billing_history.billing_month IS 'Format: YYYY-MM for grouping monthly charges';


--
-- Name: COLUMN fleet_billing_history.hours_running; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_billing_history.hours_running IS 'Total hours fleet was active during billing period';


--
-- Name: COLUMN fleet_billing_history.budget_exceeded; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_billing_history.budget_exceeded IS 'True if total_cost exceeded budget_limit during period';


--
-- Name: fleet_billing_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.fleet_billing_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: fleet_billing_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.fleet_billing_history_id_seq OWNED BY public.fleet_billing_history.id;


--
-- Name: fleet_billing_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.fleet_billing_summary AS
 SELECT f.fleet_uuid,
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
        CASE
            WHEN ((f.budget_limit IS NOT NULL) AND (f.budget_limit > (0)::numeric)) THEN round(((f.current_cost / f.budget_limit) * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS budget_used_percent,
        CASE
            WHEN ((f.budget_limit IS NOT NULL) AND (f.budget_limit > (0)::numeric)) THEN (f.current_cost >= ((f.budget_limit * f.budget_alert_threshold) / (100)::numeric))
            ELSE false
        END AS budget_alert_triggered,
        CASE
            WHEN (((f.billing_mode)::text = 'hourly'::text) AND (f.cost_per_hour IS NOT NULL)) THEN round((f.cost_per_hour * (730)::numeric), 2)
            ELSE f.cost_per_month
        END AS projected_monthly_cost,
        CASE
            WHEN (((f.status)::text = 'active'::text) AND (f.started_at IS NOT NULL)) THEN round((EXTRACT(epoch FROM (CURRENT_TIMESTAMP - (f.started_at)::timestamp with time zone)) / (3600)::numeric), 2)
            ELSE (0)::numeric
        END AS current_session_hours,
    count(d.uuid) AS device_count,
    count(d.uuid) FILTER (WHERE (d.is_online = true)) AS running_devices,
    ( SELECT count(*) AS count
           FROM public.device_sensors ds
          WHERE (ds.device_uuid IN ( SELECT d2.uuid
                   FROM public.devices d2
                  WHERE ((d2.fleet_id)::text = (f.fleet_id)::text)))) AS total_endpoints
   FROM (public.fleets f
     LEFT JOIN public.devices d ON (((d.fleet_id)::text = (f.fleet_id)::text)))
  WHERE ((f.billing_enabled = true) AND ((f.status)::text = ANY ((ARRAY['active'::character varying, 'stopped'::character varying])::text[])))
  GROUP BY f.fleet_uuid, f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, f.billing_mode, f.cost_per_hour, f.cost_per_month, f.total_running_hours, f.current_cost, f.budget_limit, f.budget_alert_threshold, f.last_metered_at, f.started_at, f.status;



--
-- Name: fleet_monthly_costs; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.fleet_monthly_costs AS
 SELECT f.customer_id,
    fbh.billing_month,
    count(DISTINCT fbh.fleet_id) AS fleet_count,
    sum(fbh.total_cost) AS total_monthly_cost,
    sum(fbh.hours_running) AS total_hours,
    avg(fbh.device_count) AS avg_device_count,
    sum(fbh.overage_cost) AS total_overage,
    count(*) FILTER (WHERE (fbh.budget_exceeded = true)) AS fleets_over_budget
   FROM (public.fleet_billing_history fbh
     JOIN public.fleets f ON (((f.fleet_id)::text = (fbh.fleet_id)::text)))
  GROUP BY f.customer_id, fbh.billing_month
  ORDER BY fbh.billing_month DESC, (sum(fbh.total_cost)) DESC;



--
-- Name: VIEW fleet_monthly_costs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.fleet_monthly_costs IS 'Aggregate monthly costs by customer for billing reports';


--
-- Name: fleet_namespaces; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE fleet_namespaces; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.fleet_namespaces IS 'Cache of pre-provisioned fleet namespaces from Kubernetes. Synced by FleetNamespaceManager every 5 minutes.';


--
-- Name: COLUMN fleet_namespaces.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.name IS 'Kubernetes namespace name (e.g., fleet-test, fleet-pool-01). Must match namespace with label iotistica.com/fleet-namespace=true';


--
-- Name: COLUMN fleet_namespaces.max_agents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.max_agents IS 'Maximum number of virtual agents allowed in this namespace. From namespace label iotistica.com/max-agents or ResourceQuota.';


--
-- Name: COLUMN fleet_namespaces.max_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.max_devices IS 'Maximum number of devices that can be managed in this namespace (max_agents ├ù devices_per_agent). From namespace label iotistica.com/max-devices.';


--
-- Name: COLUMN fleet_namespaces.current_agents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.current_agents IS 'Current number of virtual agent deployments in this namespace. Calculated from fleets table WHERE k8s_namespace = this.name.';


--
-- Name: COLUMN fleet_namespaces.current_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.current_devices IS 'Current number of devices managed in this namespace. Calculated from SUM(devices_per_agent) for fleets in this namespace.';


--
-- Name: COLUMN fleet_namespaces.cpu_quota_request; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.cpu_quota_request IS 'CPU resource quota request (e.g., "600m" for 2 agents ├ù 300m). From ResourceQuota hard limits.';


--
-- Name: COLUMN fleet_namespaces.memory_quota_request; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.memory_quota_request IS 'Memory resource quota request (e.g., "960Mi" for 2 agents ├ù 480Mi). From ResourceQuota hard limits.';


--
-- Name: COLUMN fleet_namespaces.available; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.available IS 'Whether namespace has capacity for more agents. False when current_agents >= max_agents.';


--
-- Name: COLUMN fleet_namespaces.utilization_percent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.utilization_percent IS 'Percentage of namespace capacity used. Calculated as (current_agents / max_agents) ├ù 100.';


--
-- Name: COLUMN fleet_namespaces.last_synced; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.fleet_namespaces.last_synced IS 'Last time namespace metadata was synced from Kubernetes. Used to trigger periodic re-sync.';


--
-- Name: fleet_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.fleet_summary AS
 SELECT f.id,
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
    count(d.uuid) AS total_devices,
    count(d.uuid) FILTER (WHERE (d.is_online = true)) AS online_devices,
    count(d.uuid) FILTER (WHERE (d.is_online = false)) AS offline_devices,
    count(d.uuid) FILTER (WHERE ((d.device_type)::text = 'virtual'::text)) AS virtual_devices,
    count(d.uuid) FILTER (WHERE (((d.device_type)::text <> 'virtual'::text) OR (d.device_type IS NULL))) AS physical_devices,
    COALESCE(round(avg(d.cpu_usage), 2), (0)::numeric) AS avg_cpu_usage,
    COALESCE(sum(d.memory_usage), (0)::numeric) AS total_memory_usage,
    COALESCE(sum(d.memory_total), (0)::numeric) AS total_memory_capacity,
        CASE
            WHEN (sum(d.memory_total) > (0)::numeric) THEN round(((sum(d.memory_usage) / sum(d.memory_total)) * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS avg_memory_percent,
    ( SELECT count(*) AS count
           FROM public.device_sensors ds
          WHERE (ds.device_uuid IN ( SELECT d2.uuid
                   FROM public.devices d2
                  WHERE ((d2.fleet_id)::text = (f.fleet_id)::text)))) AS total_endpoints
   FROM (public.fleets f
     LEFT JOIN public.devices d ON (((d.fleet_id)::text = (f.fleet_id)::text)))
  GROUP BY f.id, f.fleet_uuid, f.fleet_id, f.fleet_name, f.customer_id, f.fleet_type, f.status, f.billing_enabled, f.current_cost, f.budget_limit, f.environment, f.location, f.created_at, f.updated_at;



--
-- Name: fleet_usage_events; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT valid_event_type CHECK (((event_type)::text = ANY ((ARRAY['fleet_created'::character varying, 'started'::character varying, 'stopped'::character varying, 'cost_updated'::character varying, 'budget_alert'::character varying, 'budget_exceeded'::character varying, 'device_added'::character varying, 'device_removed'::character varying, 'deployment_complete'::character varying, 'deployment_failed'::character varying])::text[])))
);



--
-- Name: TABLE fleet_usage_events; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.fleet_usage_events IS 'Detailed event log for fleet lifecycle (start, stop, cost updates, alerts)';


--
-- Name: CONSTRAINT valid_event_type ON fleet_usage_events; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON CONSTRAINT valid_event_type ON public.fleet_usage_events IS 'Validates event types for fleet lifecycle tracking. fleet_created marks initial fleet creation.';


--
-- Name: fleet_usage_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.fleet_usage_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: fleet_usage_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.fleet_usage_events_id_seq OWNED BY public.fleet_usage_events.id;


--
-- Name: fleets_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.fleets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: fleets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.fleets_id_seq OWNED BY public.fleets.id;


--
-- Name: global_app_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.global_app_id_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: global_service_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.global_service_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: housekeeper_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.housekeeper_config (
    task_name character varying(255) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    schedule character varying(100),
    last_modified_at timestamp without time zone DEFAULT now() NOT NULL,
    last_modified_by character varying(255)
);



--
-- Name: TABLE housekeeper_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.housekeeper_config IS 'Configuration for housekeeper tasks (enable/disable, schedules)';


--
-- Name: housekeeper_runs; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE housekeeper_runs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.housekeeper_runs IS 'Tracks execution history of housekeeper maintenance tasks';


--
-- Name: housekeeper_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.housekeeper_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: housekeeper_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.housekeeper_runs_id_seq OWNED BY public.housekeeper_runs.id;


--
-- Name: image_approval_requests; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE image_approval_requests; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.image_approval_requests IS 'Workflow tracking for image approval process';


--
-- Name: COLUMN image_approval_requests.image_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_approval_requests.image_id IS 'Reference to approved image (for tag approvals)';


--
-- Name: COLUMN image_approval_requests.tag_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_approval_requests.tag_name IS 'Specific tag requiring approval';


--
-- Name: COLUMN image_approval_requests.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_approval_requests.metadata IS 'Additional metadata from Docker Hub (digest, architectures, etc)';


--
-- Name: image_approval_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.image_approval_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: image_approval_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.image_approval_requests_id_seq OWNED BY public.image_approval_requests.id;


--
-- Name: image_rollouts; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT image_rollouts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'scheduled'::character varying, 'in_progress'::character varying, 'paused'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'rolled_back'::character varying])::text[]))),
    CONSTRAINT image_rollouts_strategy_check CHECK (((strategy)::text = ANY ((ARRAY['auto'::character varying, 'staged'::character varying, 'manual'::character varying, 'scheduled'::character varying])::text[])))
);



--
-- Name: TABLE image_rollouts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.image_rollouts IS 'Tracks image update rollouts across fleet';


--
-- Name: COLUMN image_rollouts.failure_rate; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_rollouts.failure_rate IS 'Fraction of devices that failed (0.0000 to 1.0000)';


--
-- Name: image_rollouts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.image_rollouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: image_rollouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.image_rollouts_id_seq OWNED BY public.image_rollouts.id;


--
-- Name: image_tags; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE image_tags; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.image_tags IS 'Available tags/versions for approved images';


--
-- Name: COLUMN image_tags.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_tags.metadata IS 'Additional metadata from Docker Hub (architectures, layers, etc.)';


--
-- Name: COLUMN image_tags.last_updated; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_tags.last_updated IS 'Last update timestamp from Docker Hub (not our DB update time)';


--
-- Name: image_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.image_tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: image_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.image_tags_id_seq OWNED BY public.image_tags.id;


--
-- Name: image_update_policies; Type: TABLE; Schema: public; Owner: postgres
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
    device_tags jsonb,
    device_uuids text[],
    enabled boolean DEFAULT true,
    priority integer DEFAULT 100,
    description text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT image_update_policies_update_strategy_check CHECK (((update_strategy)::text = ANY ((ARRAY['auto'::character varying, 'staged'::character varying, 'manual'::character varying, 'scheduled'::character varying])::text[])))
);



--
-- Name: TABLE image_update_policies; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.image_update_policies IS 'Defines update strategies for Docker images';


--
-- Name: COLUMN image_update_policies.image_pattern; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_update_policies.image_pattern IS 'Glob pattern like iotistic/app:* or iotistic/*:latest';


--
-- Name: COLUMN image_update_policies.staged_batches; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_update_policies.staged_batches IS 'Number of batches for staged rollout';


--
-- Name: COLUMN image_update_policies.batch_delay_minutes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.image_update_policies.batch_delay_minutes IS 'Wait time between batches';


--
-- Name: image_update_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.image_update_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: image_update_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.image_update_policies_id_seq OWNED BY public.image_update_policies.id;


--
-- Name: images; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE images; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.images IS 'Registry of Docker images approved for deployment';


--
-- Name: COLUMN images.watch_for_updates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.images.watch_for_updates IS 'Whether to automatically check Docker Hub for new tags';


--
-- Name: COLUMN images.last_checked_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.images.last_checked_at IS 'Last time Docker Hub was polled for this image';


--
-- Name: COLUMN images.next_check_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.images.next_check_at IS 'Next scheduled check time';


--
-- Name: images_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.images_id_seq OWNED BY public.images.id;


--
-- Name: job_executions; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: job_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.job_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: job_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.job_executions_id_seq OWNED BY public.job_executions.id;


--
-- Name: job_handlers; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: job_handlers_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.job_handlers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: job_handlers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.job_handlers_id_seq OWNED BY public.job_handlers.id;


--
-- Name: job_templates; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: job_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.job_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: job_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.job_templates_id_seq OWNED BY public.job_templates.id;


--
-- Name: latest_readings; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.latest_readings AS
 SELECT DISTINCT ON (r.device_uuid, (r.extra ->> 'deviceName'::text), r.metric_name) r.device_uuid AS agent_uuid,
    (r.extra ->> 'deviceName'::text) AS device_name,
    (r.extra ->> 'location'::text) AS device_location,
    r.metric_name,
    r."time",
    r.value,
    r.quality,
    r.unit,
    r.protocol,
    (r.extra ->> 'ingested_at'::text) AS ingested_at,
    r.anomaly_score,
    r.anomaly_threshold,
    d.device_name AS agent_name,
    d.location AS agent_location,
    d.uuid AS agent_full_uuid,
    d.is_online AS agent_is_online
   FROM (public.readings r
     LEFT JOIN public.devices d ON ((r.device_uuid = d.uuid)))
  WHERE (r."time" > (now() - '01:00:00'::interval))
  ORDER BY r.device_uuid, (r.extra ->> 'deviceName'::text), r.metric_name, r."time" DESC
  WITH NO DATA;



--
-- Name: MATERIALIZED VIEW latest_readings; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.latest_readings IS 'Latest reading per metric per actual device (from extra.deviceName) with location info. Refreshed frequently for dashboard widgets.';


--
-- Name: log_alert_rules; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE log_alert_rules; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.log_alert_rules IS 'Alert rules for monitoring device logs';


--
-- Name: COLUMN log_alert_rules.device_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.device_uuid IS 'Device scope (NULL = global rule applies to all devices)';


--
-- Name: COLUMN log_alert_rules.pattern; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.pattern IS 'Pattern to match in log messages (regex or keyword)';


--
-- Name: COLUMN log_alert_rules.pattern_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.pattern_type IS 'Pattern matching type: regex, keyword, or exact';


--
-- Name: COLUMN log_alert_rules.service_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.service_name IS 'Filter by service name (NULL = all services)';


--
-- Name: COLUMN log_alert_rules.level; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.level IS 'Filter by log level (NULL = all levels)';


--
-- Name: COLUMN log_alert_rules.trigger_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.trigger_type IS 'How to trigger: count, rate, or sequence';


--
-- Name: COLUMN log_alert_rules.threshold; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.threshold IS 'Number of matches required to trigger';


--
-- Name: COLUMN log_alert_rules.time_window; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alert_rules.time_window IS 'Time window in seconds for count/rate triggers';


--
-- Name: log_alert_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.log_alert_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: log_alert_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.log_alert_rules_id_seq OWNED BY public.log_alert_rules.id;


--
-- Name: log_alerts; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE log_alerts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.log_alerts IS 'Alert instances triggered by log_alert_rules';


--
-- Name: COLUMN log_alerts.matched_log_ids; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alerts.matched_log_ids IS 'Array of device_logs.id entries that triggered this alert';


--
-- Name: COLUMN log_alerts.count; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alerts.count IS 'Number of log matches in the time window';


--
-- Name: COLUMN log_alerts.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alerts.status IS 'Alert lifecycle: active, acknowledged, or resolved';


--
-- Name: COLUMN log_alerts.first_seen; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alerts.first_seen IS 'Timestamp of first matching log';


--
-- Name: COLUMN log_alerts.last_seen; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.log_alerts.last_seen IS 'Timestamp of most recent matching log';


--
-- Name: log_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.log_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: log_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.log_alerts_id_seq OWNED BY public.log_alerts.id;


--
-- Name: metric_catalog; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.metric_catalog AS
 SELECT r.device_uuid AS agent_uuid,
    d.device_name AS agent_name,
    (r.extra ->> 'deviceName'::text) AS device_name,
    r.protocol,
    r.metric_name,
    r.unit,
    count(*) AS sample_count,
    min(r."time") AS first_seen,
    max(r."time") AS last_seen,
    avg(r.value) AS avg_value,
    min(r.value) AS min_value,
    max(r.value) AS max_value,
    stddev(r.value) AS stddev_value,
    (((sum(
        CASE
            WHEN (r.quality = 'good'::text) THEN 1
            ELSE 0
        END))::double precision / (NULLIF(count(*), 0))::double precision) * (100)::double precision) AS quality_percentage,
    avg(r.anomaly_score) FILTER (WHERE (r.anomaly_score IS NOT NULL)) AS avg_anomaly_score,
    max(r.anomaly_score) AS max_anomaly_score,
    count(*) FILTER (WHERE (r.anomaly_score > r.anomaly_threshold)) AS anomaly_count
   FROM (public.readings r
     LEFT JOIN public.devices d ON ((r.device_uuid = d.uuid)))
  WHERE (r."time" > (now() - '7 days'::interval))
  GROUP BY r.device_uuid, d.device_name, (r.extra ->> 'deviceName'::text), r.protocol, r.metric_name, r.unit
  WITH NO DATA;



--
-- Name: MATERIALIZED VIEW metric_catalog; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.metric_catalog IS 'Catalog of available metrics with statistics (7-day window). Used for metric discovery and widget configuration.';


--
-- Name: mqtt_acls; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: COLUMN mqtt_acls.access; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_acls.access IS '1=read, 2=write, 3=readwrite, 4=subscribe, 5=read+subscribe, 6=write+subscribe, 7=all';


--
-- Name: mqtt_acls_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_acls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_acls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_acls_id_seq OWNED BY public.mqtt_acls.id;


--
-- Name: mqtt_broker_config; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT valid_broker_type CHECK (((broker_type)::text = ANY ((ARRAY['local'::character varying, 'cloud'::character varying, 'edge'::character varying, 'test'::character varying])::text[]))),
    CONSTRAINT valid_keep_alive CHECK ((keep_alive > 0)),
    CONSTRAINT valid_port CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT valid_protocol CHECK (((protocol)::text = ANY ((ARRAY['mqtt'::character varying, 'mqtts'::character varying, 'ws'::character varying, 'wss'::character varying])::text[])))
);



--
-- Name: TABLE mqtt_broker_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.mqtt_broker_config IS 'MQTT broker connection configuration. Environment variables (MQTT_BROKER_*) always override database values.';


--
-- Name: COLUMN mqtt_broker_config.protocol; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_config.protocol IS 'Connection protocol: mqtt (plain), mqtts (TLS), ws (WebSocket), wss (WebSocket Secure)';


--
-- Name: COLUMN mqtt_broker_config.port; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_config.port IS 'MQTT broker port. E2E/Docker: 5883, Production with TLS: 8883';


--
-- Name: COLUMN mqtt_broker_config.use_tls; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_config.use_tls IS 'Enable TLS/SSL encryption. Requires valid certificates in ca_cert, client_cert, client_key fields';


--
-- Name: COLUMN mqtt_broker_config.is_default; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_config.is_default IS 'Default broker used for new device provisioning when device.mqtt_broker_id is NULL';


--
-- Name: COLUMN mqtt_broker_config.broker_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_broker_config.broker_type IS 'Broker deployment type: local (self-hosted Mosquitto), cloud (HiveMQ Cloud, AWS IoT Core), edge (gateway broker), test (development)';


--
-- Name: mqtt_broker_comparison; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.mqtt_broker_comparison AS
 SELECT id,
    name,
    broker_type,
    protocol,
    host,
    port,
    use_tls,
    is_active,
    is_default,
        CASE
            WHEN ((broker_type)::text = 'local'::text) THEN 'Self-hosted, full control, infrastructure management required'::text
            WHEN ((broker_type)::text = 'cloud'::text) THEN 'Managed service, zero infrastructure, usage-based pricing'::text
            WHEN ((broker_type)::text = 'edge'::text) THEN 'Edge gateway broker for local device communication'::text
            ELSE 'Testing/development broker'::text
        END AS deployment_model,
        CASE
            WHEN ((broker_type)::text = 'local'::text) THEN 'Customer infrastructure'::text
            WHEN ((broker_type)::text = 'cloud'::text) THEN (extra_config ->> 'provider'::text)
            ELSE 'N/A'::text
        END AS provider,
    created_at,
    updated_at,
    last_connected_at
   FROM public.mqtt_broker_config
  ORDER BY is_default DESC, is_active DESC, name;



--
-- Name: VIEW mqtt_broker_comparison; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.mqtt_broker_comparison IS 'Comparison view of available MQTT brokers for customer selection';


--
-- Name: mqtt_broker_config_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_broker_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_broker_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_broker_config_id_seq OWNED BY public.mqtt_broker_config.id;


--
-- Name: mqtt_broker_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_broker_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_broker_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_broker_stats_id_seq OWNED BY public.mqtt_broker_stats.id;


--
-- Name: mqtt_broker_summary; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.mqtt_broker_summary AS
 SELECT mbc.id,
    mbc.name,
    mbc.description,
    mbc.protocol,
    mbc.host,
    mbc.port,
    mbc.username,
    mbc.is_active,
    mbc.is_default,
    mbc.broker_type,
    mbc.use_tls,
    mbc.last_connected_at,
    mbc.created_at,
    count(d.uuid) AS device_count,
    count(
        CASE
            WHEN (d.is_active = true) THEN 1
            ELSE NULL::integer
        END) AS active_device_count
   FROM (public.mqtt_broker_config mbc
     LEFT JOIN public.devices d ON ((d.mqtt_broker_id = mbc.id)))
  GROUP BY mbc.id, mbc.name, mbc.description, mbc.protocol, mbc.host, mbc.port, mbc.username, mbc.is_active, mbc.is_default, mbc.broker_type, mbc.use_tls, mbc.last_connected_at, mbc.created_at;



--
-- Name: VIEW mqtt_broker_summary; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.mqtt_broker_summary IS 'MQTT broker configuration summary with device counts';


--
-- Name: mqtt_schema_history; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE mqtt_schema_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.mqtt_schema_history IS 'History of schema changes for MQTT topics';


--
-- Name: COLUMN mqtt_schema_history.schema_hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_schema_history.schema_hash IS 'MD5 hash of schema for deduplication';


--
-- Name: COLUMN mqtt_schema_history.topic_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_schema_history.topic_id IS 'Reference to mqtt_topics.topic_id';


--
-- Name: mqtt_schema_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_schema_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_schema_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_schema_history_id_seq OWNED BY public.mqtt_schema_history.id;


--
-- Name: mqtt_topic_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_topic_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_topic_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_topic_metrics_id_seq OWNED BY public.mqtt_topic_metrics.id;


--
-- Name: mqtt_topics; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE mqtt_topics; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.mqtt_topics IS 'Discovered MQTT topics and their metadata';


--
-- Name: COLUMN mqtt_topics.schema; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_topics.schema IS 'Inferred JSON schema from message samples';


--
-- Name: COLUMN mqtt_topics.topic_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.mqtt_topics.topic_id IS 'Stable UUID identifier for topic, used in API endpoints';


--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_topics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_topics_id_seq OWNED BY public.mqtt_topics.id;


--
-- Name: mqtt_users; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: mqtt_users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mqtt_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: mqtt_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mqtt_users_id_seq OWNED BY public.mqtt_users.id;


--
-- Name: nodered_credentials; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE nodered_credentials; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.nodered_credentials IS 'Node-RED encrypted credentials (single instance)';


--
-- Name: COLUMN nodered_credentials.revision; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.nodered_credentials.revision IS 'Revision counter for optimistic locking';


--
-- Name: nodered_flows; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE nodered_flows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.nodered_flows IS 'Node-RED flow configurations (single instance)';


--
-- Name: COLUMN nodered_flows.revision; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.nodered_flows.revision IS 'Revision counter for optimistic locking';


--
-- Name: nodered_library; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE nodered_library; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.nodered_library IS 'Node-RED library entries (reusable flows/functions)';


--
-- Name: nodered_library_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.nodered_library_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: nodered_library_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.nodered_library_id_seq OWNED BY public.nodered_library.id;


--
-- Name: nodered_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nodered_sessions (
    id integer DEFAULT 1 NOT NULL,
    sessions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);



--
-- Name: TABLE nodered_sessions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.nodered_sessions IS 'Node-RED user sessions (single instance)';


--
-- Name: nodered_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.nodered_settings (
    id integer DEFAULT 1 NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT single_row CHECK ((id = 1))
);



--
-- Name: TABLE nodered_settings; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.nodered_settings IS 'Node-RED runtime settings (single instance)';


--
-- Name: profile_configs; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE profile_configs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.profile_configs IS 'Centralized protocol configuration profiles (formerly vendor_configs) - replaces static dataPoints.json file';


--
-- Name: COLUMN profile_configs.profile_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.profile_configs.profile_name IS 'Profile identifier (e.g., COMAP, Generic, ComAp-InteliGen)';


--
-- Name: COLUMN profile_configs.data_points; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.profile_configs.data_points IS 'JSONB array of protocol-specific data point definitions';


--
-- Name: COLUMN profile_configs.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.profile_configs.metadata IS 'Additional profile information (URLs, descriptions, model, version, etc.)';


--
-- Name: provisioning_attempts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.provisioning_attempts (
    id bigint NOT NULL,
    ip_address inet NOT NULL,
    device_uuid uuid,
    provisioning_key_id uuid,
    success boolean NOT NULL,
    error_message text,
    user_agent text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE provisioning_attempts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.provisioning_attempts IS 'Tracks provisioning attempts for rate limiting and security monitoring';


--
-- Name: provisioning_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.provisioning_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: provisioning_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.provisioning_attempts_id_seq OWNED BY public.provisioning_attempts.id;


--
-- Name: provisioning_keys; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.provisioning_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_hash character varying(255) NOT NULL,
    fleet_id character varying(100),
    description text,
    max_devices integer DEFAULT 100,
    devices_provisioned integer DEFAULT 0,
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
    CONSTRAINT devices_not_exceeded CHECK ((devices_provisioned <= max_devices))
);



--
-- Name: TABLE provisioning_keys; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.provisioning_keys IS 'Fleet-level provisioning keys with device limits and expiration';


--
-- Name: COLUMN provisioning_keys.fleet_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.fleet_id IS 'Legacy column - nullable. Use fleet_uuid for all new operations.';


--
-- Name: COLUMN provisioning_keys.key_hash_fast; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.key_hash_fast IS 'SHA-256 hash for fast O(1) lookup before bcrypt verification. Reduces validation from O(N) to O(1) + 1 bcrypt.';


--
-- Name: COLUMN provisioning_keys.deployment_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.deployment_type IS 'Deployment type: k8s-fleet, edge-device, or standalone';


--
-- Name: COLUMN provisioning_keys.simulator_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.simulator_config IS 'JSON configuration for simulators (Modbus, OPC-UA, SNMP) used in K8s fleet deployments';


--
-- Name: COLUMN provisioning_keys.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.metadata IS 'Additional metadata about the deployment (pod name, index, etc.)';


--
-- Name: COLUMN provisioning_keys.fleet_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.provisioning_keys.fleet_uuid IS 'UUID reference to fleets.fleet_uuid (preferred over fleet_id)';


--
-- Name: provisioning_key_fleet_references; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.provisioning_key_fleet_references AS
 SELECT pk.id AS key_id,
    pk.description,
    pk.fleet_id AS legacy_fleet_id,
    pk.fleet_uuid,
    f.fleet_name,
    f.fleet_type,
    pk.max_devices,
    pk.devices_provisioned,
    pk.is_active,
    pk.expires_at,
        CASE
            WHEN ((pk.fleet_id IS NULL) AND (pk.fleet_uuid IS NULL)) THEN 'no_fleet'::text
            WHEN ((pk.fleet_id IS NOT NULL) AND (pk.fleet_uuid IS NULL)) THEN 'orphaned_fleet_id'::text
            WHEN ((pk.fleet_id IS NULL) AND (pk.fleet_uuid IS NOT NULL)) THEN 'uuid_only'::text
            WHEN ((pk.fleet_id IS NOT NULL) AND (pk.fleet_uuid IS NOT NULL) AND (f.fleet_id IS NOT NULL)) THEN 'migrated'::text
            WHEN ((pk.fleet_id IS NOT NULL) AND (pk.fleet_uuid IS NOT NULL) AND (f.fleet_id IS NULL)) THEN 'invalid_fleet_uuid'::text
            ELSE 'unknown'::text
        END AS migration_status
   FROM (public.provisioning_keys pk
     LEFT JOIN public.fleets f ON ((pk.fleet_uuid = f.fleet_uuid)))
  ORDER BY pk.created_at DESC;



--
-- Name: VIEW provisioning_key_fleet_references; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.provisioning_key_fleet_references IS 'Helper view showing provisioning key fleet references during migration from fleet_id to fleet_uuid. Check migration_status column for issues.';


--
-- Name: readings_1h; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.readings_1h AS
 SELECT bucket,
    agent_uuid,
    device_name,
    protocol,
    metric_name,
    unit,
    avg_value,
    min_value,
    max_value,
    stddev_value,
    sample_count,
    quality_ratio
   FROM _timescaledb_internal._materialized_hypertable_18;



--
-- Name: readings_1m; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.readings_1m AS
 SELECT bucket,
    agent_uuid,
    device_name,
    protocol,
    metric_name,
    unit,
    avg_value,
    min_value,
    max_value,
    sample_count,
    quality_ratio,
    max_anomaly_score,
    avg_anomaly_score
   FROM _timescaledb_internal._materialized_hypertable_17;



--
-- Name: readings_daily; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.readings_daily AS
 SELECT bucket,
    device_uuid,
    device_name,
    metric_name,
    protocol,
    avg_value,
    min_value,
    max_value,
    stddev_value,
    sample_count,
    first_value,
    last_value,
    last_time,
    quality_ratio
   FROM _timescaledb_internal._materialized_hypertable_22;



--
-- Name: readings_hourly; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.readings_hourly AS
 SELECT bucket,
    device_uuid,
    device_name,
    metric_name,
    protocol,
    avg_value,
    min_value,
    max_value,
    stddev_value,
    sample_count,
    first_value,
    last_value,
    last_time,
    quality_ratio
   FROM _timescaledb_internal._materialized_hypertable_21;



--
-- Name: recent_anomalies; Type: MATERIALIZED VIEW; Schema: public; Owner: postgres
--

CREATE MATERIALIZED VIEW public.recent_anomalies AS
 SELECT ae.timestamp_ms,
    ae.agent_uuid AS agent_id,
    ae.metric,
    ae.observed_value,
    ae.anomaly_score,
    ae.confidence,
    ae.severity,
    ae.severity_reason,
    ae.fingerprint,
    ae.triggered_by,
    ae.baseline,
    ae.expected_range,
    ae.deviation,
    ae.consecutive_count,
    ae.event_count,
    d.device_name AS agent_name,
    d.uuid AS agent_uuid,
    d.is_online AS agent_is_online
   FROM (public.anomaly_events ae
     LEFT JOIN public.devices d ON ((ae.agent_uuid = (d.uuid)::text)))
  WHERE (ae.timestamp_ms > ((EXTRACT(epoch FROM (now() - '24:00:00'::interval)))::bigint * 1000))
  ORDER BY ae.timestamp_ms DESC
  WITH NO DATA;



--
-- Name: MATERIALIZED VIEW recent_anomalies; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON MATERIALIZED VIEW public.recent_anomalies IS 'Recent anomaly events (last 24 hours) from anomaly_events table. Used for anomaly timeline widgets.';


--
-- Name: reconciliation_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.reconciliation_history (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    status character varying(20) NOT NULL,
    target_snapshot_id integer,
    current_snapshot_id integer,
    changes_detected integer DEFAULT 0,
    changes_applied integer DEFAULT 0,
    changes_failed integer DEFAULT 0,
    diff jsonb,
    actions_taken jsonb,
    errors jsonb,
    duration_ms integer,
    correlation_id uuid,
    CONSTRAINT reconciliation_history_status_check CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'success'::character varying, 'failed'::character varying, 'partial'::character varying])::text[])))
);



--
-- Name: reconciliation_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.reconciliation_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: reconciliation_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.reconciliation_history_id_seq OWNED BY public.reconciliation_history.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;


--
-- Name: releases; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: releases_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.releases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: releases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.releases_id_seq OWNED BY public.releases.id;


--
-- Name: rollout_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rollout_events (
    id integer NOT NULL,
    rollout_id character varying(255) NOT NULL,
    device_uuid uuid,
    event_type character varying(50) NOT NULL,
    event_data jsonb,
    message text,
    "timestamp" timestamp without time zone DEFAULT now(),
    CONSTRAINT rollout_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['rollout_created'::character varying, 'rollout_started'::character varying, 'batch_started'::character varying, 'batch_completed'::character varying, 'device_scheduled'::character varying, 'device_updated'::character varying, 'device_failed'::character varying, 'health_check_passed'::character varying, 'health_check_failed'::character varying, 'rollback_triggered'::character varying, 'rollout_paused'::character varying, 'rollout_resumed'::character varying, 'rollout_completed'::character varying, 'rollout_failed'::character varying])::text[])))
);



--
-- Name: TABLE rollout_events; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.rollout_events IS 'Detailed event log for rollout debugging';


--
-- Name: rollout_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.rollout_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: rollout_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.rollout_events_id_seq OWNED BY public.rollout_events.id;


--
-- Name: scheduled_jobs; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT chk_schedule_type CHECK (((schedule_type)::text = ANY ((ARRAY['cron'::character varying, 'interval'::character varying])::text[]))),
    CONSTRAINT chk_target_type CHECK (((target_type)::text = ANY ((ARRAY['device'::character varying, 'group'::character varying, 'all'::character varying])::text[])))
);



--
-- Name: scheduled_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.scheduled_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: scheduled_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.scheduled_jobs_id_seq OWNED BY public.scheduled_jobs.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    id integer NOT NULL,
    migration_number integer NOT NULL,
    name character varying(255) NOT NULL,
    filename character varying(255) NOT NULL,
    applied_at timestamp without time zone DEFAULT now(),
    checksum character varying(64),
    execution_time_ms integer
);



--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE IF NOT EXISTS public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;


--
-- Name: sensor_health_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sensor_health_history (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    sensor_name character varying(255) NOT NULL,
    state character varying(50) NOT NULL,
    healthy boolean DEFAULT false NOT NULL,
    addr character varying(500) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_error text,
    last_error_time timestamp with time zone,
    last_connected_time timestamp with time zone,
    messages_received bigint DEFAULT 0,
    messages_published bigint DEFAULT 0,
    bytes_received bigint DEFAULT 0,
    bytes_published bigint DEFAULT 0,
    reconnect_attempts integer DEFAULT 0,
    last_publish_time timestamp with time zone,
    last_heartbeat_time timestamp with time zone,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: TABLE sensor_health_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.sensor_health_history IS 'Historical tracking of sensor connection health from sensor-publish feature. Grants applied conditionally based on role existence.';


--
-- Name: sensor_health_history_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.sensor_health_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: sensor_health_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.sensor_health_history_id_seq OWNED BY public.sensor_health_history.id;


--
-- Name: sensor_health_latest; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.sensor_health_latest AS
 SELECT DISTINCT ON (device_uuid, sensor_name) id,
    device_uuid,
    sensor_name,
    state,
    healthy,
    addr,
    enabled,
    last_error,
    last_error_time,
    last_connected_time,
    messages_received,
    messages_published,
    bytes_received,
    bytes_published,
    reconnect_attempts,
    last_publish_time,
    last_heartbeat_time,
    reported_at
   FROM public.sensor_health_history
  ORDER BY device_uuid, sensor_name, reported_at DESC;



--
-- Name: VIEW sensor_health_latest; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.sensor_health_latest IS 'Latest sensor health status for each device (dashboard view)';


--
-- Name: shell_audit_log; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE shell_audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.shell_audit_log IS 'Audit log of shell commands executed via Remote Access';


--
-- Name: COLUMN shell_audit_log.command; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_audit_log.command IS 'The command text entered by the user (logged when Enter is pressed)';


--
-- Name: shell_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.shell_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: shell_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.shell_audit_log_id_seq OWNED BY public.shell_audit_log.id;


--
-- Name: shell_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.shell_sessions (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_uuid uuid NOT NULL,
    user_id character varying(255),
    status character varying(20) DEFAULT 'creating'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_activity timestamp with time zone DEFAULT now(),
    terminated_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT valid_status CHECK (((status)::text = ANY ((ARRAY['creating'::character varying, 'starting'::character varying, 'active'::character varying, 'detached'::character varying, 'agent-timeout'::character varying, 'terminated'::character varying])::text[])))
);



--
-- Name: TABLE shell_sessions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.shell_sessions IS 'Persistent shell sessions that survive client disconnects';


--
-- Name: COLUMN shell_sessions.session_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.session_id IS 'Unique session identifier (UUID)';


--
-- Name: COLUMN shell_sessions.device_uuid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.device_uuid IS 'Device this session is connected to';


--
-- Name: COLUMN shell_sessions.user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.user_id IS 'User who created the session (optional)';


--
-- Name: COLUMN shell_sessions.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.status IS 'Session lifecycle status: creating (session created), starting (command sent to agent), active (agent responded), detached (client disconnected), agent-timeout (agent not responding), terminated (session ended)';


--
-- Name: COLUMN shell_sessions.last_activity; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.last_activity IS 'Last time session received input or output';


--
-- Name: COLUMN shell_sessions.terminated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.terminated_at IS 'When session was explicitly terminated';


--
-- Name: COLUMN shell_sessions.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.shell_sessions.metadata IS 'Additional session metadata (shell type, terminal size, etc.)';


--
-- Name: state_changes; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT state_changes_state_type_check CHECK (((state_type)::text = ANY ((ARRAY['target'::character varying, 'current'::character varying])::text[])))
);



--
-- Name: state_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.state_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: state_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.state_changes_id_seq OWNED BY public.state_changes.id;


--
-- Name: state_projections; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: state_snapshots; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.state_snapshots (
    id integer NOT NULL,
    device_uuid uuid NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    state_type character varying(20) NOT NULL,
    state jsonb NOT NULL,
    version integer NOT NULL,
    checksum character varying(64) NOT NULL,
    source character varying(50),
    notes text,
    CONSTRAINT state_snapshots_state_type_check CHECK (((state_type)::text = ANY ((ARRAY['target'::character varying, 'current'::character varying])::text[])))
);



--
-- Name: state_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.state_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: state_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.state_snapshots_id_seq OWNED BY public.state_snapshots.id;


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.system_config (
    key character varying(255) NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);



--
-- Name: TABLE system_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.system_config IS 'System-wide configuration (cloud state, not env vars). Use configService.get/set to access.';


--
-- Name: COLUMN system_config.key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.system_config.key IS 'Configuration key (e.g., heartbeat_last_check)';


--
-- Name: COLUMN system_config.value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.system_config.value IS 'Configuration value stored as JSON';


--
-- Name: COLUMN system_config.updated_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.system_config.updated_at IS 'Last update timestamp';


--
-- Name: tag_definitions; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE tag_definitions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tag_definitions IS 'Optional tag governance - defines allowed keys and values';


--
-- Name: COLUMN tag_definitions.key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tag_definitions.key IS 'Tag key name';


--
-- Name: COLUMN tag_definitions.allowed_values; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tag_definitions.allowed_values IS 'Suggested values shown in UI (NULL = no suggestions). Values are NOT enforced - users can enter any value.';


--
-- Name: COLUMN tag_definitions.is_required; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tag_definitions.is_required IS 'Whether this tag must exist on all devices';


--
-- Name: tag_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tag_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: tag_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tag_definitions_id_seq OWNED BY public.tag_definitions.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.user_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: user_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
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
    CONSTRAINT valid_role CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'manager'::character varying, 'operator'::character varying, 'viewer'::character varying])::text[])))
);



--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.users IS 'System users with authentication credentials';


--
-- Name: COLUMN users.username; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.username IS 'Unique username for login';


--
-- Name: COLUMN users.password_hash; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.password_hash IS 'Bcrypt hashed password';


--
-- Name: COLUMN users.role; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.role IS 'User role: admin, user, viewer';


--
-- Name: CONSTRAINT valid_role ON users; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON CONSTRAINT valid_role ON public.users IS 'Valid roles: owner (full access + billing), admin (full access), manager (read all + write devices/users), operator (read all + control devices), viewer (read-only)';


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vendor_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.vendor_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: vendor_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.vendor_configs_id_seq OWNED BY public.profile_configs.id;


--
-- Name: wg_config; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE wg_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.wg_config IS 'WireGuard server interface configuration';


--
-- Name: wg_config_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.wg_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: wg_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.wg_config_id_seq OWNED BY public.wg_config.id;


--
-- Name: wg_ip_pool; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.wg_ip_pool (
    id integer NOT NULL,
    ip_address character varying(45) NOT NULL,
    assigned_to character varying(255),
    assigned_at timestamp without time zone,
    is_available boolean DEFAULT true
);



--
-- Name: TABLE wg_ip_pool; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.wg_ip_pool IS 'Available IP addresses for VPN clients (10.8.0.2-254)';


--
-- Name: wg_ip_pool_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.wg_ip_pool_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: wg_ip_pool_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.wg_ip_pool_id_seq OWNED BY public.wg_ip_pool.id;


--
-- Name: wg_peers; Type: TABLE; Schema: public; Owner: postgres
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
-- Name: TABLE wg_peers; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.wg_peers IS 'WireGuard VPN peer configurations';


--
-- Name: COLUMN wg_peers.peer_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.peer_id IS 'Unique peer identifier (UUID)';


--
-- Name: COLUMN wg_peers.public_key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.public_key IS 'WireGuard peer public key';


--
-- Name: COLUMN wg_peers.private_key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.private_key IS 'WireGuard peer private key (for client config generation)';


--
-- Name: COLUMN wg_peers.preshared_key; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.preshared_key IS 'Optional preshared key for post-quantum security';


--
-- Name: COLUMN wg_peers.ip_address; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.ip_address IS 'Allocated VPN IP address';


--
-- Name: COLUMN wg_peers.device_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.wg_peers.device_id IS 'Associated IoT device identifier';


--
-- Name: wg_peers_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.wg_peers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: wg_peers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.wg_peers_id_seq OWNED BY public.wg_peers.id;


--
-- Name: events_2026_01_11; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_11 FOR VALUES FROM ('2026-01-11 00:00:00') TO ('2026-01-12 00:00:00');


--
-- Name: events_2026_01_12; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_12 FOR VALUES FROM ('2026-01-12 00:00:00') TO ('2026-01-13 00:00:00');


--
-- Name: events_2026_01_13; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_13 FOR VALUES FROM ('2026-01-13 00:00:00') TO ('2026-01-14 00:00:00');


--
-- Name: events_2026_01_14; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_14 FOR VALUES FROM ('2026-01-14 00:00:00') TO ('2026-01-15 00:00:00');


--
-- Name: events_2026_01_15; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_15 FOR VALUES FROM ('2026-01-15 00:00:00') TO ('2026-01-16 00:00:00');


--
-- Name: events_2026_01_16; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_16 FOR VALUES FROM ('2026-01-16 00:00:00') TO ('2026-01-17 00:00:00');


--
-- Name: events_2026_01_17; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_17 FOR VALUES FROM ('2026-01-17 00:00:00') TO ('2026-01-18 00:00:00');


--
-- Name: events_2026_01_18; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_18 FOR VALUES FROM ('2026-01-18 00:00:00') TO ('2026-01-19 00:00:00');


--
-- Name: events_2026_01_19; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_19 FOR VALUES FROM ('2026-01-19 00:00:00') TO ('2026-01-20 00:00:00');


--
-- Name: events_2026_01_20; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_20 FOR VALUES FROM ('2026-01-20 00:00:00') TO ('2026-01-21 00:00:00');


--
-- Name: events_2026_01_21; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_21 FOR VALUES FROM ('2026-01-21 00:00:00') TO ('2026-01-22 00:00:00');


--
-- Name: events_2026_01_22; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_22 FOR VALUES FROM ('2026-01-22 00:00:00') TO ('2026-01-23 00:00:00');


--
-- Name: events_2026_01_23; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_23 FOR VALUES FROM ('2026-01-23 00:00:00') TO ('2026-01-24 00:00:00');


--
-- Name: events_2026_01_24; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_24 FOR VALUES FROM ('2026-01-24 00:00:00') TO ('2026-01-25 00:00:00');


--
-- Name: events_2026_01_25; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_25 FOR VALUES FROM ('2026-01-25 00:00:00') TO ('2026-01-26 00:00:00');


--
-- Name: events_2026_01_26; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_26 FOR VALUES FROM ('2026-01-26 00:00:00') TO ('2026-01-27 00:00:00');


--
-- Name: events_2026_01_27; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_27 FOR VALUES FROM ('2026-01-27 00:00:00') TO ('2026-01-28 00:00:00');


--
-- Name: events_2026_01_28; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_28 FOR VALUES FROM ('2026-01-28 00:00:00') TO ('2026-01-29 00:00:00');


--
-- Name: events_2026_01_29; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_29 FOR VALUES FROM ('2026-01-29 00:00:00') TO ('2026-01-30 00:00:00');


--
-- Name: events_2026_01_30; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_30 FOR VALUES FROM ('2026-01-30 00:00:00') TO ('2026-01-31 00:00:00');


--
-- Name: events_2026_01_31; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_01_31 FOR VALUES FROM ('2026-01-31 00:00:00') TO ('2026-02-01 00:00:00');


--
-- Name: events_2026_02_01; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_01 FOR VALUES FROM ('2026-02-01 00:00:00') TO ('2026-02-02 00:00:00');


--
-- Name: events_2026_02_02; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_02 FOR VALUES FROM ('2026-02-02 00:00:00') TO ('2026-02-03 00:00:00');


--
-- Name: events_2026_02_03; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_03 FOR VALUES FROM ('2026-02-03 00:00:00') TO ('2026-02-04 00:00:00');


--
-- Name: events_2026_02_04; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_04 FOR VALUES FROM ('2026-02-04 00:00:00') TO ('2026-02-05 00:00:00');


--
-- Name: events_2026_02_05; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_05 FOR VALUES FROM ('2026-02-05 00:00:00') TO ('2026-02-06 00:00:00');


--
-- Name: events_2026_02_06; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_06 FOR VALUES FROM ('2026-02-06 00:00:00') TO ('2026-02-07 00:00:00');


--
-- Name: events_2026_02_07; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_07 FOR VALUES FROM ('2026-02-07 00:00:00') TO ('2026-02-08 00:00:00');


--
-- Name: events_2026_02_08; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_08 FOR VALUES FROM ('2026-02-08 00:00:00') TO ('2026-02-09 00:00:00');


--
-- Name: events_2026_02_09; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_09 FOR VALUES FROM ('2026-02-09 00:00:00') TO ('2026-02-10 00:00:00');


--
-- Name: events_2026_02_10; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_10 FOR VALUES FROM ('2026-02-10 00:00:00') TO ('2026-02-11 00:00:00');


--
-- Name: events_2026_02_11; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_11 FOR VALUES FROM ('2026-02-11 00:00:00') TO ('2026-02-12 00:00:00');


--
-- Name: events_2026_02_12; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_12 FOR VALUES FROM ('2026-02-12 00:00:00') TO ('2026-02-13 00:00:00');


--
-- Name: events_2026_02_13; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_13 FOR VALUES FROM ('2026-02-13 00:00:00') TO ('2026-02-14 00:00:00');


--
-- Name: events_2026_02_14; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_14 FOR VALUES FROM ('2026-02-14 00:00:00') TO ('2026-02-15 00:00:00');


--
-- Name: events_2026_02_15; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_15 FOR VALUES FROM ('2026-02-15 00:00:00') TO ('2026-02-16 00:00:00');


--
-- Name: events_2026_02_16; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_16 FOR VALUES FROM ('2026-02-16 00:00:00') TO ('2026-02-17 00:00:00');


--
-- Name: events_2026_02_17; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_17 FOR VALUES FROM ('2026-02-17 00:00:00') TO ('2026-02-18 00:00:00');


--
-- Name: events_2026_02_22; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_22 FOR VALUES FROM ('2026-02-22 00:00:00') TO ('2026-02-23 00:00:00');


--
-- Name: events_2026_02_23; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_23 FOR VALUES FROM ('2026-02-23 00:00:00') TO ('2026-02-24 00:00:00');


--
-- Name: events_2026_02_24; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_24 FOR VALUES FROM ('2026-02-24 00:00:00') TO ('2026-02-25 00:00:00');


--
-- Name: events_2026_02_25; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_25 FOR VALUES FROM ('2026-02-25 00:00:00') TO ('2026-02-26 00:00:00');


--
-- Name: events_2026_02_26; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_26 FOR VALUES FROM ('2026-02-26 00:00:00') TO ('2026-02-27 00:00:00');


--
-- Name: events_2026_02_27; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_27 FOR VALUES FROM ('2026-02-27 00:00:00') TO ('2026-02-28 00:00:00');


--
-- Name: events_2026_02_28; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_02_28 FOR VALUES FROM ('2026-02-28 00:00:00') TO ('2026-03-01 00:00:00');


--
-- Name: events_2026_03_01; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_01 FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-03-02 00:00:00');


--
-- Name: events_2026_03_02; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_02 FOR VALUES FROM ('2026-03-02 00:00:00') TO ('2026-03-03 00:00:00');


--
-- Name: events_2026_03_03; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_03 FOR VALUES FROM ('2026-03-03 00:00:00') TO ('2026-03-04 00:00:00');


--
-- Name: events_2026_03_04; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_04 FOR VALUES FROM ('2026-03-04 00:00:00') TO ('2026-03-05 00:00:00');


--
-- Name: events_2026_03_05; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_05 FOR VALUES FROM ('2026-03-05 00:00:00') TO ('2026-03-06 00:00:00');


--
-- Name: events_2026_03_06; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_06 FOR VALUES FROM ('2026-03-06 00:00:00') TO ('2026-03-07 00:00:00');


--
-- Name: events_2026_03_07; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_07 FOR VALUES FROM ('2026-03-07 00:00:00') TO ('2026-03-08 00:00:00');


--
-- Name: events_2026_03_08; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_08 FOR VALUES FROM ('2026-03-08 00:00:00') TO ('2026-03-09 00:00:00');


--
-- Name: events_2026_03_09; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_09 FOR VALUES FROM ('2026-03-09 00:00:00') TO ('2026-03-10 00:00:00');


--
-- Name: events_2026_03_10; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_10 FOR VALUES FROM ('2026-03-10 00:00:00') TO ('2026-03-11 00:00:00');


--
-- Name: events_2026_03_11; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_11 FOR VALUES FROM ('2026-03-11 00:00:00') TO ('2026-03-12 00:00:00');


--
-- Name: events_2026_03_12; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_12 FOR VALUES FROM ('2026-03-12 00:00:00') TO ('2026-03-13 00:00:00');


--
-- Name: events_2026_03_13; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_13 FOR VALUES FROM ('2026-03-13 00:00:00') TO ('2026-03-14 00:00:00');


--
-- Name: events_2026_03_14; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_14 FOR VALUES FROM ('2026-03-14 00:00:00') TO ('2026-03-15 00:00:00');


--
-- Name: events_2026_03_15; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_15 FOR VALUES FROM ('2026-03-15 00:00:00') TO ('2026-03-16 00:00:00');


--
-- Name: events_2026_03_16; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_16 FOR VALUES FROM ('2026-03-16 00:00:00') TO ('2026-03-17 00:00:00');


--
-- Name: events_2026_03_17; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_17 FOR VALUES FROM ('2026-03-17 00:00:00') TO ('2026-03-18 00:00:00');


--
-- Name: events_2026_03_18; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_18 FOR VALUES FROM ('2026-03-18 00:00:00') TO ('2026-03-19 00:00:00');


--
-- Name: events_2026_03_19; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_19 FOR VALUES FROM ('2026-03-19 00:00:00') TO ('2026-03-20 00:00:00');


--
-- Name: events_2026_03_20; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_20 FOR VALUES FROM ('2026-03-20 00:00:00') TO ('2026-03-21 00:00:00');


--
-- Name: events_2026_03_21; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_21 FOR VALUES FROM ('2026-03-21 00:00:00') TO ('2026-03-22 00:00:00');


--
-- Name: events_2026_03_22; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_22 FOR VALUES FROM ('2026-03-22 00:00:00') TO ('2026-03-23 00:00:00');


--
-- Name: events_2026_03_23; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_23 FOR VALUES FROM ('2026-03-23 00:00:00') TO ('2026-03-24 00:00:00');


--
-- Name: events_2026_03_24; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_24 FOR VALUES FROM ('2026-03-24 00:00:00') TO ('2026-03-25 00:00:00');


--
-- Name: events_2026_03_25; Type: TABLE ATTACH; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ATTACH PARTITION public.events_2026_03_25 FOR VALUES FROM ('2026-03-25 00:00:00') TO ('2026-03-26 00:00:00');


--
-- Name: _hyper_15_113_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_113_chunk ALTER COLUMN id SET DEFAULT nextval('public.anomaly_events_id_seq'::regclass);


--
-- Name: _hyper_15_113_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_113_chunk ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: _hyper_15_113_chunk device_name; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_113_chunk ALTER COLUMN device_name SET DEFAULT 'Unknown'::text;


--
-- Name: _hyper_15_114_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_114_chunk ALTER COLUMN id SET DEFAULT nextval('public.anomaly_events_id_seq'::regclass);


--
-- Name: _hyper_15_114_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_114_chunk ALTER COLUMN created_at SET DEFAULT now();


--
-- Name: _hyper_15_114_chunk device_name; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_114_chunk ALTER COLUMN device_name SET DEFAULT 'Unknown'::text;


--
-- Name: _hyper_1_115_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_115_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_115_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_115_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_115_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_115_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_62_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_62_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_62_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_62_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_62_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_62_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_72_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_72_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_72_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_72_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_72_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_72_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_75_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_75_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_75_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_75_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_75_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_75_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_77_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_77_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_77_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_77_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_77_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_77_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_80_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_80_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_80_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_80_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_80_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_80_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_82_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: _hyper_1_82_chunk level; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN level SET DEFAULT 'info'::character varying;


--
-- Name: _hyper_1_82_chunk is_system; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN is_system SET DEFAULT false;


--
-- Name: _hyper_1_82_chunk is_stderr; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN is_stderr SET DEFAULT false;


--
-- Name: _hyper_1_82_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_1_82_chunk created_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_23_52_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topic_metrics_id_seq'::regclass);


--
-- Name: _hyper_23_52_chunk message_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN message_count SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk qos_0_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN qos_0_count SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk qos_1_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN qos_1_count SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk qos_2_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN qos_2_count SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk retained_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN retained_count SET DEFAULT 0;


--
-- Name: _hyper_23_52_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_23_52_chunk message_rate; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_52_chunk ALTER COLUMN message_rate SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topic_metrics_id_seq'::regclass);


--
-- Name: _hyper_23_53_chunk message_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN message_count SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk qos_0_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN qos_0_count SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk qos_1_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN qos_1_count SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk qos_2_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN qos_2_count SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk retained_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN retained_count SET DEFAULT 0;


--
-- Name: _hyper_23_53_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_23_53_chunk message_rate; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_53_chunk ALTER COLUMN message_rate SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topic_metrics_id_seq'::regclass);


--
-- Name: _hyper_23_59_chunk message_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN message_count SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk qos_0_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN qos_0_count SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk qos_1_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN qos_1_count SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk qos_2_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN qos_2_count SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk retained_count; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN retained_count SET DEFAULT 0;


--
-- Name: _hyper_23_59_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_23_59_chunk message_rate; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_23_59_chunk ALTER COLUMN message_rate SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_stats_id_seq'::regclass);


--
-- Name: _hyper_25_54_chunk connected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN connected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk disconnected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN disconnected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk total_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN total_clients SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk subscriptions; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN subscriptions SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk retained_messages; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN retained_messages SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk messages_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN messages_sent SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk messages_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN messages_received SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk messages_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN messages_published SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk messages_dropped; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN messages_dropped SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk bytes_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN bytes_sent SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk message_rate_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN message_rate_published SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk message_rate_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN message_rate_received SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk throughput_inbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN throughput_inbound SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk throughput_outbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN throughput_outbound SET DEFAULT 0;


--
-- Name: _hyper_25_54_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_54_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_25_55_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_stats_id_seq'::regclass);


--
-- Name: _hyper_25_55_chunk connected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN connected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk disconnected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN disconnected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk total_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN total_clients SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk subscriptions; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN subscriptions SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk retained_messages; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN retained_messages SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk messages_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN messages_sent SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk messages_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN messages_received SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk messages_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN messages_published SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk messages_dropped; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN messages_dropped SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk bytes_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN bytes_sent SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk message_rate_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN message_rate_published SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk message_rate_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN message_rate_received SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk throughput_inbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN throughput_inbound SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk throughput_outbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN throughput_outbound SET DEFAULT 0;


--
-- Name: _hyper_25_55_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_55_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_25_58_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_stats_id_seq'::regclass);


--
-- Name: _hyper_25_58_chunk connected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN connected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk disconnected_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN disconnected_clients SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk total_clients; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN total_clients SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk subscriptions; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN subscriptions SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk retained_messages; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN retained_messages SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk messages_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN messages_sent SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk messages_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN messages_received SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk messages_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN messages_published SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk messages_dropped; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN messages_dropped SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk bytes_sent; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN bytes_sent SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk bytes_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN bytes_received SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk message_rate_published; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN message_rate_published SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk message_rate_received; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN message_rate_received SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk throughput_inbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN throughput_inbound SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk throughput_outbound; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN throughput_outbound SET DEFAULT 0;


--
-- Name: _hyper_25_58_chunk timestamp; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_25_58_chunk ALTER COLUMN "timestamp" SET DEFAULT CURRENT_TIMESTAMP;


--
-- Name: _hyper_5_116_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_116_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_116_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_116_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_40_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_40_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_40_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_40_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_43_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_43_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_43_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_43_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_49_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_49_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_49_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_49_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_60_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_60_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_60_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_60_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_73_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_73_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_73_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_73_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_76_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_76_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_76_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_76_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_78_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_78_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_78_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_78_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_81_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_81_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_81_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_81_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_5_87_chunk quality; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_87_chunk ALTER COLUMN quality SET DEFAULT 'good'::text;


--
-- Name: _hyper_5_87_chunk extra; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_87_chunk ALTER COLUMN extra SET DEFAULT '{}'::jsonb;


--
-- Name: _hyper_9_1_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_1_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_metrics_id_seq'::regclass);


--
-- Name: _hyper_9_1_chunk top_processes; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_1_chunk ALTER COLUMN top_processes SET DEFAULT '[]'::jsonb;


--
-- Name: _hyper_9_1_chunk recorded_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_1_chunk ALTER COLUMN recorded_at SET DEFAULT now();


--
-- Name: _hyper_9_44_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_44_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_metrics_id_seq'::regclass);


--
-- Name: _hyper_9_44_chunk top_processes; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_44_chunk ALTER COLUMN top_processes SET DEFAULT '[]'::jsonb;


--
-- Name: _hyper_9_44_chunk recorded_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_44_chunk ALTER COLUMN recorded_at SET DEFAULT now();


--
-- Name: _hyper_9_61_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_61_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_metrics_id_seq'::regclass);


--
-- Name: _hyper_9_61_chunk top_processes; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_61_chunk ALTER COLUMN top_processes SET DEFAULT '[]'::jsonb;


--
-- Name: _hyper_9_61_chunk recorded_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_61_chunk ALTER COLUMN recorded_at SET DEFAULT now();


--
-- Name: _hyper_9_86_chunk id; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_86_chunk ALTER COLUMN id SET DEFAULT nextval('public.device_metrics_id_seq'::regclass);


--
-- Name: _hyper_9_86_chunk top_processes; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_86_chunk ALTER COLUMN top_processes SET DEFAULT '[]'::jsonb;


--
-- Name: _hyper_9_86_chunk recorded_at; Type: DEFAULT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_86_chunk ALTER COLUMN recorded_at SET DEFAULT now();


--
-- Name: agent_updates id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_updates ALTER COLUMN id SET DEFAULT nextval('public.agent_updates_id_seq'::regclass);


--
-- Name: anomaly_alerts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_alerts ALTER COLUMN id SET DEFAULT nextval('public.anomaly_alerts_id_seq'::regclass);


--
-- Name: anomaly_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_events ALTER COLUMN id SET DEFAULT nextval('public.anomaly_events_id_seq'::regclass);


--
-- Name: anomaly_incidents id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_incidents ALTER COLUMN id SET DEFAULT nextval('public.anomaly_incidents_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: app_service_ids id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_service_ids ALTER COLUMN id SET DEFAULT nextval('public.app_service_ids_id_seq'::regclass);


--
-- Name: applications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications ALTER COLUMN id SET DEFAULT nextval('public.applications_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: dashboard_layouts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboard_layouts ALTER COLUMN id SET DEFAULT nextval('public.dashboard_layouts_id_seq'::regclass);


--
-- Name: device_api_key_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_key_history ALTER COLUMN id SET DEFAULT nextval('public.device_api_key_history_id_seq'::regclass);


--
-- Name: device_api_keys id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_keys ALTER COLUMN id SET DEFAULT nextval('public.device_api_keys_id_seq'::regclass);


--
-- Name: device_current_state id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_current_state ALTER COLUMN id SET DEFAULT nextval('public.device_current_state_id_seq'::regclass);


--
-- Name: device_environment_variable id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_environment_variable ALTER COLUMN id SET DEFAULT nextval('public.device_environment_variable_id_seq'::regclass);


--
-- Name: device_flows id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_flows ALTER COLUMN id SET DEFAULT nextval('public.device_flows_id_seq'::regclass);


--
-- Name: device_job_status id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_job_status ALTER COLUMN id SET DEFAULT nextval('public.device_job_status_id_seq'::regclass);


--
-- Name: device_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_logs ALTER COLUMN id SET DEFAULT nextval('public.device_logs_id_seq'::regclass);


--
-- Name: device_metrics id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metrics ALTER COLUMN id SET DEFAULT nextval('public.device_metrics_id_seq'::regclass);


--
-- Name: device_rollout_status id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_rollout_status ALTER COLUMN id SET DEFAULT nextval('public.device_rollout_status_id_seq'::regclass);


--
-- Name: device_sensors id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_sensors ALTER COLUMN id SET DEFAULT nextval('public.device_sensors_id_seq'::regclass);


--
-- Name: device_services id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_services ALTER COLUMN id SET DEFAULT nextval('public.device_services_id_seq'::regclass);


--
-- Name: device_shadow_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadow_history ALTER COLUMN id SET DEFAULT nextval('public.device_shadow_history_id_seq'::regclass);


--
-- Name: device_shadows id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadows ALTER COLUMN id SET DEFAULT nextval('public.device_shadows_id_seq'::regclass);


--
-- Name: device_tags id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_tags ALTER COLUMN id SET DEFAULT nextval('public.device_tags_id_seq'::regclass);


--
-- Name: device_target_state id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state ALTER COLUMN id SET DEFAULT nextval('public.device_target_state_id_seq'::regclass);


--
-- Name: device_target_state_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state_history ALTER COLUMN id SET DEFAULT nextval('public.device_target_state_history_id_seq'::regclass);


--
-- Name: device_traffic_stats id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_traffic_stats ALTER COLUMN id SET DEFAULT nextval('public.device_traffic_stats_id_seq'::regclass);


--
-- Name: devices id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.devices ALTER COLUMN id SET DEFAULT nextval('public.devices_id_seq'::regclass);


--
-- Name: dictionary_enum_devices id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_devices ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_devices_id_seq'::regclass);


--
-- Name: dictionary_enum_metrics id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_metrics ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_metrics_id_seq'::regclass);


--
-- Name: dictionary_enum_observations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_observations ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_observations_id_seq'::regclass);


--
-- Name: dictionary_enum_quality_codes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_quality_codes_id_seq'::regclass);


--
-- Name: dictionary_enum_units id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_units ALTER COLUMN id SET DEFAULT nextval('public.dictionary_enum_units_id_seq'::regclass);


--
-- Name: email_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.email_logs ALTER COLUMN id SET DEFAULT nextval('public.email_logs_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: fleet_billing_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_billing_history ALTER COLUMN id SET DEFAULT nextval('public.fleet_billing_history_id_seq'::regclass);


--
-- Name: fleet_usage_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_usage_events ALTER COLUMN id SET DEFAULT nextval('public.fleet_usage_events_id_seq'::regclass);


--
-- Name: fleets id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleets ALTER COLUMN id SET DEFAULT nextval('public.fleets_id_seq'::regclass);


--
-- Name: housekeeper_runs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.housekeeper_runs ALTER COLUMN id SET DEFAULT nextval('public.housekeeper_runs_id_seq'::regclass);


--
-- Name: image_approval_requests id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_approval_requests ALTER COLUMN id SET DEFAULT nextval('public.image_approval_requests_id_seq'::regclass);


--
-- Name: image_rollouts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_rollouts ALTER COLUMN id SET DEFAULT nextval('public.image_rollouts_id_seq'::regclass);


--
-- Name: image_tags id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_tags ALTER COLUMN id SET DEFAULT nextval('public.image_tags_id_seq'::regclass);


--
-- Name: image_update_policies id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_update_policies ALTER COLUMN id SET DEFAULT nextval('public.image_update_policies_id_seq'::regclass);


--
-- Name: images id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.images ALTER COLUMN id SET DEFAULT nextval('public.images_id_seq'::regclass);


--
-- Name: job_executions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_executions ALTER COLUMN id SET DEFAULT nextval('public.job_executions_id_seq'::regclass);


--
-- Name: job_handlers id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_handlers ALTER COLUMN id SET DEFAULT nextval('public.job_handlers_id_seq'::regclass);


--
-- Name: job_templates id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_templates ALTER COLUMN id SET DEFAULT nextval('public.job_templates_id_seq'::regclass);


--
-- Name: log_alert_rules id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alert_rules ALTER COLUMN id SET DEFAULT nextval('public.log_alert_rules_id_seq'::regclass);


--
-- Name: log_alerts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alerts ALTER COLUMN id SET DEFAULT nextval('public.log_alerts_id_seq'::regclass);


--
-- Name: mqtt_acls id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_acls ALTER COLUMN id SET DEFAULT nextval('public.mqtt_acls_id_seq'::regclass);


--
-- Name: mqtt_broker_config id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_broker_config ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_config_id_seq'::regclass);


--
-- Name: mqtt_broker_stats id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_broker_stats ALTER COLUMN id SET DEFAULT nextval('public.mqtt_broker_stats_id_seq'::regclass);


--
-- Name: mqtt_schema_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_schema_history ALTER COLUMN id SET DEFAULT nextval('public.mqtt_schema_history_id_seq'::regclass);


--
-- Name: mqtt_topic_metrics id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_topic_metrics ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topic_metrics_id_seq'::regclass);


--
-- Name: mqtt_topics id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_topics ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topics_id_seq'::regclass);


--
-- Name: mqtt_users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_users ALTER COLUMN id SET DEFAULT nextval('public.mqtt_users_id_seq'::regclass);


--
-- Name: nodered_library id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_library ALTER COLUMN id SET DEFAULT nextval('public.nodered_library_id_seq'::regclass);


--
-- Name: profile_configs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profile_configs ALTER COLUMN id SET DEFAULT nextval('public.vendor_configs_id_seq'::regclass);


--
-- Name: provisioning_attempts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.provisioning_attempts ALTER COLUMN id SET DEFAULT nextval('public.provisioning_attempts_id_seq'::regclass);


--
-- Name: reconciliation_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reconciliation_history ALTER COLUMN id SET DEFAULT nextval('public.reconciliation_history_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);


--
-- Name: releases id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.releases ALTER COLUMN id SET DEFAULT nextval('public.releases_id_seq'::regclass);


--
-- Name: rollout_events id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rollout_events ALTER COLUMN id SET DEFAULT nextval('public.rollout_events_id_seq'::regclass);


--
-- Name: scheduled_jobs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_jobs ALTER COLUMN id SET DEFAULT nextval('public.scheduled_jobs_id_seq'::regclass);


--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);


--
-- Name: sensor_health_history id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sensor_health_history ALTER COLUMN id SET DEFAULT nextval('public.sensor_health_history_id_seq'::regclass);


--
-- Name: shell_audit_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shell_audit_log ALTER COLUMN id SET DEFAULT nextval('public.shell_audit_log_id_seq'::regclass);


--
-- Name: state_changes id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_changes ALTER COLUMN id SET DEFAULT nextval('public.state_changes_id_seq'::regclass);


--
-- Name: state_snapshots id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_snapshots ALTER COLUMN id SET DEFAULT nextval('public.state_snapshots_id_seq'::regclass);


--
-- Name: tag_definitions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_definitions ALTER COLUMN id SET DEFAULT nextval('public.tag_definitions_id_seq'::regclass);


--
-- Name: user_sessions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: wg_config id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_config ALTER COLUMN id SET DEFAULT nextval('public.wg_config_id_seq'::regclass);


--
-- Name: wg_ip_pool id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_ip_pool ALTER COLUMN id SET DEFAULT nextval('public.wg_ip_pool_id_seq'::regclass);


--
-- Name: wg_peers id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_peers ALTER COLUMN id SET DEFAULT nextval('public.wg_peers_id_seq'::regclass);


--
-- Name: _hyper_15_113_chunk 113_105_anomaly_events_msg_id_timestamp_ms_key; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_113_chunk
    ADD CONSTRAINT "113_105_anomaly_events_msg_id_timestamp_ms_key" UNIQUE (msg_id, timestamp_ms);


--
-- Name: _hyper_15_113_chunk 113_106_anomaly_events_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_113_chunk
    ADD CONSTRAINT "113_106_anomaly_events_pkey" PRIMARY KEY (id, timestamp_ms);


--
-- Name: _hyper_15_114_chunk 114_107_anomaly_events_msg_id_timestamp_ms_key; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_114_chunk
    ADD CONSTRAINT "114_107_anomaly_events_msg_id_timestamp_ms_key" UNIQUE (msg_id, timestamp_ms);


--
-- Name: _hyper_15_114_chunk 114_108_anomaly_events_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_15_114_chunk
    ADD CONSTRAINT "114_108_anomaly_events_pkey" PRIMARY KEY (id, timestamp_ms);


--
-- Name: _hyper_1_115_chunk 115_109_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk
    ADD CONSTRAINT "115_109_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_5_116_chunk 116_111_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_116_chunk
    ADD CONSTRAINT "116_111_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_9_1_chunk 1_1_device_metrics_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_1_chunk
    ADD CONSTRAINT "1_1_device_metrics_pkey" PRIMARY KEY (id, recorded_at);


--
-- Name: _hyper_5_40_chunk 40_37_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_40_chunk
    ADD CONSTRAINT "40_37_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_5_43_chunk 43_38_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_43_chunk
    ADD CONSTRAINT "43_38_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_9_44_chunk 44_39_device_metrics_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_44_chunk
    ADD CONSTRAINT "44_39_device_metrics_pkey" PRIMARY KEY (id, recorded_at);


--
-- Name: _hyper_5_49_chunk 49_42_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_49_chunk
    ADD CONSTRAINT "49_42_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_5_60_chunk 60_43_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_60_chunk
    ADD CONSTRAINT "60_43_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_9_61_chunk 61_44_device_metrics_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_61_chunk
    ADD CONSTRAINT "61_44_device_metrics_pkey" PRIMARY KEY (id, recorded_at);


--
-- Name: _hyper_1_62_chunk 62_45_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk
    ADD CONSTRAINT "62_45_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_1_72_chunk 72_47_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk
    ADD CONSTRAINT "72_47_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_5_73_chunk 73_49_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_73_chunk
    ADD CONSTRAINT "73_49_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_1_75_chunk 75_50_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk
    ADD CONSTRAINT "75_50_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_5_76_chunk 76_52_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_76_chunk
    ADD CONSTRAINT "76_52_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_1_77_chunk 77_53_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk
    ADD CONSTRAINT "77_53_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_5_78_chunk 78_55_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_78_chunk
    ADD CONSTRAINT "78_55_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_1_80_chunk 80_56_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk
    ADD CONSTRAINT "80_56_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_5_81_chunk 81_58_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_81_chunk
    ADD CONSTRAINT "81_58_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: _hyper_1_82_chunk 82_59_device_logs_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk
    ADD CONSTRAINT "82_59_device_logs_pkey" PRIMARY KEY (id, "timestamp");


--
-- Name: _hyper_9_86_chunk 86_61_device_metrics_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_9_86_chunk
    ADD CONSTRAINT "86_61_device_metrics_pkey" PRIMARY KEY (id, recorded_at);


--
-- Name: _hyper_5_87_chunk 87_62_readings_pkey; Type: CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_5_87_chunk
    ADD CONSTRAINT "87_62_readings_pkey" PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: agent_updates agent_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_updates
    ADD CONSTRAINT agent_updates_pkey PRIMARY KEY (id);


--
-- Name: anomaly_alerts anomaly_alerts_alert_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_alert_id_key UNIQUE (alert_id);


--
-- Name: anomaly_alerts anomaly_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_pkey PRIMARY KEY (id);


--
-- Name: anomaly_events anomaly_events_msg_id_timestamp_ms_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT anomaly_events_msg_id_timestamp_ms_key UNIQUE (msg_id, timestamp_ms);


--
-- Name: anomaly_events anomaly_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT anomaly_events_pkey PRIMARY KEY (id, timestamp_ms);


--
-- Name: anomaly_incidents anomaly_incidents_incident_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_incidents
    ADD CONSTRAINT anomaly_incidents_incident_id_key UNIQUE (incident_id);


--
-- Name: anomaly_incidents anomaly_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_incidents
    ADD CONSTRAINT anomaly_incidents_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_key UNIQUE (key);


--
-- Name: api_keys api_keys_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_name_key UNIQUE (name);


--
-- Name: CONSTRAINT api_keys_name_key ON api_keys; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON CONSTRAINT api_keys_name_key ON public.api_keys IS 'Ensure API key names are unique for easy reference';


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_service_ids app_service_ids_entity_type_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_service_ids
    ADD CONSTRAINT app_service_ids_entity_type_entity_id_key UNIQUE (entity_type, entity_id);


--
-- Name: app_service_ids app_service_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_service_ids
    ADD CONSTRAINT app_service_ids_pkey PRIMARY KEY (id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: applications applications_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_slug_key UNIQUE (slug);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: dashboard_layouts dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_pkey PRIMARY KEY (id);


--
-- Name: device_api_key_history device_api_key_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_key_history
    ADD CONSTRAINT device_api_key_history_pkey PRIMARY KEY (id);


--
-- Name: device_api_keys device_api_keys_device_uuid_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_keys
    ADD CONSTRAINT device_api_keys_device_uuid_key_hash_key UNIQUE (device_uuid, key_hash);


--
-- Name: device_api_keys device_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_keys
    ADD CONSTRAINT device_api_keys_pkey PRIMARY KEY (id);


--
-- Name: device_current_state device_current_state_device_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_current_state
    ADD CONSTRAINT device_current_state_device_uuid_key UNIQUE (device_uuid);


--
-- Name: device_current_state device_current_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_current_state
    ADD CONSTRAINT device_current_state_pkey PRIMARY KEY (id);


--
-- Name: dictionary_entries device_dictionary_entries_device_uuid_field_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_device_uuid_field_index_key UNIQUE (device_uuid, field_index);


--
-- Name: dictionary_entries device_dictionary_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_pkey PRIMARY KEY (device_uuid, field_name);


--
-- Name: dictionary_metadata device_dictionary_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_metadata
    ADD CONSTRAINT device_dictionary_metadata_pkey PRIMARY KEY (device_uuid);


--
-- Name: device_environment_variable device_environment_variable_device_uuid_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_environment_variable
    ADD CONSTRAINT device_environment_variable_device_uuid_name_key UNIQUE (device_uuid, name);


--
-- Name: device_environment_variable device_environment_variable_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_environment_variable
    ADD CONSTRAINT device_environment_variable_pkey PRIMARY KEY (id);


--
-- Name: device_flows device_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_flows
    ADD CONSTRAINT device_flows_pkey PRIMARY KEY (id);


--
-- Name: device_job_status device_job_status_job_id_device_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_job_status
    ADD CONSTRAINT device_job_status_job_id_device_uuid_key UNIQUE (job_id, device_uuid);


--
-- Name: device_job_status device_job_status_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_job_status
    ADD CONSTRAINT device_job_status_pkey PRIMARY KEY (id);


--
-- Name: device_logs device_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_logs
    ADD CONSTRAINT device_logs_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: device_metrics device_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_metrics
    ADD CONSTRAINT device_metrics_pkey PRIMARY KEY (id, recorded_at);


--
-- Name: device_rollout_status device_rollout_status_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_rollout_status
    ADD CONSTRAINT device_rollout_status_pkey PRIMARY KEY (id);


--
-- Name: device_rollout_status device_rollout_status_rollout_id_device_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_rollout_status
    ADD CONSTRAINT device_rollout_status_rollout_id_device_uuid_key UNIQUE (rollout_id, device_uuid);


--
-- Name: device_sensors device_sensors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_sensors
    ADD CONSTRAINT device_sensors_pkey PRIMARY KEY (id);


--
-- Name: device_sensors device_sensors_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_sensors
    ADD CONSTRAINT device_sensors_uuid_key UNIQUE (uuid);


--
-- Name: device_services device_services_device_uuid_service_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_services
    ADD CONSTRAINT device_services_device_uuid_service_name_key UNIQUE (device_uuid, service_name);


--
-- Name: device_services device_services_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_services
    ADD CONSTRAINT device_services_pkey PRIMARY KEY (id);


--
-- Name: device_shadow_history device_shadow_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadow_history
    ADD CONSTRAINT device_shadow_history_pkey PRIMARY KEY (id);


--
-- Name: device_shadows device_shadows_device_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadows
    ADD CONSTRAINT device_shadows_device_uuid_key UNIQUE (device_uuid);


--
-- Name: device_shadows device_shadows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadows
    ADD CONSTRAINT device_shadows_pkey PRIMARY KEY (id);


--
-- Name: device_tags device_tags_device_uuid_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_tags
    ADD CONSTRAINT device_tags_device_uuid_key_key UNIQUE (device_uuid, key);


--
-- Name: device_tags device_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_tags
    ADD CONSTRAINT device_tags_pkey PRIMARY KEY (id);


--
-- Name: device_target_state device_target_state_device_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state
    ADD CONSTRAINT device_target_state_device_uuid_key UNIQUE (device_uuid);


--
-- Name: device_target_state_history device_target_state_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state_history
    ADD CONSTRAINT device_target_state_history_pkey PRIMARY KEY (id);


--
-- Name: device_target_state device_target_state_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state
    ADD CONSTRAINT device_target_state_pkey PRIMARY KEY (id);


--
-- Name: device_traffic_stats device_traffic_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_traffic_stats
    ADD CONSTRAINT device_traffic_stats_pkey PRIMARY KEY (id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: devices devices_uuid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_uuid_key UNIQUE (uuid);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_protocol_device_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_protocol_device_name_key UNIQUE (device_uuid, protocol, device_name);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_protocol_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_protocol_enum_index_key UNIQUE (device_uuid, protocol, enum_index);


--
-- Name: dictionary_enum_devices dictionary_enum_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_protocol_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_protocol_enum_index_key UNIQUE (device_uuid, protocol, enum_index);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_protocol_metric_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_protocol_metric_name_key UNIQUE (device_uuid, protocol, metric_name);


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_observations dictionary_enum_observations_device_uuid_category_namespace_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_device_uuid_category_namespace_key UNIQUE (device_uuid, category, namespace, value);


--
-- Name: dictionary_enum_observations dictionary_enum_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_code_value_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_code_value_key UNIQUE (device_uuid, code_value);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_enum_index_key UNIQUE (device_uuid, enum_index);


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_pkey PRIMARY KEY (id);


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_enum_index_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_enum_index_key UNIQUE (device_uuid, enum_index);


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_unit_value_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_unit_value_key UNIQUE (device_uuid, unit_value);


--
-- Name: dictionary_enum_units dictionary_enum_units_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_pkey PRIMARY KEY (id);


--
-- Name: email_logs email_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.email_logs
    ADD CONSTRAINT email_logs_pkey PRIMARY KEY (id);


--
-- Name: event_cursors event_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.event_cursors
    ADD CONSTRAINT event_cursors_pkey PRIMARY KEY (processor_name);


--
-- Name: event_types event_types_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.event_types
    ADD CONSTRAINT event_types_pkey PRIMARY KEY (event_type);


--
-- Name: events events_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_11 events_2026_01_11_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_11
    ADD CONSTRAINT events_2026_01_11_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_11 events_2026_01_11_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_11
    ADD CONSTRAINT events_2026_01_11_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_12 events_2026_01_12_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_12
    ADD CONSTRAINT events_2026_01_12_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_12 events_2026_01_12_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_12
    ADD CONSTRAINT events_2026_01_12_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_13 events_2026_01_13_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_13
    ADD CONSTRAINT events_2026_01_13_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_13 events_2026_01_13_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_13
    ADD CONSTRAINT events_2026_01_13_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_14 events_2026_01_14_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_14
    ADD CONSTRAINT events_2026_01_14_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_14 events_2026_01_14_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_14
    ADD CONSTRAINT events_2026_01_14_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_15 events_2026_01_15_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_15
    ADD CONSTRAINT events_2026_01_15_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_15 events_2026_01_15_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_15
    ADD CONSTRAINT events_2026_01_15_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_16 events_2026_01_16_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_16
    ADD CONSTRAINT events_2026_01_16_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_16 events_2026_01_16_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_16
    ADD CONSTRAINT events_2026_01_16_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_17 events_2026_01_17_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_17
    ADD CONSTRAINT events_2026_01_17_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_17 events_2026_01_17_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_17
    ADD CONSTRAINT events_2026_01_17_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_18 events_2026_01_18_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_18
    ADD CONSTRAINT events_2026_01_18_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_18 events_2026_01_18_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_18
    ADD CONSTRAINT events_2026_01_18_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_19 events_2026_01_19_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_19
    ADD CONSTRAINT events_2026_01_19_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_19 events_2026_01_19_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_19
    ADD CONSTRAINT events_2026_01_19_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_20 events_2026_01_20_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_20
    ADD CONSTRAINT events_2026_01_20_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_20 events_2026_01_20_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_20
    ADD CONSTRAINT events_2026_01_20_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_21 events_2026_01_21_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_21
    ADD CONSTRAINT events_2026_01_21_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_21 events_2026_01_21_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_21
    ADD CONSTRAINT events_2026_01_21_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_22 events_2026_01_22_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_22
    ADD CONSTRAINT events_2026_01_22_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_22 events_2026_01_22_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_22
    ADD CONSTRAINT events_2026_01_22_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_23 events_2026_01_23_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_23
    ADD CONSTRAINT events_2026_01_23_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_23 events_2026_01_23_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_23
    ADD CONSTRAINT events_2026_01_23_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_24 events_2026_01_24_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_24
    ADD CONSTRAINT events_2026_01_24_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_24 events_2026_01_24_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_24
    ADD CONSTRAINT events_2026_01_24_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_25 events_2026_01_25_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_25
    ADD CONSTRAINT events_2026_01_25_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_25 events_2026_01_25_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_25
    ADD CONSTRAINT events_2026_01_25_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_26 events_2026_01_26_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_26
    ADD CONSTRAINT events_2026_01_26_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_26 events_2026_01_26_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_26
    ADD CONSTRAINT events_2026_01_26_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_27 events_2026_01_27_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_27
    ADD CONSTRAINT events_2026_01_27_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_27 events_2026_01_27_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_27
    ADD CONSTRAINT events_2026_01_27_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_28 events_2026_01_28_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_28
    ADD CONSTRAINT events_2026_01_28_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_28 events_2026_01_28_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_28
    ADD CONSTRAINT events_2026_01_28_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_29 events_2026_01_29_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_29
    ADD CONSTRAINT events_2026_01_29_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_29 events_2026_01_29_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_29
    ADD CONSTRAINT events_2026_01_29_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_30 events_2026_01_30_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_30
    ADD CONSTRAINT events_2026_01_30_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_30 events_2026_01_30_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_30
    ADD CONSTRAINT events_2026_01_30_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_01_31 events_2026_01_31_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_31
    ADD CONSTRAINT events_2026_01_31_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_01_31 events_2026_01_31_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_01_31
    ADD CONSTRAINT events_2026_01_31_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_01 events_2026_02_01_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_01
    ADD CONSTRAINT events_2026_02_01_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_01 events_2026_02_01_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_01
    ADD CONSTRAINT events_2026_02_01_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_02 events_2026_02_02_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_02
    ADD CONSTRAINT events_2026_02_02_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_02 events_2026_02_02_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_02
    ADD CONSTRAINT events_2026_02_02_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_03 events_2026_02_03_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_03
    ADD CONSTRAINT events_2026_02_03_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_03 events_2026_02_03_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_03
    ADD CONSTRAINT events_2026_02_03_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_04 events_2026_02_04_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_04
    ADD CONSTRAINT events_2026_02_04_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_04 events_2026_02_04_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_04
    ADD CONSTRAINT events_2026_02_04_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_05 events_2026_02_05_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_05
    ADD CONSTRAINT events_2026_02_05_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_05 events_2026_02_05_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_05
    ADD CONSTRAINT events_2026_02_05_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_06 events_2026_02_06_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_06
    ADD CONSTRAINT events_2026_02_06_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_06 events_2026_02_06_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_06
    ADD CONSTRAINT events_2026_02_06_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_07 events_2026_02_07_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_07
    ADD CONSTRAINT events_2026_02_07_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_07 events_2026_02_07_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_07
    ADD CONSTRAINT events_2026_02_07_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_08 events_2026_02_08_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_08
    ADD CONSTRAINT events_2026_02_08_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_08 events_2026_02_08_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_08
    ADD CONSTRAINT events_2026_02_08_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_09 events_2026_02_09_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_09
    ADD CONSTRAINT events_2026_02_09_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_09 events_2026_02_09_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_09
    ADD CONSTRAINT events_2026_02_09_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_10 events_2026_02_10_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_10
    ADD CONSTRAINT events_2026_02_10_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_10 events_2026_02_10_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_10
    ADD CONSTRAINT events_2026_02_10_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_11 events_2026_02_11_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_11
    ADD CONSTRAINT events_2026_02_11_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_11 events_2026_02_11_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_11
    ADD CONSTRAINT events_2026_02_11_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_12 events_2026_02_12_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_12
    ADD CONSTRAINT events_2026_02_12_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_12 events_2026_02_12_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_12
    ADD CONSTRAINT events_2026_02_12_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_13 events_2026_02_13_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_13
    ADD CONSTRAINT events_2026_02_13_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_13 events_2026_02_13_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_13
    ADD CONSTRAINT events_2026_02_13_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_14 events_2026_02_14_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_14
    ADD CONSTRAINT events_2026_02_14_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_14 events_2026_02_14_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_14
    ADD CONSTRAINT events_2026_02_14_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_15 events_2026_02_15_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_15
    ADD CONSTRAINT events_2026_02_15_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_15 events_2026_02_15_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_15
    ADD CONSTRAINT events_2026_02_15_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_16 events_2026_02_16_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_16
    ADD CONSTRAINT events_2026_02_16_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_16 events_2026_02_16_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_16
    ADD CONSTRAINT events_2026_02_16_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_17 events_2026_02_17_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_17
    ADD CONSTRAINT events_2026_02_17_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_17 events_2026_02_17_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_17
    ADD CONSTRAINT events_2026_02_17_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_22 events_2026_02_22_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_22
    ADD CONSTRAINT events_2026_02_22_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_22 events_2026_02_22_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_22
    ADD CONSTRAINT events_2026_02_22_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_23 events_2026_02_23_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_23
    ADD CONSTRAINT events_2026_02_23_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_23 events_2026_02_23_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_23
    ADD CONSTRAINT events_2026_02_23_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_24 events_2026_02_24_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_24
    ADD CONSTRAINT events_2026_02_24_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_24 events_2026_02_24_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_24
    ADD CONSTRAINT events_2026_02_24_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_25 events_2026_02_25_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_25
    ADD CONSTRAINT events_2026_02_25_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_25 events_2026_02_25_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_25
    ADD CONSTRAINT events_2026_02_25_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_26 events_2026_02_26_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_26
    ADD CONSTRAINT events_2026_02_26_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_26 events_2026_02_26_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_26
    ADD CONSTRAINT events_2026_02_26_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_27 events_2026_02_27_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_27
    ADD CONSTRAINT events_2026_02_27_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_27 events_2026_02_27_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_27
    ADD CONSTRAINT events_2026_02_27_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_02_28 events_2026_02_28_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_28
    ADD CONSTRAINT events_2026_02_28_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_02_28 events_2026_02_28_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_02_28
    ADD CONSTRAINT events_2026_02_28_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_01 events_2026_03_01_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_01
    ADD CONSTRAINT events_2026_03_01_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_01 events_2026_03_01_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_01
    ADD CONSTRAINT events_2026_03_01_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_02 events_2026_03_02_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_02
    ADD CONSTRAINT events_2026_03_02_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_02 events_2026_03_02_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_02
    ADD CONSTRAINT events_2026_03_02_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_03 events_2026_03_03_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_03
    ADD CONSTRAINT events_2026_03_03_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_03 events_2026_03_03_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_03
    ADD CONSTRAINT events_2026_03_03_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_04 events_2026_03_04_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_04
    ADD CONSTRAINT events_2026_03_04_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_04 events_2026_03_04_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_04
    ADD CONSTRAINT events_2026_03_04_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_05 events_2026_03_05_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_05
    ADD CONSTRAINT events_2026_03_05_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_05 events_2026_03_05_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_05
    ADD CONSTRAINT events_2026_03_05_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_06 events_2026_03_06_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_06
    ADD CONSTRAINT events_2026_03_06_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_06 events_2026_03_06_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_06
    ADD CONSTRAINT events_2026_03_06_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_07 events_2026_03_07_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_07
    ADD CONSTRAINT events_2026_03_07_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_07 events_2026_03_07_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_07
    ADD CONSTRAINT events_2026_03_07_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_08 events_2026_03_08_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_08
    ADD CONSTRAINT events_2026_03_08_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_08 events_2026_03_08_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_08
    ADD CONSTRAINT events_2026_03_08_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_09 events_2026_03_09_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_09
    ADD CONSTRAINT events_2026_03_09_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_09 events_2026_03_09_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_09
    ADD CONSTRAINT events_2026_03_09_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_10 events_2026_03_10_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_10
    ADD CONSTRAINT events_2026_03_10_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_10 events_2026_03_10_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_10
    ADD CONSTRAINT events_2026_03_10_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_11 events_2026_03_11_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_11
    ADD CONSTRAINT events_2026_03_11_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_11 events_2026_03_11_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_11
    ADD CONSTRAINT events_2026_03_11_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_12 events_2026_03_12_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_12
    ADD CONSTRAINT events_2026_03_12_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_12 events_2026_03_12_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_12
    ADD CONSTRAINT events_2026_03_12_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_13 events_2026_03_13_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_13
    ADD CONSTRAINT events_2026_03_13_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_13 events_2026_03_13_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_13
    ADD CONSTRAINT events_2026_03_13_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_14 events_2026_03_14_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_14
    ADD CONSTRAINT events_2026_03_14_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_14 events_2026_03_14_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_14
    ADD CONSTRAINT events_2026_03_14_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_15 events_2026_03_15_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_15
    ADD CONSTRAINT events_2026_03_15_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_15 events_2026_03_15_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_15
    ADD CONSTRAINT events_2026_03_15_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_16 events_2026_03_16_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_16
    ADD CONSTRAINT events_2026_03_16_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_16 events_2026_03_16_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_16
    ADD CONSTRAINT events_2026_03_16_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_17 events_2026_03_17_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_17
    ADD CONSTRAINT events_2026_03_17_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_17 events_2026_03_17_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_17
    ADD CONSTRAINT events_2026_03_17_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_18 events_2026_03_18_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_18
    ADD CONSTRAINT events_2026_03_18_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_18 events_2026_03_18_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_18
    ADD CONSTRAINT events_2026_03_18_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_19 events_2026_03_19_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_19
    ADD CONSTRAINT events_2026_03_19_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_19 events_2026_03_19_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_19
    ADD CONSTRAINT events_2026_03_19_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_20 events_2026_03_20_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_20
    ADD CONSTRAINT events_2026_03_20_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_20 events_2026_03_20_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_20
    ADD CONSTRAINT events_2026_03_20_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_21 events_2026_03_21_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_21
    ADD CONSTRAINT events_2026_03_21_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_21 events_2026_03_21_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_21
    ADD CONSTRAINT events_2026_03_21_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_22 events_2026_03_22_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_22
    ADD CONSTRAINT events_2026_03_22_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_22 events_2026_03_22_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_22
    ADD CONSTRAINT events_2026_03_22_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_23 events_2026_03_23_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_23
    ADD CONSTRAINT events_2026_03_23_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_23 events_2026_03_23_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_23
    ADD CONSTRAINT events_2026_03_23_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_24 events_2026_03_24_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_24
    ADD CONSTRAINT events_2026_03_24_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_24 events_2026_03_24_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_24
    ADD CONSTRAINT events_2026_03_24_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: events_2026_03_25 events_2026_03_25_event_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_25
    ADD CONSTRAINT events_2026_03_25_event_id_timestamp_key UNIQUE (event_id, "timestamp");


--
-- Name: events_2026_03_25 events_2026_03_25_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.events_2026_03_25
    ADD CONSTRAINT events_2026_03_25_pkey PRIMARY KEY (id, "timestamp");


--
-- Name: fleet_billing_history fleet_billing_history_fleet_id_billing_month_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_billing_history
    ADD CONSTRAINT fleet_billing_history_fleet_id_billing_month_key UNIQUE (fleet_id, billing_month);


--
-- Name: fleet_billing_history fleet_billing_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_billing_history
    ADD CONSTRAINT fleet_billing_history_pkey PRIMARY KEY (id);


--
-- Name: fleet_namespaces fleet_namespaces_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_namespaces
    ADD CONSTRAINT fleet_namespaces_pkey PRIMARY KEY (name);


--
-- Name: fleet_usage_events fleet_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleet_usage_events
    ADD CONSTRAINT fleet_usage_events_pkey PRIMARY KEY (id);


--
-- Name: fleets fleets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fleets
    ADD CONSTRAINT fleets_pkey PRIMARY KEY (id);


--
-- Name: housekeeper_config housekeeper_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.housekeeper_config
    ADD CONSTRAINT housekeeper_config_pkey PRIMARY KEY (task_name);


--
-- Name: housekeeper_runs housekeeper_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.housekeeper_runs
    ADD CONSTRAINT housekeeper_runs_pkey PRIMARY KEY (id);


--
-- Name: image_approval_requests image_approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_approval_requests
    ADD CONSTRAINT image_approval_requests_pkey PRIMARY KEY (id);


--
-- Name: image_rollouts image_rollouts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_pkey PRIMARY KEY (id);


--
-- Name: image_rollouts image_rollouts_rollout_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_rollout_id_key UNIQUE (rollout_id);


--
-- Name: image_tags image_tags_image_id_tag_architecture_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_image_id_tag_architecture_key UNIQUE (image_id, tag, architecture);


--
-- Name: image_tags image_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_pkey PRIMARY KEY (id);


--
-- Name: image_update_policies image_update_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_update_policies
    ADD CONSTRAINT image_update_policies_pkey PRIMARY KEY (id);


--
-- Name: images images_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_pkey PRIMARY KEY (id);


--
-- Name: images images_registry_image_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_registry_image_name_key UNIQUE (registry, image_name);


--
-- Name: job_executions job_executions_job_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_job_id_key UNIQUE (job_id);


--
-- Name: job_executions job_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_pkey PRIMARY KEY (id);


--
-- Name: job_handlers job_handlers_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_handlers
    ADD CONSTRAINT job_handlers_name_key UNIQUE (name);


--
-- Name: job_handlers job_handlers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_handlers
    ADD CONSTRAINT job_handlers_pkey PRIMARY KEY (id);


--
-- Name: job_templates job_templates_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_templates
    ADD CONSTRAINT job_templates_name_key UNIQUE (name);


--
-- Name: job_templates job_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_templates
    ADD CONSTRAINT job_templates_pkey PRIMARY KEY (id);


--
-- Name: log_alert_rules log_alert_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alert_rules
    ADD CONSTRAINT log_alert_rules_pkey PRIMARY KEY (id);


--
-- Name: log_alerts log_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_pkey PRIMARY KEY (id);


--
-- Name: mqtt_acls mqtt_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_acls
    ADD CONSTRAINT mqtt_acls_pkey PRIMARY KEY (id);


--
-- Name: mqtt_broker_config mqtt_broker_config_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_broker_config
    ADD CONSTRAINT mqtt_broker_config_name_key UNIQUE (name);


--
-- Name: mqtt_broker_config mqtt_broker_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_broker_config
    ADD CONSTRAINT mqtt_broker_config_pkey PRIMARY KEY (id);


--
-- Name: mqtt_schema_history mqtt_schema_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_schema_history
    ADD CONSTRAINT mqtt_schema_history_pkey PRIMARY KEY (id);


--
-- Name: mqtt_topics mqtt_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_pkey PRIMARY KEY (id);


--
-- Name: mqtt_topics mqtt_topics_topic_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_topic_key UNIQUE (topic);


--
-- Name: mqtt_users mqtt_users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_users
    ADD CONSTRAINT mqtt_users_pkey PRIMARY KEY (id);


--
-- Name: mqtt_users mqtt_users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_users
    ADD CONSTRAINT mqtt_users_username_key UNIQUE (username);


--
-- Name: nodered_credentials nodered_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_credentials
    ADD CONSTRAINT nodered_credentials_pkey PRIMARY KEY (id);


--
-- Name: nodered_flows nodered_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_flows
    ADD CONSTRAINT nodered_flows_pkey PRIMARY KEY (id);


--
-- Name: nodered_library nodered_library_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_library
    ADD CONSTRAINT nodered_library_pkey PRIMARY KEY (id);


--
-- Name: nodered_library nodered_library_type_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_library
    ADD CONSTRAINT nodered_library_type_name_key UNIQUE (type, name);


--
-- Name: nodered_sessions nodered_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_sessions
    ADD CONSTRAINT nodered_sessions_pkey PRIMARY KEY (id);


--
-- Name: nodered_settings nodered_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.nodered_settings
    ADD CONSTRAINT nodered_settings_pkey PRIMARY KEY (id);


--
-- Name: profile_configs profile_configs_profile_name_protocol_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profile_configs
    ADD CONSTRAINT profile_configs_profile_name_protocol_key UNIQUE (profile_name, protocol);


--
-- Name: provisioning_attempts provisioning_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.provisioning_attempts
    ADD CONSTRAINT provisioning_attempts_pkey PRIMARY KEY (id);


--
-- Name: provisioning_keys provisioning_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.provisioning_keys
    ADD CONSTRAINT provisioning_keys_pkey PRIMARY KEY (id);


--
-- Name: readings readings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.readings
    ADD CONSTRAINT readings_pkey PRIMARY KEY (device_uuid, metric_name, "time");


--
-- Name: reconciliation_history reconciliation_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reconciliation_history
    ADD CONSTRAINT reconciliation_history_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: releases releases_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);


--
-- Name: rollout_events rollout_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rollout_events
    ADD CONSTRAINT rollout_events_pkey PRIMARY KEY (id);


--
-- Name: scheduled_jobs scheduled_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (id);


--
-- Name: scheduled_jobs scheduled_jobs_schedule_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_schedule_id_key UNIQUE (schedule_id);


--
-- Name: schema_migrations schema_migrations_migration_number_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

DO $$ BEGIN
    ALTER TABLE ONLY public.schema_migrations
        ADD CONSTRAINT schema_migrations_migration_number_key UNIQUE (migration_number);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

DO $$ BEGIN
    ALTER TABLE ONLY public.schema_migrations
        ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


--
-- Name: sensor_health_history sensor_health_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sensor_health_history
    ADD CONSTRAINT sensor_health_history_pkey PRIMARY KEY (id);


--
-- Name: shell_audit_log shell_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shell_audit_log
    ADD CONSTRAINT shell_audit_log_pkey PRIMARY KEY (id);


--
-- Name: shell_sessions shell_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shell_sessions
    ADD CONSTRAINT shell_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: state_changes state_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_changes
    ADD CONSTRAINT state_changes_pkey PRIMARY KEY (id);


--
-- Name: state_projections state_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_projections
    ADD CONSTRAINT state_projections_pkey PRIMARY KEY (device_uuid);


--
-- Name: state_snapshots state_snapshots_device_uuid_state_type_version_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_snapshots
    ADD CONSTRAINT state_snapshots_device_uuid_state_type_version_key UNIQUE (device_uuid, state_type, version);


--
-- Name: state_snapshots state_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_snapshots
    ADD CONSTRAINT state_snapshots_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (key);


--
-- Name: tag_definitions tag_definitions_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_key_key UNIQUE (key);


--
-- Name: tag_definitions tag_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_pkey PRIMARY KEY (id);


--
-- Name: device_flows unique_device_subflow; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_flows
    ADD CONSTRAINT unique_device_subflow UNIQUE (device_uuid, subflow_id);


--
-- Name: device_target_state_history unique_device_version; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state_history
    ADD CONSTRAINT unique_device_version UNIQUE (device_uuid, version);


--
-- Name: dashboard_layouts unique_share_token; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT unique_share_token UNIQUE (share_token);


--
-- Name: mqtt_schema_history unique_topic_schema; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mqtt_schema_history
    ADD CONSTRAINT unique_topic_schema UNIQUE (topic, schema_hash);


--
-- Name: device_traffic_stats unique_traffic_entry; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_traffic_stats
    ADD CONSTRAINT unique_traffic_entry UNIQUE (device_id, endpoint, method, time_bucket);


--
-- Name: device_sensors uq_device_sensor_name; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_sensors
    ADD CONSTRAINT uq_device_sensor_name UNIQUE (device_uuid, name);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_session_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_session_token_key UNIQUE (session_token);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: profile_configs vendor_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profile_configs
    ADD CONSTRAINT vendor_configs_pkey PRIMARY KEY (id);


--
-- Name: profile_configs vendor_configs_vendor_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profile_configs
    ADD CONSTRAINT vendor_configs_vendor_name_key UNIQUE (profile_name);


--
-- Name: wg_config wg_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_config
    ADD CONSTRAINT wg_config_pkey PRIMARY KEY (id);


--
-- Name: wg_ip_pool wg_ip_pool_ip_address_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_ip_pool
    ADD CONSTRAINT wg_ip_pool_ip_address_key UNIQUE (ip_address);


--
-- Name: wg_ip_pool wg_ip_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_ip_pool
    ADD CONSTRAINT wg_ip_pool_pkey PRIMARY KEY (id);


--
-- Name: wg_peers wg_peers_peer_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_peer_id_key UNIQUE (peer_id);


--
-- Name: wg_peers wg_peers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_pkey PRIMARY KEY (id);


--
-- Name: wg_peers wg_peers_public_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.wg_peers
    ADD CONSTRAINT wg_peers_public_key_key UNIQUE (public_key);


--
-- Name: _hyper_10_2_chunk__materialized_hypertable_10_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_10_2_chunk__materialized_hypertable_10_bucket_idx ON _timescaledb_internal._hyper_10_2_chunk USING btree (bucket DESC);


--
-- Name: _hyper_10_2_chunk__materialized_hypertable_10_device_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_10_2_chunk__materialized_hypertable_10_device_uuid_bucke ON _timescaledb_internal._hyper_10_2_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_10_89_chunk__materialized_hypertable_10_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_10_89_chunk__materialized_hypertable_10_bucket_idx ON _timescaledb_internal._hyper_10_89_chunk USING btree (bucket DESC);


--
-- Name: _hyper_10_89_chunk__materialized_hypertable_10_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_10_89_chunk__materialized_hypertable_10_device_uuid_buck ON _timescaledb_internal._hyper_10_89_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_11_3_chunk__materialized_hypertable_11_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_11_3_chunk__materialized_hypertable_11_bucket_idx ON _timescaledb_internal._hyper_11_3_chunk USING btree (bucket DESC);


--
-- Name: _hyper_11_3_chunk__materialized_hypertable_11_device_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_11_3_chunk__materialized_hypertable_11_device_uuid_bucke ON _timescaledb_internal._hyper_11_3_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_11_90_chunk__materialized_hypertable_11_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_11_90_chunk__materialized_hypertable_11_bucket_idx ON _timescaledb_internal._hyper_11_90_chunk USING btree (bucket DESC);


--
-- Name: _hyper_11_90_chunk__materialized_hypertable_11_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_11_90_chunk__materialized_hypertable_11_device_uuid_buck ON _timescaledb_internal._hyper_11_90_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_12_47_chunk__materialized_hypertable_12_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_12_47_chunk__materialized_hypertable_12_bucket_idx ON _timescaledb_internal._hyper_12_47_chunk USING btree (bucket DESC);


--
-- Name: _hyper_12_47_chunk__materialized_hypertable_12_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_12_47_chunk__materialized_hypertable_12_device_uuid_buck ON _timescaledb_internal._hyper_12_47_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_13_74_chunk__materialized_hypertable_13_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk__materialized_hypertable_13_bucket_idx ON _timescaledb_internal._hyper_13_74_chunk USING btree (bucket DESC);


--
-- Name: _hyper_13_74_chunk__materialized_hypertable_13_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk__materialized_hypertable_13_device_name_buck ON _timescaledb_internal._hyper_13_74_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_13_74_chunk__materialized_hypertable_13_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk__materialized_hypertable_13_device_uuid_buck ON _timescaledb_internal._hyper_13_74_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_13_74_chunk__materialized_hypertable_13_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk__materialized_hypertable_13_metric_name_buck ON _timescaledb_internal._hyper_13_74_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_13_74_chunk__materialized_hypertable_13_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk__materialized_hypertable_13_protocol_bucket_ ON _timescaledb_internal._hyper_13_74_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_13_74_chunk_idx_anomaly_hourly_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk_idx_anomaly_hourly_device_time ON _timescaledb_internal._hyper_13_74_chunk USING btree (device_uuid, device_name, bucket DESC);


--
-- Name: _hyper_13_74_chunk_idx_anomaly_hourly_high_scores; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_13_74_chunk_idx_anomaly_hourly_high_scores ON _timescaledb_internal._hyper_13_74_chunk USING btree (bucket DESC) WHERE (high_anomaly_count > 0);


--
-- Name: _hyper_14_79_chunk__materialized_hypertable_14_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk__materialized_hypertable_14_bucket_idx ON _timescaledb_internal._hyper_14_79_chunk USING btree (bucket DESC);


--
-- Name: _hyper_14_79_chunk__materialized_hypertable_14_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk__materialized_hypertable_14_device_name_buck ON _timescaledb_internal._hyper_14_79_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_14_79_chunk__materialized_hypertable_14_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk__materialized_hypertable_14_device_uuid_buck ON _timescaledb_internal._hyper_14_79_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_14_79_chunk__materialized_hypertable_14_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk__materialized_hypertable_14_metric_name_buck ON _timescaledb_internal._hyper_14_79_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_14_79_chunk__materialized_hypertable_14_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk__materialized_hypertable_14_protocol_bucket_ ON _timescaledb_internal._hyper_14_79_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_14_79_chunk_idx_anomaly_daily_critical; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk_idx_anomaly_daily_critical ON _timescaledb_internal._hyper_14_79_chunk USING btree (bucket DESC) WHERE (critical_count > 0);


--
-- Name: _hyper_14_79_chunk_idx_anomaly_daily_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_14_79_chunk_idx_anomaly_daily_device_time ON _timescaledb_internal._hyper_14_79_chunk USING btree (device_uuid, device_name, bucket DESC);


--
-- Name: _hyper_15_113_chunk_anomaly_events_timestamp_ms_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_anomaly_events_timestamp_ms_idx ON _timescaledb_internal._hyper_15_113_chunk USING btree (timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_agent_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_agent_uuid ON _timescaledb_internal._hyper_15_113_chunk USING btree (agent_uuid, timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_device_name; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_device_name ON _timescaledb_internal._hyper_15_113_chunk USING btree (device_name, timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_device_type; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_device_type ON _timescaledb_internal._hyper_15_113_chunk USING btree (device_type, timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_fingerprint; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_fingerprint ON _timescaledb_internal._hyper_15_113_chunk USING btree (fingerprint, timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_metric; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_metric ON _timescaledb_internal._hyper_15_113_chunk USING btree (metric, timestamp_ms DESC);


--
-- Name: _hyper_15_113_chunk_idx_anomaly_events_severity; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_113_chunk_idx_anomaly_events_severity ON _timescaledb_internal._hyper_15_113_chunk USING btree (severity, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_anomaly_events_timestamp_ms_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_anomaly_events_timestamp_ms_idx ON _timescaledb_internal._hyper_15_114_chunk USING btree (timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_agent_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_agent_uuid ON _timescaledb_internal._hyper_15_114_chunk USING btree (agent_uuid, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_device_name; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_device_name ON _timescaledb_internal._hyper_15_114_chunk USING btree (device_name, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_device_type; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_device_type ON _timescaledb_internal._hyper_15_114_chunk USING btree (device_type, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_fingerprint; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_fingerprint ON _timescaledb_internal._hyper_15_114_chunk USING btree (fingerprint, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_metric; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_metric ON _timescaledb_internal._hyper_15_114_chunk USING btree (metric, timestamp_ms DESC);


--
-- Name: _hyper_15_114_chunk_idx_anomaly_events_severity; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_15_114_chunk_idx_anomaly_events_severity ON _timescaledb_internal._hyper_15_114_chunk USING btree (severity, timestamp_ms DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_agent_uuid_bucke ON _timescaledb_internal._hyper_17_41_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_bucket_idx ON _timescaledb_internal._hyper_17_41_chunk USING btree (bucket DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_device_name_buck ON _timescaledb_internal._hyper_17_41_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_metric_name_buck ON _timescaledb_internal._hyper_17_41_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_protocol_bucket_ ON _timescaledb_internal._hyper_17_41_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_17_41_chunk__materialized_hypertable_17_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_41_chunk__materialized_hypertable_17_unit_bucket_idx ON _timescaledb_internal._hyper_17_41_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_agent_uuid_bucke ON _timescaledb_internal._hyper_17_50_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_bucket_idx ON _timescaledb_internal._hyper_17_50_chunk USING btree (bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_device_name_buck ON _timescaledb_internal._hyper_17_50_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_metric_name_buck ON _timescaledb_internal._hyper_17_50_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_protocol_bucket_ ON _timescaledb_internal._hyper_17_50_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_17_50_chunk__materialized_hypertable_17_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_50_chunk__materialized_hypertable_17_unit_bucket_idx ON _timescaledb_internal._hyper_17_50_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_agent_uuid_bucke ON _timescaledb_internal._hyper_17_88_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_bucket_idx ON _timescaledb_internal._hyper_17_88_chunk USING btree (bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_device_name_buck ON _timescaledb_internal._hyper_17_88_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_metric_name_buck ON _timescaledb_internal._hyper_17_88_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_protocol_bucket_ ON _timescaledb_internal._hyper_17_88_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_17_88_chunk__materialized_hypertable_17_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_17_88_chunk__materialized_hypertable_17_unit_bucket_idx ON _timescaledb_internal._hyper_17_88_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_agent_uuid_bucke ON _timescaledb_internal._hyper_18_42_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_bucket_idx ON _timescaledb_internal._hyper_18_42_chunk USING btree (bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_device_name_buck ON _timescaledb_internal._hyper_18_42_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_metric_name_buck ON _timescaledb_internal._hyper_18_42_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_protocol_bucket_ ON _timescaledb_internal._hyper_18_42_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_18_42_chunk__materialized_hypertable_18_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_42_chunk__materialized_hypertable_18_unit_bucket_idx ON _timescaledb_internal._hyper_18_42_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_agent_uuid_bucke ON _timescaledb_internal._hyper_18_51_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_bucket_idx ON _timescaledb_internal._hyper_18_51_chunk USING btree (bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_device_name_buck ON _timescaledb_internal._hyper_18_51_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_metric_name_buck ON _timescaledb_internal._hyper_18_51_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_protocol_bucket_ ON _timescaledb_internal._hyper_18_51_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_18_51_chunk__materialized_hypertable_18_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_51_chunk__materialized_hypertable_18_unit_bucket_idx ON _timescaledb_internal._hyper_18_51_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_agent_uuid_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_agent_uuid_bucke ON _timescaledb_internal._hyper_18_91_chunk USING btree (agent_uuid, bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_bucket_idx ON _timescaledb_internal._hyper_18_91_chunk USING btree (bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_device_name_buck ON _timescaledb_internal._hyper_18_91_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_metric_name_buck ON _timescaledb_internal._hyper_18_91_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_protocol_bucket_ ON _timescaledb_internal._hyper_18_91_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_18_91_chunk__materialized_hypertable_18_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_18_91_chunk__materialized_hypertable_18_unit_bucket_idx ON _timescaledb_internal._hyper_18_91_chunk USING btree (unit, bucket DESC);


--
-- Name: _hyper_1_115_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_115_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_115_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_115_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_115_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_115_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_115_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_115_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_115_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_115_chunk USING btree (level);


--
-- Name: _hyper_1_115_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_115_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_115_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_62_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_62_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_62_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_62_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_62_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_62_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_62_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_62_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_62_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_62_chunk USING btree (level);


--
-- Name: _hyper_1_62_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_62_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_62_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_72_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_72_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_72_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_72_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_72_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_72_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_72_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_72_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_72_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_72_chunk USING btree (level);


--
-- Name: _hyper_1_72_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_72_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_72_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_75_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_75_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_75_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_75_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_75_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_75_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_75_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_75_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_75_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_75_chunk USING btree (level);


--
-- Name: _hyper_1_75_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_75_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_75_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_77_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_77_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_77_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_77_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_77_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_77_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_77_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_77_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_77_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_77_chunk USING btree (level);


--
-- Name: _hyper_1_77_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_77_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_77_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_80_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_80_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_80_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_80_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_80_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_80_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_80_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_80_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_80_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_80_chunk USING btree (level);


--
-- Name: _hyper_1_80_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_80_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_80_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_1_82_chunk_device_logs_timestamp_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_device_logs_timestamp_idx ON _timescaledb_internal._hyper_1_82_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_1_82_chunk_idx_device_logs_device_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_idx_device_logs_device_timestamp ON _timescaledb_internal._hyper_1_82_chunk USING btree (device_uuid, "timestamp" DESC);


--
-- Name: _hyper_1_82_chunk_idx_device_logs_device_uuid; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_idx_device_logs_device_uuid ON _timescaledb_internal._hyper_1_82_chunk USING btree (device_uuid);


--
-- Name: _hyper_1_82_chunk_idx_device_logs_error_logs; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_idx_device_logs_error_logs ON _timescaledb_internal._hyper_1_82_chunk USING btree (device_uuid, is_stderr) WHERE is_stderr;


--
-- Name: _hyper_1_82_chunk_idx_device_logs_level; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_idx_device_logs_level ON _timescaledb_internal._hyper_1_82_chunk USING btree (level);


--
-- Name: _hyper_1_82_chunk_idx_device_logs_service; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_1_82_chunk_idx_device_logs_service ON _timescaledb_internal._hyper_1_82_chunk USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: _hyper_21_64_chunk__materialized_hypertable_21_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_21_64_chunk__materialized_hypertable_21_bucket_idx ON _timescaledb_internal._hyper_21_64_chunk USING btree (bucket DESC);


--
-- Name: _hyper_21_64_chunk__materialized_hypertable_21_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_21_64_chunk__materialized_hypertable_21_device_name_buck ON _timescaledb_internal._hyper_21_64_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_21_64_chunk__materialized_hypertable_21_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_21_64_chunk__materialized_hypertable_21_device_uuid_buck ON _timescaledb_internal._hyper_21_64_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_21_64_chunk__materialized_hypertable_21_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_21_64_chunk__materialized_hypertable_21_metric_name_buck ON _timescaledb_internal._hyper_21_64_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_21_64_chunk__materialized_hypertable_21_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_21_64_chunk__materialized_hypertable_21_protocol_bucket_ ON _timescaledb_internal._hyper_21_64_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_22_71_chunk__materialized_hypertable_22_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_22_71_chunk__materialized_hypertable_22_bucket_idx ON _timescaledb_internal._hyper_22_71_chunk USING btree (bucket DESC);


--
-- Name: _hyper_22_71_chunk__materialized_hypertable_22_device_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_22_71_chunk__materialized_hypertable_22_device_name_buck ON _timescaledb_internal._hyper_22_71_chunk USING btree (device_name, bucket DESC);


--
-- Name: _hyper_22_71_chunk__materialized_hypertable_22_device_uuid_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_22_71_chunk__materialized_hypertable_22_device_uuid_buck ON _timescaledb_internal._hyper_22_71_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_22_71_chunk__materialized_hypertable_22_metric_name_buck; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_22_71_chunk__materialized_hypertable_22_metric_name_buck ON _timescaledb_internal._hyper_22_71_chunk USING btree (metric_name, bucket DESC);


--
-- Name: _hyper_22_71_chunk__materialized_hypertable_22_protocol_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_22_71_chunk__materialized_hypertable_22_protocol_bucket_ ON _timescaledb_internal._hyper_22_71_chunk USING btree (protocol, bucket DESC);


--
-- Name: _hyper_23_52_chunk_idx_mqtt_topic_metrics_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_52_chunk_idx_mqtt_topic_metrics_timestamp ON _timescaledb_internal._hyper_23_52_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic ON _timescaledb_internal._hyper_23_52_chunk USING btree (topic);


--
-- Name: _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic_id; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic_id ON _timescaledb_internal._hyper_23_52_chunk USING btree (topic_id);


--
-- Name: _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_52_chunk_idx_mqtt_topic_metrics_topic_timestamp ON _timescaledb_internal._hyper_23_52_chunk USING btree (topic, "timestamp" DESC);


--
-- Name: _hyper_23_53_chunk_idx_mqtt_topic_metrics_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_53_chunk_idx_mqtt_topic_metrics_timestamp ON _timescaledb_internal._hyper_23_53_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic ON _timescaledb_internal._hyper_23_53_chunk USING btree (topic);


--
-- Name: _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic_id; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic_id ON _timescaledb_internal._hyper_23_53_chunk USING btree (topic_id);


--
-- Name: _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_53_chunk_idx_mqtt_topic_metrics_topic_timestamp ON _timescaledb_internal._hyper_23_53_chunk USING btree (topic, "timestamp" DESC);


--
-- Name: _hyper_23_59_chunk_idx_mqtt_topic_metrics_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_59_chunk_idx_mqtt_topic_metrics_timestamp ON _timescaledb_internal._hyper_23_59_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic ON _timescaledb_internal._hyper_23_59_chunk USING btree (topic);


--
-- Name: _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic_id; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic_id ON _timescaledb_internal._hyper_23_59_chunk USING btree (topic_id);


--
-- Name: _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_23_59_chunk_idx_mqtt_topic_metrics_topic_timestamp ON _timescaledb_internal._hyper_23_59_chunk USING btree (topic, "timestamp" DESC);


--
-- Name: _hyper_25_54_chunk_idx_mqtt_broker_stats_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_25_54_chunk_idx_mqtt_broker_stats_timestamp ON _timescaledb_internal._hyper_25_54_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_25_55_chunk_idx_mqtt_broker_stats_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_25_55_chunk_idx_mqtt_broker_stats_timestamp ON _timescaledb_internal._hyper_25_55_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_25_58_chunk_idx_mqtt_broker_stats_timestamp; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_25_58_chunk_idx_mqtt_broker_stats_timestamp ON _timescaledb_internal._hyper_25_58_chunk USING btree ("timestamp" DESC);


--
-- Name: _hyper_3_5_chunk__materialized_hypertable_3_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_5_chunk__materialized_hypertable_3_bucket_idx ON _timescaledb_internal._hyper_3_5_chunk USING btree (bucket DESC);


--
-- Name: _hyper_3_5_chunk__materialized_hypertable_3_device_uuid_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_5_chunk__materialized_hypertable_3_device_uuid_bucket_ ON _timescaledb_internal._hyper_3_5_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_3_5_chunk__materialized_hypertable_3_service_name_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_5_chunk__materialized_hypertable_3_service_name_bucket ON _timescaledb_internal._hyper_3_5_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_3_5_chunk_idx_device_logs_5min_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_5_chunk_idx_device_logs_5min_service_bucket ON _timescaledb_internal._hyper_3_5_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_3_63_chunk__materialized_hypertable_3_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_63_chunk__materialized_hypertable_3_bucket_idx ON _timescaledb_internal._hyper_3_63_chunk USING btree (bucket DESC);


--
-- Name: _hyper_3_63_chunk__materialized_hypertable_3_device_uuid_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_63_chunk__materialized_hypertable_3_device_uuid_bucket ON _timescaledb_internal._hyper_3_63_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_3_63_chunk__materialized_hypertable_3_service_name_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_63_chunk__materialized_hypertable_3_service_name_bucke ON _timescaledb_internal._hyper_3_63_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_3_63_chunk_idx_device_logs_5min_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_63_chunk_idx_device_logs_5min_service_bucket ON _timescaledb_internal._hyper_3_63_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_3_83_chunk__materialized_hypertable_3_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_83_chunk__materialized_hypertable_3_bucket_idx ON _timescaledb_internal._hyper_3_83_chunk USING btree (bucket DESC);


--
-- Name: _hyper_3_83_chunk__materialized_hypertable_3_device_uuid_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_83_chunk__materialized_hypertable_3_device_uuid_bucket ON _timescaledb_internal._hyper_3_83_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_3_83_chunk__materialized_hypertable_3_service_name_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_83_chunk__materialized_hypertable_3_service_name_bucke ON _timescaledb_internal._hyper_3_83_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_3_83_chunk_idx_device_logs_5min_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_3_83_chunk_idx_device_logs_5min_service_bucket ON _timescaledb_internal._hyper_3_83_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_4_66_chunk__materialized_hypertable_4_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_66_chunk__materialized_hypertable_4_bucket_idx ON _timescaledb_internal._hyper_4_66_chunk USING btree (bucket DESC);


--
-- Name: _hyper_4_66_chunk__materialized_hypertable_4_device_uuid_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_66_chunk__materialized_hypertable_4_device_uuid_bucket ON _timescaledb_internal._hyper_4_66_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_4_66_chunk__materialized_hypertable_4_service_name_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_66_chunk__materialized_hypertable_4_service_name_bucke ON _timescaledb_internal._hyper_4_66_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_4_66_chunk_idx_device_logs_hourly_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_66_chunk_idx_device_logs_hourly_service_bucket ON _timescaledb_internal._hyper_4_66_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_4_6_chunk__materialized_hypertable_4_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_6_chunk__materialized_hypertable_4_bucket_idx ON _timescaledb_internal._hyper_4_6_chunk USING btree (bucket DESC);


--
-- Name: _hyper_4_6_chunk__materialized_hypertable_4_device_uuid_bucket_; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_6_chunk__materialized_hypertable_4_device_uuid_bucket_ ON _timescaledb_internal._hyper_4_6_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_4_6_chunk__materialized_hypertable_4_service_name_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_6_chunk__materialized_hypertable_4_service_name_bucket ON _timescaledb_internal._hyper_4_6_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_4_6_chunk_idx_device_logs_hourly_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_6_chunk_idx_device_logs_hourly_service_bucket ON _timescaledb_internal._hyper_4_6_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_4_84_chunk__materialized_hypertable_4_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_84_chunk__materialized_hypertable_4_bucket_idx ON _timescaledb_internal._hyper_4_84_chunk USING btree (bucket DESC);


--
-- Name: _hyper_4_84_chunk__materialized_hypertable_4_device_uuid_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_84_chunk__materialized_hypertable_4_device_uuid_bucket ON _timescaledb_internal._hyper_4_84_chunk USING btree (device_uuid, bucket DESC);


--
-- Name: _hyper_4_84_chunk__materialized_hypertable_4_service_name_bucke; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_84_chunk__materialized_hypertable_4_service_name_bucke ON _timescaledb_internal._hyper_4_84_chunk USING btree (service_name, bucket DESC);


--
-- Name: _hyper_4_84_chunk_idx_device_logs_hourly_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_4_84_chunk_idx_device_logs_hourly_service_bucket ON _timescaledb_internal._hyper_4_84_chunk USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: _hyper_5_116_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_116_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_116_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_116_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_116_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_116_chunk USING gin (extra);


--
-- Name: _hyper_5_116_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_116_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_116_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_116_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_116_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_116_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_116_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_40_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_40_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_40_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_40_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_40_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_40_chunk USING gin (extra);


--
-- Name: _hyper_5_40_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_40_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_40_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_40_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_40_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_40_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_40_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_43_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_43_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_43_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_43_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_43_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_43_chunk USING gin (extra);


--
-- Name: _hyper_5_43_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_43_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_43_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_43_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_43_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_43_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_43_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_49_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_49_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_49_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_49_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_49_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_49_chunk USING gin (extra);


--
-- Name: _hyper_5_49_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_49_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_49_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_49_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_49_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_49_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_49_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_60_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_60_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_60_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_60_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_60_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_60_chunk USING gin (extra);


--
-- Name: _hyper_5_60_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_60_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_60_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_60_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_60_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_60_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_60_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_73_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_73_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_73_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_73_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_73_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_73_chunk USING gin (extra);


--
-- Name: _hyper_5_73_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_73_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_73_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_73_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_73_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_73_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_73_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_76_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_76_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_76_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_76_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_76_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_76_chunk USING gin (extra);


--
-- Name: _hyper_5_76_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_76_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_76_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_76_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_76_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_76_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_76_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_78_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_78_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_78_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_78_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_78_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_78_chunk USING gin (extra);


--
-- Name: _hyper_5_78_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_78_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_78_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_78_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_78_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_78_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_78_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_81_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_81_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_81_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_81_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_81_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_81_chunk USING gin (extra);


--
-- Name: _hyper_5_81_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_81_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_81_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_81_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_81_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_81_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_81_chunk USING btree ("time" DESC);


--
-- Name: _hyper_5_87_chunk_idx_readings_anomaly_score; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_idx_readings_anomaly_score ON _timescaledb_internal._hyper_5_87_chunk USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: _hyper_5_87_chunk_idx_readings_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_idx_readings_device_time ON _timescaledb_internal._hyper_5_87_chunk USING btree (device_uuid, "time" DESC);


--
-- Name: _hyper_5_87_chunk_idx_readings_extra; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_idx_readings_extra ON _timescaledb_internal._hyper_5_87_chunk USING gin (extra);


--
-- Name: _hyper_5_87_chunk_idx_readings_metric_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_idx_readings_metric_time ON _timescaledb_internal._hyper_5_87_chunk USING btree (metric_name, "time" DESC);


--
-- Name: _hyper_5_87_chunk_idx_readings_protocol; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_idx_readings_protocol ON _timescaledb_internal._hyper_5_87_chunk USING btree (protocol, "time" DESC);


--
-- Name: _hyper_5_87_chunk_readings_time_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_5_87_chunk_readings_time_idx ON _timescaledb_internal._hyper_5_87_chunk USING btree ("time" DESC);


--
-- Name: _hyper_9_1_chunk_device_metrics_recorded_at_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_1_chunk_device_metrics_recorded_at_idx ON _timescaledb_internal._hyper_9_1_chunk USING btree (recorded_at DESC);


--
-- Name: _hyper_9_1_chunk_idx_device_metrics_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_1_chunk_idx_device_metrics_device_time ON _timescaledb_internal._hyper_9_1_chunk USING btree (device_uuid, recorded_at DESC);


--
-- Name: _hyper_9_44_chunk_device_metrics_recorded_at_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_44_chunk_device_metrics_recorded_at_idx ON _timescaledb_internal._hyper_9_44_chunk USING btree (recorded_at DESC);


--
-- Name: _hyper_9_44_chunk_idx_device_metrics_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_44_chunk_idx_device_metrics_device_time ON _timescaledb_internal._hyper_9_44_chunk USING btree (device_uuid, recorded_at DESC);


--
-- Name: _hyper_9_61_chunk_device_metrics_recorded_at_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_61_chunk_device_metrics_recorded_at_idx ON _timescaledb_internal._hyper_9_61_chunk USING btree (recorded_at DESC);


--
-- Name: _hyper_9_61_chunk_idx_device_metrics_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_61_chunk_idx_device_metrics_device_time ON _timescaledb_internal._hyper_9_61_chunk USING btree (device_uuid, recorded_at DESC);


--
-- Name: _hyper_9_86_chunk_device_metrics_recorded_at_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_86_chunk_device_metrics_recorded_at_idx ON _timescaledb_internal._hyper_9_86_chunk USING btree (recorded_at DESC);


--
-- Name: _hyper_9_86_chunk_idx_device_metrics_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _hyper_9_86_chunk_idx_device_metrics_device_time ON _timescaledb_internal._hyper_9_86_chunk USING btree (device_uuid, recorded_at DESC);


--
-- Name: _materialized_hypertable_10_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_10_bucket_idx ON _timescaledb_internal._materialized_hypertable_10 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_10_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_10_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_10 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_11_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_11_bucket_idx ON _timescaledb_internal._materialized_hypertable_11 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_11_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_11_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_11 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_12_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_12_bucket_idx ON _timescaledb_internal._materialized_hypertable_12 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_12_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_12_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_12 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_13_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_13_bucket_idx ON _timescaledb_internal._materialized_hypertable_13 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_13_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_13_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_13 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_13_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_13_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_13 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_13_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_13_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_13 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_13_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_13_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_13 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_14_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_14_bucket_idx ON _timescaledb_internal._materialized_hypertable_14 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_14_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_14_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_14 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_14_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_14_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_14 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_14_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_14_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_14 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_14_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_14_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_14 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_17_agent_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_agent_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (agent_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_17_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_17_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_17_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_17_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_17_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_17_unit_bucket_idx ON _timescaledb_internal._materialized_hypertable_17 USING btree (unit, bucket DESC);


--
-- Name: _materialized_hypertable_18_agent_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_agent_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (agent_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_18_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_18_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_18_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_18_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_18_unit_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_18_unit_bucket_idx ON _timescaledb_internal._materialized_hypertable_18 USING btree (unit, bucket DESC);


--
-- Name: _materialized_hypertable_21_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_21_bucket_idx ON _timescaledb_internal._materialized_hypertable_21 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_21_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_21_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_21 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_21_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_21_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_21 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_21_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_21_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_21 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_21_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_21_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_21 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_22_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_22_bucket_idx ON _timescaledb_internal._materialized_hypertable_22 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_22_device_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_22_device_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_22 USING btree (device_name, bucket DESC);


--
-- Name: _materialized_hypertable_22_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_22_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_22 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_22_metric_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_22_metric_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_22 USING btree (metric_name, bucket DESC);


--
-- Name: _materialized_hypertable_22_protocol_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_22_protocol_bucket_idx ON _timescaledb_internal._materialized_hypertable_22 USING btree (protocol, bucket DESC);


--
-- Name: _materialized_hypertable_3_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_3_bucket_idx ON _timescaledb_internal._materialized_hypertable_3 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_3_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_3_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_3 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_3_service_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_3_service_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_3 USING btree (service_name, bucket DESC);


--
-- Name: _materialized_hypertable_4_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_4_bucket_idx ON _timescaledb_internal._materialized_hypertable_4 USING btree (bucket DESC);


--
-- Name: _materialized_hypertable_4_device_uuid_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_4_device_uuid_bucket_idx ON _timescaledb_internal._materialized_hypertable_4 USING btree (device_uuid, bucket DESC);


--
-- Name: _materialized_hypertable_4_service_name_bucket_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX _materialized_hypertable_4_service_name_bucket_idx ON _timescaledb_internal._materialized_hypertable_4 USING btree (service_name, bucket DESC);


--
-- Name: compress_hyper_24_57_chunk_topic__ts_meta_min_1__ts_meta_ma_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_24_57_chunk_topic__ts_meta_min_1__ts_meta_ma_idx ON _timescaledb_internal.compress_hyper_24_57_chunk USING btree (topic, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_24_69_chunk_topic__ts_meta_min_1__ts_meta_ma_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_24_69_chunk_topic__ts_meta_min_1__ts_meta_ma_idx ON _timescaledb_internal.compress_hyper_24_69_chunk USING btree (topic, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_26_56_chunk__ts_meta_min_1__ts_meta_max_1_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_26_56_chunk__ts_meta_min_1__ts_meta_max_1_idx ON _timescaledb_internal.compress_hyper_26_56_chunk USING btree (_ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_26_68_chunk__ts_meta_min_1__ts_meta_max_1_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_26_68_chunk__ts_meta_min_1__ts_meta_max_1_idx ON _timescaledb_internal.compress_hyper_26_68_chunk USING btree (_ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_6_117_chunk_device_uuid_metric_name__ts_meta_idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_6_117_chunk_device_uuid_metric_name__ts_meta_idx ON _timescaledb_internal.compress_hyper_6_117_chunk USING btree (device_uuid, metric_name, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_6_65_chunk_device_uuid_metric_name__ts_meta__idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_6_65_chunk_device_uuid_metric_name__ts_meta__idx ON _timescaledb_internal.compress_hyper_6_65_chunk USING btree (device_uuid, metric_name, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_6_70_chunk_device_uuid_metric_name__ts_meta__idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_6_70_chunk_device_uuid_metric_name__ts_meta__idx ON _timescaledb_internal.compress_hyper_6_70_chunk USING btree (device_uuid, metric_name, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: compress_hyper_6_85_chunk_device_uuid_metric_name__ts_meta__idx; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX compress_hyper_6_85_chunk_device_uuid_metric_name__ts_meta__idx ON _timescaledb_internal.compress_hyper_6_85_chunk USING btree (device_uuid, metric_name, _ts_meta_min_1 DESC, _ts_meta_max_1 DESC);


--
-- Name: idx_anomaly_daily_critical; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_daily_critical ON _timescaledb_internal._materialized_hypertable_14 USING btree (bucket DESC) WHERE (critical_count > 0);


--
-- Name: idx_anomaly_daily_device_name; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_daily_device_name ON _timescaledb_internal._materialized_hypertable_14 USING btree (device_name, bucket DESC);


--
-- Name: idx_anomaly_daily_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_daily_device_time ON _timescaledb_internal._materialized_hypertable_14 USING btree (device_uuid, device_name, bucket DESC);


--
-- Name: idx_anomaly_hourly_device_name; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_hourly_device_name ON _timescaledb_internal._materialized_hypertable_13 USING btree (device_name, bucket DESC);


--
-- Name: idx_anomaly_hourly_device_time; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_hourly_device_time ON _timescaledb_internal._materialized_hypertable_13 USING btree (device_uuid, device_name, bucket DESC);


--
-- Name: idx_anomaly_hourly_high_scores; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_anomaly_hourly_high_scores ON _timescaledb_internal._materialized_hypertable_13 USING btree (bucket DESC) WHERE (high_anomaly_count > 0);


--
-- Name: idx_device_logs_5min_device_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_device_logs_5min_device_bucket ON _timescaledb_internal._materialized_hypertable_3 USING btree (device_uuid, bucket DESC);


--
-- Name: idx_device_logs_5min_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_device_logs_5min_service_bucket ON _timescaledb_internal._materialized_hypertable_3 USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: idx_device_logs_hourly_device_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_device_logs_hourly_device_bucket ON _timescaledb_internal._materialized_hypertable_4 USING btree (device_uuid, bucket DESC);


--
-- Name: idx_device_logs_hourly_service_bucket; Type: INDEX; Schema: _timescaledb_internal; Owner: postgres
--

CREATE INDEX idx_device_logs_hourly_service_bucket ON _timescaledb_internal._materialized_hypertable_4 USING btree (device_uuid, service_name, bucket DESC);


--
-- Name: anomaly_events_timestamp_ms_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX anomaly_events_timestamp_ms_idx ON public.anomaly_events USING btree (timestamp_ms DESC);


--
-- Name: device_logs_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX device_logs_timestamp_idx ON public.device_logs USING btree ("timestamp" DESC);


--
-- Name: device_metrics_recorded_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX device_metrics_recorded_at_idx ON public.device_metrics USING btree (recorded_at DESC);


--
-- Name: idx_events_actor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_actor ON ONLY public.events USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_11_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_actor_type_actor_id_idx ON public.events_2026_01_11 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: idx_events_aggregate; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_aggregate ON ONLY public.events USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_11 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: idx_events_causation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_causation ON ONLY public.events USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_11_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_causation_id_idx ON public.events_2026_01_11 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: idx_events_correlation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_correlation ON ONLY public.events USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_11_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_correlation_id_idx ON public.events_2026_01_11 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_type ON ONLY public.events USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_11_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_event_type_timestamp_idx ON public.events_2026_01_11 USING btree (event_type, "timestamp");


--
-- Name: idx_events_impact; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_impact ON ONLY public.events USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_11_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_impact_idx ON public.events_2026_01_11 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: idx_events_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_severity ON ONLY public.events USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_11_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_severity_idx ON public.events_2026_01_11 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: idx_events_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_events_timestamp ON ONLY public.events USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_11_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_11_timestamp_idx ON public.events_2026_01_11 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_12_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_actor_type_actor_id_idx ON public.events_2026_01_12 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_12 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_12_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_causation_id_idx ON public.events_2026_01_12 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_12_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_correlation_id_idx ON public.events_2026_01_12 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_12_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_event_type_timestamp_idx ON public.events_2026_01_12 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_12_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_impact_idx ON public.events_2026_01_12 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_12_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_severity_idx ON public.events_2026_01_12 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_12_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_12_timestamp_idx ON public.events_2026_01_12 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_13_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_actor_type_actor_id_idx ON public.events_2026_01_13 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_13 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_13_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_causation_id_idx ON public.events_2026_01_13 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_13_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_correlation_id_idx ON public.events_2026_01_13 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_13_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_event_type_timestamp_idx ON public.events_2026_01_13 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_13_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_impact_idx ON public.events_2026_01_13 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_13_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_severity_idx ON public.events_2026_01_13 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_13_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_13_timestamp_idx ON public.events_2026_01_13 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_14_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_actor_type_actor_id_idx ON public.events_2026_01_14 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_14 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_14_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_causation_id_idx ON public.events_2026_01_14 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_14_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_correlation_id_idx ON public.events_2026_01_14 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_14_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_event_type_timestamp_idx ON public.events_2026_01_14 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_14_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_impact_idx ON public.events_2026_01_14 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_14_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_severity_idx ON public.events_2026_01_14 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_14_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_14_timestamp_idx ON public.events_2026_01_14 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_15_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_actor_type_actor_id_idx ON public.events_2026_01_15 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_15 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_15_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_causation_id_idx ON public.events_2026_01_15 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_15_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_correlation_id_idx ON public.events_2026_01_15 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_15_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_event_type_timestamp_idx ON public.events_2026_01_15 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_15_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_impact_idx ON public.events_2026_01_15 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_15_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_severity_idx ON public.events_2026_01_15 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_15_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_15_timestamp_idx ON public.events_2026_01_15 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_16_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_actor_type_actor_id_idx ON public.events_2026_01_16 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_16 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_16_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_causation_id_idx ON public.events_2026_01_16 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_16_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_correlation_id_idx ON public.events_2026_01_16 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_16_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_event_type_timestamp_idx ON public.events_2026_01_16 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_16_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_impact_idx ON public.events_2026_01_16 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_16_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_severity_idx ON public.events_2026_01_16 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_16_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_16_timestamp_idx ON public.events_2026_01_16 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_17_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_actor_type_actor_id_idx ON public.events_2026_01_17 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_17 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_17_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_causation_id_idx ON public.events_2026_01_17 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_17_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_correlation_id_idx ON public.events_2026_01_17 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_17_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_event_type_timestamp_idx ON public.events_2026_01_17 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_17_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_impact_idx ON public.events_2026_01_17 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_17_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_severity_idx ON public.events_2026_01_17 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_17_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_17_timestamp_idx ON public.events_2026_01_17 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_18_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_actor_type_actor_id_idx ON public.events_2026_01_18 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_18_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_18 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_18_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_causation_id_idx ON public.events_2026_01_18 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_18_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_correlation_id_idx ON public.events_2026_01_18 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_18_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_event_type_timestamp_idx ON public.events_2026_01_18 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_18_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_impact_idx ON public.events_2026_01_18 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_18_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_severity_idx ON public.events_2026_01_18 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_18_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_18_timestamp_idx ON public.events_2026_01_18 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_19_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_actor_type_actor_id_idx ON public.events_2026_01_19 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_19_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_19 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_19_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_causation_id_idx ON public.events_2026_01_19 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_19_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_correlation_id_idx ON public.events_2026_01_19 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_19_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_event_type_timestamp_idx ON public.events_2026_01_19 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_19_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_impact_idx ON public.events_2026_01_19 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_19_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_severity_idx ON public.events_2026_01_19 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_19_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_19_timestamp_idx ON public.events_2026_01_19 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_20_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_actor_type_actor_id_idx ON public.events_2026_01_20 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_20_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_20 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_20_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_causation_id_idx ON public.events_2026_01_20 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_20_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_correlation_id_idx ON public.events_2026_01_20 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_20_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_event_type_timestamp_idx ON public.events_2026_01_20 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_20_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_impact_idx ON public.events_2026_01_20 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_20_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_severity_idx ON public.events_2026_01_20 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_20_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_20_timestamp_idx ON public.events_2026_01_20 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_21_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_actor_type_actor_id_idx ON public.events_2026_01_21 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_21_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_21 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_21_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_causation_id_idx ON public.events_2026_01_21 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_21_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_correlation_id_idx ON public.events_2026_01_21 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_21_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_event_type_timestamp_idx ON public.events_2026_01_21 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_21_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_impact_idx ON public.events_2026_01_21 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_21_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_severity_idx ON public.events_2026_01_21 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_21_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_21_timestamp_idx ON public.events_2026_01_21 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_22_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_actor_type_actor_id_idx ON public.events_2026_01_22 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_22 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_22_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_causation_id_idx ON public.events_2026_01_22 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_22_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_correlation_id_idx ON public.events_2026_01_22 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_22_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_event_type_timestamp_idx ON public.events_2026_01_22 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_22_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_impact_idx ON public.events_2026_01_22 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_22_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_severity_idx ON public.events_2026_01_22 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_22_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_22_timestamp_idx ON public.events_2026_01_22 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_23_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_actor_type_actor_id_idx ON public.events_2026_01_23 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_23 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_23_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_causation_id_idx ON public.events_2026_01_23 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_23_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_correlation_id_idx ON public.events_2026_01_23 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_23_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_event_type_timestamp_idx ON public.events_2026_01_23 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_23_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_impact_idx ON public.events_2026_01_23 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_23_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_severity_idx ON public.events_2026_01_23 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_23_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_23_timestamp_idx ON public.events_2026_01_23 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_24_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_actor_type_actor_id_idx ON public.events_2026_01_24 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_24 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_24_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_causation_id_idx ON public.events_2026_01_24 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_24_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_correlation_id_idx ON public.events_2026_01_24 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_24_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_event_type_timestamp_idx ON public.events_2026_01_24 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_24_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_impact_idx ON public.events_2026_01_24 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_24_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_severity_idx ON public.events_2026_01_24 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_24_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_24_timestamp_idx ON public.events_2026_01_24 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_25_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_actor_type_actor_id_idx ON public.events_2026_01_25 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_25 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_25_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_causation_id_idx ON public.events_2026_01_25 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_25_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_correlation_id_idx ON public.events_2026_01_25 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_25_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_event_type_timestamp_idx ON public.events_2026_01_25 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_25_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_impact_idx ON public.events_2026_01_25 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_25_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_severity_idx ON public.events_2026_01_25 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_25_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_25_timestamp_idx ON public.events_2026_01_25 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_26_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_actor_type_actor_id_idx ON public.events_2026_01_26 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_26_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_26 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_26_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_causation_id_idx ON public.events_2026_01_26 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_26_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_correlation_id_idx ON public.events_2026_01_26 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_26_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_event_type_timestamp_idx ON public.events_2026_01_26 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_26_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_impact_idx ON public.events_2026_01_26 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_26_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_severity_idx ON public.events_2026_01_26 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_26_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_26_timestamp_idx ON public.events_2026_01_26 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_27_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_actor_type_actor_id_idx ON public.events_2026_01_27 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_27_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_27 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_27_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_causation_id_idx ON public.events_2026_01_27 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_27_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_correlation_id_idx ON public.events_2026_01_27 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_27_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_event_type_timestamp_idx ON public.events_2026_01_27 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_27_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_impact_idx ON public.events_2026_01_27 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_27_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_severity_idx ON public.events_2026_01_27 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_27_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_27_timestamp_idx ON public.events_2026_01_27 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_28_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_actor_type_actor_id_idx ON public.events_2026_01_28 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_28_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_28 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_28_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_causation_id_idx ON public.events_2026_01_28 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_28_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_correlation_id_idx ON public.events_2026_01_28 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_28_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_event_type_timestamp_idx ON public.events_2026_01_28 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_28_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_impact_idx ON public.events_2026_01_28 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_28_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_severity_idx ON public.events_2026_01_28 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_28_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_28_timestamp_idx ON public.events_2026_01_28 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_29_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_actor_type_actor_id_idx ON public.events_2026_01_29 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_29_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_29 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_29_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_causation_id_idx ON public.events_2026_01_29 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_29_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_correlation_id_idx ON public.events_2026_01_29 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_29_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_event_type_timestamp_idx ON public.events_2026_01_29 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_29_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_impact_idx ON public.events_2026_01_29 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_29_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_severity_idx ON public.events_2026_01_29 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_29_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_29_timestamp_idx ON public.events_2026_01_29 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_30_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_actor_type_actor_id_idx ON public.events_2026_01_30 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_30_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_30 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_30_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_causation_id_idx ON public.events_2026_01_30 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_30_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_correlation_id_idx ON public.events_2026_01_30 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_30_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_event_type_timestamp_idx ON public.events_2026_01_30 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_30_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_impact_idx ON public.events_2026_01_30 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_30_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_severity_idx ON public.events_2026_01_30 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_30_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_30_timestamp_idx ON public.events_2026_01_30 USING btree ("timestamp" DESC);


--
-- Name: events_2026_01_31_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_actor_type_actor_id_idx ON public.events_2026_01_31 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_01_31_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_01_31 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_01_31_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_causation_id_idx ON public.events_2026_01_31 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_01_31_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_correlation_id_idx ON public.events_2026_01_31 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_01_31_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_event_type_timestamp_idx ON public.events_2026_01_31 USING btree (event_type, "timestamp");


--
-- Name: events_2026_01_31_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_impact_idx ON public.events_2026_01_31 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_01_31_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_severity_idx ON public.events_2026_01_31 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_01_31_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_01_31_timestamp_idx ON public.events_2026_01_31 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_01_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_actor_type_actor_id_idx ON public.events_2026_02_01 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_01_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_01 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_01_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_causation_id_idx ON public.events_2026_02_01 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_01_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_correlation_id_idx ON public.events_2026_02_01 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_01_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_event_type_timestamp_idx ON public.events_2026_02_01 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_01_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_impact_idx ON public.events_2026_02_01 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_01_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_severity_idx ON public.events_2026_02_01 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_01_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_01_timestamp_idx ON public.events_2026_02_01 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_02_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_actor_type_actor_id_idx ON public.events_2026_02_02 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_02_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_02 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_02_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_causation_id_idx ON public.events_2026_02_02 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_02_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_correlation_id_idx ON public.events_2026_02_02 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_02_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_event_type_timestamp_idx ON public.events_2026_02_02 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_02_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_impact_idx ON public.events_2026_02_02 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_02_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_severity_idx ON public.events_2026_02_02 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_02_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_02_timestamp_idx ON public.events_2026_02_02 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_03_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_actor_type_actor_id_idx ON public.events_2026_02_03 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_03_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_03 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_03_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_causation_id_idx ON public.events_2026_02_03 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_03_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_correlation_id_idx ON public.events_2026_02_03 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_03_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_event_type_timestamp_idx ON public.events_2026_02_03 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_03_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_impact_idx ON public.events_2026_02_03 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_03_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_severity_idx ON public.events_2026_02_03 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_03_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_03_timestamp_idx ON public.events_2026_02_03 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_04_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_actor_type_actor_id_idx ON public.events_2026_02_04 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_04_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_04 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_04_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_causation_id_idx ON public.events_2026_02_04 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_04_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_correlation_id_idx ON public.events_2026_02_04 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_04_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_event_type_timestamp_idx ON public.events_2026_02_04 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_04_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_impact_idx ON public.events_2026_02_04 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_04_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_severity_idx ON public.events_2026_02_04 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_04_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_04_timestamp_idx ON public.events_2026_02_04 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_05_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_actor_type_actor_id_idx ON public.events_2026_02_05 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_05_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_05 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_05_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_causation_id_idx ON public.events_2026_02_05 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_05_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_correlation_id_idx ON public.events_2026_02_05 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_05_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_event_type_timestamp_idx ON public.events_2026_02_05 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_05_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_impact_idx ON public.events_2026_02_05 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_05_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_severity_idx ON public.events_2026_02_05 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_05_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_05_timestamp_idx ON public.events_2026_02_05 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_06_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_actor_type_actor_id_idx ON public.events_2026_02_06 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_06_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_06 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_06_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_causation_id_idx ON public.events_2026_02_06 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_06_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_correlation_id_idx ON public.events_2026_02_06 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_06_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_event_type_timestamp_idx ON public.events_2026_02_06 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_06_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_impact_idx ON public.events_2026_02_06 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_06_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_severity_idx ON public.events_2026_02_06 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_06_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_06_timestamp_idx ON public.events_2026_02_06 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_07_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_actor_type_actor_id_idx ON public.events_2026_02_07 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_07_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_07 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_07_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_causation_id_idx ON public.events_2026_02_07 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_07_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_correlation_id_idx ON public.events_2026_02_07 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_07_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_event_type_timestamp_idx ON public.events_2026_02_07 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_07_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_impact_idx ON public.events_2026_02_07 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_07_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_severity_idx ON public.events_2026_02_07 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_07_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_07_timestamp_idx ON public.events_2026_02_07 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_08_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_actor_type_actor_id_idx ON public.events_2026_02_08 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_08_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_08 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_08_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_causation_id_idx ON public.events_2026_02_08 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_08_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_correlation_id_idx ON public.events_2026_02_08 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_08_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_event_type_timestamp_idx ON public.events_2026_02_08 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_08_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_impact_idx ON public.events_2026_02_08 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_08_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_severity_idx ON public.events_2026_02_08 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_08_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_08_timestamp_idx ON public.events_2026_02_08 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_09_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_actor_type_actor_id_idx ON public.events_2026_02_09 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_09_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_09 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_09_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_causation_id_idx ON public.events_2026_02_09 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_09_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_correlation_id_idx ON public.events_2026_02_09 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_09_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_event_type_timestamp_idx ON public.events_2026_02_09 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_09_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_impact_idx ON public.events_2026_02_09 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_09_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_severity_idx ON public.events_2026_02_09 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_09_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_09_timestamp_idx ON public.events_2026_02_09 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_10_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_actor_type_actor_id_idx ON public.events_2026_02_10 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_10_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_10 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_10_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_causation_id_idx ON public.events_2026_02_10 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_10_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_correlation_id_idx ON public.events_2026_02_10 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_10_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_event_type_timestamp_idx ON public.events_2026_02_10 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_10_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_impact_idx ON public.events_2026_02_10 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_10_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_severity_idx ON public.events_2026_02_10 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_10_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_10_timestamp_idx ON public.events_2026_02_10 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_11_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_actor_type_actor_id_idx ON public.events_2026_02_11 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_11 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_11_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_causation_id_idx ON public.events_2026_02_11 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_11_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_correlation_id_idx ON public.events_2026_02_11 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_11_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_event_type_timestamp_idx ON public.events_2026_02_11 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_11_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_impact_idx ON public.events_2026_02_11 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_11_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_severity_idx ON public.events_2026_02_11 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_11_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_11_timestamp_idx ON public.events_2026_02_11 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_12_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_actor_type_actor_id_idx ON public.events_2026_02_12 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_12 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_12_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_causation_id_idx ON public.events_2026_02_12 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_12_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_correlation_id_idx ON public.events_2026_02_12 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_12_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_event_type_timestamp_idx ON public.events_2026_02_12 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_12_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_impact_idx ON public.events_2026_02_12 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_12_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_severity_idx ON public.events_2026_02_12 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_12_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_12_timestamp_idx ON public.events_2026_02_12 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_13_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_actor_type_actor_id_idx ON public.events_2026_02_13 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_13 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_13_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_causation_id_idx ON public.events_2026_02_13 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_13_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_correlation_id_idx ON public.events_2026_02_13 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_13_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_event_type_timestamp_idx ON public.events_2026_02_13 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_13_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_impact_idx ON public.events_2026_02_13 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_13_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_severity_idx ON public.events_2026_02_13 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_13_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_13_timestamp_idx ON public.events_2026_02_13 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_14_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_actor_type_actor_id_idx ON public.events_2026_02_14 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_14 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_14_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_causation_id_idx ON public.events_2026_02_14 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_14_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_correlation_id_idx ON public.events_2026_02_14 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_14_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_event_type_timestamp_idx ON public.events_2026_02_14 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_14_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_impact_idx ON public.events_2026_02_14 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_14_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_severity_idx ON public.events_2026_02_14 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_14_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_14_timestamp_idx ON public.events_2026_02_14 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_15_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_actor_type_actor_id_idx ON public.events_2026_02_15 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_15 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_15_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_causation_id_idx ON public.events_2026_02_15 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_15_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_correlation_id_idx ON public.events_2026_02_15 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_15_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_event_type_timestamp_idx ON public.events_2026_02_15 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_15_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_impact_idx ON public.events_2026_02_15 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_15_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_severity_idx ON public.events_2026_02_15 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_15_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_15_timestamp_idx ON public.events_2026_02_15 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_16_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_actor_type_actor_id_idx ON public.events_2026_02_16 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_16 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_16_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_causation_id_idx ON public.events_2026_02_16 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_16_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_correlation_id_idx ON public.events_2026_02_16 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_16_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_event_type_timestamp_idx ON public.events_2026_02_16 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_16_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_impact_idx ON public.events_2026_02_16 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_16_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_severity_idx ON public.events_2026_02_16 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_16_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_16_timestamp_idx ON public.events_2026_02_16 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_17_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_actor_type_actor_id_idx ON public.events_2026_02_17 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_17 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_17_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_causation_id_idx ON public.events_2026_02_17 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_17_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_correlation_id_idx ON public.events_2026_02_17 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_17_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_event_type_timestamp_idx ON public.events_2026_02_17 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_17_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_impact_idx ON public.events_2026_02_17 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_17_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_severity_idx ON public.events_2026_02_17 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_17_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_17_timestamp_idx ON public.events_2026_02_17 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_22_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_actor_type_actor_id_idx ON public.events_2026_02_22 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_22 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_22_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_causation_id_idx ON public.events_2026_02_22 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_22_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_correlation_id_idx ON public.events_2026_02_22 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_22_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_event_type_timestamp_idx ON public.events_2026_02_22 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_22_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_impact_idx ON public.events_2026_02_22 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_22_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_severity_idx ON public.events_2026_02_22 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_22_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_22_timestamp_idx ON public.events_2026_02_22 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_23_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_actor_type_actor_id_idx ON public.events_2026_02_23 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_23 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_23_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_causation_id_idx ON public.events_2026_02_23 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_23_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_correlation_id_idx ON public.events_2026_02_23 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_23_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_event_type_timestamp_idx ON public.events_2026_02_23 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_23_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_impact_idx ON public.events_2026_02_23 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_23_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_severity_idx ON public.events_2026_02_23 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_23_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_23_timestamp_idx ON public.events_2026_02_23 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_24_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_actor_type_actor_id_idx ON public.events_2026_02_24 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_24 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_24_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_causation_id_idx ON public.events_2026_02_24 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_24_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_correlation_id_idx ON public.events_2026_02_24 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_24_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_event_type_timestamp_idx ON public.events_2026_02_24 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_24_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_impact_idx ON public.events_2026_02_24 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_24_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_severity_idx ON public.events_2026_02_24 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_24_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_24_timestamp_idx ON public.events_2026_02_24 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_25_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_actor_type_actor_id_idx ON public.events_2026_02_25 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_25 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_25_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_causation_id_idx ON public.events_2026_02_25 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_25_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_correlation_id_idx ON public.events_2026_02_25 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_25_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_event_type_timestamp_idx ON public.events_2026_02_25 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_25_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_impact_idx ON public.events_2026_02_25 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_25_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_severity_idx ON public.events_2026_02_25 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_25_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_25_timestamp_idx ON public.events_2026_02_25 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_26_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_actor_type_actor_id_idx ON public.events_2026_02_26 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_26_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_26 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_26_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_causation_id_idx ON public.events_2026_02_26 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_26_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_correlation_id_idx ON public.events_2026_02_26 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_26_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_event_type_timestamp_idx ON public.events_2026_02_26 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_26_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_impact_idx ON public.events_2026_02_26 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_26_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_severity_idx ON public.events_2026_02_26 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_26_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_26_timestamp_idx ON public.events_2026_02_26 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_27_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_actor_type_actor_id_idx ON public.events_2026_02_27 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_27_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_27 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_27_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_causation_id_idx ON public.events_2026_02_27 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_27_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_correlation_id_idx ON public.events_2026_02_27 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_27_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_event_type_timestamp_idx ON public.events_2026_02_27 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_27_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_impact_idx ON public.events_2026_02_27 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_27_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_severity_idx ON public.events_2026_02_27 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_27_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_27_timestamp_idx ON public.events_2026_02_27 USING btree ("timestamp" DESC);


--
-- Name: events_2026_02_28_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_actor_type_actor_id_idx ON public.events_2026_02_28 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_02_28_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_02_28 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_02_28_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_causation_id_idx ON public.events_2026_02_28 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_02_28_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_correlation_id_idx ON public.events_2026_02_28 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_02_28_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_event_type_timestamp_idx ON public.events_2026_02_28 USING btree (event_type, "timestamp");


--
-- Name: events_2026_02_28_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_impact_idx ON public.events_2026_02_28 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_02_28_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_severity_idx ON public.events_2026_02_28 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_02_28_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_02_28_timestamp_idx ON public.events_2026_02_28 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_01_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_actor_type_actor_id_idx ON public.events_2026_03_01 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_01_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_01 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_01_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_causation_id_idx ON public.events_2026_03_01 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_01_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_correlation_id_idx ON public.events_2026_03_01 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_01_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_event_type_timestamp_idx ON public.events_2026_03_01 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_01_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_impact_idx ON public.events_2026_03_01 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_01_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_severity_idx ON public.events_2026_03_01 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_01_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_01_timestamp_idx ON public.events_2026_03_01 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_02_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_actor_type_actor_id_idx ON public.events_2026_03_02 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_02_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_02 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_02_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_causation_id_idx ON public.events_2026_03_02 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_02_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_correlation_id_idx ON public.events_2026_03_02 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_02_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_event_type_timestamp_idx ON public.events_2026_03_02 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_02_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_impact_idx ON public.events_2026_03_02 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_02_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_severity_idx ON public.events_2026_03_02 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_02_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_02_timestamp_idx ON public.events_2026_03_02 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_03_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_actor_type_actor_id_idx ON public.events_2026_03_03 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_03_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_03 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_03_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_causation_id_idx ON public.events_2026_03_03 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_03_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_correlation_id_idx ON public.events_2026_03_03 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_03_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_event_type_timestamp_idx ON public.events_2026_03_03 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_03_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_impact_idx ON public.events_2026_03_03 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_03_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_severity_idx ON public.events_2026_03_03 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_03_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_03_timestamp_idx ON public.events_2026_03_03 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_04_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_actor_type_actor_id_idx ON public.events_2026_03_04 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_04_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_04 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_04_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_causation_id_idx ON public.events_2026_03_04 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_04_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_correlation_id_idx ON public.events_2026_03_04 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_04_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_event_type_timestamp_idx ON public.events_2026_03_04 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_04_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_impact_idx ON public.events_2026_03_04 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_04_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_severity_idx ON public.events_2026_03_04 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_04_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_04_timestamp_idx ON public.events_2026_03_04 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_05_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_actor_type_actor_id_idx ON public.events_2026_03_05 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_05_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_05 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_05_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_causation_id_idx ON public.events_2026_03_05 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_05_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_correlation_id_idx ON public.events_2026_03_05 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_05_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_event_type_timestamp_idx ON public.events_2026_03_05 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_05_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_impact_idx ON public.events_2026_03_05 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_05_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_severity_idx ON public.events_2026_03_05 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_05_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_05_timestamp_idx ON public.events_2026_03_05 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_06_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_actor_type_actor_id_idx ON public.events_2026_03_06 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_06_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_06 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_06_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_causation_id_idx ON public.events_2026_03_06 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_06_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_correlation_id_idx ON public.events_2026_03_06 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_06_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_event_type_timestamp_idx ON public.events_2026_03_06 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_06_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_impact_idx ON public.events_2026_03_06 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_06_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_severity_idx ON public.events_2026_03_06 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_06_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_06_timestamp_idx ON public.events_2026_03_06 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_07_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_actor_type_actor_id_idx ON public.events_2026_03_07 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_07_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_07 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_07_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_causation_id_idx ON public.events_2026_03_07 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_07_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_correlation_id_idx ON public.events_2026_03_07 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_07_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_event_type_timestamp_idx ON public.events_2026_03_07 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_07_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_impact_idx ON public.events_2026_03_07 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_07_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_severity_idx ON public.events_2026_03_07 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_07_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_07_timestamp_idx ON public.events_2026_03_07 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_08_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_actor_type_actor_id_idx ON public.events_2026_03_08 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_08_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_08 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_08_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_causation_id_idx ON public.events_2026_03_08 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_08_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_correlation_id_idx ON public.events_2026_03_08 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_08_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_event_type_timestamp_idx ON public.events_2026_03_08 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_08_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_impact_idx ON public.events_2026_03_08 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_08_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_severity_idx ON public.events_2026_03_08 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_08_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_08_timestamp_idx ON public.events_2026_03_08 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_09_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_actor_type_actor_id_idx ON public.events_2026_03_09 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_09_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_09 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_09_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_causation_id_idx ON public.events_2026_03_09 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_09_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_correlation_id_idx ON public.events_2026_03_09 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_09_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_event_type_timestamp_idx ON public.events_2026_03_09 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_09_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_impact_idx ON public.events_2026_03_09 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_09_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_severity_idx ON public.events_2026_03_09 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_09_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_09_timestamp_idx ON public.events_2026_03_09 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_10_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_actor_type_actor_id_idx ON public.events_2026_03_10 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_10_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_10 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_10_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_causation_id_idx ON public.events_2026_03_10 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_10_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_correlation_id_idx ON public.events_2026_03_10 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_10_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_event_type_timestamp_idx ON public.events_2026_03_10 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_10_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_impact_idx ON public.events_2026_03_10 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_10_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_severity_idx ON public.events_2026_03_10 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_10_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_10_timestamp_idx ON public.events_2026_03_10 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_11_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_actor_type_actor_id_idx ON public.events_2026_03_11 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_11 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_11_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_causation_id_idx ON public.events_2026_03_11 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_11_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_correlation_id_idx ON public.events_2026_03_11 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_11_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_event_type_timestamp_idx ON public.events_2026_03_11 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_11_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_impact_idx ON public.events_2026_03_11 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_11_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_severity_idx ON public.events_2026_03_11 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_11_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_11_timestamp_idx ON public.events_2026_03_11 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_12_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_actor_type_actor_id_idx ON public.events_2026_03_12 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_12 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_12_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_causation_id_idx ON public.events_2026_03_12 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_12_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_correlation_id_idx ON public.events_2026_03_12 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_12_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_event_type_timestamp_idx ON public.events_2026_03_12 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_12_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_impact_idx ON public.events_2026_03_12 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_12_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_severity_idx ON public.events_2026_03_12 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_12_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_12_timestamp_idx ON public.events_2026_03_12 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_13_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_actor_type_actor_id_idx ON public.events_2026_03_13 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_13 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_13_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_causation_id_idx ON public.events_2026_03_13 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_13_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_correlation_id_idx ON public.events_2026_03_13 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_13_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_event_type_timestamp_idx ON public.events_2026_03_13 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_13_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_impact_idx ON public.events_2026_03_13 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_13_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_severity_idx ON public.events_2026_03_13 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_13_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_13_timestamp_idx ON public.events_2026_03_13 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_14_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_actor_type_actor_id_idx ON public.events_2026_03_14 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_14 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_14_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_causation_id_idx ON public.events_2026_03_14 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_14_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_correlation_id_idx ON public.events_2026_03_14 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_14_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_event_type_timestamp_idx ON public.events_2026_03_14 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_14_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_impact_idx ON public.events_2026_03_14 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_14_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_severity_idx ON public.events_2026_03_14 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_14_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_14_timestamp_idx ON public.events_2026_03_14 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_15_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_actor_type_actor_id_idx ON public.events_2026_03_15 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_15 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_15_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_causation_id_idx ON public.events_2026_03_15 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_15_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_correlation_id_idx ON public.events_2026_03_15 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_15_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_event_type_timestamp_idx ON public.events_2026_03_15 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_15_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_impact_idx ON public.events_2026_03_15 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_15_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_severity_idx ON public.events_2026_03_15 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_15_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_15_timestamp_idx ON public.events_2026_03_15 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_16_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_actor_type_actor_id_idx ON public.events_2026_03_16 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_16 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_16_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_causation_id_idx ON public.events_2026_03_16 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_16_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_correlation_id_idx ON public.events_2026_03_16 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_16_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_event_type_timestamp_idx ON public.events_2026_03_16 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_16_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_impact_idx ON public.events_2026_03_16 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_16_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_severity_idx ON public.events_2026_03_16 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_16_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_16_timestamp_idx ON public.events_2026_03_16 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_17_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_actor_type_actor_id_idx ON public.events_2026_03_17 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_17 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_17_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_causation_id_idx ON public.events_2026_03_17 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_17_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_correlation_id_idx ON public.events_2026_03_17 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_17_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_event_type_timestamp_idx ON public.events_2026_03_17 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_17_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_impact_idx ON public.events_2026_03_17 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_17_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_severity_idx ON public.events_2026_03_17 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_17_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_17_timestamp_idx ON public.events_2026_03_17 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_18_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_actor_type_actor_id_idx ON public.events_2026_03_18 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_18_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_18 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_18_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_causation_id_idx ON public.events_2026_03_18 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_18_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_correlation_id_idx ON public.events_2026_03_18 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_18_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_event_type_timestamp_idx ON public.events_2026_03_18 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_18_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_impact_idx ON public.events_2026_03_18 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_18_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_severity_idx ON public.events_2026_03_18 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_18_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_18_timestamp_idx ON public.events_2026_03_18 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_19_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_actor_type_actor_id_idx ON public.events_2026_03_19 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_19_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_19 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_19_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_causation_id_idx ON public.events_2026_03_19 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_19_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_correlation_id_idx ON public.events_2026_03_19 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_19_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_event_type_timestamp_idx ON public.events_2026_03_19 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_19_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_impact_idx ON public.events_2026_03_19 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_19_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_severity_idx ON public.events_2026_03_19 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_19_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_19_timestamp_idx ON public.events_2026_03_19 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_20_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_actor_type_actor_id_idx ON public.events_2026_03_20 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_20_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_20 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_20_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_causation_id_idx ON public.events_2026_03_20 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_20_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_correlation_id_idx ON public.events_2026_03_20 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_20_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_event_type_timestamp_idx ON public.events_2026_03_20 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_20_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_impact_idx ON public.events_2026_03_20 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_20_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_severity_idx ON public.events_2026_03_20 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_20_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_20_timestamp_idx ON public.events_2026_03_20 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_21_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_actor_type_actor_id_idx ON public.events_2026_03_21 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_21_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_21 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_21_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_causation_id_idx ON public.events_2026_03_21 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_21_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_correlation_id_idx ON public.events_2026_03_21 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_21_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_event_type_timestamp_idx ON public.events_2026_03_21 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_21_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_impact_idx ON public.events_2026_03_21 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_21_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_severity_idx ON public.events_2026_03_21 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_21_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_21_timestamp_idx ON public.events_2026_03_21 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_22_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_actor_type_actor_id_idx ON public.events_2026_03_22 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_22 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_22_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_causation_id_idx ON public.events_2026_03_22 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_22_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_correlation_id_idx ON public.events_2026_03_22 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_22_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_event_type_timestamp_idx ON public.events_2026_03_22 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_22_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_impact_idx ON public.events_2026_03_22 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_22_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_severity_idx ON public.events_2026_03_22 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_22_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_22_timestamp_idx ON public.events_2026_03_22 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_23_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_actor_type_actor_id_idx ON public.events_2026_03_23 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_23 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_23_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_causation_id_idx ON public.events_2026_03_23 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_23_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_correlation_id_idx ON public.events_2026_03_23 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_23_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_event_type_timestamp_idx ON public.events_2026_03_23 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_23_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_impact_idx ON public.events_2026_03_23 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_23_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_severity_idx ON public.events_2026_03_23 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_23_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_23_timestamp_idx ON public.events_2026_03_23 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_24_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_actor_type_actor_id_idx ON public.events_2026_03_24 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_24 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_24_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_causation_id_idx ON public.events_2026_03_24 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_24_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_correlation_id_idx ON public.events_2026_03_24 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_24_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_event_type_timestamp_idx ON public.events_2026_03_24 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_24_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_impact_idx ON public.events_2026_03_24 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_24_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_severity_idx ON public.events_2026_03_24 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_24_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_24_timestamp_idx ON public.events_2026_03_24 USING btree ("timestamp" DESC);


--
-- Name: events_2026_03_25_actor_type_actor_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_actor_type_actor_id_idx ON public.events_2026_03_25 USING btree (actor_type, actor_id) WHERE (actor_type IS NOT NULL);


--
-- Name: events_2026_03_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_aggregate_type_aggregate_id_timestamp_idx ON public.events_2026_03_25 USING btree (aggregate_type, aggregate_id, "timestamp");


--
-- Name: events_2026_03_25_causation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_causation_id_idx ON public.events_2026_03_25 USING btree (causation_id) WHERE (causation_id IS NOT NULL);


--
-- Name: events_2026_03_25_correlation_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_correlation_id_idx ON public.events_2026_03_25 USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: events_2026_03_25_event_type_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_event_type_timestamp_idx ON public.events_2026_03_25 USING btree (event_type, "timestamp");


--
-- Name: events_2026_03_25_impact_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_impact_idx ON public.events_2026_03_25 USING btree (impact) WHERE (impact IS NOT NULL);


--
-- Name: events_2026_03_25_severity_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_severity_idx ON public.events_2026_03_25 USING btree (severity) WHERE (severity IS NOT NULL);


--
-- Name: events_2026_03_25_timestamp_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX events_2026_03_25_timestamp_idx ON public.events_2026_03_25 USING btree ("timestamp" DESC);


--
-- Name: idx_agent_updates_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_updates_created_at ON public.agent_updates USING btree (created_at DESC);


--
-- Name: idx_agent_updates_device_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_updates_device_status ON public.agent_updates USING btree (device_uuid, status);


--
-- Name: idx_agent_updates_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_updates_device_uuid ON public.agent_updates USING btree (device_uuid);


--
-- Name: idx_agent_updates_scheduled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_updates_scheduled ON public.agent_updates USING btree (scheduled_time) WHERE (scheduled_time IS NOT NULL);


--
-- Name: idx_agent_updates_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_updates_status ON public.agent_updates USING btree (status);


--
-- Name: idx_alert_rules_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alert_rules_device ON public.log_alert_rules USING btree (device_uuid);


--
-- Name: idx_alert_rules_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alert_rules_enabled ON public.log_alert_rules USING btree (is_enabled);


--
-- Name: idx_alert_rules_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alert_rules_severity ON public.log_alert_rules USING btree (severity);


--
-- Name: idx_alerts_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_created_at ON public.log_alerts USING btree (created_at DESC);


--
-- Name: idx_alerts_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_device ON public.log_alerts USING btree (device_uuid);


--
-- Name: idx_alerts_first_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_first_seen ON public.log_alerts USING btree (first_seen DESC);


--
-- Name: idx_alerts_last_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_last_seen ON public.log_alerts USING btree (last_seen DESC);


--
-- Name: idx_alerts_rule; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_rule ON public.log_alerts USING btree (rule_id);


--
-- Name: idx_alerts_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_severity ON public.log_alerts USING btree (severity);


--
-- Name: idx_alerts_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_alerts_status ON public.log_alerts USING btree (status);


--
-- Name: idx_anomaly_alerts_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_alerts_created_at ON public.anomaly_alerts USING btree (created_at);


--
-- Name: idx_anomaly_alerts_incident_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_alerts_incident_id ON public.anomaly_alerts USING btree (incident_id);


--
-- Name: idx_anomaly_alerts_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_alerts_severity ON public.anomaly_alerts USING btree (severity);


--
-- Name: idx_anomaly_events_agent_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_agent_uuid ON public.anomaly_events USING btree (agent_uuid, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_device_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_device_name ON public.anomaly_events USING btree (device_name, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_device_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_device_type ON public.anomaly_events USING btree (device_type, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_fingerprint; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_fingerprint ON public.anomaly_events USING btree (fingerprint, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_metric; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_metric ON public.anomaly_events USING btree (metric, timestamp_ms DESC);


--
-- Name: idx_anomaly_events_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_events_severity ON public.anomaly_events USING btree (severity, timestamp_ms DESC);


--
-- Name: idx_anomaly_incidents_acknowledged_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_acknowledged_at ON public.anomaly_incidents USING btree (acknowledged_at);


--
-- Name: idx_anomaly_incidents_device_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_device_name ON public.anomaly_incidents USING btree (device_name);


--
-- Name: idx_anomaly_incidents_feedback; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_feedback ON public.anomaly_incidents USING btree (feedback) WHERE (feedback IS NOT NULL);


--
-- Name: idx_anomaly_incidents_feedback_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_feedback_at ON public.anomaly_incidents USING btree (feedback_at DESC) WHERE (feedback_at IS NOT NULL);


--
-- Name: idx_anomaly_incidents_fingerprint; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_fingerprint ON public.anomaly_incidents USING btree (fingerprint);


--
-- Name: idx_anomaly_incidents_last_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_last_seen ON public.anomaly_incidents USING btree (last_seen);


--
-- Name: idx_anomaly_incidents_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_severity ON public.anomaly_incidents USING btree (severity);


--
-- Name: idx_anomaly_incidents_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_anomaly_incidents_status ON public.anomaly_incidents USING btree (status);


--
-- Name: idx_app_service_ids_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_app_service_ids_name ON public.app_service_ids USING btree (entity_name);


--
-- Name: idx_app_service_ids_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_app_service_ids_type ON public.app_service_ids USING btree (entity_type);


--
-- Name: idx_app_service_ids_type_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_app_service_ids_type_id ON public.app_service_ids USING btree (entity_type, entity_id);


--
-- Name: idx_applications_app_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_applications_app_name ON public.applications USING btree (app_name);


--
-- Name: idx_applications_slug; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_applications_slug ON public.applications USING btree (slug);


--
-- Name: idx_approval_requests_image_tag; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_approval_requests_image_tag ON public.image_approval_requests USING btree (image_id, tag_name) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_approval_requests_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_approval_requests_status ON public.image_approval_requests USING btree (status);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_created_at ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_logs_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_device_uuid ON public.audit_logs USING btree (device_uuid);


--
-- Name: idx_audit_logs_event_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_event_type ON public.audit_logs USING btree (event_type);


--
-- Name: idx_audit_logs_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_severity ON public.audit_logs USING btree (severity);


--
-- Name: idx_audit_logs_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_logs_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_dashboard_layouts_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_device ON public.dashboard_layouts USING btree (device_uuid);


--
-- Name: idx_dashboard_layouts_global; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_global ON public.dashboard_layouts USING btree (user_id) WHERE (device_uuid IS NULL);


--
-- Name: idx_dashboard_layouts_one_default; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_dashboard_layouts_one_default ON public.dashboard_layouts USING btree (user_id, COALESCE((device_uuid)::text, 'global'::text)) WHERE (is_default = true);


--
-- Name: idx_dashboard_layouts_share_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_share_token ON public.dashboard_layouts USING btree (share_token);


--
-- Name: idx_dashboard_layouts_unique_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_dashboard_layouts_unique_name ON public.dashboard_layouts USING btree (user_id, COALESCE((device_uuid)::text, 'global'::text), layout_name);


--
-- Name: idx_dashboard_layouts_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_user ON public.dashboard_layouts USING btree (user_id);


--
-- Name: idx_dashboard_layouts_user_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_user_device ON public.dashboard_layouts USING btree (user_id, device_uuid) WHERE (device_uuid IS NOT NULL);


--
-- Name: idx_dashboard_layouts_widgets; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dashboard_layouts_widgets ON public.dashboard_layouts USING gin (widgets);


--
-- Name: idx_device_api_keys_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_api_keys_device_uuid ON public.device_api_keys USING btree (device_uuid);


--
-- Name: idx_device_api_keys_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_api_keys_expires_at ON public.device_api_keys USING btree (expires_at);


--
-- Name: idx_device_api_keys_revoked; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_api_keys_revoked ON public.device_api_keys USING btree (revoked);


--
-- Name: idx_device_batch; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_batch ON public.device_rollout_status USING btree (batch_number);


--
-- Name: idx_device_current_state_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_current_state_device_uuid ON public.device_current_state USING btree (device_uuid);


--
-- Name: idx_device_current_state_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_current_state_version ON public.device_current_state USING btree (version);


--
-- Name: idx_device_flows_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_flows_active ON public.device_flows USING btree (is_active);


--
-- Name: idx_device_flows_deployed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_flows_deployed_at ON public.device_flows USING btree (deployed_at);


--
-- Name: idx_device_flows_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_flows_device_uuid ON public.device_flows USING btree (device_uuid);


--
-- Name: idx_device_flows_hash; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_flows_hash ON public.device_flows USING btree (hash);


--
-- Name: idx_device_flows_subflow_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_flows_subflow_id ON public.device_flows USING btree (subflow_id);


--
-- Name: idx_device_job_status_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_job_status_device_uuid ON public.device_job_status USING btree (device_uuid);


--
-- Name: idx_device_job_status_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_job_status_job_id ON public.device_job_status USING btree (job_id);


--
-- Name: idx_device_job_status_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_job_status_status ON public.device_job_status USING btree (status);


--
-- Name: idx_device_key_history_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_key_history_device_uuid ON public.device_api_key_history USING btree (device_uuid);


--
-- Name: idx_device_key_history_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_key_history_is_active ON public.device_api_key_history USING btree (is_active);


--
-- Name: idx_device_key_history_issued_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_key_history_issued_at ON public.device_api_key_history USING btree (issued_at DESC);


--
-- Name: idx_device_logs_device_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_device_timestamp ON public.device_logs USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_device_logs_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_device_uuid ON public.device_logs USING btree (device_uuid);


--
-- Name: idx_device_logs_error_logs; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_error_logs ON public.device_logs USING btree (device_uuid, is_stderr) WHERE (is_stderr = true);


--
-- Name: idx_device_logs_level; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_level ON public.device_logs USING btree (level);


--
-- Name: idx_device_logs_service; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_service ON public.device_logs USING btree (device_uuid, service_name, "timestamp" DESC);


--
-- Name: idx_device_logs_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_logs_timestamp ON public.device_logs USING btree ("timestamp" DESC);


--
-- Name: idx_device_metrics_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_metrics_device_time ON public.device_metrics USING btree (device_uuid, recorded_at DESC);


--
-- Name: idx_device_metrics_recorded_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_metrics_recorded_at ON public.device_metrics USING btree (recorded_at DESC);


--
-- Name: idx_device_rollout; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_rollout ON public.device_rollout_status USING btree (rollout_id, device_uuid);


--
-- Name: idx_device_sensors_config_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_config_id ON public.device_sensors USING btree (config_id);


--
-- Name: idx_device_sensors_deployment_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_deployment_status ON public.device_sensors USING btree (deployment_status);


--
-- Name: idx_device_sensors_device_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_device_protocol ON public.device_sensors USING btree (device_uuid, protocol);


--
-- Name: idx_device_sensors_device_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_device_status ON public.device_sensors USING btree (device_uuid, deployment_status);


--
-- Name: idx_device_sensors_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_device_uuid ON public.device_sensors USING btree (device_uuid);


--
-- Name: idx_device_sensors_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_enabled ON public.device_sensors USING btree (enabled);


--
-- Name: idx_device_sensors_health_dashboard; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_health_dashboard ON public.device_sensors USING btree (device_uuid, protocol, health_status) WHERE (health_status IS NOT NULL);


--
-- Name: idx_device_sensors_health_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_health_status ON public.device_sensors USING btree (health_status) WHERE (health_status IS NOT NULL);


--
-- Name: idx_device_sensors_health_updated; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_health_updated ON public.device_sensors USING btree (device_uuid, health_updated_at DESC) WHERE (health_updated_at IS NOT NULL);


--
-- Name: idx_device_sensors_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_location ON public.device_sensors USING btree (location) WHERE (location IS NOT NULL);


--
-- Name: idx_device_sensors_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_protocol ON public.device_sensors USING btree (protocol);


--
-- Name: idx_device_sensors_sync; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_sync ON public.device_sensors USING btree (synced_to_config);


--
-- Name: idx_device_sensors_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_sensors_uuid ON public.device_sensors USING btree (uuid);


--
-- Name: idx_device_services_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_services_device_uuid ON public.device_services USING btree (device_uuid);


--
-- Name: idx_device_shadows_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_shadows_device_uuid ON public.device_shadows USING btree (device_uuid);


--
-- Name: idx_device_shadows_updated_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_shadows_updated_at ON public.device_shadows USING btree (updated_at DESC);


--
-- Name: idx_device_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_status ON public.device_rollout_status USING btree (status);


--
-- Name: idx_device_tags_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_tags_device_uuid ON public.device_tags USING btree (device_uuid);


--
-- Name: idx_device_tags_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_tags_key ON public.device_tags USING btree (key);


--
-- Name: idx_device_tags_key_value; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_tags_key_value ON public.device_tags USING btree (key, value);


--
-- Name: idx_device_target_state_deployed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_target_state_deployed_at ON public.device_target_state USING btree (last_deployed_at DESC);


--
-- Name: idx_device_target_state_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_target_state_device_uuid ON public.device_target_state USING btree (device_uuid);


--
-- Name: idx_device_target_state_needs_deployment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_device_target_state_needs_deployment ON public.device_target_state USING btree (needs_deployment) WHERE (needs_deployment = true);


--
-- Name: idx_devices_api_key_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_api_key_expires_at ON public.devices USING btree (api_key_expires_at) WHERE ((api_key_expires_at IS NOT NULL) AND (is_active = true));


--
-- Name: idx_devices_challenge_expires; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_challenge_expires ON public.devices USING btree (last_challenge_expires_at) WHERE (last_challenge_expires_at IS NOT NULL);


--
-- Name: idx_devices_fleet_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_fleet_id ON public.devices USING btree (fleet_id);


--
-- Name: idx_devices_fleet_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_fleet_uuid ON public.devices USING btree (fleet_uuid);


--
-- Name: idx_devices_fleet_uuid_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_fleet_uuid_status ON public.devices USING btree (fleet_uuid, is_online, is_active) WHERE (fleet_uuid IS NOT NULL);


--
-- Name: idx_devices_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_is_active ON public.devices USING btree (is_active);


--
-- Name: idx_devices_is_online; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_is_online ON public.devices USING btree (is_online);


--
-- Name: idx_devices_k8s_namespace; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_k8s_namespace ON public.devices USING btree (k8s_namespace) WHERE (k8s_namespace IS NOT NULL);


--
-- Name: idx_devices_last_auth_method; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_last_auth_method ON public.devices USING btree (last_auth_method) WHERE (((last_auth_method)::text = 'bcrypt'::text) AND (is_active = true));


--
-- Name: idx_devices_last_auth_pop; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_last_auth_pop ON public.devices USING btree (last_auth_method, last_auth_at) WHERE (((last_auth_method)::text = 'pop'::text) AND (is_active = true));


--
-- Name: idx_devices_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_location ON public.devices USING btree (location) WHERE (location IS NOT NULL);


--
-- Name: idx_devices_mqtt_broker_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_mqtt_broker_id ON public.devices USING btree (mqtt_broker_id);


--
-- Name: idx_devices_mqtt_username; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_mqtt_username ON public.devices USING btree (mqtt_username);


--
-- Name: idx_devices_network_interfaces; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_network_interfaces ON public.devices USING gin (network_interfaces);


--
-- Name: idx_devices_pop_verified; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_pop_verified ON public.devices USING btree (pop_verified) WHERE (pop_verified = false);


--
-- Name: idx_devices_top_processes; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_top_processes ON public.devices USING gin (top_processes);


--
-- Name: idx_devices_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_uuid ON public.devices USING btree (uuid);


--
-- Name: idx_devices_virtual_deployment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_virtual_deployment ON public.devices USING btree (device_type, deployment_status) WHERE ((device_type)::text = 'virtual'::text);


--
-- Name: idx_devices_virtual_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_virtual_status ON public.devices USING btree (device_type, deployment_status, status) WHERE ((device_type)::text = 'virtual'::text);


--
-- Name: idx_devices_vpn_config; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_vpn_config ON public.devices USING btree (vpn_config_id);


--
-- Name: idx_devices_vpn_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_vpn_enabled ON public.devices USING btree (vpn_enabled) WHERE (vpn_enabled = true);


--
-- Name: idx_devices_vpn_username; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_devices_vpn_username ON public.devices USING btree (vpn_username) WHERE (vpn_username IS NOT NULL);


--
-- Name: idx_dictionary_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dictionary_device ON public.dictionary_entries USING btree (device_uuid);


--
-- Name: idx_dictionary_meta_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dictionary_meta_version ON public.dictionary_metadata USING btree (device_uuid, current_version);


--
-- Name: idx_dictionary_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dictionary_version ON public.dictionary_entries USING btree (device_uuid, version_added);


--
-- Name: idx_email_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_email_logs_created_at ON public.email_logs USING btree (created_at);


--
-- Name: idx_email_logs_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_email_logs_job_id ON public.email_logs USING btree (job_id);


--
-- Name: idx_email_logs_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_email_logs_status ON public.email_logs USING btree (status);


--
-- Name: idx_email_logs_template_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_email_logs_template_name ON public.email_logs USING btree (template_name);


--
-- Name: idx_email_logs_user_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_email_logs_user_email ON public.email_logs USING btree (user_email);


--
-- Name: idx_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enabled ON public.image_update_policies USING btree (enabled);


--
-- Name: idx_endpoint_devices_agent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_agent ON public.endpoint_devices USING btree (agent_uuid);


--
-- Name: idx_endpoint_devices_agent_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_agent_location ON public.endpoint_devices USING btree (agent_location) WHERE (agent_location IS NOT NULL);


--
-- Name: idx_endpoint_devices_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_device ON public.endpoint_devices USING btree (device_name);


--
-- Name: idx_endpoint_devices_device_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_device_location ON public.endpoint_devices USING btree (device_location) WHERE (device_location IS NOT NULL);


--
-- Name: idx_endpoint_devices_last_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_last_seen ON public.endpoint_devices USING btree (last_seen DESC);


--
-- Name: idx_endpoint_devices_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_endpoint_devices_protocol ON public.endpoint_devices USING btree (protocol);


--
-- Name: idx_endpoint_devices_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_endpoint_devices_unique ON public.endpoint_devices USING btree (agent_uuid, device_name, protocol);


--
-- Name: idx_enum_devices_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_devices_active ON public.dictionary_enum_devices USING btree (device_uuid, protocol, inactive);


--
-- Name: idx_enum_devices_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_devices_device ON public.dictionary_enum_devices USING btree (device_uuid);


--
-- Name: idx_enum_devices_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_devices_index ON public.dictionary_enum_devices USING btree (device_uuid, protocol, enum_index);


--
-- Name: idx_enum_devices_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_devices_protocol ON public.dictionary_enum_devices USING btree (device_uuid, protocol);


--
-- Name: idx_enum_metrics_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_metrics_active ON public.dictionary_enum_metrics USING btree (device_uuid, protocol, inactive);


--
-- Name: idx_enum_metrics_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_metrics_device ON public.dictionary_enum_metrics USING btree (device_uuid);


--
-- Name: idx_enum_metrics_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_metrics_index ON public.dictionary_enum_metrics USING btree (device_uuid, protocol, enum_index);


--
-- Name: idx_enum_metrics_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_metrics_protocol ON public.dictionary_enum_metrics USING btree (device_uuid, protocol);


--
-- Name: idx_enum_observations_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_observations_category ON public.dictionary_enum_observations USING btree (device_uuid, category);


--
-- Name: idx_enum_observations_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_observations_device ON public.dictionary_enum_observations USING btree (device_uuid);


--
-- Name: idx_enum_observations_namespace; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_observations_namespace ON public.dictionary_enum_observations USING btree (device_uuid, namespace);


--
-- Name: idx_enum_observations_promoted; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_observations_promoted ON public.dictionary_enum_observations USING btree (device_uuid, category, is_promoted);


--
-- Name: idx_enum_quality_codes_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_quality_codes_active ON public.dictionary_enum_quality_codes USING btree (device_uuid, inactive);


--
-- Name: idx_enum_quality_codes_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_quality_codes_device ON public.dictionary_enum_quality_codes USING btree (device_uuid);


--
-- Name: idx_enum_quality_codes_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_quality_codes_index ON public.dictionary_enum_quality_codes USING btree (device_uuid, enum_index);


--
-- Name: idx_enum_units_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_units_active ON public.dictionary_enum_units USING btree (device_uuid, inactive);


--
-- Name: idx_enum_units_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_units_device ON public.dictionary_enum_units USING btree (device_uuid);


--
-- Name: idx_enum_units_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_enum_units_index ON public.dictionary_enum_units USING btree (device_uuid, enum_index);


--
-- Name: idx_fleet_billing_history_fleet; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_billing_history_fleet ON public.fleet_billing_history USING btree (fleet_id);


--
-- Name: idx_fleet_billing_history_invoice; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_billing_history_invoice ON public.fleet_billing_history USING btree (invoice_status) WHERE ((invoice_status)::text = 'pending'::text);


--
-- Name: idx_fleet_billing_history_month; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_billing_history_month ON public.fleet_billing_history USING btree (billing_month);


--
-- Name: idx_fleet_billing_history_period; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_billing_history_period ON public.fleet_billing_history USING btree (period_start, period_end);


--
-- Name: idx_fleet_namespaces_available_utilization; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_namespaces_available_utilization ON public.fleet_namespaces USING btree (available, utilization_percent) WHERE (available = true);


--
-- Name: idx_fleet_namespaces_last_synced; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_namespaces_last_synced ON public.fleet_namespaces USING btree (last_synced DESC);


--
-- Name: idx_fleet_usage_events_fleet; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_usage_events_fleet ON public.fleet_usage_events USING btree (fleet_id);


--
-- Name: idx_fleet_usage_events_fleet_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_usage_events_fleet_type ON public.fleet_usage_events USING btree (fleet_id, event_type);


--
-- Name: idx_fleet_usage_events_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_usage_events_timestamp ON public.fleet_usage_events USING btree (event_timestamp DESC);


--
-- Name: idx_fleet_usage_events_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleet_usage_events_type ON public.fleet_usage_events USING btree (event_type);


--
-- Name: idx_fleets_billing; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_billing ON public.fleets USING btree (customer_id, billing_enabled) WHERE (billing_enabled = true);


--
-- Name: idx_fleets_customer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_customer ON public.fleets USING btree (customer_id);


--
-- Name: idx_fleets_environment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_environment ON public.fleets USING btree (customer_id, environment);


--
-- Name: idx_fleets_fleet_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_fleet_id ON public.fleets USING btree (fleet_id);


--
-- Name: idx_fleets_fleet_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_fleets_fleet_uuid ON public.fleets USING btree (fleet_uuid);


--
-- Name: idx_fleets_k8s_namespace; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_k8s_namespace ON public.fleets USING btree (k8s_namespace) WHERE (k8s_namespace IS NOT NULL);


--
-- Name: idx_fleets_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_status ON public.fleets USING btree (customer_id, status);


--
-- Name: idx_fleets_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fleets_type ON public.fleets USING btree (fleet_type);


--
-- Name: idx_housekeeper_runs_started_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_housekeeper_runs_started_at ON public.housekeeper_runs USING btree (started_at DESC);


--
-- Name: idx_housekeeper_runs_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_housekeeper_runs_status ON public.housekeeper_runs USING btree (status);


--
-- Name: idx_housekeeper_runs_task_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_housekeeper_runs_task_name ON public.housekeeper_runs USING btree (task_name);


--
-- Name: idx_image_pattern; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_image_pattern ON public.image_update_policies USING btree (image_pattern);


--
-- Name: idx_image_tags_image_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_image_tags_image_id ON public.image_tags USING btree (image_id);


--
-- Name: idx_image_tags_last_updated; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_image_tags_last_updated ON public.image_tags USING btree (last_updated DESC);


--
-- Name: idx_image_tags_metadata; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_image_tags_metadata ON public.image_tags USING gin (metadata);


--
-- Name: idx_image_tags_tag; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_image_tags_tag ON public.image_tags USING btree (tag);


--
-- Name: idx_images_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_images_name ON public.images USING btree (image_name);


--
-- Name: idx_images_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_images_status ON public.images USING btree (approval_status);


--
-- Name: idx_images_watch_updates; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_images_watch_updates ON public.images USING btree (watch_for_updates, approval_status) WHERE ((watch_for_updates = true) AND ((approval_status)::text = 'approved'::text));


--
-- Name: idx_job_executions_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_executions_created_at ON public.job_executions USING btree (created_at DESC);


--
-- Name: idx_job_executions_job_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_executions_job_id ON public.job_executions USING btree (job_id);


--
-- Name: idx_job_executions_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_executions_status ON public.job_executions USING btree (status);


--
-- Name: idx_job_templates_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_templates_category ON public.job_templates USING btree (category);


--
-- Name: idx_job_templates_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_job_templates_is_active ON public.job_templates USING btree (is_active);


--
-- Name: idx_latest_readings_agent_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_latest_readings_agent_location ON public.latest_readings USING btree (agent_location) WHERE (agent_location IS NOT NULL);


--
-- Name: idx_latest_readings_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_latest_readings_device ON public.latest_readings USING btree (device_name);


--
-- Name: idx_latest_readings_device_location; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_latest_readings_device_location ON public.latest_readings USING btree (device_location) WHERE (device_location IS NOT NULL);


--
-- Name: idx_latest_readings_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_latest_readings_protocol ON public.latest_readings USING btree (protocol);


--
-- Name: idx_latest_readings_quality; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_latest_readings_quality ON public.latest_readings USING btree (quality);


--
-- Name: idx_latest_readings_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_latest_readings_unique ON public.latest_readings USING btree (agent_uuid, device_name, metric_name);


--
-- Name: idx_metric_catalog_agent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_metric_catalog_agent ON public.metric_catalog USING btree (agent_uuid);


--
-- Name: idx_metric_catalog_composite; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_metric_catalog_composite ON public.metric_catalog USING btree (device_name, metric_name);


--
-- Name: idx_metric_catalog_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_metric_catalog_device ON public.metric_catalog USING btree (device_name);


--
-- Name: idx_metric_catalog_metric; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_metric_catalog_metric ON public.metric_catalog USING btree (metric_name);


--
-- Name: idx_metric_catalog_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_metric_catalog_protocol ON public.metric_catalog USING btree (protocol);


--
-- Name: idx_metric_catalog_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_metric_catalog_unique ON public.metric_catalog USING btree (agent_uuid, device_name, protocol, metric_name);


--
-- Name: INDEX idx_metric_catalog_unique; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_metric_catalog_unique IS 'Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY';


--
-- Name: idx_mqtt_acls_clientid_access_topic; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_acls_clientid_access_topic ON public.mqtt_acls USING btree (clientid, access, topic);


--
-- Name: INDEX idx_mqtt_acls_clientid_access_topic; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_acls_clientid_access_topic IS 'Composite index for client-specific ACL lookups';


--
-- Name: idx_mqtt_acls_global_rules; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_acls_global_rules ON public.mqtt_acls USING btree (access, topic, priority) WHERE (username IS NULL);


--
-- Name: INDEX idx_mqtt_acls_global_rules; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_acls_global_rules IS 'Partial index for global ACL rules (username IS NULL)';


--
-- Name: idx_mqtt_acls_priority; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_acls_priority ON public.mqtt_acls USING btree (priority DESC);


--
-- Name: idx_mqtt_acls_topic_pattern; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_acls_topic_pattern ON public.mqtt_acls USING btree (topic text_pattern_ops);


--
-- Name: INDEX idx_mqtt_acls_topic_pattern; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_acls_topic_pattern IS 'Index for wildcard topic pattern matching';


--
-- Name: idx_mqtt_acls_username_access_topic; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_acls_username_access_topic ON public.mqtt_acls USING btree (username, access, topic);


--
-- Name: INDEX idx_mqtt_acls_username_access_topic; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_acls_username_access_topic IS 'Composite index for ACL lookups (username + access + topic)';


--
-- Name: idx_mqtt_broker_config_broker_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_broker_config_broker_type ON public.mqtt_broker_config USING btree (broker_type);


--
-- Name: idx_mqtt_broker_config_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_broker_config_is_active ON public.mqtt_broker_config USING btree (is_active);


--
-- Name: idx_mqtt_broker_config_is_default; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_broker_config_is_default ON public.mqtt_broker_config USING btree (is_default);


--
-- Name: idx_mqtt_broker_config_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_broker_config_name ON public.mqtt_broker_config USING btree (name);


--
-- Name: idx_mqtt_broker_stats_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_broker_stats_timestamp ON public.mqtt_broker_stats USING btree ("timestamp" DESC);


--
-- Name: idx_mqtt_schema_history_detected; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_schema_history_detected ON public.mqtt_schema_history USING btree (detected_at DESC);


--
-- Name: idx_mqtt_schema_history_topic; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_schema_history_topic ON public.mqtt_schema_history USING btree (topic);


--
-- Name: idx_mqtt_schema_history_topic_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_schema_history_topic_id ON public.mqtt_schema_history USING btree (topic_id);


--
-- Name: idx_mqtt_topic_metrics_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topic_metrics_timestamp ON public.mqtt_topic_metrics USING btree ("timestamp" DESC);


--
-- Name: idx_mqtt_topic_metrics_topic; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topic_metrics_topic ON public.mqtt_topic_metrics USING btree (topic);


--
-- Name: idx_mqtt_topic_metrics_topic_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topic_metrics_topic_id ON public.mqtt_topic_metrics USING btree (topic_id);


--
-- Name: idx_mqtt_topic_metrics_topic_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topic_metrics_topic_timestamp ON public.mqtt_topic_metrics USING btree (topic, "timestamp" DESC);


--
-- Name: idx_mqtt_topics_last_seen; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topics_last_seen ON public.mqtt_topics USING btree (last_seen DESC);


--
-- Name: idx_mqtt_topics_message_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topics_message_type ON public.mqtt_topics USING btree (message_type);


--
-- Name: idx_mqtt_topics_topic; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_topics_topic ON public.mqtt_topics USING btree (topic);


--
-- Name: idx_mqtt_topics_topic_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_mqtt_topics_topic_id ON public.mqtt_topics USING btree (topic_id);


--
-- Name: idx_mqtt_users_auth_covering; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_users_auth_covering ON public.mqtt_users USING btree (username) INCLUDE (password_hash, is_superuser, is_active);


--
-- Name: INDEX idx_mqtt_users_auth_covering; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_users_auth_covering IS 'Covering index to avoid table lookups during authentication';


--
-- Name: idx_mqtt_users_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_users_is_active ON public.mqtt_users USING btree (is_active);


--
-- Name: idx_mqtt_users_superuser; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_users_superuser ON public.mqtt_users USING btree (username, is_superuser) WHERE (is_superuser = true);


--
-- Name: INDEX idx_mqtt_users_superuser; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_users_superuser IS 'Partial index for superuser checks';


--
-- Name: idx_mqtt_users_username_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mqtt_users_username_active ON public.mqtt_users USING btree (username, is_active) WHERE (is_active = true);


--
-- Name: INDEX idx_mqtt_users_username_active; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON INDEX public.idx_mqtt_users_username_active IS 'Composite index for authentication queries (username + is_active)';


--
-- Name: idx_nodered_library_lookup; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_nodered_library_lookup ON public.nodered_library USING btree (type, name);


--
-- Name: idx_nodered_library_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_nodered_library_type ON public.nodered_library USING btree (type);


--
-- Name: idx_profile_configs_profile_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_profile_configs_profile_name ON public.profile_configs USING btree (profile_name);


--
-- Name: idx_profile_configs_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_profile_configs_protocol ON public.profile_configs USING btree (protocol);


--
-- Name: idx_provisioning_attempts_ip; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_attempts_ip ON public.provisioning_attempts USING btree (ip_address, created_at);


--
-- Name: idx_provisioning_attempts_success; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_attempts_success ON public.provisioning_attempts USING btree (success);


--
-- Name: idx_provisioning_keys_deployment_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_deployment_type ON public.provisioning_keys USING btree (deployment_type);


--
-- Name: idx_provisioning_keys_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_expires_at ON public.provisioning_keys USING btree (expires_at);


--
-- Name: idx_provisioning_keys_fast_hash; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_fast_hash ON public.provisioning_keys USING btree (key_hash_fast);


--
-- Name: idx_provisioning_keys_fleet_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_fleet_id ON public.provisioning_keys USING btree (fleet_id);


--
-- Name: idx_provisioning_keys_fleet_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_fleet_uuid ON public.provisioning_keys USING btree (fleet_uuid);


--
-- Name: idx_provisioning_keys_fleet_uuid_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_fleet_uuid_active ON public.provisioning_keys USING btree (fleet_uuid, is_active) WHERE (fleet_uuid IS NOT NULL);


--
-- Name: idx_provisioning_keys_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_is_active ON public.provisioning_keys USING btree (is_active);


--
-- Name: idx_provisioning_keys_simulator_config; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_provisioning_keys_simulator_config ON public.provisioning_keys USING gin (simulator_config);


--
-- Name: idx_readings_anomaly_score; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_readings_anomaly_score ON public.readings USING btree (device_uuid, "time" DESC) WHERE (anomaly_score IS NOT NULL);


--
-- Name: idx_readings_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_readings_device_time ON public.readings USING btree (device_uuid, "time" DESC);


--
-- Name: idx_readings_extra; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_readings_extra ON public.readings USING gin (extra);


--
-- Name: idx_readings_metric_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_readings_metric_time ON public.readings USING btree (metric_name, "time" DESC);


--
-- Name: idx_readings_protocol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_readings_protocol ON public.readings USING btree (protocol, "time" DESC);


--
-- Name: idx_recent_anomalies_agent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_recent_anomalies_agent ON public.recent_anomalies USING btree (agent_id, timestamp_ms DESC);


--
-- Name: idx_recent_anomalies_fingerprint; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_recent_anomalies_fingerprint ON public.recent_anomalies USING btree (fingerprint);


--
-- Name: idx_recent_anomalies_metric; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_recent_anomalies_metric ON public.recent_anomalies USING btree (metric);


--
-- Name: idx_recent_anomalies_severity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_recent_anomalies_severity ON public.recent_anomalies USING btree (severity, timestamp_ms DESC);


--
-- Name: idx_reconciliation_correlation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_reconciliation_correlation ON public.reconciliation_history USING btree (correlation_id);


--
-- Name: idx_reconciliation_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_reconciliation_device_time ON public.reconciliation_history USING btree (device_uuid, started_at DESC);


--
-- Name: idx_reconciliation_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_reconciliation_status ON public.reconciliation_history USING btree (status);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_revoked; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_revoked ON public.refresh_tokens USING btree (revoked);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_releases_application_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_releases_application_id ON public.releases USING btree (application_id);


--
-- Name: idx_rollout_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_created ON public.image_rollouts USING btree (created_at);


--
-- Name: idx_rollout_events_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_events_device ON public.rollout_events USING btree (device_uuid);


--
-- Name: idx_rollout_events_rollout; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_events_rollout ON public.rollout_events USING btree (rollout_id);


--
-- Name: idx_rollout_events_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_events_timestamp ON public.rollout_events USING btree ("timestamp");


--
-- Name: idx_rollout_events_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_events_type ON public.rollout_events USING btree (event_type);


--
-- Name: idx_rollout_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_id ON public.image_rollouts USING btree (rollout_id);


--
-- Name: idx_rollout_image; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_image ON public.image_rollouts USING btree (image_name, new_tag);


--
-- Name: idx_rollout_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_rollout_status ON public.image_rollouts USING btree (status);


--
-- Name: idx_scheduled_jobs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scheduled_jobs_created_at ON public.scheduled_jobs USING btree (created_at DESC);


--
-- Name: idx_scheduled_jobs_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scheduled_jobs_is_active ON public.scheduled_jobs USING btree (is_active);


--
-- Name: idx_scheduled_jobs_schedule_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scheduled_jobs_schedule_id ON public.scheduled_jobs USING btree (schedule_id);


--
-- Name: idx_schema_migrations_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX IF NOT EXISTS idx_schema_migrations_number ON public.schema_migrations USING btree (migration_number);


--
-- Name: idx_sensor_health_dashboard; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_dashboard ON public.sensor_health_history USING btree (device_uuid, sensor_name, reported_at DESC);


--
-- Name: idx_sensor_health_device_sensor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_device_sensor ON public.sensor_health_history USING btree (device_uuid, sensor_name);


--
-- Name: idx_sensor_health_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_device_uuid ON public.sensor_health_history USING btree (device_uuid);


--
-- Name: idx_sensor_health_healthy; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_healthy ON public.sensor_health_history USING btree (healthy);


--
-- Name: idx_sensor_health_reported_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_reported_at ON public.sensor_health_history USING btree (reported_at DESC);


--
-- Name: idx_sensor_health_sensor_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_sensor_name ON public.sensor_health_history USING btree (sensor_name);


--
-- Name: idx_sensor_health_state; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_sensor_health_state ON public.sensor_health_history USING btree (state);


--
-- Name: idx_shadow_history_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_device_time ON public.device_shadow_history USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_shadow_history_device_uuid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_device_uuid ON public.device_shadow_history USING btree (device_uuid);


--
-- Name: idx_shadow_history_query; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_query ON public.device_shadow_history USING btree (device_uuid, shadow_name, "timestamp" DESC);


--
-- Name: idx_shadow_history_shadow_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_shadow_name ON public.device_shadow_history USING btree (shadow_name);


--
-- Name: idx_shadow_history_state; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_state ON public.device_shadow_history USING gin (reported_state);


--
-- Name: idx_shadow_history_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shadow_history_timestamp ON public.device_shadow_history USING btree ("timestamp" DESC);


--
-- Name: idx_shell_audit_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_audit_device ON public.shell_audit_log USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_shell_audit_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_audit_session ON public.shell_audit_log USING btree (session_id);


--
-- Name: idx_shell_audit_timestamp; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_audit_timestamp ON public.shell_audit_log USING btree ("timestamp" DESC);


--
-- Name: idx_shell_audit_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_audit_user ON public.shell_audit_log USING btree (user_id, "timestamp" DESC);


--
-- Name: idx_shell_sessions_device; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_sessions_device ON public.shell_sessions USING btree (device_uuid);


--
-- Name: idx_shell_sessions_device_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_sessions_device_status ON public.shell_sessions USING btree (device_uuid, status);


--
-- Name: idx_shell_sessions_last_activity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_sessions_last_activity ON public.shell_sessions USING btree (last_activity);


--
-- Name: idx_shell_sessions_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_shell_sessions_status ON public.shell_sessions USING btree (status);


--
-- Name: idx_state_changes_correlation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_changes_correlation ON public.state_changes USING btree (correlation_id);


--
-- Name: idx_state_changes_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_changes_device_time ON public.state_changes USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_state_changes_entity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_changes_entity ON public.state_changes USING btree (entity_type, entity_id);


--
-- Name: idx_state_changes_triggered_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_changes_triggered_by ON public.state_changes USING btree (triggered_by);


--
-- Name: idx_state_snapshots_checksum; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_snapshots_checksum ON public.state_snapshots USING btree (checksum);


--
-- Name: idx_state_snapshots_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_snapshots_device_time ON public.state_snapshots USING btree (device_uuid, "timestamp" DESC);


--
-- Name: idx_state_snapshots_type_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_state_snapshots_type_version ON public.state_snapshots USING btree (device_uuid, state_type, version DESC);


--
-- Name: idx_system_config_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_system_config_key ON public.system_config USING btree (key);


--
-- Name: idx_tag_definitions_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tag_definitions_key ON public.tag_definitions USING btree (key);


--
-- Name: idx_target_history_deployed_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_target_history_deployed_at ON public.device_target_state_history USING btree (device_uuid, deployed_at DESC);


--
-- Name: idx_target_history_deployed_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_target_history_deployed_by ON public.device_target_state_history USING btree (deployed_by);


--
-- Name: idx_target_history_device_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_target_history_device_version ON public.device_target_state_history USING btree (device_uuid, version DESC);


--
-- Name: idx_target_history_rollback; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_target_history_rollback ON public.device_target_state_history USING btree (device_uuid, is_rollback) WHERE (is_rollback = true);


--
-- Name: idx_traffic_device_endpoint; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_traffic_device_endpoint ON public.device_traffic_stats USING btree (device_id, endpoint);


--
-- Name: idx_traffic_device_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_traffic_device_time ON public.device_traffic_stats USING btree (device_id, time_bucket DESC);


--
-- Name: idx_traffic_status_codes; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_traffic_status_codes ON public.device_traffic_stats USING gin (status_codes);


--
-- Name: idx_traffic_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_traffic_time ON public.device_traffic_stats USING btree (time_bucket DESC);


--
-- Name: idx_update_strategy; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_update_strategy ON public.image_update_policies USING btree (update_strategy);


--
-- Name: idx_user_sessions_expires_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_sessions_expires_at ON public.user_sessions USING btree (expires_at);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_is_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_is_active ON public.users USING btree (is_active);


--
-- Name: idx_users_mqtt_username; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_mqtt_username ON public.users USING btree (mqtt_username);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: idx_users_username; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_username ON public.users USING btree (username);


--
-- Name: idx_wg_ip_pool_available; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_wg_ip_pool_available ON public.wg_ip_pool USING btree (is_available);


--
-- Name: idx_wg_peers_device_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_wg_peers_device_id ON public.wg_peers USING btree (device_id);


--
-- Name: idx_wg_peers_enabled; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_wg_peers_enabled ON public.wg_peers USING btree (enabled);


--
-- Name: readings_time_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX readings_time_idx ON public.readings USING btree ("time" DESC);


--
-- Name: events_2026_01_11_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_11_actor_type_actor_id_idx;


--
-- Name: events_2026_01_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_11_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_11_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_11_causation_id_idx;


--
-- Name: events_2026_01_11_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_11_correlation_id_idx;


--
-- Name: events_2026_01_11_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_11_event_id_timestamp_key;


--
-- Name: events_2026_01_11_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_11_event_type_timestamp_idx;


--
-- Name: events_2026_01_11_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_11_impact_idx;


--
-- Name: events_2026_01_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_11_pkey;


--
-- Name: events_2026_01_11_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_11_severity_idx;


--
-- Name: events_2026_01_11_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_11_timestamp_idx;


--
-- Name: events_2026_01_12_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_12_actor_type_actor_id_idx;


--
-- Name: events_2026_01_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_12_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_12_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_12_causation_id_idx;


--
-- Name: events_2026_01_12_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_12_correlation_id_idx;


--
-- Name: events_2026_01_12_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_12_event_id_timestamp_key;


--
-- Name: events_2026_01_12_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_12_event_type_timestamp_idx;


--
-- Name: events_2026_01_12_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_12_impact_idx;


--
-- Name: events_2026_01_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_12_pkey;


--
-- Name: events_2026_01_12_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_12_severity_idx;


--
-- Name: events_2026_01_12_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_12_timestamp_idx;


--
-- Name: events_2026_01_13_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_13_actor_type_actor_id_idx;


--
-- Name: events_2026_01_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_13_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_13_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_13_causation_id_idx;


--
-- Name: events_2026_01_13_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_13_correlation_id_idx;


--
-- Name: events_2026_01_13_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_13_event_id_timestamp_key;


--
-- Name: events_2026_01_13_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_13_event_type_timestamp_idx;


--
-- Name: events_2026_01_13_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_13_impact_idx;


--
-- Name: events_2026_01_13_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_13_pkey;


--
-- Name: events_2026_01_13_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_13_severity_idx;


--
-- Name: events_2026_01_13_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_13_timestamp_idx;


--
-- Name: events_2026_01_14_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_14_actor_type_actor_id_idx;


--
-- Name: events_2026_01_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_14_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_14_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_14_causation_id_idx;


--
-- Name: events_2026_01_14_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_14_correlation_id_idx;


--
-- Name: events_2026_01_14_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_14_event_id_timestamp_key;


--
-- Name: events_2026_01_14_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_14_event_type_timestamp_idx;


--
-- Name: events_2026_01_14_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_14_impact_idx;


--
-- Name: events_2026_01_14_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_14_pkey;


--
-- Name: events_2026_01_14_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_14_severity_idx;


--
-- Name: events_2026_01_14_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_14_timestamp_idx;


--
-- Name: events_2026_01_15_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_15_actor_type_actor_id_idx;


--
-- Name: events_2026_01_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_15_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_15_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_15_causation_id_idx;


--
-- Name: events_2026_01_15_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_15_correlation_id_idx;


--
-- Name: events_2026_01_15_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_15_event_id_timestamp_key;


--
-- Name: events_2026_01_15_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_15_event_type_timestamp_idx;


--
-- Name: events_2026_01_15_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_15_impact_idx;


--
-- Name: events_2026_01_15_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_15_pkey;


--
-- Name: events_2026_01_15_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_15_severity_idx;


--
-- Name: events_2026_01_15_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_15_timestamp_idx;


--
-- Name: events_2026_01_16_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_16_actor_type_actor_id_idx;


--
-- Name: events_2026_01_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_16_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_16_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_16_causation_id_idx;


--
-- Name: events_2026_01_16_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_16_correlation_id_idx;


--
-- Name: events_2026_01_16_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_16_event_id_timestamp_key;


--
-- Name: events_2026_01_16_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_16_event_type_timestamp_idx;


--
-- Name: events_2026_01_16_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_16_impact_idx;


--
-- Name: events_2026_01_16_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_16_pkey;


--
-- Name: events_2026_01_16_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_16_severity_idx;


--
-- Name: events_2026_01_16_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_16_timestamp_idx;


--
-- Name: events_2026_01_17_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_17_actor_type_actor_id_idx;


--
-- Name: events_2026_01_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_17_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_17_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_17_causation_id_idx;


--
-- Name: events_2026_01_17_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_17_correlation_id_idx;


--
-- Name: events_2026_01_17_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_17_event_id_timestamp_key;


--
-- Name: events_2026_01_17_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_17_event_type_timestamp_idx;


--
-- Name: events_2026_01_17_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_17_impact_idx;


--
-- Name: events_2026_01_17_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_17_pkey;


--
-- Name: events_2026_01_17_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_17_severity_idx;


--
-- Name: events_2026_01_17_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_17_timestamp_idx;


--
-- Name: events_2026_01_18_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_18_actor_type_actor_id_idx;


--
-- Name: events_2026_01_18_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_18_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_18_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_18_causation_id_idx;


--
-- Name: events_2026_01_18_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_18_correlation_id_idx;


--
-- Name: events_2026_01_18_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_18_event_id_timestamp_key;


--
-- Name: events_2026_01_18_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_18_event_type_timestamp_idx;


--
-- Name: events_2026_01_18_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_18_impact_idx;


--
-- Name: events_2026_01_18_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_18_pkey;


--
-- Name: events_2026_01_18_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_18_severity_idx;


--
-- Name: events_2026_01_18_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_18_timestamp_idx;


--
-- Name: events_2026_01_19_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_19_actor_type_actor_id_idx;


--
-- Name: events_2026_01_19_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_19_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_19_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_19_causation_id_idx;


--
-- Name: events_2026_01_19_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_19_correlation_id_idx;


--
-- Name: events_2026_01_19_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_19_event_id_timestamp_key;


--
-- Name: events_2026_01_19_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_19_event_type_timestamp_idx;


--
-- Name: events_2026_01_19_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_19_impact_idx;


--
-- Name: events_2026_01_19_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_19_pkey;


--
-- Name: events_2026_01_19_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_19_severity_idx;


--
-- Name: events_2026_01_19_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_19_timestamp_idx;


--
-- Name: events_2026_01_20_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_20_actor_type_actor_id_idx;


--
-- Name: events_2026_01_20_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_20_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_20_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_20_causation_id_idx;


--
-- Name: events_2026_01_20_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_20_correlation_id_idx;


--
-- Name: events_2026_01_20_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_20_event_id_timestamp_key;


--
-- Name: events_2026_01_20_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_20_event_type_timestamp_idx;


--
-- Name: events_2026_01_20_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_20_impact_idx;


--
-- Name: events_2026_01_20_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_20_pkey;


--
-- Name: events_2026_01_20_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_20_severity_idx;


--
-- Name: events_2026_01_20_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_20_timestamp_idx;


--
-- Name: events_2026_01_21_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_21_actor_type_actor_id_idx;


--
-- Name: events_2026_01_21_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_21_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_21_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_21_causation_id_idx;


--
-- Name: events_2026_01_21_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_21_correlation_id_idx;


--
-- Name: events_2026_01_21_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_21_event_id_timestamp_key;


--
-- Name: events_2026_01_21_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_21_event_type_timestamp_idx;


--
-- Name: events_2026_01_21_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_21_impact_idx;


--
-- Name: events_2026_01_21_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_21_pkey;


--
-- Name: events_2026_01_21_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_21_severity_idx;


--
-- Name: events_2026_01_21_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_21_timestamp_idx;


--
-- Name: events_2026_01_22_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_22_actor_type_actor_id_idx;


--
-- Name: events_2026_01_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_22_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_22_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_22_causation_id_idx;


--
-- Name: events_2026_01_22_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_22_correlation_id_idx;


--
-- Name: events_2026_01_22_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_22_event_id_timestamp_key;


--
-- Name: events_2026_01_22_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_22_event_type_timestamp_idx;


--
-- Name: events_2026_01_22_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_22_impact_idx;


--
-- Name: events_2026_01_22_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_22_pkey;


--
-- Name: events_2026_01_22_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_22_severity_idx;


--
-- Name: events_2026_01_22_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_22_timestamp_idx;


--
-- Name: events_2026_01_23_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_23_actor_type_actor_id_idx;


--
-- Name: events_2026_01_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_23_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_23_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_23_causation_id_idx;


--
-- Name: events_2026_01_23_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_23_correlation_id_idx;


--
-- Name: events_2026_01_23_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_23_event_id_timestamp_key;


--
-- Name: events_2026_01_23_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_23_event_type_timestamp_idx;


--
-- Name: events_2026_01_23_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_23_impact_idx;


--
-- Name: events_2026_01_23_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_23_pkey;


--
-- Name: events_2026_01_23_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_23_severity_idx;


--
-- Name: events_2026_01_23_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_23_timestamp_idx;


--
-- Name: events_2026_01_24_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_24_actor_type_actor_id_idx;


--
-- Name: events_2026_01_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_24_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_24_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_24_causation_id_idx;


--
-- Name: events_2026_01_24_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_24_correlation_id_idx;


--
-- Name: events_2026_01_24_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_24_event_id_timestamp_key;


--
-- Name: events_2026_01_24_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_24_event_type_timestamp_idx;


--
-- Name: events_2026_01_24_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_24_impact_idx;


--
-- Name: events_2026_01_24_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_24_pkey;


--
-- Name: events_2026_01_24_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_24_severity_idx;


--
-- Name: events_2026_01_24_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_24_timestamp_idx;


--
-- Name: events_2026_01_25_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_25_actor_type_actor_id_idx;


--
-- Name: events_2026_01_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_25_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_25_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_25_causation_id_idx;


--
-- Name: events_2026_01_25_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_25_correlation_id_idx;


--
-- Name: events_2026_01_25_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_25_event_id_timestamp_key;


--
-- Name: events_2026_01_25_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_25_event_type_timestamp_idx;


--
-- Name: events_2026_01_25_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_25_impact_idx;


--
-- Name: events_2026_01_25_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_25_pkey;


--
-- Name: events_2026_01_25_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_25_severity_idx;


--
-- Name: events_2026_01_25_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_25_timestamp_idx;


--
-- Name: events_2026_01_26_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_26_actor_type_actor_id_idx;


--
-- Name: events_2026_01_26_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_26_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_26_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_26_causation_id_idx;


--
-- Name: events_2026_01_26_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_26_correlation_id_idx;


--
-- Name: events_2026_01_26_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_26_event_id_timestamp_key;


--
-- Name: events_2026_01_26_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_26_event_type_timestamp_idx;


--
-- Name: events_2026_01_26_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_26_impact_idx;


--
-- Name: events_2026_01_26_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_26_pkey;


--
-- Name: events_2026_01_26_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_26_severity_idx;


--
-- Name: events_2026_01_26_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_26_timestamp_idx;


--
-- Name: events_2026_01_27_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_27_actor_type_actor_id_idx;


--
-- Name: events_2026_01_27_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_27_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_27_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_27_causation_id_idx;


--
-- Name: events_2026_01_27_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_27_correlation_id_idx;


--
-- Name: events_2026_01_27_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_27_event_id_timestamp_key;


--
-- Name: events_2026_01_27_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_27_event_type_timestamp_idx;


--
-- Name: events_2026_01_27_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_27_impact_idx;


--
-- Name: events_2026_01_27_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_27_pkey;


--
-- Name: events_2026_01_27_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_27_severity_idx;


--
-- Name: events_2026_01_27_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_27_timestamp_idx;


--
-- Name: events_2026_01_28_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_28_actor_type_actor_id_idx;


--
-- Name: events_2026_01_28_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_28_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_28_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_28_causation_id_idx;


--
-- Name: events_2026_01_28_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_28_correlation_id_idx;


--
-- Name: events_2026_01_28_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_28_event_id_timestamp_key;


--
-- Name: events_2026_01_28_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_28_event_type_timestamp_idx;


--
-- Name: events_2026_01_28_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_28_impact_idx;


--
-- Name: events_2026_01_28_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_28_pkey;


--
-- Name: events_2026_01_28_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_28_severity_idx;


--
-- Name: events_2026_01_28_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_28_timestamp_idx;


--
-- Name: events_2026_01_29_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_29_actor_type_actor_id_idx;


--
-- Name: events_2026_01_29_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_29_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_29_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_29_causation_id_idx;


--
-- Name: events_2026_01_29_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_29_correlation_id_idx;


--
-- Name: events_2026_01_29_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_29_event_id_timestamp_key;


--
-- Name: events_2026_01_29_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_29_event_type_timestamp_idx;


--
-- Name: events_2026_01_29_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_29_impact_idx;


--
-- Name: events_2026_01_29_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_29_pkey;


--
-- Name: events_2026_01_29_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_29_severity_idx;


--
-- Name: events_2026_01_29_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_29_timestamp_idx;


--
-- Name: events_2026_01_30_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_30_actor_type_actor_id_idx;


--
-- Name: events_2026_01_30_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_30_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_30_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_30_causation_id_idx;


--
-- Name: events_2026_01_30_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_30_correlation_id_idx;


--
-- Name: events_2026_01_30_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_30_event_id_timestamp_key;


--
-- Name: events_2026_01_30_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_30_event_type_timestamp_idx;


--
-- Name: events_2026_01_30_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_30_impact_idx;


--
-- Name: events_2026_01_30_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_30_pkey;


--
-- Name: events_2026_01_30_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_30_severity_idx;


--
-- Name: events_2026_01_30_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_30_timestamp_idx;


--
-- Name: events_2026_01_31_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_01_31_actor_type_actor_id_idx;


--
-- Name: events_2026_01_31_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_01_31_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_01_31_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_01_31_causation_id_idx;


--
-- Name: events_2026_01_31_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_01_31_correlation_id_idx;


--
-- Name: events_2026_01_31_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_01_31_event_id_timestamp_key;


--
-- Name: events_2026_01_31_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_01_31_event_type_timestamp_idx;


--
-- Name: events_2026_01_31_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_01_31_impact_idx;


--
-- Name: events_2026_01_31_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_01_31_pkey;


--
-- Name: events_2026_01_31_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_01_31_severity_idx;


--
-- Name: events_2026_01_31_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_01_31_timestamp_idx;


--
-- Name: events_2026_02_01_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_01_actor_type_actor_id_idx;


--
-- Name: events_2026_02_01_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_01_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_01_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_01_causation_id_idx;


--
-- Name: events_2026_02_01_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_01_correlation_id_idx;


--
-- Name: events_2026_02_01_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_01_event_id_timestamp_key;


--
-- Name: events_2026_02_01_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_01_event_type_timestamp_idx;


--
-- Name: events_2026_02_01_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_01_impact_idx;


--
-- Name: events_2026_02_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_01_pkey;


--
-- Name: events_2026_02_01_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_01_severity_idx;


--
-- Name: events_2026_02_01_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_01_timestamp_idx;


--
-- Name: events_2026_02_02_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_02_actor_type_actor_id_idx;


--
-- Name: events_2026_02_02_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_02_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_02_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_02_causation_id_idx;


--
-- Name: events_2026_02_02_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_02_correlation_id_idx;


--
-- Name: events_2026_02_02_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_02_event_id_timestamp_key;


--
-- Name: events_2026_02_02_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_02_event_type_timestamp_idx;


--
-- Name: events_2026_02_02_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_02_impact_idx;


--
-- Name: events_2026_02_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_02_pkey;


--
-- Name: events_2026_02_02_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_02_severity_idx;


--
-- Name: events_2026_02_02_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_02_timestamp_idx;


--
-- Name: events_2026_02_03_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_03_actor_type_actor_id_idx;


--
-- Name: events_2026_02_03_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_03_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_03_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_03_causation_id_idx;


--
-- Name: events_2026_02_03_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_03_correlation_id_idx;


--
-- Name: events_2026_02_03_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_03_event_id_timestamp_key;


--
-- Name: events_2026_02_03_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_03_event_type_timestamp_idx;


--
-- Name: events_2026_02_03_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_03_impact_idx;


--
-- Name: events_2026_02_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_03_pkey;


--
-- Name: events_2026_02_03_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_03_severity_idx;


--
-- Name: events_2026_02_03_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_03_timestamp_idx;


--
-- Name: events_2026_02_04_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_04_actor_type_actor_id_idx;


--
-- Name: events_2026_02_04_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_04_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_04_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_04_causation_id_idx;


--
-- Name: events_2026_02_04_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_04_correlation_id_idx;


--
-- Name: events_2026_02_04_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_04_event_id_timestamp_key;


--
-- Name: events_2026_02_04_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_04_event_type_timestamp_idx;


--
-- Name: events_2026_02_04_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_04_impact_idx;


--
-- Name: events_2026_02_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_04_pkey;


--
-- Name: events_2026_02_04_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_04_severity_idx;


--
-- Name: events_2026_02_04_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_04_timestamp_idx;


--
-- Name: events_2026_02_05_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_05_actor_type_actor_id_idx;


--
-- Name: events_2026_02_05_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_05_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_05_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_05_causation_id_idx;


--
-- Name: events_2026_02_05_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_05_correlation_id_idx;


--
-- Name: events_2026_02_05_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_05_event_id_timestamp_key;


--
-- Name: events_2026_02_05_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_05_event_type_timestamp_idx;


--
-- Name: events_2026_02_05_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_05_impact_idx;


--
-- Name: events_2026_02_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_05_pkey;


--
-- Name: events_2026_02_05_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_05_severity_idx;


--
-- Name: events_2026_02_05_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_05_timestamp_idx;


--
-- Name: events_2026_02_06_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_06_actor_type_actor_id_idx;


--
-- Name: events_2026_02_06_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_06_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_06_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_06_causation_id_idx;


--
-- Name: events_2026_02_06_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_06_correlation_id_idx;


--
-- Name: events_2026_02_06_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_06_event_id_timestamp_key;


--
-- Name: events_2026_02_06_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_06_event_type_timestamp_idx;


--
-- Name: events_2026_02_06_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_06_impact_idx;


--
-- Name: events_2026_02_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_06_pkey;


--
-- Name: events_2026_02_06_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_06_severity_idx;


--
-- Name: events_2026_02_06_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_06_timestamp_idx;


--
-- Name: events_2026_02_07_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_07_actor_type_actor_id_idx;


--
-- Name: events_2026_02_07_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_07_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_07_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_07_causation_id_idx;


--
-- Name: events_2026_02_07_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_07_correlation_id_idx;


--
-- Name: events_2026_02_07_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_07_event_id_timestamp_key;


--
-- Name: events_2026_02_07_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_07_event_type_timestamp_idx;


--
-- Name: events_2026_02_07_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_07_impact_idx;


--
-- Name: events_2026_02_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_07_pkey;


--
-- Name: events_2026_02_07_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_07_severity_idx;


--
-- Name: events_2026_02_07_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_07_timestamp_idx;


--
-- Name: events_2026_02_08_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_08_actor_type_actor_id_idx;


--
-- Name: events_2026_02_08_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_08_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_08_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_08_causation_id_idx;


--
-- Name: events_2026_02_08_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_08_correlation_id_idx;


--
-- Name: events_2026_02_08_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_08_event_id_timestamp_key;


--
-- Name: events_2026_02_08_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_08_event_type_timestamp_idx;


--
-- Name: events_2026_02_08_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_08_impact_idx;


--
-- Name: events_2026_02_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_08_pkey;


--
-- Name: events_2026_02_08_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_08_severity_idx;


--
-- Name: events_2026_02_08_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_08_timestamp_idx;


--
-- Name: events_2026_02_09_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_09_actor_type_actor_id_idx;


--
-- Name: events_2026_02_09_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_09_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_09_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_09_causation_id_idx;


--
-- Name: events_2026_02_09_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_09_correlation_id_idx;


--
-- Name: events_2026_02_09_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_09_event_id_timestamp_key;


--
-- Name: events_2026_02_09_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_09_event_type_timestamp_idx;


--
-- Name: events_2026_02_09_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_09_impact_idx;


--
-- Name: events_2026_02_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_09_pkey;


--
-- Name: events_2026_02_09_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_09_severity_idx;


--
-- Name: events_2026_02_09_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_09_timestamp_idx;


--
-- Name: events_2026_02_10_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_10_actor_type_actor_id_idx;


--
-- Name: events_2026_02_10_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_10_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_10_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_10_causation_id_idx;


--
-- Name: events_2026_02_10_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_10_correlation_id_idx;


--
-- Name: events_2026_02_10_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_10_event_id_timestamp_key;


--
-- Name: events_2026_02_10_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_10_event_type_timestamp_idx;


--
-- Name: events_2026_02_10_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_10_impact_idx;


--
-- Name: events_2026_02_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_10_pkey;


--
-- Name: events_2026_02_10_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_10_severity_idx;


--
-- Name: events_2026_02_10_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_10_timestamp_idx;


--
-- Name: events_2026_02_11_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_11_actor_type_actor_id_idx;


--
-- Name: events_2026_02_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_11_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_11_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_11_causation_id_idx;


--
-- Name: events_2026_02_11_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_11_correlation_id_idx;


--
-- Name: events_2026_02_11_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_11_event_id_timestamp_key;


--
-- Name: events_2026_02_11_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_11_event_type_timestamp_idx;


--
-- Name: events_2026_02_11_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_11_impact_idx;


--
-- Name: events_2026_02_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_11_pkey;


--
-- Name: events_2026_02_11_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_11_severity_idx;


--
-- Name: events_2026_02_11_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_11_timestamp_idx;


--
-- Name: events_2026_02_12_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_12_actor_type_actor_id_idx;


--
-- Name: events_2026_02_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_12_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_12_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_12_causation_id_idx;


--
-- Name: events_2026_02_12_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_12_correlation_id_idx;


--
-- Name: events_2026_02_12_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_12_event_id_timestamp_key;


--
-- Name: events_2026_02_12_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_12_event_type_timestamp_idx;


--
-- Name: events_2026_02_12_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_12_impact_idx;


--
-- Name: events_2026_02_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_12_pkey;


--
-- Name: events_2026_02_12_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_12_severity_idx;


--
-- Name: events_2026_02_12_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_12_timestamp_idx;


--
-- Name: events_2026_02_13_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_13_actor_type_actor_id_idx;


--
-- Name: events_2026_02_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_13_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_13_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_13_causation_id_idx;


--
-- Name: events_2026_02_13_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_13_correlation_id_idx;


--
-- Name: events_2026_02_13_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_13_event_id_timestamp_key;


--
-- Name: events_2026_02_13_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_13_event_type_timestamp_idx;


--
-- Name: events_2026_02_13_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_13_impact_idx;


--
-- Name: events_2026_02_13_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_13_pkey;


--
-- Name: events_2026_02_13_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_13_severity_idx;


--
-- Name: events_2026_02_13_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_13_timestamp_idx;


--
-- Name: events_2026_02_14_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_14_actor_type_actor_id_idx;


--
-- Name: events_2026_02_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_14_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_14_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_14_causation_id_idx;


--
-- Name: events_2026_02_14_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_14_correlation_id_idx;


--
-- Name: events_2026_02_14_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_14_event_id_timestamp_key;


--
-- Name: events_2026_02_14_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_14_event_type_timestamp_idx;


--
-- Name: events_2026_02_14_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_14_impact_idx;


--
-- Name: events_2026_02_14_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_14_pkey;


--
-- Name: events_2026_02_14_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_14_severity_idx;


--
-- Name: events_2026_02_14_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_14_timestamp_idx;


--
-- Name: events_2026_02_15_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_15_actor_type_actor_id_idx;


--
-- Name: events_2026_02_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_15_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_15_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_15_causation_id_idx;


--
-- Name: events_2026_02_15_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_15_correlation_id_idx;


--
-- Name: events_2026_02_15_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_15_event_id_timestamp_key;


--
-- Name: events_2026_02_15_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_15_event_type_timestamp_idx;


--
-- Name: events_2026_02_15_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_15_impact_idx;


--
-- Name: events_2026_02_15_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_15_pkey;


--
-- Name: events_2026_02_15_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_15_severity_idx;


--
-- Name: events_2026_02_15_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_15_timestamp_idx;


--
-- Name: events_2026_02_16_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_16_actor_type_actor_id_idx;


--
-- Name: events_2026_02_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_16_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_16_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_16_causation_id_idx;


--
-- Name: events_2026_02_16_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_16_correlation_id_idx;


--
-- Name: events_2026_02_16_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_16_event_id_timestamp_key;


--
-- Name: events_2026_02_16_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_16_event_type_timestamp_idx;


--
-- Name: events_2026_02_16_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_16_impact_idx;


--
-- Name: events_2026_02_16_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_16_pkey;


--
-- Name: events_2026_02_16_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_16_severity_idx;


--
-- Name: events_2026_02_16_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_16_timestamp_idx;


--
-- Name: events_2026_02_17_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_17_actor_type_actor_id_idx;


--
-- Name: events_2026_02_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_17_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_17_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_17_causation_id_idx;


--
-- Name: events_2026_02_17_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_17_correlation_id_idx;


--
-- Name: events_2026_02_17_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_17_event_id_timestamp_key;


--
-- Name: events_2026_02_17_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_17_event_type_timestamp_idx;


--
-- Name: events_2026_02_17_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_17_impact_idx;


--
-- Name: events_2026_02_17_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_17_pkey;


--
-- Name: events_2026_02_17_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_17_severity_idx;


--
-- Name: events_2026_02_17_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_17_timestamp_idx;


--
-- Name: events_2026_02_22_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_22_actor_type_actor_id_idx;


--
-- Name: events_2026_02_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_22_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_22_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_22_causation_id_idx;


--
-- Name: events_2026_02_22_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_22_correlation_id_idx;


--
-- Name: events_2026_02_22_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_22_event_id_timestamp_key;


--
-- Name: events_2026_02_22_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_22_event_type_timestamp_idx;


--
-- Name: events_2026_02_22_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_22_impact_idx;


--
-- Name: events_2026_02_22_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_22_pkey;


--
-- Name: events_2026_02_22_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_22_severity_idx;


--
-- Name: events_2026_02_22_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_22_timestamp_idx;


--
-- Name: events_2026_02_23_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_23_actor_type_actor_id_idx;


--
-- Name: events_2026_02_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_23_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_23_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_23_causation_id_idx;


--
-- Name: events_2026_02_23_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_23_correlation_id_idx;


--
-- Name: events_2026_02_23_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_23_event_id_timestamp_key;


--
-- Name: events_2026_02_23_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_23_event_type_timestamp_idx;


--
-- Name: events_2026_02_23_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_23_impact_idx;


--
-- Name: events_2026_02_23_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_23_pkey;


--
-- Name: events_2026_02_23_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_23_severity_idx;


--
-- Name: events_2026_02_23_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_23_timestamp_idx;


--
-- Name: events_2026_02_24_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_24_actor_type_actor_id_idx;


--
-- Name: events_2026_02_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_24_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_24_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_24_causation_id_idx;


--
-- Name: events_2026_02_24_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_24_correlation_id_idx;


--
-- Name: events_2026_02_24_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_24_event_id_timestamp_key;


--
-- Name: events_2026_02_24_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_24_event_type_timestamp_idx;


--
-- Name: events_2026_02_24_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_24_impact_idx;


--
-- Name: events_2026_02_24_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_24_pkey;


--
-- Name: events_2026_02_24_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_24_severity_idx;


--
-- Name: events_2026_02_24_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_24_timestamp_idx;


--
-- Name: events_2026_02_25_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_25_actor_type_actor_id_idx;


--
-- Name: events_2026_02_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_25_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_25_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_25_causation_id_idx;


--
-- Name: events_2026_02_25_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_25_correlation_id_idx;


--
-- Name: events_2026_02_25_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_25_event_id_timestamp_key;


--
-- Name: events_2026_02_25_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_25_event_type_timestamp_idx;


--
-- Name: events_2026_02_25_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_25_impact_idx;


--
-- Name: events_2026_02_25_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_25_pkey;


--
-- Name: events_2026_02_25_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_25_severity_idx;


--
-- Name: events_2026_02_25_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_25_timestamp_idx;


--
-- Name: events_2026_02_26_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_26_actor_type_actor_id_idx;


--
-- Name: events_2026_02_26_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_26_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_26_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_26_causation_id_idx;


--
-- Name: events_2026_02_26_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_26_correlation_id_idx;


--
-- Name: events_2026_02_26_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_26_event_id_timestamp_key;


--
-- Name: events_2026_02_26_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_26_event_type_timestamp_idx;


--
-- Name: events_2026_02_26_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_26_impact_idx;


--
-- Name: events_2026_02_26_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_26_pkey;


--
-- Name: events_2026_02_26_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_26_severity_idx;


--
-- Name: events_2026_02_26_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_26_timestamp_idx;


--
-- Name: events_2026_02_27_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_27_actor_type_actor_id_idx;


--
-- Name: events_2026_02_27_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_27_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_27_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_27_causation_id_idx;


--
-- Name: events_2026_02_27_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_27_correlation_id_idx;


--
-- Name: events_2026_02_27_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_27_event_id_timestamp_key;


--
-- Name: events_2026_02_27_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_27_event_type_timestamp_idx;


--
-- Name: events_2026_02_27_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_27_impact_idx;


--
-- Name: events_2026_02_27_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_27_pkey;


--
-- Name: events_2026_02_27_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_27_severity_idx;


--
-- Name: events_2026_02_27_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_27_timestamp_idx;


--
-- Name: events_2026_02_28_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_02_28_actor_type_actor_id_idx;


--
-- Name: events_2026_02_28_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_02_28_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_02_28_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_02_28_causation_id_idx;


--
-- Name: events_2026_02_28_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_02_28_correlation_id_idx;


--
-- Name: events_2026_02_28_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_02_28_event_id_timestamp_key;


--
-- Name: events_2026_02_28_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_02_28_event_type_timestamp_idx;


--
-- Name: events_2026_02_28_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_02_28_impact_idx;


--
-- Name: events_2026_02_28_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_02_28_pkey;


--
-- Name: events_2026_02_28_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_02_28_severity_idx;


--
-- Name: events_2026_02_28_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_02_28_timestamp_idx;


--
-- Name: events_2026_03_01_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_01_actor_type_actor_id_idx;


--
-- Name: events_2026_03_01_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_01_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_01_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_01_causation_id_idx;


--
-- Name: events_2026_03_01_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_01_correlation_id_idx;


--
-- Name: events_2026_03_01_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_01_event_id_timestamp_key;


--
-- Name: events_2026_03_01_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_01_event_type_timestamp_idx;


--
-- Name: events_2026_03_01_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_01_impact_idx;


--
-- Name: events_2026_03_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_01_pkey;


--
-- Name: events_2026_03_01_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_01_severity_idx;


--
-- Name: events_2026_03_01_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_01_timestamp_idx;


--
-- Name: events_2026_03_02_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_02_actor_type_actor_id_idx;


--
-- Name: events_2026_03_02_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_02_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_02_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_02_causation_id_idx;


--
-- Name: events_2026_03_02_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_02_correlation_id_idx;


--
-- Name: events_2026_03_02_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_02_event_id_timestamp_key;


--
-- Name: events_2026_03_02_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_02_event_type_timestamp_idx;


--
-- Name: events_2026_03_02_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_02_impact_idx;


--
-- Name: events_2026_03_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_02_pkey;


--
-- Name: events_2026_03_02_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_02_severity_idx;


--
-- Name: events_2026_03_02_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_02_timestamp_idx;


--
-- Name: events_2026_03_03_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_03_actor_type_actor_id_idx;


--
-- Name: events_2026_03_03_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_03_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_03_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_03_causation_id_idx;


--
-- Name: events_2026_03_03_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_03_correlation_id_idx;


--
-- Name: events_2026_03_03_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_03_event_id_timestamp_key;


--
-- Name: events_2026_03_03_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_03_event_type_timestamp_idx;


--
-- Name: events_2026_03_03_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_03_impact_idx;


--
-- Name: events_2026_03_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_03_pkey;


--
-- Name: events_2026_03_03_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_03_severity_idx;


--
-- Name: events_2026_03_03_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_03_timestamp_idx;


--
-- Name: events_2026_03_04_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_04_actor_type_actor_id_idx;


--
-- Name: events_2026_03_04_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_04_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_04_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_04_causation_id_idx;


--
-- Name: events_2026_03_04_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_04_correlation_id_idx;


--
-- Name: events_2026_03_04_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_04_event_id_timestamp_key;


--
-- Name: events_2026_03_04_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_04_event_type_timestamp_idx;


--
-- Name: events_2026_03_04_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_04_impact_idx;


--
-- Name: events_2026_03_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_04_pkey;


--
-- Name: events_2026_03_04_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_04_severity_idx;


--
-- Name: events_2026_03_04_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_04_timestamp_idx;


--
-- Name: events_2026_03_05_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_05_actor_type_actor_id_idx;


--
-- Name: events_2026_03_05_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_05_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_05_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_05_causation_id_idx;


--
-- Name: events_2026_03_05_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_05_correlation_id_idx;


--
-- Name: events_2026_03_05_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_05_event_id_timestamp_key;


--
-- Name: events_2026_03_05_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_05_event_type_timestamp_idx;


--
-- Name: events_2026_03_05_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_05_impact_idx;


--
-- Name: events_2026_03_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_05_pkey;


--
-- Name: events_2026_03_05_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_05_severity_idx;


--
-- Name: events_2026_03_05_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_05_timestamp_idx;


--
-- Name: events_2026_03_06_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_06_actor_type_actor_id_idx;


--
-- Name: events_2026_03_06_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_06_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_06_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_06_causation_id_idx;


--
-- Name: events_2026_03_06_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_06_correlation_id_idx;


--
-- Name: events_2026_03_06_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_06_event_id_timestamp_key;


--
-- Name: events_2026_03_06_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_06_event_type_timestamp_idx;


--
-- Name: events_2026_03_06_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_06_impact_idx;


--
-- Name: events_2026_03_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_06_pkey;


--
-- Name: events_2026_03_06_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_06_severity_idx;


--
-- Name: events_2026_03_06_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_06_timestamp_idx;


--
-- Name: events_2026_03_07_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_07_actor_type_actor_id_idx;


--
-- Name: events_2026_03_07_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_07_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_07_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_07_causation_id_idx;


--
-- Name: events_2026_03_07_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_07_correlation_id_idx;


--
-- Name: events_2026_03_07_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_07_event_id_timestamp_key;


--
-- Name: events_2026_03_07_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_07_event_type_timestamp_idx;


--
-- Name: events_2026_03_07_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_07_impact_idx;


--
-- Name: events_2026_03_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_07_pkey;


--
-- Name: events_2026_03_07_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_07_severity_idx;


--
-- Name: events_2026_03_07_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_07_timestamp_idx;


--
-- Name: events_2026_03_08_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_08_actor_type_actor_id_idx;


--
-- Name: events_2026_03_08_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_08_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_08_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_08_causation_id_idx;


--
-- Name: events_2026_03_08_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_08_correlation_id_idx;


--
-- Name: events_2026_03_08_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_08_event_id_timestamp_key;


--
-- Name: events_2026_03_08_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_08_event_type_timestamp_idx;


--
-- Name: events_2026_03_08_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_08_impact_idx;


--
-- Name: events_2026_03_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_08_pkey;


--
-- Name: events_2026_03_08_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_08_severity_idx;


--
-- Name: events_2026_03_08_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_08_timestamp_idx;


--
-- Name: events_2026_03_09_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_09_actor_type_actor_id_idx;


--
-- Name: events_2026_03_09_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_09_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_09_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_09_causation_id_idx;


--
-- Name: events_2026_03_09_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_09_correlation_id_idx;


--
-- Name: events_2026_03_09_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_09_event_id_timestamp_key;


--
-- Name: events_2026_03_09_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_09_event_type_timestamp_idx;


--
-- Name: events_2026_03_09_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_09_impact_idx;


--
-- Name: events_2026_03_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_09_pkey;


--
-- Name: events_2026_03_09_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_09_severity_idx;


--
-- Name: events_2026_03_09_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_09_timestamp_idx;


--
-- Name: events_2026_03_10_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_10_actor_type_actor_id_idx;


--
-- Name: events_2026_03_10_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_10_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_10_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_10_causation_id_idx;


--
-- Name: events_2026_03_10_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_10_correlation_id_idx;


--
-- Name: events_2026_03_10_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_10_event_id_timestamp_key;


--
-- Name: events_2026_03_10_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_10_event_type_timestamp_idx;


--
-- Name: events_2026_03_10_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_10_impact_idx;


--
-- Name: events_2026_03_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_10_pkey;


--
-- Name: events_2026_03_10_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_10_severity_idx;


--
-- Name: events_2026_03_10_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_10_timestamp_idx;


--
-- Name: events_2026_03_11_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_11_actor_type_actor_id_idx;


--
-- Name: events_2026_03_11_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_11_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_11_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_11_causation_id_idx;


--
-- Name: events_2026_03_11_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_11_correlation_id_idx;


--
-- Name: events_2026_03_11_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_11_event_id_timestamp_key;


--
-- Name: events_2026_03_11_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_11_event_type_timestamp_idx;


--
-- Name: events_2026_03_11_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_11_impact_idx;


--
-- Name: events_2026_03_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_11_pkey;


--
-- Name: events_2026_03_11_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_11_severity_idx;


--
-- Name: events_2026_03_11_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_11_timestamp_idx;


--
-- Name: events_2026_03_12_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_12_actor_type_actor_id_idx;


--
-- Name: events_2026_03_12_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_12_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_12_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_12_causation_id_idx;


--
-- Name: events_2026_03_12_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_12_correlation_id_idx;


--
-- Name: events_2026_03_12_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_12_event_id_timestamp_key;


--
-- Name: events_2026_03_12_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_12_event_type_timestamp_idx;


--
-- Name: events_2026_03_12_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_12_impact_idx;


--
-- Name: events_2026_03_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_12_pkey;


--
-- Name: events_2026_03_12_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_12_severity_idx;


--
-- Name: events_2026_03_12_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_12_timestamp_idx;


--
-- Name: events_2026_03_13_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_13_actor_type_actor_id_idx;


--
-- Name: events_2026_03_13_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_13_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_13_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_13_causation_id_idx;


--
-- Name: events_2026_03_13_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_13_correlation_id_idx;


--
-- Name: events_2026_03_13_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_13_event_id_timestamp_key;


--
-- Name: events_2026_03_13_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_13_event_type_timestamp_idx;


--
-- Name: events_2026_03_13_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_13_impact_idx;


--
-- Name: events_2026_03_13_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_13_pkey;


--
-- Name: events_2026_03_13_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_13_severity_idx;


--
-- Name: events_2026_03_13_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_13_timestamp_idx;


--
-- Name: events_2026_03_14_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_14_actor_type_actor_id_idx;


--
-- Name: events_2026_03_14_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_14_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_14_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_14_causation_id_idx;


--
-- Name: events_2026_03_14_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_14_correlation_id_idx;


--
-- Name: events_2026_03_14_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_14_event_id_timestamp_key;


--
-- Name: events_2026_03_14_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_14_event_type_timestamp_idx;


--
-- Name: events_2026_03_14_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_14_impact_idx;


--
-- Name: events_2026_03_14_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_14_pkey;


--
-- Name: events_2026_03_14_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_14_severity_idx;


--
-- Name: events_2026_03_14_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_14_timestamp_idx;


--
-- Name: events_2026_03_15_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_15_actor_type_actor_id_idx;


--
-- Name: events_2026_03_15_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_15_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_15_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_15_causation_id_idx;


--
-- Name: events_2026_03_15_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_15_correlation_id_idx;


--
-- Name: events_2026_03_15_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_15_event_id_timestamp_key;


--
-- Name: events_2026_03_15_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_15_event_type_timestamp_idx;


--
-- Name: events_2026_03_15_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_15_impact_idx;


--
-- Name: events_2026_03_15_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_15_pkey;


--
-- Name: events_2026_03_15_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_15_severity_idx;


--
-- Name: events_2026_03_15_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_15_timestamp_idx;


--
-- Name: events_2026_03_16_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_16_actor_type_actor_id_idx;


--
-- Name: events_2026_03_16_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_16_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_16_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_16_causation_id_idx;


--
-- Name: events_2026_03_16_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_16_correlation_id_idx;


--
-- Name: events_2026_03_16_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_16_event_id_timestamp_key;


--
-- Name: events_2026_03_16_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_16_event_type_timestamp_idx;


--
-- Name: events_2026_03_16_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_16_impact_idx;


--
-- Name: events_2026_03_16_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_16_pkey;


--
-- Name: events_2026_03_16_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_16_severity_idx;


--
-- Name: events_2026_03_16_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_16_timestamp_idx;


--
-- Name: events_2026_03_17_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_17_actor_type_actor_id_idx;


--
-- Name: events_2026_03_17_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_17_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_17_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_17_causation_id_idx;


--
-- Name: events_2026_03_17_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_17_correlation_id_idx;


--
-- Name: events_2026_03_17_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_17_event_id_timestamp_key;


--
-- Name: events_2026_03_17_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_17_event_type_timestamp_idx;


--
-- Name: events_2026_03_17_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_17_impact_idx;


--
-- Name: events_2026_03_17_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_17_pkey;


--
-- Name: events_2026_03_17_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_17_severity_idx;


--
-- Name: events_2026_03_17_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_17_timestamp_idx;


--
-- Name: events_2026_03_18_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_18_actor_type_actor_id_idx;


--
-- Name: events_2026_03_18_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_18_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_18_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_18_causation_id_idx;


--
-- Name: events_2026_03_18_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_18_correlation_id_idx;


--
-- Name: events_2026_03_18_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_18_event_id_timestamp_key;


--
-- Name: events_2026_03_18_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_18_event_type_timestamp_idx;


--
-- Name: events_2026_03_18_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_18_impact_idx;


--
-- Name: events_2026_03_18_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_18_pkey;


--
-- Name: events_2026_03_18_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_18_severity_idx;


--
-- Name: events_2026_03_18_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_18_timestamp_idx;


--
-- Name: events_2026_03_19_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_19_actor_type_actor_id_idx;


--
-- Name: events_2026_03_19_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_19_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_19_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_19_causation_id_idx;


--
-- Name: events_2026_03_19_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_19_correlation_id_idx;


--
-- Name: events_2026_03_19_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_19_event_id_timestamp_key;


--
-- Name: events_2026_03_19_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_19_event_type_timestamp_idx;


--
-- Name: events_2026_03_19_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_19_impact_idx;


--
-- Name: events_2026_03_19_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_19_pkey;


--
-- Name: events_2026_03_19_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_19_severity_idx;


--
-- Name: events_2026_03_19_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_19_timestamp_idx;


--
-- Name: events_2026_03_20_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_20_actor_type_actor_id_idx;


--
-- Name: events_2026_03_20_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_20_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_20_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_20_causation_id_idx;


--
-- Name: events_2026_03_20_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_20_correlation_id_idx;


--
-- Name: events_2026_03_20_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_20_event_id_timestamp_key;


--
-- Name: events_2026_03_20_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_20_event_type_timestamp_idx;


--
-- Name: events_2026_03_20_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_20_impact_idx;


--
-- Name: events_2026_03_20_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_20_pkey;


--
-- Name: events_2026_03_20_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_20_severity_idx;


--
-- Name: events_2026_03_20_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_20_timestamp_idx;


--
-- Name: events_2026_03_21_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_21_actor_type_actor_id_idx;


--
-- Name: events_2026_03_21_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_21_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_21_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_21_causation_id_idx;


--
-- Name: events_2026_03_21_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_21_correlation_id_idx;


--
-- Name: events_2026_03_21_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_21_event_id_timestamp_key;


--
-- Name: events_2026_03_21_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_21_event_type_timestamp_idx;


--
-- Name: events_2026_03_21_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_21_impact_idx;


--
-- Name: events_2026_03_21_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_21_pkey;


--
-- Name: events_2026_03_21_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_21_severity_idx;


--
-- Name: events_2026_03_21_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_21_timestamp_idx;


--
-- Name: events_2026_03_22_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_22_actor_type_actor_id_idx;


--
-- Name: events_2026_03_22_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_22_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_22_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_22_causation_id_idx;


--
-- Name: events_2026_03_22_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_22_correlation_id_idx;


--
-- Name: events_2026_03_22_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_22_event_id_timestamp_key;


--
-- Name: events_2026_03_22_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_22_event_type_timestamp_idx;


--
-- Name: events_2026_03_22_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_22_impact_idx;


--
-- Name: events_2026_03_22_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_22_pkey;


--
-- Name: events_2026_03_22_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_22_severity_idx;


--
-- Name: events_2026_03_22_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_22_timestamp_idx;


--
-- Name: events_2026_03_23_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_23_actor_type_actor_id_idx;


--
-- Name: events_2026_03_23_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_23_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_23_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_23_causation_id_idx;


--
-- Name: events_2026_03_23_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_23_correlation_id_idx;


--
-- Name: events_2026_03_23_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_23_event_id_timestamp_key;


--
-- Name: events_2026_03_23_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_23_event_type_timestamp_idx;


--
-- Name: events_2026_03_23_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_23_impact_idx;


--
-- Name: events_2026_03_23_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_23_pkey;


--
-- Name: events_2026_03_23_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_23_severity_idx;


--
-- Name: events_2026_03_23_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_23_timestamp_idx;


--
-- Name: events_2026_03_24_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_24_actor_type_actor_id_idx;


--
-- Name: events_2026_03_24_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_24_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_24_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_24_causation_id_idx;


--
-- Name: events_2026_03_24_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_24_correlation_id_idx;


--
-- Name: events_2026_03_24_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_24_event_id_timestamp_key;


--
-- Name: events_2026_03_24_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_24_event_type_timestamp_idx;


--
-- Name: events_2026_03_24_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_24_impact_idx;


--
-- Name: events_2026_03_24_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_24_pkey;


--
-- Name: events_2026_03_24_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_24_severity_idx;


--
-- Name: events_2026_03_24_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_24_timestamp_idx;


--
-- Name: events_2026_03_25_actor_type_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_actor ATTACH PARTITION public.events_2026_03_25_actor_type_actor_id_idx;


--
-- Name: events_2026_03_25_aggregate_type_aggregate_id_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_aggregate ATTACH PARTITION public.events_2026_03_25_aggregate_type_aggregate_id_timestamp_idx;


--
-- Name: events_2026_03_25_causation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_causation ATTACH PARTITION public.events_2026_03_25_causation_id_idx;


--
-- Name: events_2026_03_25_correlation_id_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_correlation ATTACH PARTITION public.events_2026_03_25_correlation_id_idx;


--
-- Name: events_2026_03_25_event_id_timestamp_key; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_event_id_timestamp_key ATTACH PARTITION public.events_2026_03_25_event_id_timestamp_key;


--
-- Name: events_2026_03_25_event_type_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_type ATTACH PARTITION public.events_2026_03_25_event_type_timestamp_idx;


--
-- Name: events_2026_03_25_impact_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_impact ATTACH PARTITION public.events_2026_03_25_impact_idx;


--
-- Name: events_2026_03_25_pkey; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.events_pkey ATTACH PARTITION public.events_2026_03_25_pkey;


--
-- Name: events_2026_03_25_severity_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_severity ATTACH PARTITION public.events_2026_03_25_severity_idx;


--
-- Name: events_2026_03_25_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: postgres
--

ALTER INDEX public.idx_events_timestamp ATTACH PARTITION public.events_2026_03_25_timestamp_idx;


--
-- Name: active_rollouts _RETURN; Type: RULE; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW public.active_rollouts AS
 SELECT r.id,
    r.rollout_id,
    r.image_name,
    r.old_tag,
    r.new_tag,
    r.registry,
    r.policy_id,
    r.strategy,
    r.total_devices,
    r.batch_sizes,
    r.status,
    r.current_batch,
    r.updated_devices,
    r.failed_devices,
    r.healthy_devices,
    r.rolled_back_devices,
    r.failure_rate,
    r.auto_paused,
    r.scheduled_at,
    r.started_at,
    r.paused_at,
    r.resumed_at,
    r.completed_at,
    r.created_at,
    r.updated_at,
    r.triggered_by,
    r.webhook_payload,
    r.filters_applied,
    r.error_message,
    r.notes,
    p.image_pattern,
    p.description AS policy_description,
    (((r.updated_devices)::double precision / (NULLIF(r.total_devices, 0))::double precision) * (100)::double precision) AS progress_percentage,
    count(DISTINCT d.device_uuid) FILTER (WHERE ((d.status)::text = 'completed'::text)) AS devices_completed,
    count(DISTINCT d.device_uuid) FILTER (WHERE ((d.status)::text = 'failed'::text)) AS devices_failed,
    count(DISTINCT d.device_uuid) FILTER (WHERE ((d.status)::text = ANY ((ARRAY['pending'::character varying, 'scheduled'::character varying])::text[]))) AS devices_pending
   FROM ((public.image_rollouts r
     LEFT JOIN public.image_update_policies p ON ((r.policy_id = p.id)))
     LEFT JOIN public.device_rollout_status d ON (((r.rollout_id)::text = (d.rollout_id)::text)))
  WHERE ((r.status)::text = ANY ((ARRAY['pending'::character varying, 'scheduled'::character varying, 'in_progress'::character varying, 'paused'::character varying])::text[]))
  GROUP BY r.id, p.id;


--
-- Name: dashboard_layouts dashboard_layouts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER dashboard_layouts_updated_at BEFORE UPDATE ON public.dashboard_layouts FOR EACH ROW EXECUTE FUNCTION public.update_dashboard_layouts_updated_at();


--
-- Name: device_job_status device_job_status_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER device_job_status_updated_at BEFORE UPDATE ON public.device_job_status FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_executions job_executions_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER job_executions_updated_at BEFORE UPDATE ON public.job_executions FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_handlers job_handlers_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER job_handlers_updated_at BEFORE UPDATE ON public.job_handlers FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: job_templates job_templates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER job_templates_updated_at BEFORE UPDATE ON public.job_templates FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: mqtt_topics mqtt_topics_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER mqtt_topics_updated_at BEFORE UPDATE ON public.mqtt_topics FOR EACH ROW EXECUTE FUNCTION public.update_mqtt_topics_updated_at();


--
-- Name: scheduled_jobs scheduled_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER scheduled_jobs_updated_at BEFORE UPDATE ON public.scheduled_jobs FOR EACH ROW EXECUTE FUNCTION public.update_job_updated_at();


--
-- Name: device_traffic_stats traffic_stats_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER traffic_stats_updated_at BEFORE UPDATE ON public.device_traffic_stats FOR EACH ROW EXECUTE FUNCTION public.update_traffic_stats_updated_at();


--
-- Name: device_sensors trg_update_device_sensor_timestamp; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_update_device_sensor_timestamp BEFORE UPDATE ON public.device_sensors FOR EACH ROW EXECUTE FUNCTION public.update_device_sensor_timestamp();


--
-- Name: device_sensors trg_update_sensor_deployment_timestamp; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_update_sensor_deployment_timestamp BEFORE UPDATE ON public.device_sensors FOR EACH ROW EXECUTE FUNCTION public.update_sensor_deployment_timestamp();


--
-- Name: devices trigger_archive_device_api_key; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_archive_device_api_key BEFORE UPDATE OF device_api_key_hash ON public.devices FOR EACH ROW WHEN (((old.device_api_key_hash)::text IS DISTINCT FROM (new.device_api_key_hash)::text)) EXECUTE FUNCTION public.archive_device_api_key();


--
-- Name: device_target_state trigger_deployment_history; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_deployment_history AFTER INSERT OR UPDATE ON public.device_target_state FOR EACH ROW EXECUTE FUNCTION public.create_deployment_history_snapshot();


--
-- Name: device_flows trigger_device_flows_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_device_flows_updated_at BEFORE UPDATE ON public.device_flows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: TRIGGER trigger_device_flows_updated_at ON device_flows; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TRIGGER trigger_device_flows_updated_at ON public.device_flows IS 'Automatically updates updated_at timestamp on row modification';


--
-- Name: device_tags trigger_device_tags_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_device_tags_updated_at BEFORE UPDATE ON public.device_tags FOR EACH ROW EXECUTE FUNCTION public.update_device_tags_timestamp();


--
-- Name: mqtt_broker_config trigger_ensure_one_default_broker; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_ensure_one_default_broker BEFORE INSERT OR UPDATE OF is_default ON public.mqtt_broker_config FOR EACH ROW WHEN ((new.is_default = true)) EXECUTE FUNCTION public.ensure_one_default_broker();


--
-- Name: fleet_billing_history trigger_fleet_billing_history_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_fleet_billing_history_updated_at BEFORE UPDATE ON public.fleet_billing_history FOR EACH ROW EXECUTE FUNCTION public.update_fleet_billing_history_timestamp();


--
-- Name: fleets trigger_fleets_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_fleets_updated_at BEFORE UPDATE ON public.fleets FOR EACH ROW EXECUTE FUNCTION public.update_fleet_timestamp();


--
-- Name: mqtt_broker_config trigger_mqtt_broker_config_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_mqtt_broker_config_updated_at BEFORE UPDATE ON public.mqtt_broker_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: nodered_credentials trigger_nodered_credentials_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_nodered_credentials_updated_at BEFORE UPDATE ON public.nodered_credentials FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_flows trigger_nodered_flows_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_nodered_flows_updated_at BEFORE UPDATE ON public.nodered_flows FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_library trigger_nodered_library_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_nodered_library_updated_at BEFORE UPDATE ON public.nodered_library FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_sessions trigger_nodered_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_nodered_sessions_updated_at BEFORE UPDATE ON public.nodered_sessions FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: nodered_settings trigger_nodered_settings_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_nodered_settings_updated_at BEFORE UPDATE ON public.nodered_settings FOR EACH ROW EXECUTE FUNCTION public.update_nodered_updated_at();


--
-- Name: profile_configs trigger_profile_configs_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_profile_configs_updated_at BEFORE UPDATE ON public.profile_configs FOR EACH ROW EXECUTE FUNCTION public.update_profile_configs_updated_at();


--
-- Name: tag_definitions trigger_tag_definitions_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_tag_definitions_updated_at BEFORE UPDATE ON public.tag_definitions FOR EACH ROW EXECUTE FUNCTION public.update_tag_definitions_timestamp();


--
-- Name: agent_updates update_agent_updates_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_agent_updates_updated_at BEFORE UPDATE ON public.agent_updates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: applications update_applications_modified_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_applications_modified_at BEFORE UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: device_environment_variable update_device_environment_variable_modified_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_device_environment_variable_modified_at BEFORE UPDATE ON public.device_environment_variable FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: device_rollout_status update_device_rollout_status_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_device_rollout_status_updated_at BEFORE UPDATE ON public.device_rollout_status FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: device_services update_device_services_modified_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_device_services_modified_at BEFORE UPDATE ON public.device_services FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: devices update_devices_modified_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_devices_modified_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: image_rollouts update_image_rollouts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_image_rollouts_updated_at BEFORE UPDATE ON public.image_rollouts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: image_update_policies update_image_update_policies_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_image_update_policies_updated_at BEFORE UPDATE ON public.image_update_policies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: log_alert_rules update_log_alert_rules_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_log_alert_rules_updated_at BEFORE UPDATE ON public.log_alert_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: log_alerts update_log_alerts_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_log_alerts_updated_at BEFORE UPDATE ON public.log_alerts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: releases update_releases_modified_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_releases_modified_at BEFORE UPDATE ON public.releases FOR EACH ROW EXECUTE FUNCTION public.update_modified_at_column();


--
-- Name: _hyper_1_115_chunk 115_110_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_115_chunk
    ADD CONSTRAINT "115_110_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_62_chunk 62_46_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_62_chunk
    ADD CONSTRAINT "62_46_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_72_chunk 72_48_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_72_chunk
    ADD CONSTRAINT "72_48_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_75_chunk 75_51_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_75_chunk
    ADD CONSTRAINT "75_51_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_77_chunk 77_54_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_77_chunk
    ADD CONSTRAINT "77_54_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_80_chunk 80_57_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_80_chunk
    ADD CONSTRAINT "80_57_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: _hyper_1_82_chunk 82_60_fk_device_logs_device; Type: FK CONSTRAINT; Schema: _timescaledb_internal; Owner: postgres
--

ALTER TABLE ONLY _timescaledb_internal._hyper_1_82_chunk
    ADD CONSTRAINT "82_60_fk_device_logs_device" FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: agent_updates agent_updates_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_updates
    ADD CONSTRAINT agent_updates_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: anomaly_alerts anomaly_alerts_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.anomaly_alerts
    ADD CONSTRAINT anomaly_alerts_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.anomaly_incidents(incident_id);


--
-- Name: audit_logs audit_logs_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE SET NULL;


--
-- Name: dashboard_layouts dashboard_layouts_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dashboard_layouts dashboard_layouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: device_api_key_history device_api_key_history_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_key_history
    ADD CONSTRAINT device_api_key_history_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_api_keys device_api_keys_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_api_keys
    ADD CONSTRAINT device_api_keys_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_current_state device_current_state_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_current_state
    ADD CONSTRAINT device_current_state_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_entries device_dictionary_entries_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT device_dictionary_entries_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_metadata device_dictionary_metadata_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_metadata
    ADD CONSTRAINT device_dictionary_metadata_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_environment_variable device_environment_variable_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_environment_variable
    ADD CONSTRAINT device_environment_variable_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_flows device_flows_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_flows
    ADD CONSTRAINT device_flows_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_job_status device_job_status_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_job_status
    ADD CONSTRAINT device_job_status_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_job_status device_job_status_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_job_status
    ADD CONSTRAINT device_job_status_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.job_executions(job_id) ON DELETE CASCADE;


--
-- Name: device_rollout_status device_rollout_status_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_rollout_status
    ADD CONSTRAINT device_rollout_status_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_rollout_status device_rollout_status_rollout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_rollout_status
    ADD CONSTRAINT device_rollout_status_rollout_id_fkey FOREIGN KEY (rollout_id) REFERENCES public.image_rollouts(rollout_id) ON DELETE CASCADE;


--
-- Name: device_sensors device_sensors_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_sensors
    ADD CONSTRAINT device_sensors_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_services device_services_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_services
    ADD CONSTRAINT device_services_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_shadow_history device_shadow_history_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadow_history
    ADD CONSTRAINT device_shadow_history_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_shadows device_shadows_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_shadows
    ADD CONSTRAINT device_shadows_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_tags device_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_tags
    ADD CONSTRAINT device_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: device_tags device_tags_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_tags
    ADD CONSTRAINT device_tags_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_target_state device_target_state_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state
    ADD CONSTRAINT device_target_state_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_target_state_history device_target_state_history_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_target_state_history
    ADD CONSTRAINT device_target_state_history_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: devices devices_provisioned_by_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_provisioned_by_key_id_fkey FOREIGN KEY (provisioned_by_key_id) REFERENCES public.provisioning_keys(id) ON DELETE SET NULL;


--
-- Name: dictionary_enum_devices dictionary_enum_devices_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_devices
    ADD CONSTRAINT dictionary_enum_devices_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_metrics dictionary_enum_metrics_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_metrics
    ADD CONSTRAINT dictionary_enum_metrics_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_observations dictionary_enum_observations_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_observations
    ADD CONSTRAINT dictionary_enum_observations_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_quality_codes dictionary_enum_quality_codes_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_quality_codes
    ADD CONSTRAINT dictionary_enum_quality_codes_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: dictionary_enum_units dictionary_enum_units_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.dictionary_enum_units
    ADD CONSTRAINT dictionary_enum_units_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: device_logs fk_device_logs_device; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.device_logs
    ADD CONSTRAINT fk_device_logs_device FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: shell_sessions fk_shell_sessions_device; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shell_sessions
    ADD CONSTRAINT fk_shell_sessions_device FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: image_approval_requests image_approval_requests_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_approval_requests
    ADD CONSTRAINT image_approval_requests_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: image_rollouts image_rollouts_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_rollouts
    ADD CONSTRAINT image_rollouts_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.image_update_policies(id) ON DELETE SET NULL;


--
-- Name: image_tags image_tags_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.image_tags
    ADD CONSTRAINT image_tags_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;


--
-- Name: job_executions job_executions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.job_templates(id) ON DELETE SET NULL;


--
-- Name: log_alert_rules log_alert_rules_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alert_rules
    ADD CONSTRAINT log_alert_rules_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: log_alerts log_alerts_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: log_alerts log_alerts_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.log_alerts
    ADD CONSTRAINT log_alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.log_alert_rules(id) ON DELETE CASCADE;


--
-- Name: provisioning_attempts provisioning_attempts_provisioning_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.provisioning_attempts
    ADD CONSTRAINT provisioning_attempts_provisioning_key_id_fkey FOREIGN KEY (provisioning_key_id) REFERENCES public.provisioning_keys(id) ON DELETE SET NULL;


--
-- Name: reconciliation_history reconciliation_history_current_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reconciliation_history
    ADD CONSTRAINT reconciliation_history_current_snapshot_id_fkey FOREIGN KEY (current_snapshot_id) REFERENCES public.state_snapshots(id);


--
-- Name: reconciliation_history reconciliation_history_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reconciliation_history
    ADD CONSTRAINT reconciliation_history_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: reconciliation_history reconciliation_history_target_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reconciliation_history
    ADD CONSTRAINT reconciliation_history_target_snapshot_id_fkey FOREIGN KEY (target_snapshot_id) REFERENCES public.state_snapshots(id);


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: releases releases_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.applications(id) ON DELETE CASCADE;


--
-- Name: sensor_health_history sensor_health_history_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sensor_health_history
    ADD CONSTRAINT sensor_health_history_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: shell_audit_log shell_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.shell_audit_log
    ADD CONSTRAINT shell_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: state_changes state_changes_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_changes
    ADD CONSTRAINT state_changes_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: state_changes state_changes_parent_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_changes
    ADD CONSTRAINT state_changes_parent_snapshot_id_fkey FOREIGN KEY (parent_snapshot_id) REFERENCES public.state_snapshots(id);


--
-- Name: state_snapshots state_snapshots_device_uuid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.state_snapshots
    ADD CONSTRAINT state_snapshots_device_uuid_fkey FOREIGN KEY (device_uuid) REFERENCES public.devices(uuid) ON DELETE CASCADE;


--
-- Name: tag_definitions tag_definitions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tag_definitions
    ADD CONSTRAINT tag_definitions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--





