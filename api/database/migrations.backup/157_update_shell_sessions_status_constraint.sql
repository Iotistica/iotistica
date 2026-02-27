-- Migration: Update shell sessions status constraint
-- Description: Add 'starting' and 'agent-timeout' status values to shell_sessions table
--              to support better user feedback when agent is not responding

-- Drop existing constraint
ALTER TABLE shell_sessions DROP CONSTRAINT IF EXISTS valid_status;

-- Add updated constraint with new status values
ALTER TABLE shell_sessions ADD CONSTRAINT valid_status 
    CHECK (status IN ('creating', 'starting', 'active', 'detached', 'agent-timeout', 'terminated'));

-- Update comment to reflect new statuses
COMMENT ON COLUMN shell_sessions.status IS 'Session lifecycle status: creating (session created), starting (command sent to agent), active (agent responded), detached (client disconnected), agent-timeout (agent not responding), terminated (session ended)';
