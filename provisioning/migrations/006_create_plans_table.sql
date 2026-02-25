-- Migration 006: Create plans table for flexible tier management
-- Allows adding/modifying plans without code changes

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  
  -- Plan identification
  plan_name VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  
  -- Stripe integration
  stripe_price_id VARCHAR(255),
  stripe_product_id VARCHAR(255),
  
  -- Pricing
  price_cents INTEGER NOT NULL DEFAULT 0,
  billing_interval VARCHAR(20) DEFAULT 'month',
  
  -- Feature limits (JSON for flexibility)
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  
  -- Plan properties
  is_active BOOLEAN DEFAULT true,
  is_visible BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  trial_days INTEGER DEFAULT 0,
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_plans_plan_name ON plans(plan_name);
CREATE INDEX idx_plans_active ON plans(is_active);

-- Plan history for audit trail
CREATE TABLE IF NOT EXISTS plan_history (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER REFERENCES plans(id),
  plan_name VARCHAR(50) NOT NULL,
  changed_by VARCHAR(255),
  change_type VARCHAR(50) NOT NULL,
  old_values JSONB,
  new_values JSONB,
  changed_at TIMESTAMP DEFAULT NOW()
);

-- Seed default plans
INSERT INTO plans (plan_name, display_name, description, price_cents, features, trial_days, sort_order) VALUES
(
  'trial',
  'Free Trial',
  'Try Iotistic free for 14 days',
  0,
  '{
    "maxDevices": 10,
    "dataRetentionDays": 30,
    "canExecuteJobs": true,
    "canScheduleJobs": false,
    "remoteAccess": true,
    "otaUpdates": false,
    "canExportData": false,
    "advancedAlerts": false,
    "customDashboards": false,
    "apiAccess": true,
    "mqttAccess": true,
    "customBranding": false,
    "maxJobTemplates": 5,
    "maxAlertRules": 10,
    "maxUsers": 2,
    "supportLevel": "community",
    "slaUptime": 95.0
  }'::jsonb,
  14,
  1
),
(
  'starter',
  'Starter Plan',
  'Perfect for small deployments',
  2900,
  '{
    "maxDevices": 10,
    "dataRetentionDays": 30,
    "canExecuteJobs": true,
    "canScheduleJobs": false,
    "remoteAccess": true,
    "otaUpdates": false,
    "canExportData": true,
    "advancedAlerts": false,
    "customDashboards": false,
    "apiAccess": true,
    "mqttAccess": true,
    "customBranding": false,
    "maxJobTemplates": 10,
    "maxAlertRules": 25,
    "maxUsers": 5,
    "supportLevel": "email",
    "slaUptime": 99.0
  }'::jsonb,
  0,
  2
),
(
  'professional',
  'Professional Plan',
  'Advanced features for growing businesses',
  9900,
  '{
    "maxDevices": 50,
    "dataRetentionDays": 365,
    "canExecuteJobs": true,
    "canScheduleJobs": true,
    "remoteAccess": true,
    "otaUpdates": true,
    "canExportData": true,
    "advancedAlerts": true,
    "customDashboards": true,
    "apiAccess": true,
    "mqttAccess": true,
    "customBranding": false,
    "maxJobTemplates": 50,
    "maxAlertRules": 100,
    "maxUsers": 15,
    "supportLevel": "priority",
    "slaUptime": 99.5
  }'::jsonb,
  0,
  3
),
(
  'enterprise',
  'Enterprise Plan',
  'Unlimited everything with custom support',
  0,
  '{
    "maxDevices": -1,
    "dataRetentionDays": -1,
    "canExecuteJobs": true,
    "canScheduleJobs": true,
    "remoteAccess": true,
    "otaUpdates": true,
    "canExportData": true,
    "advancedAlerts": true,
    "customDashboards": true,
    "apiAccess": true,
    "mqttAccess": true,
    "customBranding": true,
    "maxJobTemplates": -1,
    "maxAlertRules": -1,
    "maxUsers": -1,
    "supportLevel": "dedicated",
    "slaUptime": 99.9
  }'::jsonb,
  0,
  4
);

-- Note: -1 in features means unlimited
