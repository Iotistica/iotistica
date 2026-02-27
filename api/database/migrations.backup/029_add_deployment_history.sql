-- Migration: Add Deployment History Tracking
-- Enables rollback capability and full audit trail of deployments

BEGIN;

-- Deployment history: Snapshot of each deployment for rollback and audit
CREATE TABLE device_target_state_history (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    
    -- State snapshot at deployment time
    apps JSONB NOT NULL DEFAULT '{}'::jsonb,
    config JSONB DEFAULT '{}'::jsonb,
    
    -- Deployment metadata
    deployed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deployed_by VARCHAR(255) NOT NULL,
    
    -- Change tracking
    changes_summary TEXT, -- Human-readable summary of changes
    apps_count INTEGER, -- Number of apps in this version
    services_count INTEGER, -- Total number of services across all apps
    
    -- Rollback support
    is_rollback BOOLEAN DEFAULT false,
    rollback_from_version INTEGER, -- If this is a rollback, which version we rolled back from
    
    -- Audit
    deployment_notes TEXT, -- Optional notes about this deployment
    metadata JSONB, -- Additional context (user_id, request_id, ci_pipeline, etc.)
    
    CONSTRAINT unique_device_version UNIQUE(device_uuid, version)
);

-- Indexes for performance
CREATE INDEX idx_target_history_device_version ON device_target_state_history(device_uuid, version DESC);
CREATE INDEX idx_target_history_deployed_at ON device_target_state_history(device_uuid, deployed_at DESC);
CREATE INDEX idx_target_history_deployed_by ON device_target_state_history(deployed_by);
CREATE INDEX idx_target_history_rollback ON device_target_state_history(device_uuid, is_rollback) WHERE is_rollback = true;

-- Add comments for documentation
COMMENT ON TABLE device_target_state_history IS 'Historical snapshots of device target state at each deployment for audit and rollback';
COMMENT ON COLUMN device_target_state_history.version IS 'Version number at time of deployment (matches device_target_state.version)';
COMMENT ON COLUMN device_target_state_history.apps IS 'Complete apps configuration at this deployment';
COMMENT ON COLUMN device_target_state_history.is_rollback IS 'True if this deployment was a rollback to a previous version';
COMMENT ON COLUMN device_target_state_history.rollback_from_version IS 'If rollback, the version we rolled back from';

-- Trigger function: Auto-create history snapshot on deployment
CREATE OR REPLACE FUNCTION create_deployment_history_snapshot()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- Create trigger on device_target_state
CREATE TRIGGER trigger_deployment_history
    AFTER INSERT OR UPDATE ON device_target_state
    FOR EACH ROW
    EXECUTE FUNCTION create_deployment_history_snapshot();

-- Helper function: Get deployment history for device
CREATE OR REPLACE FUNCTION get_deployment_history(
    p_device_uuid UUID,
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE(
    version INTEGER,
    deployed_at TIMESTAMP,
    deployed_by VARCHAR,
    apps_count INTEGER,
    services_count INTEGER,
    is_rollback BOOLEAN,
    changes_summary TEXT
) AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Get specific version for rollback
CREATE OR REPLACE FUNCTION get_deployment_version(
    p_device_uuid UUID,
    p_version INTEGER
)
RETURNS TABLE(
    apps JSONB,
    config JSONB,
    deployed_at TIMESTAMP,
    deployed_by VARCHAR
) AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Compare two versions (for rollback preview)
CREATE OR REPLACE FUNCTION compare_deployment_versions(
    p_device_uuid UUID,
    p_from_version INTEGER,
    p_to_version INTEGER
)
RETURNS JSONB AS $$
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
$$ LANGUAGE plpgsql;

-- Helper function: Get deployment statistics
CREATE OR REPLACE FUNCTION get_deployment_stats(
    p_device_uuid UUID DEFAULT NULL,
    p_days_back INTEGER DEFAULT 30
)
RETURNS TABLE(
    total_deployments BIGINT,
    rollback_count BIGINT,
    unique_deployers BIGINT,
    avg_time_between_deployments INTERVAL,
    most_active_deployer VARCHAR
) AS $$
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
$$ LANGUAGE plpgsql;

-- Migrate existing data: Create history entry for current version
INSERT INTO device_target_state_history (
    device_uuid,
    version,
    apps,
    config,
    deployed_at,
    deployed_by,
    apps_count,
    services_count,
    changes_summary
)
SELECT 
    dts.device_uuid,
    dts.version,
    dts.apps,
    dts.config,
    COALESCE(dts.last_deployed_at, dts.updated_at, dts.created_at),
    COALESCE(dts.deployed_by, 'migration'),
    (SELECT COUNT(*) FROM jsonb_object_keys(dts.apps)),
    (SELECT SUM(jsonb_array_length(app.value->'services'))::INTEGER
     FROM jsonb_each(dts.apps) app
     WHERE jsonb_typeof(app.value->'services') = 'array'),
    'Initial history entry from migration'
FROM device_target_state dts
ON CONFLICT (device_uuid, version) DO NOTHING;

COMMIT;

-- Display summary
SELECT 
    'Deployment history table created' as status,
    (SELECT COUNT(*) FROM device_target_state_history) as history_entries_created,
    (SELECT COUNT(DISTINCT device_uuid) FROM device_target_state_history) as devices_with_history,
    'Ready for rollback support' as next_step;
