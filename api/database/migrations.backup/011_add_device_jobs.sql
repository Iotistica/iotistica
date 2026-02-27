-- Migration 011: Add Device Jobs Management
-- Creates tables for managing device jobs (inspired by AWS IoT Jobs)

BEGIN;

-- Job Templates - Reusable job definitions
CREATE TABLE IF NOT EXISTS job_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    category VARCHAR(100),  -- 'system', 'maintenance', 'deployment', 'custom'
    job_document JSONB NOT NULL,  -- Job document schema (v1.0)
    created_by VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Job Executions - Individual job instances sent to devices
CREATE TABLE IF NOT EXISTS job_executions (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(255) NOT NULL UNIQUE,  -- Unique job identifier (UUID)
    template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
    job_name VARCHAR(255) NOT NULL,
    job_document JSONB NOT NULL,
    
    -- Target devices
    target_type VARCHAR(50) NOT NULL,  -- 'device', 'group', 'all'
    target_devices UUID[],  -- Array of device UUIDs (if target_type='device')
    target_filter JSONB,    -- Filter criteria (if target_type='group')
    
    -- Execution settings
    execution_type VARCHAR(50) DEFAULT 'oneTime',  -- 'oneTime', 'recurring', 'continuous'
    schedule JSONB,  -- For recurring jobs
    max_executions INTEGER,
    timeout_minutes INTEGER DEFAULT 60,
    
    -- Status
    status VARCHAR(50) DEFAULT 'QUEUED',  -- QUEUED, IN_PROGRESS, SUCCEEDED, FAILED, CANCELED
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Statistics
    total_devices INTEGER DEFAULT 0,
    succeeded_devices INTEGER DEFAULT 0,
    failed_devices INTEGER DEFAULT 0,
    in_progress_devices INTEGER DEFAULT 0,
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device Job Status - Per-device execution tracking
CREATE TABLE IF NOT EXISTS device_job_status (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(255) NOT NULL REFERENCES job_executions(job_id) ON DELETE CASCADE,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    
    -- Execution info
    status VARCHAR(50) DEFAULT 'QUEUED',  -- QUEUED, IN_PROGRESS, SUCCEEDED, FAILED, TIMED_OUT, REJECTED, CANCELED
    execution_number INTEGER DEFAULT 1,
    version_number INTEGER DEFAULT 1,
    
    -- Timing
    queued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    last_updated_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Results
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    reason TEXT,
    executed_steps INTEGER,
    failed_step VARCHAR(255),
    
    -- Status details (custom key-value pairs from device)
    status_details JSONB DEFAULT '{}',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(job_id, device_uuid)
);

-- Job Handlers - Registered handler scripts on devices
CREATE TABLE IF NOT EXISTS job_handlers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    script_type VARCHAR(50) DEFAULT 'bash',  -- 'bash', 'python', 'node'
    script_content TEXT NOT NULL,
    permissions VARCHAR(10) DEFAULT '700',
    default_args JSONB DEFAULT '[]',
    created_by VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(name)
);

-- Indexes for performance
CREATE INDEX idx_job_executions_status ON job_executions(status);
CREATE INDEX idx_job_executions_created_at ON job_executions(created_at DESC);
CREATE INDEX idx_job_executions_job_id ON job_executions(job_id);
CREATE INDEX idx_device_job_status_job_id ON device_job_status(job_id);
CREATE INDEX idx_device_job_status_device_uuid ON device_job_status(device_uuid);
CREATE INDEX idx_device_job_status_status ON device_job_status(status);
CREATE INDEX idx_job_templates_category ON job_templates(category);
CREATE INDEX idx_job_templates_is_active ON job_templates(is_active);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_job_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER job_templates_updated_at
    BEFORE UPDATE ON job_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_job_updated_at();

CREATE TRIGGER job_executions_updated_at
    BEFORE UPDATE ON job_executions
    FOR EACH ROW
    EXECUTE FUNCTION update_job_updated_at();

CREATE TRIGGER device_job_status_updated_at
    BEFORE UPDATE ON device_job_status
    FOR EACH ROW
    EXECUTE FUNCTION update_job_updated_at();

CREATE TRIGGER job_handlers_updated_at
    BEFORE UPDATE ON job_handlers
    FOR EACH ROW
    EXECUTE FUNCTION update_job_updated_at();

-- Insert sample job templates
INSERT INTO job_templates (name, description, category, job_document) VALUES
('restart-service', 'Restart a specific service', 'system', '{
  "version": "1.0",
  "includeStdOut": true,
  "steps": [
    {
      "name": "Restart Service",
      "type": "runCommand",
      "input": {
        "command": "systemctl,restart,{{SERVICE_NAME}}"
      },
      "runAsUser": "root"
    }
  ]
}'),
('update-config', 'Update configuration file', 'system', '{
  "version": "1.0",
  "includeStdOut": true,
  "steps": [
    {
      "name": "Backup Config",
      "type": "runCommand",
      "input": {
        "command": "cp,{{CONFIG_PATH}},{{CONFIG_PATH}}.backup"
      }
    },
    {
      "name": "Download New Config",
      "type": "runHandler",
      "input": {
        "handler": "download-file",
        "args": ["{{CONFIG_URL}}", "{{CONFIG_PATH}}"]
      }
    }
  ],
  "finalStep": {
    "name": "Restart Service",
    "type": "runCommand",
    "input": {
      "command": "systemctl,restart,{{SERVICE_NAME}}"
    },
    "runAsUser": "root"
  }
}'),
('health-check', 'System health check', 'maintenance', '{
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
    },
    {
      "name": "Check Services",
      "type": "runCommand",
      "input": {
        "command": "systemctl,status,{{SERVICE_NAME}}"
      }
    }
  ]
}');

-- Insert sample job handlers
INSERT INTO job_handlers (name, description, script_type, script_content) VALUES
('download-file', 'Download file from URL', 'bash', '#!/bin/bash
# Downloads a file from URL to destination
# Args: $2=URL, $3=DEST_PATH

URL=$2
DEST=$3

echo "Downloading from $URL to $DEST"
curl -fsSL -o "$DEST" "$URL"
exit $?
'),
('backup-directory', 'Backup directory to tar.gz', 'bash', '#!/bin/bash
# Backup directory to compressed archive
# Args: $2=SOURCE_DIR, $3=BACKUP_NAME

SOURCE=$2
BACKUP_NAME=$3
BACKUP_DIR="/var/backups"

mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" "$SOURCE"
echo "Backup created: $BACKUP_DIR/${BACKUP_NAME}.tar.gz"
exit $?
');

COMMIT;

-- Display summary
SELECT 
    'Device Jobs System Installed' as status,
    (SELECT COUNT(*) FROM job_templates) as job_templates_created,
    (SELECT COUNT(*) FROM job_handlers) as job_handlers_created;
