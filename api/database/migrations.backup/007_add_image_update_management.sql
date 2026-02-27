-- Migration 007: Add Image Update Management Tables
-- Run with: psql -U postgres -d iotistic_cloud -f database/migrations/007_add_image_update_management.sql

BEGIN;

-- 1. Image Update Policies
CREATE TABLE IF NOT EXISTS image_update_policies (
  id SERIAL PRIMARY KEY,
  image_pattern VARCHAR(255) NOT NULL,  -- e.g., 'iotistic/app:*' or 'iotistic/*:latest'
  update_strategy VARCHAR(50) NOT NULL CHECK (update_strategy IN ('auto', 'staged', 'manual', 'scheduled')),
  
  -- Staged rollout settings
  staged_batches INTEGER DEFAULT 3,
  batch_delay_minutes INTEGER DEFAULT 30,
  
  -- Health check settings
  health_check_enabled BOOLEAN DEFAULT true,
  health_check_timeout_seconds INTEGER DEFAULT 300,
  auto_rollback BOOLEAN DEFAULT true,
  health_check_config JSONB,
  
  -- Scheduling
  maintenance_window_start TIME,
  maintenance_window_end TIME,
  
  -- Filters
  fleet_id VARCHAR(255),
  device_tags JSONB,
  device_uuids TEXT[],
  
  -- Metadata
  enabled BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  description TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_pattern ON image_update_policies(image_pattern);
CREATE INDEX IF NOT EXISTS idx_update_strategy ON image_update_policies(update_strategy);
CREATE INDEX IF NOT EXISTS idx_enabled ON image_update_policies(enabled);

COMMENT ON TABLE image_update_policies IS 'Defines update strategies for Docker images';
COMMENT ON COLUMN image_update_policies.image_pattern IS 'Glob pattern like iotistic/app:* or iotistic/*:latest';
COMMENT ON COLUMN image_update_policies.staged_batches IS 'Number of batches for staged rollout';
COMMENT ON COLUMN image_update_policies.batch_delay_minutes IS 'Wait time between batches';

-- 2. Image Rollouts
CREATE TABLE IF NOT EXISTS image_rollouts (
  id SERIAL PRIMARY KEY,
  rollout_id VARCHAR(255) UNIQUE NOT NULL,
  
  -- Image info
  image_name VARCHAR(255) NOT NULL,
  old_tag VARCHAR(100),
  new_tag VARCHAR(100) NOT NULL,
  registry VARCHAR(255) DEFAULT 'hub.docker.com',
  
  -- Policy reference
  policy_id INTEGER REFERENCES image_update_policies(id) ON DELETE SET NULL,
  
  -- Rollout settings
  strategy VARCHAR(50) NOT NULL CHECK (strategy IN ('auto', 'staged', 'manual', 'scheduled')),
  total_devices INTEGER NOT NULL,
  batch_sizes JSONB,
  
  -- Progress tracking
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN (
    'pending', 'scheduled', 'in_progress', 'paused', 
    'completed', 'failed', 'cancelled', 'rolled_back'
  )),
  current_batch INTEGER DEFAULT 0,
  updated_devices INTEGER DEFAULT 0,
  failed_devices INTEGER DEFAULT 0,
  healthy_devices INTEGER DEFAULT 0,
  rolled_back_devices INTEGER DEFAULT 0,
  
  -- Failure tracking
  failure_rate DECIMAL(5, 4) DEFAULT 0,
  auto_paused BOOLEAN DEFAULT false,
  
  -- Timestamps
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  paused_at TIMESTAMP,
  resumed_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Metadata
  triggered_by VARCHAR(100),
  webhook_payload JSONB,
  filters_applied JSONB,
  error_message TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_rollout_id ON image_rollouts(rollout_id);
CREATE INDEX IF NOT EXISTS idx_rollout_status ON image_rollouts(status);
CREATE INDEX IF NOT EXISTS idx_rollout_image ON image_rollouts(image_name, new_tag);
CREATE INDEX IF NOT EXISTS idx_rollout_created ON image_rollouts(created_at);

COMMENT ON TABLE image_rollouts IS 'Tracks image update rollouts across fleet';
COMMENT ON COLUMN image_rollouts.failure_rate IS 'Fraction of devices that failed (0.0000 to 1.0000)';

-- 3. Device Rollout Status
CREATE TABLE IF NOT EXISTS device_rollout_status (
  id SERIAL PRIMARY KEY,
  rollout_id VARCHAR(255) NOT NULL REFERENCES image_rollouts(rollout_id) ON DELETE CASCADE,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  
  -- Update progress
  batch_number INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN (
    'pending', 'scheduled', 'pulling', 'updating', 'health_checking',
    'completed', 'failed', 'rolled_back', 'skipped'
  )),
  
  -- Image tracking
  old_image_tag VARCHAR(100),
  new_image_tag VARCHAR(100),
  current_image_tag VARCHAR(100),
  
  -- Health tracking
  health_check_passed BOOLEAN,
  health_check_details JSONB,
  health_check_attempts INTEGER DEFAULT 0,
  
  -- Timestamps
  scheduled_at TIMESTAMP,
  update_started_at TIMESTAMP,
  image_pulled_at TIMESTAMP,
  container_restarted_at TIMESTAMP,
  health_checked_at TIMESTAMP,
  update_completed_at TIMESTAMP,
  rolled_back_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Error tracking
  error_message TEXT,
  error_details JSONB,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  
  UNIQUE(rollout_id, device_uuid)
);

CREATE INDEX IF NOT EXISTS idx_device_rollout ON device_rollout_status(rollout_id, device_uuid);
CREATE INDEX IF NOT EXISTS idx_device_status ON device_rollout_status(status);
CREATE INDEX IF NOT EXISTS idx_device_batch ON device_rollout_status(batch_number);

COMMENT ON TABLE device_rollout_status IS 'Per-device status for each rollout';

-- 4. Rollout Events (detailed logging)
CREATE TABLE IF NOT EXISTS rollout_events (
  id SERIAL PRIMARY KEY,
  rollout_id VARCHAR(255) NOT NULL,
  device_uuid UUID,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'rollout_created', 'rollout_started', 'batch_started', 'batch_completed',
    'device_scheduled', 'device_updated', 'device_failed',
    'health_check_passed', 'health_check_failed', 'rollback_triggered',
    'rollout_paused', 'rollout_resumed', 'rollout_completed', 'rollout_failed'
  )),
  event_data JSONB,
  message TEXT,
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rollout_events_rollout ON rollout_events(rollout_id);
CREATE INDEX IF NOT EXISTS idx_rollout_events_device ON rollout_events(device_uuid);
CREATE INDEX IF NOT EXISTS idx_rollout_events_type ON rollout_events(event_type);
CREATE INDEX IF NOT EXISTS idx_rollout_events_timestamp ON rollout_events(timestamp);

COMMENT ON TABLE rollout_events IS 'Detailed event log for rollout debugging';

-- 5. Create helpful views
CREATE OR REPLACE VIEW active_rollouts AS
SELECT 
  r.*,
  p.image_pattern,
  p.description as policy_description,
  (r.updated_devices::float / NULLIF(r.total_devices, 0) * 100) as progress_percentage,
  COUNT(DISTINCT d.device_uuid) FILTER (WHERE d.status = 'completed') as devices_completed,
  COUNT(DISTINCT d.device_uuid) FILTER (WHERE d.status = 'failed') as devices_failed,
  COUNT(DISTINCT d.device_uuid) FILTER (WHERE d.status IN ('pending', 'scheduled')) as devices_pending
FROM image_rollouts r
LEFT JOIN image_update_policies p ON r.policy_id = p.id
LEFT JOIN device_rollout_status d ON r.rollout_id = d.rollout_id
WHERE r.status IN ('pending', 'scheduled', 'in_progress', 'paused')
GROUP BY r.id, p.id;

COMMENT ON VIEW active_rollouts IS 'Active rollouts with progress statistics';

-- 6. Add trigger to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_image_update_policies_updated_at BEFORE UPDATE ON image_update_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_image_rollouts_updated_at BEFORE UPDATE ON image_rollouts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_device_rollout_status_updated_at BEFORE UPDATE ON device_rollout_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
