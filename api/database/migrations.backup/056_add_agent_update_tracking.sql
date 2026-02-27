-- Migration: Add agent update tracking
-- Purpose: Track agent update attempts, status, and history
-- Date: 2025-11-10

BEGIN;

-- Agent update history table
CREATE TABLE IF NOT EXISTS agent_updates (
    id BIGSERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    
    -- Update details
    target_version VARCHAR(100) NOT NULL,
    current_version VARCHAR(100),
    deployment_type VARCHAR(50), -- 'docker' or 'systemd'
    
    -- Status tracking
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    -- Status values:
    --   'pending'         - Update command sent, waiting for device acknowledgment
    --   'acknowledged'    - Device received update command
    --   'scheduled'       - Update scheduled for future time
    --   'in_progress'     - Update is currently running
    --   'succeeded'       - Update completed successfully
    --   'failed'          - Update failed
    --   'timeout'         - Update timed out (no response from device)
    --   'cancelled'       - Update was cancelled
    
    -- Timing
    scheduled_time TIMESTAMP,           -- When update should run (if scheduled)
    started_at TIMESTAMP,               -- When update actually started
    completed_at TIMESTAMP,             -- When update finished (success or fail)
    timeout_at TIMESTAMP,               -- When update will timeout
    
    -- Configuration
    force BOOLEAN DEFAULT FALSE,        -- Whether this was a forced update
    retain_data BOOLEAN DEFAULT TRUE,   -- Whether to retain data during update
    
    -- Results
    exit_code INTEGER,                  -- Exit code from update script
    error_message TEXT,                 -- Error message if failed
    update_log TEXT,                    -- Log output from update script
    
    -- Metadata
    triggered_by VARCHAR(100),          -- 'api', 'user', 'system', 'scheduled'
    triggered_by_user_id INTEGER,      -- User who triggered (if applicable)
    correlation_id UUID,                -- Link to event chain
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX idx_agent_updates_device_uuid ON agent_updates(device_uuid);
CREATE INDEX idx_agent_updates_status ON agent_updates(status);
CREATE INDEX idx_agent_updates_created_at ON agent_updates(created_at DESC);
CREATE INDEX idx_agent_updates_device_status ON agent_updates(device_uuid, status);
CREATE INDEX idx_agent_updates_scheduled ON agent_updates(scheduled_time) WHERE scheduled_time IS NOT NULL;

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_agent_updates_updated_at 
    BEFORE UPDATE ON agent_updates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to get latest update status for a device
CREATE OR REPLACE FUNCTION get_device_latest_update(p_device_uuid UUID)
RETURNS TABLE(
    id BIGINT,
    target_version VARCHAR,
    status VARCHAR,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
) AS $$
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
$$ LANGUAGE plpgsql;

-- Function to get pending updates (for monitoring/alerting)
CREATE OR REPLACE FUNCTION get_pending_updates(p_timeout_minutes INTEGER DEFAULT 30)
RETURNS TABLE(
    device_uuid UUID,
    target_version VARCHAR,
    status VARCHAR,
    created_at TIMESTAMP,
    minutes_elapsed INTEGER
) AS $$
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
$$ LANGUAGE plpgsql;

-- View for update statistics
CREATE OR REPLACE VIEW agent_update_stats AS
SELECT 
    DATE_TRUNC('day', created_at) as date,
    status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds
FROM agent_updates
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at), status
ORDER BY date DESC, status;

COMMIT;

-- Display summary
SELECT 
    'Agent Update Tracking Installed' as status,
    (SELECT COUNT(*) FROM agent_updates) as total_updates,
    (SELECT COUNT(*) FROM agent_updates WHERE status = 'succeeded') as successful_updates,
    (SELECT COUNT(*) FROM agent_updates WHERE status = 'failed') as failed_updates;
