-- Migration 038: Fix ambiguous name error in housekeeper stats function

-- Drop the old function first (safe because we're recreating it)
DROP FUNCTION IF EXISTS get_housekeeper_stats();

-- Recreate the function with fixed aliases
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
$$ LANGUAGE plpgsql;

-- Add comment
COMMENT ON FUNCTION get_housekeeper_stats() IS 'Returns summarized stats for housekeeper tasks (fixed ambiguous alias issue)';
