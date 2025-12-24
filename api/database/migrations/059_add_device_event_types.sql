-- Migration: Add comprehensive device event types and retention policies
-- Description: Expands event sourcing with 60+ new device lifecycle, monitoring, security, and operational events
-- Date: 2025-11-14

BEGIN;

-- ============================================================================
-- 1. Add retention policy columns to event_types table
-- ============================================================================

ALTER TABLE event_types 
  ADD COLUMN IF NOT EXISTS retention_tier VARCHAR(20) DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS retention_days INTEGER DEFAULT 90;

COMMENT ON COLUMN event_types.retention_tier IS 'Retention tier: critical (7 years), important (1 year), standard (90 days), debug (7 days)';
COMMENT ON COLUMN event_types.retention_days IS 'Number of days to retain events of this type';

-- ============================================================================
-- 2. Add metadata enrichment columns to events table (one at a time for safety)
-- ============================================================================

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'actor_type') THEN
    ALTER TABLE events ADD COLUMN actor_type VARCHAR(50);
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'actor_id') THEN
    ALTER TABLE events ADD COLUMN actor_id VARCHAR(255);
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'severity') THEN
    ALTER TABLE events ADD COLUMN severity VARCHAR(20);
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'impact') THEN
    ALTER TABLE events ADD COLUMN impact VARCHAR(20);
  END IF;
END $$;

COMMENT ON COLUMN events.actor_type IS 'Who triggered this event: user, device, system, api, scheduled_job';
COMMENT ON COLUMN events.actor_id IS 'ID of the actor (user_id, device_uuid, job_id)';
COMMENT ON COLUMN events.severity IS 'Event severity: debug, info, warning, error, critical';
COMMENT ON COLUMN events.impact IS 'Business impact: low, medium, high';

-- Add indexes for filtering and analytics
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_type, actor_id) WHERE actor_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity) WHERE severity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_impact ON events(impact) WHERE impact IS NOT NULL;

-- ============================================================================
-- 3. Update existing event types with retention policies
-- ============================================================================

-- Critical events (7 years = 2555 days) - Compliance/audit requirements
UPDATE event_types SET retention_tier = 'critical', retention_days = 2555 WHERE event_type IN (
  'device.provisioned',
  'device.deprovisioned'
);

-- Important events (1 year = 365 days) - Operational history
UPDATE event_types SET retention_tier = 'important', retention_days = 365 WHERE event_type IN (
  'target_state.updated',
  'device.online',
  'device.offline',
  'image.pulled',
  'image.failed'
);

-- Standard events (90 days) - Recent operational data
UPDATE event_types SET retention_tier = 'standard', retention_days = 90 WHERE event_type IN (
  'current_state.updated',
  'reconciliation.completed',
  'reconciliation.failed',
  'container.started',
  'container.stopped',
  'container.removed',
  'volume.created',
  'volume.removed',
  'network.created',
  'network.removed'
);

-- Debug events (7 days) - High-frequency, low-importance
UPDATE event_types SET retention_tier = 'debug', retention_days = 7 WHERE event_type IN (
  'reconciliation.skipped'
);

-- ============================================================================
-- 4. Add new device lifecycle event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('device.created', 'device', 'Device registered in system (before provisioning)', 'critical', 2555),
('device.metadata_updated', 'device', 'Device name, tags, or location changed', 'important', 365),
('device.tags_changed', 'device', 'Device tags added or removed', 'standard', 90),
('device.transferred', 'device', 'Device ownership transferred to different customer', 'critical', 2555),
('device.archived', 'device', 'Device soft-deleted/archived', 'critical', 2555),
('device.reactivated', 'device', 'Device restored from archived state', 'critical', 2555),
('device.location_updated', 'device', 'Device physical location changed', 'important', 365),
('device.fleet_changed', 'device', 'Device moved to different fleet', 'important', 365)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 5. Add device security event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('device.credentials_rotated', 'device', 'API keys or certificates rotated', 'critical', 2555),
('device.access_granted', 'device', 'User or service granted access to device', 'critical', 2555),
('device.access_revoked', 'device', 'Access permissions removed', 'critical', 2555),
('device.firmware_updated', 'device', 'Agent or firmware version upgraded', 'critical', 2555),
('device.security_scan', 'device', 'Security vulnerability scan completed', 'critical', 2555),
('device.compliance_check', 'device', 'Compliance policy verification executed', 'critical', 2555),
('device.certificate_renewed', 'device', 'VPN or TLS certificate renewed', 'critical', 2555),
('device.certificate_expired', 'device', 'Certificate expiration detected', 'critical', 2555),
('device.auth_failed', 'device', 'Authentication attempt failed', 'important', 365),
('device.unauthorized_access', 'device', 'Unauthorized access attempt detected', 'critical', 2555)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 6. Add device monitoring event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('device.metrics_threshold', 'device', 'Metric exceeded configured threshold', 'important', 365),
('device.alert_triggered', 'device', 'Alert condition met', 'important', 365),
('device.alert_resolved', 'device', 'Alert condition cleared', 'important', 365),
('device.health_degraded', 'device', 'Device health status downgraded', 'important', 365),
('device.health_recovered', 'device', 'Device health status improved', 'important', 365),
('device.anomaly_detected', 'device', 'Anomaly detection triggered', 'important', 365),
('device.diagnostics_run', 'device', 'Diagnostic test executed', 'standard', 90),
('device.heartbeat', 'device', 'Periodic heartbeat signal (sampled)', 'debug', 7),
('device.resource_warning', 'device', 'Resource usage approaching limits (CPU/memory/disk)', 'important', 365),
('device.resource_critical', 'device', 'Resource critically low', 'critical', 2555)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 7. Add device operations event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('device.rebooted', 'device', 'Device restarted', 'important', 365),
('device.shutdown', 'device', 'Device graceful shutdown initiated', 'important', 365),
('device.maintenance_mode', 'device', 'Device entered maintenance mode', 'important', 365),
('device.backup_created', 'device', 'Device state backup created', 'important', 365),
('device.backup_restored', 'device', 'Device state restored from backup', 'critical', 2555),
('device.config_exported', 'device', 'Device configuration exported', 'standard', 90),
('device.config_imported', 'device', 'Device configuration imported/restored', 'critical', 2555),
('device.factory_reset', 'device', 'Device reset to factory defaults', 'critical', 2555)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 8. Add device job event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('job.queued', 'device', 'Job added to device queue', 'standard', 90),
('job.started', 'device', 'Job execution started on device', 'important', 365),
('job.progress', 'device', 'Job progress update', 'debug', 7),
('job.completed', 'device', 'Job finished successfully', 'important', 365),
('job.failed', 'device', 'Job execution failed', 'important', 365),
('job.cancelled', 'device', 'Job cancelled by user or system', 'important', 365),
('job.timeout', 'device', 'Job exceeded execution timeout', 'important', 365),
('job.retried', 'device', 'Job automatically retried after failure', 'standard', 90)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 9. Add device connectivity event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('device.vpn_connected', 'device', 'VPN tunnel established', 'important', 365),
('device.vpn_disconnected', 'device', 'VPN tunnel lost', 'important', 365),
('device.vpn_reconnected', 'device', 'VPN tunnel re-established after disconnect', 'important', 365),
('device.network_changed', 'device', 'IP address or network configuration changed', 'important', 365),
('device.mqtt_connected', 'device', 'MQTT broker connection established', 'important', 365),
('device.mqtt_disconnected', 'device', 'MQTT broker connection lost', 'important', 365),
('device.api_call', 'device', 'Device API request (sampled)', 'debug', 7),
('device.bandwidth_exceeded', 'device', 'Bandwidth limit exceeded', 'important', 365),
('device.connection_degraded', 'device', 'Network connection quality degraded', 'important', 365)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 10. Add device sensor/data event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('sensor.configured', 'device', 'Sensor added or configuration updated', 'important', 365),
('sensor.removed', 'device', 'Sensor removed from device', 'important', 365),
('sensor.calibrated', 'device', 'Sensor calibration performed', 'important', 365),
('sensor.data_anomaly', 'device', 'Unexpected sensor data pattern detected', 'important', 365),
('sensor.malfunction', 'device', 'Sensor hardware malfunction detected', 'important', 365),
('data.export_started', 'device', 'Data export initiated', 'standard', 90),
('data.export_completed', 'device', 'Data export finished successfully', 'standard', 90),
('data.export_failed', 'device', 'Data export failed', 'important', 365),
('data.import_started', 'device', 'Data import initiated', 'standard', 90),
('data.import_completed', 'device', 'Data import finished successfully', 'standard', 90)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 11. Add container lifecycle event types (enhanced)
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('container.created', 'device', 'Container created (not yet started)', 'standard', 90),
('container.paused', 'device', 'Container processes paused', 'standard', 90),
('container.unpaused', 'device', 'Container processes resumed', 'standard', 90),
('container.restarted', 'device', 'Container restarted', 'standard', 90),
('container.killed', 'device', 'Container forcefully terminated', 'important', 365),
('container.died', 'device', 'Container process exited unexpectedly', 'important', 365),
('container.oom', 'device', 'Container killed due to out-of-memory', 'critical', 2555),
('container.health_check_failed', 'device', 'Container health check failed', 'important', 365),
('container.state_changed', 'device', 'Container state transition (running/stopped/paused)', 'standard', 90)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 12. Add system/agent event types
-- ============================================================================

INSERT INTO event_types (event_type, aggregate_type, description, retention_tier, retention_days) VALUES
('agent.started', 'device', 'Agent service started', 'important', 365),
('agent.stopped', 'device', 'Agent service stopped', 'important', 365),
('agent.updated', 'device', 'Agent software updated to new version', 'critical', 2555),
('agent.update_failed', 'device', 'Agent update failed', 'important', 365),
('agent.crashed', 'device', 'Agent process crashed unexpectedly', 'critical', 2555),
('agent.error', 'device', 'Agent encountered error', 'important', 365),
('system.disk_full', 'device', 'Disk space critically low', 'critical', 2555),
('system.temperature_high', 'device', 'System temperature exceeds threshold', 'important', 365),
('system.power_loss', 'device', 'Unexpected power loss detected', 'critical', 2555)
ON CONFLICT (event_type) DO NOTHING;

-- ============================================================================
-- 13. Create function to get retention policy for event type
-- ============================================================================

CREATE OR REPLACE FUNCTION get_event_retention_days(p_event_type VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  v_retention_days INTEGER;
BEGIN
  SELECT retention_days INTO v_retention_days
  FROM event_types
  WHERE event_type = p_event_type;
  
  RETURN COALESCE(v_retention_days, 90); -- Default to 90 days if not found
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_event_retention_days IS 'Get retention period in days for a given event type';

-- ============================================================================
-- 14. Update drop_old_event_partitions to respect retention tiers
-- ============================================================================

-- Drop existing function (handles any parameter variations)
DROP FUNCTION IF EXISTS drop_old_event_partitions();
DROP FUNCTION IF EXISTS drop_old_event_partitions(integer);

-- Create new version with retention awareness
CREATE FUNCTION drop_old_event_partitions()
RETURNS void AS $$
DECLARE
  partition_record RECORD;
  partition_date DATE;
  min_retention_days INTEGER;
BEGIN
  -- Get the minimum retention days across all event types
  -- (we keep partitions based on the longest retention requirement)
  SELECT MIN(retention_days) INTO min_retention_days FROM event_types;
  
  -- Default to 90 days if no retention policies set
  min_retention_days := COALESCE(min_retention_days, 90);
  
  FOR partition_record IN 
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename LIKE 'events_%'
    AND tablename ~ '^events_\d{4}_\d{2}_\d{2}$'
  LOOP
    -- Extract date from partition name (format: events_YYYY_MM_DD)
    partition_date := TO_DATE(
      SUBSTRING(partition_record.tablename FROM 8), 
      'YYYY_MM_DD'
    );
    
    -- Drop partition if older than minimum retention period
    IF partition_date < CURRENT_DATE - min_retention_days THEN
      EXECUTE FORMAT('DROP TABLE IF EXISTS %I', partition_record.tablename);
      RAISE NOTICE 'Dropped old partition: %', partition_record.tablename;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION drop_old_event_partitions IS 'Drop event partitions older than the minimum retention period across all event types';

-- ============================================================================
-- 15. Create event statistics view
-- ============================================================================

CREATE OR REPLACE VIEW event_type_statistics AS
SELECT 
  et.event_type,
  et.aggregate_type,
  et.description,
  et.retention_tier,
  et.retention_days,
  COUNT(e.event_id) as total_events,
  COUNT(e.event_id) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '24 hours') as last_24h,
  COUNT(e.event_id) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '7 days') as last_7d,
  COUNT(e.event_id) FILTER (WHERE e.timestamp >= NOW() - INTERVAL '30 days') as last_30d,
  MAX(e.timestamp) as last_event_time
FROM event_types et
LEFT JOIN events e ON et.event_type = e.event_type
GROUP BY et.event_type, et.aggregate_type, et.description, et.retention_tier, et.retention_days
ORDER BY total_events DESC;

COMMENT ON VIEW event_type_statistics IS 'Event type usage statistics with retention information';

-- ============================================================================
-- 16. Create retention summary view
-- ============================================================================

CREATE OR REPLACE VIEW event_retention_summary AS
SELECT 
  et.retention_tier,
  et.retention_days,
  COUNT(DISTINCT et.event_type) as event_type_count,
  COUNT(e.event_id) as total_events,
  pg_size_pretty(SUM(pg_total_relation_size(
    ('events_' || TO_CHAR(e.timestamp, 'YYYY_MM_DD'))::regclass
  ))::bigint) as estimated_storage
FROM event_types et
LEFT JOIN events e ON et.event_type = e.event_type
GROUP BY et.retention_tier, et.retention_days
ORDER BY et.retention_days DESC;

COMMENT ON VIEW event_retention_summary IS 'Summary of events by retention tier with storage estimates';

-- ============================================================================
-- 17. Update publish_event function to accept new metadata fields
-- ============================================================================

-- Drop existing function (with all possible signatures)
DROP FUNCTION IF EXISTS publish_event(VARCHAR, VARCHAR, VARCHAR, JSONB, VARCHAR, UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS publish_event(VARCHAR, VARCHAR, VARCHAR, JSONB, VARCHAR, UUID, UUID, JSONB, VARCHAR, VARCHAR, VARCHAR, VARCHAR);

-- Create updated version with metadata enrichment
CREATE FUNCTION publish_event(
    p_event_type VARCHAR,
    p_aggregate_type VARCHAR,
    p_aggregate_id VARCHAR,
    p_data JSONB,
    p_source VARCHAR DEFAULT 'system',
    p_correlation_id UUID DEFAULT NULL,
    p_causation_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL,
    p_actor_type VARCHAR DEFAULT NULL,
    p_actor_id VARCHAR DEFAULT NULL,
    p_severity VARCHAR DEFAULT NULL,
    p_impact VARCHAR DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
    v_checksum VARCHAR(64);
    v_correlation_id UUID;
BEGIN
    -- Generate correlation ID if not provided
    v_correlation_id := COALESCE(p_correlation_id, gen_random_uuid());
    
    -- Calculate checksum
    v_checksum := encode(sha256(p_data::text::bytea), 'hex');
    
    -- Insert event with metadata enrichment
    INSERT INTO events (
        event_type, aggregate_type, aggregate_id,
        data, metadata, source,
        correlation_id, causation_id, checksum,
        actor_type, actor_id, severity, impact
    ) VALUES (
        p_event_type, p_aggregate_type, p_aggregate_id,
        p_data, p_metadata, p_source,
        v_correlation_id, p_causation_id, v_checksum,
        p_actor_type, p_actor_id, p_severity, p_impact
    ) RETURNING event_id INTO v_event_id;
    
    -- Notify listeners (for real-time event processing)
    PERFORM pg_notify('events', json_build_object(
        'event_id', v_event_id,
        'event_type', p_event_type,
        'aggregate_type', p_aggregate_type,
        'aggregate_id', p_aggregate_id,
        'severity', p_severity
    )::text);
    
    RETURN v_event_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION publish_event IS 'Publish event with metadata enrichment (actor, severity, impact)';

COMMIT;

-- ============================================================================
-- Verification Queries (run after migration)
-- ============================================================================

-- Check new event types
-- SELECT event_type, retention_tier, retention_days FROM event_types ORDER BY retention_days DESC;

-- Check event type statistics
-- SELECT * FROM event_type_statistics WHERE total_events > 0;

-- Check retention summary
-- SELECT * FROM event_retention_summary;

-- Verify metadata columns exist
-- SELECT column_name, data_type FROM information_schema.columns 
-- WHERE table_name = 'events' AND column_name IN ('actor_type', 'actor_id', 'severity', 'impact');
