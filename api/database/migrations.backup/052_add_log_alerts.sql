-- Migration: Add Log Alert System
-- Description: Alert rules and instances for device log monitoring
-- Author: System
-- Date: 2025-11-07
-- Feature: Log pattern matching and alerting

-- ============================================================================
-- OVERVIEW
-- ============================================================================
-- This migration adds tables for monitoring device logs and triggering alerts
-- based on configurable rules. Supports pattern matching, threshold detection,
-- and alert lifecycle management (active, acknowledged, resolved).

-- ============================================================================
-- STEP 1: Create log_alert_rules table
-- ============================================================================

CREATE TABLE IF NOT EXISTS log_alert_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    device_uuid UUID REFERENCES devices(uuid) ON DELETE CASCADE,  -- NULL = global rule
    
    -- Pattern matching
    pattern VARCHAR(1000) NOT NULL,  -- Regex or keyword
    pattern_type VARCHAR(20) DEFAULT 'regex',  -- 'regex', 'keyword', 'exact'
    
    -- Scope filters
    service_name VARCHAR(255),       -- Filter by service (NULL = all services)
    level VARCHAR(50),               -- Filter by log level (NULL = all levels)
    
    -- Trigger conditions
    trigger_type VARCHAR(50) NOT NULL DEFAULT 'count',  -- 'count', 'rate', 'sequence'
    threshold INTEGER DEFAULT 1,      -- Number of occurrences
    time_window INTEGER DEFAULT 300,  -- Seconds (for rate/count triggers)
    
    -- Alert severity
    severity VARCHAR(20) DEFAULT 'warning',  -- 'info', 'warning', 'critical'
    
    -- Notification channels
    notify_email BOOLEAN DEFAULT false,
    notify_webhook BOOLEAN DEFAULT false,
    notify_dashboard BOOLEAN DEFAULT true,
    
    -- State
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_device ON log_alert_rules(device_uuid);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON log_alert_rules(is_enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_severity ON log_alert_rules(severity);

COMMENT ON TABLE log_alert_rules IS 'Alert rules for monitoring device logs';
COMMENT ON COLUMN log_alert_rules.device_uuid IS 'Device scope (NULL = global rule applies to all devices)';
COMMENT ON COLUMN log_alert_rules.pattern IS 'Pattern to match in log messages (regex or keyword)';
COMMENT ON COLUMN log_alert_rules.pattern_type IS 'Pattern matching type: regex, keyword, or exact';
COMMENT ON COLUMN log_alert_rules.service_name IS 'Filter by service name (NULL = all services)';
COMMENT ON COLUMN log_alert_rules.level IS 'Filter by log level (NULL = all levels)';
COMMENT ON COLUMN log_alert_rules.trigger_type IS 'How to trigger: count, rate, or sequence';
COMMENT ON COLUMN log_alert_rules.threshold IS 'Number of matches required to trigger';
COMMENT ON COLUMN log_alert_rules.time_window IS 'Time window in seconds for count/rate triggers';

-- ============================================================================
-- STEP 2: Create log_alerts table (alert instances)
-- ============================================================================

CREATE TABLE IF NOT EXISTS log_alerts (
    id BIGSERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES log_alert_rules(id) ON DELETE CASCADE,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    
    -- Context
    matched_log_ids BIGINT[],        -- Array of device_logs.id that triggered this
    message TEXT NOT NULL,            -- Alert message
    count INTEGER DEFAULT 1,          -- Number of matches in time window
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- 'active', 'acknowledged', 'resolved'
    severity VARCHAR(20) NOT NULL,
    
    -- Timestamps
    first_seen TIMESTAMP NOT NULL,
    last_seen TIMESTAMP NOT NULL,
    acknowledged_at TIMESTAMP,
    acknowledged_by VARCHAR(255),
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alerts_device ON log_alerts(device_uuid);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON log_alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON log_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_rule ON log_alerts(rule_id);
CREATE INDEX IF NOT EXISTS idx_alerts_first_seen ON log_alerts(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON log_alerts(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON log_alerts(created_at DESC);

COMMENT ON TABLE log_alerts IS 'Alert instances triggered by log_alert_rules';
COMMENT ON COLUMN log_alerts.matched_log_ids IS 'Array of device_logs.id entries that triggered this alert';
COMMENT ON COLUMN log_alerts.count IS 'Number of log matches in the time window';
COMMENT ON COLUMN log_alerts.status IS 'Alert lifecycle: active, acknowledged, or resolved';
COMMENT ON COLUMN log_alerts.first_seen IS 'Timestamp of first matching log';
COMMENT ON COLUMN log_alerts.last_seen IS 'Timestamp of most recent matching log';

-- ============================================================================
-- STEP 3: Insert default alert rule templates
-- ============================================================================

INSERT INTO log_alert_rules (name, description, pattern, pattern_type, level, severity, threshold, time_window, is_enabled)
VALUES
    ('Critical Errors', 'Detect critical/fatal errors in logs', '\[(error|crit|alert|emerg)\]|ERROR|FATAL|CRITICAL', 'regex', 'error', 'critical', 1, 60, true),
    ('Repeated Warnings', 'Five or more warnings in 5 minutes', '.*', 'regex', 'warn', 'warning', 5, 300, false),
    ('DNS Resolution Failures', 'Detect DNS lookup errors', 'ENOTFOUND|DNS resolution failed', 'keyword', NULL, 'critical', 1, 300, true),
    ('Container Restarts', 'Detect container restart events', 'container.*restart|restarting', 'regex', NULL, 'warning', 3, 600, false),
    ('Authentication Failures', 'Failed login attempts', 'authentication failed|invalid credentials|unauthorized', 'keyword', NULL, 'warning', 5, 300, false)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 4: Create function to update updated_at timestamp
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 5: Create triggers for updated_at columns
-- ============================================================================

DROP TRIGGER IF EXISTS update_log_alert_rules_updated_at ON log_alert_rules;
CREATE TRIGGER update_log_alert_rules_updated_at
    BEFORE UPDATE ON log_alert_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_log_alerts_updated_at ON log_alerts;
CREATE TRIGGER update_log_alerts_updated_at
    BEFORE UPDATE ON log_alerts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMPLETION
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE 'Migration complete: Log alert system installed';
    RAISE NOTICE '   Tables created:';
    RAISE NOTICE '     - log_alert_rules (alert rule definitions)';
    RAISE NOTICE '     - log_alerts (triggered alert instances)';
    RAISE NOTICE '';
    RAISE NOTICE '   Default rules installed:';
    RAISE NOTICE '     - Critical Errors (enabled)';
    RAISE NOTICE '     - DNS Resolution Failures (enabled)';
    RAISE NOTICE '     - Repeated Warnings (disabled)';
    RAISE NOTICE '     - Container Restarts (disabled)';
    RAISE NOTICE '     - Authentication Failures (disabled)';
    RAISE NOTICE '';
    RAISE NOTICE '   Features:';
    RAISE NOTICE '     - Pattern matching (regex, keyword, exact)';
    RAISE NOTICE '     - Threshold-based triggers';
    RAISE NOTICE '     - Alert lifecycle (active, acknowledged, resolved)';
    RAISE NOTICE '     - Global and device-specific rules';
END $$;
