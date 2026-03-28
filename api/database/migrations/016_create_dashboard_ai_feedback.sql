-- Track AI dashboard suggestion adoption/removal signals for ranking improvements.
CREATE TABLE IF NOT EXISTS dashboard_ai_feedback_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(40) NOT NULL,
  suggestion_id VARCHAR(128),
  suggestion_signature VARCHAR(255) NOT NULL,
  device_id UUID,
  metric_name VARCHAR(255) NOT NULL,
  chart_type VARCHAR(20) NOT NULL,
  layout_bin VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'rules',
  user_id VARCHAR(255),
  customer_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT dashboard_ai_feedback_events_type_check
    CHECK (event_type IN ('suggestion_shown', 'suggestion_accepted', 'widget_removed')),
  CONSTRAINT dashboard_ai_feedback_events_chart_check
    CHECK (chart_type IN ('line', 'bar', 'gauge', 'stat')),
  CONSTRAINT dashboard_ai_feedback_events_bin_check
    CHECK (layout_bin IN ('top', 'main', 'side', 'bottom')),
  CONSTRAINT dashboard_ai_feedback_events_source_check
    CHECK (source IN ('rules', 'llm', 'hybrid'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_ai_feedback_signature
  ON dashboard_ai_feedback_events (suggestion_signature);

CREATE INDEX IF NOT EXISTS idx_dashboard_ai_feedback_customer_signature
  ON dashboard_ai_feedback_events (customer_id, suggestion_signature);

CREATE INDEX IF NOT EXISTS idx_dashboard_ai_feedback_created_at
  ON dashboard_ai_feedback_events (created_at);
