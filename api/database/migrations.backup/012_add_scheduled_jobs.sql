-- Migration 012: Add Scheduled Jobs Table
-- Creates table for managing recurring/scheduled job configurations

BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id SERIAL PRIMARY KEY,
    schedule_id VARCHAR(255) NOT NULL UNIQUE,
    job_name VARCHAR(255) NOT NULL,
    description TEXT,
    job_document JSONB NOT NULL,
    
    -- Target devices
    target_type VARCHAR(50) NOT NULL,  -- 'device', 'group', 'all'
    target_devices UUID[],  -- Array of device UUIDs (if target_type='device')
    target_filter JSONB,    -- Filter criteria (if target_type='group')
    
    -- Schedule configuration
    schedule_type VARCHAR(50) NOT NULL,  -- 'cron', 'interval'
    cron_expression VARCHAR(255),  -- Cron expression (if schedule_type='cron')
    interval_minutes INTEGER,      -- Interval in minutes (if schedule_type='interval')
    
    -- Execution limits
    max_executions INTEGER,  -- Maximum number of times to execute (NULL = unlimited)
    timeout_minutes INTEGER DEFAULT 60,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    execution_count INTEGER DEFAULT 0,
    last_execution_at TIMESTAMP,
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT chk_schedule_type CHECK (schedule_type IN ('cron', 'interval')),
    CONSTRAINT chk_target_type CHECK (target_type IN ('device', 'group', 'all')),
    CONSTRAINT chk_cron_or_interval CHECK (
        (schedule_type = 'cron' AND cron_expression IS NOT NULL) OR
        (schedule_type = 'interval' AND interval_minutes IS NOT NULL)
    )
);

-- Indexes
CREATE INDEX idx_scheduled_jobs_is_active ON scheduled_jobs(is_active);
CREATE INDEX idx_scheduled_jobs_schedule_id ON scheduled_jobs(schedule_id);
CREATE INDEX idx_scheduled_jobs_created_at ON scheduled_jobs(created_at DESC);

-- Update trigger
CREATE TRIGGER scheduled_jobs_updated_at
    BEFORE UPDATE ON scheduled_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_job_updated_at();

-- Insert sample scheduled jobs
INSERT INTO scheduled_jobs (
    schedule_id, job_name, description, job_document, target_type,
    schedule_type, cron_expression, is_active
) VALUES
(
    gen_random_uuid()::varchar,
    'Hourly Health Check',
    'Automated health check every hour',
    '{
      "version": "1.0",
      "includeStdOut": true,
      "steps": [
        {
          "name": "Check Disk Space",
          "type": "runCommand",
          "input": {
            "command": "df,-h"
          }
        },
        {
          "name": "Check Memory",
          "type": "runCommand",
          "input": {
            "command": "free,-h"
          }
        }
      ]
    }'::jsonb,
    'all',
    'cron',
    '0 * * * *',  -- Every hour at minute 0
    false  -- Disabled by default (example only)
),
(
    gen_random_uuid()::varchar,
    'Daily Backup',
    'Backup critical data daily at 2 AM',
    '{
      "version": "1.0",
      "includeStdOut": true,
      "steps": [
        {
          "name": "Backup Data",
          "type": "runHandler",
          "input": {
            "handler": "backup-directory",
            "args": ["/app/data", "daily-backup"]
          }
        }
      ]
    }'::jsonb,
    'all',
    'cron',
    '0 2 * * *',  -- Every day at 2:00 AM
    false  -- Disabled by default (example only)
);

COMMIT;

-- Display summary
SELECT 
    'Scheduled Jobs Table Created' as status,
    (SELECT COUNT(*) FROM scheduled_jobs) as sample_schedules_created;
