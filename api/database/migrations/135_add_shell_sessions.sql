-- Migration: Add shell sessions table for persistent terminal sessions
-- Description: Enables terminal sessions to persist across client disconnects,
--              allowing users to navigate away and reattach to running sessions

-- Create shell sessions table
CREATE TABLE IF NOT EXISTS shell_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_uuid UUID NOT NULL,
    user_id VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'creating', -- creating, active, detached, terminated
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    terminated_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    
    CONSTRAINT fk_shell_sessions_device 
        FOREIGN KEY (device_uuid) 
        REFERENCES devices(uuid) 
        ON DELETE CASCADE,
    
    CONSTRAINT valid_status 
        CHECK (status IN ('creating', 'active', 'detached', 'terminated'))
);

-- Create indexes for efficient queries
CREATE INDEX idx_shell_sessions_device ON shell_sessions(device_uuid);
CREATE INDEX idx_shell_sessions_status ON shell_sessions(status);
CREATE INDEX idx_shell_sessions_last_activity ON shell_sessions(last_activity);
CREATE INDEX idx_shell_sessions_device_status ON shell_sessions(device_uuid, status);

-- Grant permissions (optional - adjust role as needed for production)
-- Note: Role may not exist in all environments, handle gracefully
DO $$
BEGIN
    -- Try to grant to postgres role (most common)
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON shell_sessions TO postgres;
        RAISE NOTICE 'Granted permissions on shell_sessions to postgres';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Could not grant permissions on shell_sessions: % (%)', SQLERRM, SQLSTATE;
END $$;

-- Add comments for documentation
COMMENT ON TABLE shell_sessions IS 'Persistent shell sessions that survive client disconnects';
COMMENT ON COLUMN shell_sessions.session_id IS 'Unique session identifier (UUID)';
COMMENT ON COLUMN shell_sessions.device_uuid IS 'Device this session is connected to';
COMMENT ON COLUMN shell_sessions.user_id IS 'User who created the session (optional)';
COMMENT ON COLUMN shell_sessions.status IS 'Session lifecycle status: creating, active, detached, terminated';
COMMENT ON COLUMN shell_sessions.last_activity IS 'Last time session received input or output';
COMMENT ON COLUMN shell_sessions.terminated_at IS 'When session was explicitly terminated';
COMMENT ON COLUMN shell_sessions.metadata IS 'Additional session metadata (shell type, terminal size, etc.)';
