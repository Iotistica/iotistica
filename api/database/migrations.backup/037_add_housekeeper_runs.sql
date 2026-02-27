-- Migration 037: Add housekeeper task execution tracking
-- This enables the dashboard to display task history, logs, and status

-- Create housekeeper_runs table to track task executions
CREATE TABLE IF NOT EXISTS housekeeper_runs (
  id SERIAL PRIMARY KEY,
  task_name VARCHAR(255) NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  status VARCHAR(50) NOT NULL DEFAULT 'running', -- running, success, error
  duration_ms INTEGER,
  output TEXT,
  error TEXT,
  triggered_by VARCHAR(50) DEFAULT 'scheduler', -- scheduler, manual, startup
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_housekeeper_runs_task_name ON housekeeper_runs(task_name);
CREATE INDEX IF NOT EXISTS idx_housekeeper_runs_started_at ON housekeeper_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_housekeeper_runs_status ON housekeeper_runs(status);

-- Create housekeeper_config table for task enable/disable state
CREATE TABLE IF NOT EXISTS housekeeper_config (
  task_name VARCHAR(255) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  schedule VARCHAR(100), -- Cron expression
  last_modified_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_modified_by VARCHAR(255)
);

-- Function to clean up old housekeeper runs (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_housekeeper_runs(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  rows_deleted BIGINT;
BEGIN
  DELETE FROM housekeeper_runs
  WHERE started_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  
  RETURN QUERY SELECT rows_deleted;
END;
$$ LANGUAGE plpgsql;

-- Function to get task execution statistics
CREATE OR REPLACE FUNCTION get_housekeeper_stats()
RETURNS TABLE(
  task_name VARCHAR,
  total_runs BIGINT,
  success_count BIGINT,
  error_count BIGINT,
  avg_duration_ms NUMERIC,
  last_run_at TIMESTAMP,
  last_status VARCHAR
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    hr.task_name,
    COUNT(*) as total_runs,
    COUNT(*) FILTER (WHERE hr.status = 'success') as success_count,
    COUNT(*) FILTER (WHERE hr.status = 'error') as error_count,
    ROUND(AVG(hr.duration_ms)::NUMERIC, 2) as avg_duration_ms,
    MAX(hr.started_at) as last_run_at,
    (SELECT status FROM housekeeper_runs WHERE task_name = hr.task_name ORDER BY started_at DESC LIMIT 1) as last_status
  FROM housekeeper_runs hr
  WHERE hr.started_at > NOW() - INTERVAL '30 days'
  GROUP BY hr.task_name
  ORDER BY hr.task_name;
END;
$$ LANGUAGE plpgsql;

-- Add comment
COMMENT ON TABLE housekeeper_runs IS 'Tracks execution history of housekeeper maintenance tasks';
COMMENT ON TABLE housekeeper_config IS 'Configuration for housekeeper tasks (enable/disable, schedules)';
