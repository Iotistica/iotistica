-- Migration: Create deployment_monitor table for continuous Argo CD status tracking
-- Date: 2026-04-23
--
-- Tracks real-time Argo CD application status during and after deployment
-- Used by the continuous monitor job to record status snapshots

CREATE TABLE IF NOT EXISTS deployment_monitor (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(32) NOT NULL UNIQUE,
  client_id VARCHAR(50) NOT NULL,
  namespace VARCHAR(100) NOT NULL,
  
  -- Current Argo CD application state
  health_status VARCHAR(50),           -- Healthy | Progressing | Degraded | Suspended | Missing | Unknown
  sync_status VARCHAR(50),              -- Synced | OutOfSync | Unknown
  operation_phase VARCHAR(50),          -- Running | Succeeded | Failed | Error | Terminating
  
  -- Monitoring metadata
  last_polled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  polling_stopped_at TIMESTAMP,         -- When monitoring stopped (null = still monitoring)
  monitor_job_id VARCHAR(100),          -- Bull job ID for tracking
  status_message TEXT,                  -- Error or status details
  
  -- Counts
  poll_count INTEGER DEFAULT 0,         -- How many times we polled
  degraded_count INTEGER DEFAULT 0,     -- How many times health was degraded
  
  -- Lifecycle
  monitoring_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ready_at TIMESTAMP,                   -- When app first reached ready state
  stopped_reason VARCHAR(100),          -- "healthy" | "degraded" | "customer_deleted" | "manual_stop"
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Constraints
  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deployment_monitor_customer ON deployment_monitor(customer_id);
CREATE INDEX IF NOT EXISTS idx_deployment_monitor_monitoring ON deployment_monitor(polling_stopped_at) WHERE polling_stopped_at IS NULL;

COMMENT ON TABLE deployment_monitor IS 'Tracks continuous Argo CD status during and after deployment';
COMMENT ON COLUMN deployment_monitor.polling_stopped_at IS 'NULL while monitoring, set to timestamp when monitoring stops';
COMMENT ON COLUMN deployment_monitor.stopped_reason IS 'Why monitoring stopped: healthy (ready state reached), degraded (health failed), customer_deleted (customer removed), manual_stop (admin stopped)';
