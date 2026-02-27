-- Migration: Add State Change Tracking
-- Based on industry best practices for container orchestration systems

BEGIN;

-- State snapshots: Full state at key points
CREATE TABLE state_snapshots (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    state_type VARCHAR(20) NOT NULL CHECK (state_type IN ('target', 'current')),
    state JSONB NOT NULL,
    version INTEGER NOT NULL,
    checksum VARCHAR(64) NOT NULL, -- SHA256 hash of state
    source VARCHAR(50), -- 'api', 'supervisor', 'reconciliation', 'user'
    notes TEXT,
    
    UNIQUE(device_uuid, state_type, version)
);

-- State changes: Detailed change log
CREATE TABLE state_changes (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    state_type VARCHAR(20) NOT NULL CHECK (state_type IN ('target', 'current')),
    change_type VARCHAR(50) NOT NULL,
    -- Change types: 'app_added', 'app_removed', 'app_updated', 
    --               'config_changed', 'volume_added', 'network_added', etc.
    
    -- What changed
    entity_type VARCHAR(50), -- 'app', 'volume', 'network', 'config'
    entity_id VARCHAR(255),  -- App name, volume name, etc.
    field_path TEXT,         -- 'apps.my-app.image', 'apps.my-app.env.API_KEY'
    
    -- Values
    old_value JSONB,
    new_value JSONB,
    
    -- Context
    triggered_by VARCHAR(50) NOT NULL, -- 'api', 'supervisor', 'user', 'system'
    correlation_id UUID,    -- Group related changes
    parent_snapshot_id INTEGER REFERENCES state_snapshots(id),
    
    -- Metadata
    metadata JSONB -- Additional context (user_id, request_id, etc.)
);

-- Reconciliation history: Track supervisor reconciliation attempts
CREATE TABLE reconciliation_history (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'success', 'failed', 'partial')),
    
    -- State versions at time of reconciliation
    target_snapshot_id INTEGER REFERENCES state_snapshots(id),
    current_snapshot_id INTEGER REFERENCES state_snapshots(id),
    
    -- Changes applied
    changes_detected INTEGER DEFAULT 0,
    changes_applied INTEGER DEFAULT 0,
    changes_failed INTEGER DEFAULT 0,
    
    -- Details
    diff JSONB,             -- What differences were found
    actions_taken JSONB,    -- What actions were executed
    errors JSONB,           -- Any errors encountered
    
    duration_ms INTEGER,
    correlation_id UUID     -- Link to state_changes
);

-- Indexes for performance
CREATE INDEX idx_state_snapshots_device_time ON state_snapshots(device_uuid, timestamp DESC);
CREATE INDEX idx_state_snapshots_type_version ON state_snapshots(device_uuid, state_type, version DESC);
CREATE INDEX idx_state_snapshots_checksum ON state_snapshots(checksum);

CREATE INDEX idx_state_changes_device_time ON state_changes(device_uuid, timestamp DESC);
CREATE INDEX idx_state_changes_entity ON state_changes(entity_type, entity_id);
CREATE INDEX idx_state_changes_correlation ON state_changes(correlation_id);
CREATE INDEX idx_state_changes_triggered_by ON state_changes(triggered_by);

CREATE INDEX idx_reconciliation_device_time ON reconciliation_history(device_uuid, started_at DESC);
CREATE INDEX idx_reconciliation_status ON reconciliation_history(status);
CREATE INDEX idx_reconciliation_correlation ON reconciliation_history(correlation_id);

-- Helper function: Create state snapshot
CREATE OR REPLACE FUNCTION create_state_snapshot(
    p_device_uuid UUID,
    p_state_type VARCHAR,
    p_state JSONB,
    p_source VARCHAR DEFAULT 'system',
    p_notes TEXT DEFAULT NULL
) RETURNS INTEGER AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Log state change
CREATE OR REPLACE FUNCTION log_state_change(
    p_device_uuid UUID,
    p_state_type VARCHAR,
    p_change_type VARCHAR,
    p_entity_type VARCHAR,
    p_entity_id VARCHAR,
    p_field_path TEXT,
    p_old_value JSONB,
    p_new_value JSONB,
    p_triggered_by VARCHAR,
    p_correlation_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
) RETURNS INTEGER AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Get state changes between two snapshots
CREATE OR REPLACE FUNCTION get_state_diff(
    p_device_uuid UUID,
    p_state_type VARCHAR,
    p_from_version INTEGER,
    p_to_version INTEGER DEFAULT NULL
) RETURNS TABLE(
    change_type VARCHAR,
    entity_type VARCHAR,
    entity_id VARCHAR,
    field_path TEXT,
    old_value JSONB,
    new_value JSONB,
    change_timestamp TIMESTAMP
) AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Get reconciliation summary
CREATE OR REPLACE FUNCTION get_reconciliation_summary(
    p_device_uuid UUID,
    p_days_back INTEGER DEFAULT 7
) RETURNS TABLE(
    date DATE,
    total_reconciliations INTEGER,
    successful INTEGER,
    failed INTEGER,
    avg_duration_ms NUMERIC
) AS $$
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
$$ LANGUAGE plpgsql;

-- Create initial snapshots for existing devices (if target_state exists)
INSERT INTO state_snapshots (device_uuid, state_type, state, version, checksum, source, notes)
SELECT 
    dts.device_uuid,
    'target' as state_type,
    dts.apps as state,  -- Using apps from device_target_state table
    dts.version,
    encode(sha256(dts.apps::text::bytea), 'hex') as checksum,
    'migration' as source,
    'Initial snapshot from migration' as notes
FROM device_target_state dts
WHERE dts.apps IS NOT NULL AND dts.apps != '{}'::jsonb;

COMMIT;

-- Display summary
SELECT 
    'State tracking tables created' as status,
    (SELECT COUNT(*) FROM state_snapshots) as initial_snapshots,
    'Ready for change tracking' as next_step;
