-- Migration: Event Sourcing for Container Orchestration
-- Based on industry best practices (Kubernetes, Balena, AWS EventBridge)
-- This implements a full event sourcing system for state management

BEGIN;

-- Note: PostgreSQL 13+ has built-in sha256() - no extension needed
-- Azure PostgreSQL blocks pgcrypto extension

-- ============================================================================
-- 1. EVENT STORE (Core of Event Sourcing)
-- ============================================================================

-- Main event store: Immutable log of all events
CREATE TABLE events (
    -- Identity
    id BIGSERIAL,
    event_id UUID NOT NULL DEFAULT gen_random_uuid(),
    
    -- Event metadata
    event_type VARCHAR(100) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- Aggregate (what entity this event affects)
    aggregate_type VARCHAR(50) NOT NULL, -- 'device', 'app', 'volume', 'network'
    aggregate_id VARCHAR(255) NOT NULL,  -- device_uuid, app_name, etc.
    
    -- Event data (immutable)
    data JSONB NOT NULL,                 -- Event payload
    metadata JSONB,                      -- Context (user_id, ip, request_id, etc.)
    
    -- Causation & Correlation (for event chains)
    correlation_id UUID,                 -- Groups related events
    causation_id UUID,                   -- Event that caused this event
    
    -- Source
    source VARCHAR(100),                 -- 'api', 'supervisor', 'user', 'system'
    
    -- Checksum for integrity
    checksum VARCHAR(64) NOT NULL,       -- SHA256 of event data
    
    -- Primary key must include partition key
    PRIMARY KEY (id, timestamp),
    UNIQUE (event_id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create indexes for fast queries
CREATE INDEX idx_events_aggregate ON events(aggregate_type, aggregate_id, timestamp);
CREATE INDEX idx_events_type ON events(event_type, timestamp);
CREATE INDEX idx_events_correlation ON events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_causation ON events(causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);

-- Create initial partitions (last 30 days + next 7 days)
CREATE OR REPLACE FUNCTION create_events_partition(partition_date DATE)
RETURNS TEXT AS $$
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
$$ LANGUAGE plpgsql;

-- Create partitions for -30 to +7 days
SELECT create_events_partition((CURRENT_DATE + (i || ' days')::INTERVAL)::DATE)
FROM generate_series(-30, 7) AS i;

-- ============================================================================
-- 2. EVENT TYPES REGISTRY (Self-documenting)
-- ============================================================================

CREATE TABLE event_types (
    event_type VARCHAR(100) PRIMARY KEY,
    description TEXT,
    schema JSONB,                        -- JSON Schema for validation
    aggregate_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Register common event types
INSERT INTO event_types (event_type, aggregate_type, description) VALUES
-- Device events
('device.provisioned', 'device', 'Device was provisioned and added to system'),
('device.deprovisioned', 'device', 'Device was removed from system'),
('device.online', 'device', 'Device came online'),
('device.offline', 'device', 'Device went offline'),
('device.heartbeat', 'device', 'Device sent heartbeat'),

-- Target state events
('target_state.updated', 'device', 'Target state was updated for device'),
('target_state.app_added', 'device', 'Application added to target state'),
('target_state.app_removed', 'device', 'Application removed from target state'),
('target_state.app_updated', 'device', 'Application updated in target state'),
('target_state.config_changed', 'device', 'Configuration changed in target state'),
('target_state.volume_added', 'device', 'Volume added to target state'),
('target_state.volume_removed', 'device', 'Volume removed from target state'),
('target_state.network_added', 'device', 'Network added to target state'),
('target_state.network_removed', 'device', 'Network removed from target state'),

-- Current state events
('current_state.updated', 'device', 'Current state was updated by device'),
('current_state.app_started', 'device', 'Application started on device'),
('current_state.app_stopped', 'device', 'Application stopped on device'),
('current_state.app_crashed', 'device', 'Application crashed on device'),
('current_state.app_health_changed', 'device', 'Application health status changed'),

-- Reconciliation events
('reconciliation.started', 'device', 'Reconciliation cycle started'),
('reconciliation.completed', 'device', 'Reconciliation cycle completed'),
('reconciliation.failed', 'device', 'Reconciliation cycle failed'),
('reconciliation.drift_detected', 'device', 'State drift detected between target and current'),

-- Container events
('container.created', 'app', 'Container was created'),
('container.started', 'app', 'Container was started'),
('container.stopped', 'app', 'Container was stopped'),
('container.removed', 'app', 'Container was removed'),
('container.restarted', 'app', 'Container was restarted'),
('container.crashed', 'app', 'Container crashed'),
('container.health_check_failed', 'app', 'Container health check failed'),

-- Image events
('image.pulled', 'app', 'Container image was pulled'),
('image.pull_failed', 'app', 'Container image pull failed'),
('image.removed', 'app', 'Container image was removed'),

-- Volume events
('volume.created', 'volume', 'Volume was created'),
('volume.removed', 'volume', 'Volume was removed'),
('volume.attached', 'volume', 'Volume was attached to container'),
('volume.detached', 'volume', 'Volume was detached from container'),

-- Network events
('network.created', 'network', 'Network was created'),
('network.removed', 'network', 'Network was removed'),
('network.connected', 'network', 'Container connected to network'),
('network.disconnected', 'network', 'Container disconnected from network');

-- ============================================================================
-- 3. PROJECTIONS (Read Models from Events)
-- ============================================================================

-- Current state projection (rebuilt from events)
CREATE TABLE state_projections (
    device_uuid UUID PRIMARY KEY,
    target_state JSONB,
    current_state JSONB,
    target_version BIGINT,              -- Last event ID for target
    current_version BIGINT,             -- Last event ID for current
    last_reconciliation_at TIMESTAMP,
    in_sync BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Event processing cursor (track what's been processed)
CREATE TABLE event_cursors (
    processor_name VARCHAR(100) PRIMARY KEY,
    last_event_id BIGINT NOT NULL,
    last_processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 4. EVENT PUBLISHING FUNCTIONS
-- ============================================================================

-- Function to publish an event (main entry point)
CREATE OR REPLACE FUNCTION publish_event(
    p_event_type VARCHAR,
    p_aggregate_type VARCHAR,
    p_aggregate_id VARCHAR,
    p_data JSONB,
    p_source VARCHAR DEFAULT 'system',
    p_correlation_id UUID DEFAULT NULL,
    p_causation_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
    v_checksum VARCHAR(64);
    v_correlation_id UUID;
BEGIN
    -- Generate correlation ID if not provided
    v_correlation_id := COALESCE(p_correlation_id, gen_random_uuid());
    
    -- Calculate checksum using built-in sha256()
    v_checksum := encode(sha256(p_data::text::bytea), 'hex');
    
    -- Insert event
    INSERT INTO events (
        event_type, aggregate_type, aggregate_id,
        data, metadata, source,
        correlation_id, causation_id, checksum
    ) VALUES (
        p_event_type, p_aggregate_type, p_aggregate_id,
        p_data, p_metadata, p_source,
        v_correlation_id, p_causation_id, v_checksum
    ) RETURNING event_id INTO v_event_id;
    
    -- Notify listeners (for real-time event processing)
    PERFORM pg_notify('events', json_build_object(
        'event_id', v_event_id,
        'event_type', p_event_type,
        'aggregate_type', p_aggregate_type,
        'aggregate_id', p_aggregate_id
    )::text);
    
    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 5. EVENT REPLAY & PROJECTION BUILDING
-- ============================================================================

-- Function to rebuild device state from events
CREATE OR REPLACE FUNCTION rebuild_device_state(p_device_uuid UUID)
RETURNS JSONB AS $$
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
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 6. QUERY FUNCTIONS (Event Sourcing Queries)
-- ============================================================================

-- Get all events for an aggregate
CREATE OR REPLACE FUNCTION get_aggregate_events(
    p_aggregate_type VARCHAR,
    p_aggregate_id VARCHAR,
    p_since BIGINT DEFAULT NULL
) RETURNS TABLE(
    id BIGINT,
    event_id UUID,
    event_type VARCHAR,
    event_timestamp TIMESTAMP,
    data JSONB,
    metadata JSONB
) AS $$
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
$$ LANGUAGE plpgsql;

-- Get events by correlation ID (trace event chain)
CREATE OR REPLACE FUNCTION get_event_chain(p_correlation_id UUID)
RETURNS TABLE(
    id BIGINT,
    event_id UUID,
    event_type VARCHAR,
    aggregate_type VARCHAR,
    aggregate_id VARCHAR,
    event_timestamp TIMESTAMP,
    data JSONB,
    causation_id UUID
) AS $$
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
$$ LANGUAGE plpgsql;

-- Get event statistics
CREATE OR REPLACE FUNCTION get_event_stats(p_days_back INTEGER DEFAULT 7)
RETURNS TABLE(
    event_type VARCHAR,
    aggregate_type VARCHAR,
    event_count BIGINT,
    first_seen TIMESTAMP,
    last_seen TIMESTAMP
) AS $$
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
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 7. EVENT RETENTION (Cleanup old events)
-- ============================================================================

-- Function to drop old event partitions
CREATE OR REPLACE FUNCTION drop_old_event_partitions(p_retention_days INTEGER DEFAULT 90)
RETURNS TABLE(result TEXT) AS $$
DECLARE
    v_partition RECORD;
    v_cutoff_date DATE;
    v_partition_date DATE;
BEGIN
    v_cutoff_date := CURRENT_DATE - p_retention_days;
    
    FOR v_partition IN
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE 'events_%'
        AND tablename ~ '^events_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    LOOP
        BEGIN
            v_partition_date := TO_DATE(
                SUBSTRING(v_partition.tablename FROM 'events_(.*)'),
                'YYYY_MM_DD'
            );
            
            IF v_partition_date < v_cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', v_partition.tablename);
                RETURN QUERY SELECT 'DROPPED: ' || v_partition.tablename;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT 'ERROR: ' || v_partition.tablename || ' - ' || SQLERRM;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- Display summary
SELECT 
    'Event Sourcing System Installed' as status,
    (SELECT COUNT(*) FROM event_types) as event_types_registered,
    (SELECT COUNT(*) FROM pg_tables WHERE tablename LIKE 'events_%') as partitions_created;
