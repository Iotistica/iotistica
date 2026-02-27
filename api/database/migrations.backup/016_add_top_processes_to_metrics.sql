-- Add top_processes column to device_metrics table
-- This stores the top 10 CPU/memory consuming processes as JSONB array

ALTER TABLE device_metrics 
ADD COLUMN IF NOT EXISTS top_processes JSONB DEFAULT '[]';

-- Add comment for documentation
COMMENT ON COLUMN device_metrics.top_processes IS 'Top 10 processes by CPU/memory usage: [{pid, name, cpu, mem, command}]';

-- Create index for querying process data
CREATE INDEX IF NOT EXISTS idx_device_metrics_top_processes ON device_metrics USING GIN (top_processes);

-- Also add top_processes to devices table for latest snapshot
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS top_processes JSONB DEFAULT '[]';

COMMENT ON COLUMN devices.top_processes IS 'Latest snapshot of top 10 processes';
CREATE INDEX IF NOT EXISTS idx_devices_top_processes ON devices USING GIN (top_processes);
