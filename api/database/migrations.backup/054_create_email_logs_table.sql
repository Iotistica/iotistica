-- Migration 054: Create email_logs table
-- Purpose: Track all email communications sent through PostOffice service
-- Stores email metadata, delivery status, and error information for audit trail

CREATE TABLE IF NOT EXISTS email_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(255),
  user_email VARCHAR(255) NOT NULL,
  user_name VARCHAR(255),
  template_name VARCHAR(100) NOT NULL,
  context JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'queued',
  sent_at TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_email_logs_user_email ON email_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_template_name ON email_logs(template_name);
CREATE INDEX IF NOT EXISTS idx_email_logs_job_id ON email_logs(job_id);

-- Comments for documentation
COMMENT ON TABLE email_logs IS 'Audit trail of all emails sent through PostOffice service';
COMMENT ON COLUMN email_logs.job_id IS 'Bull queue job ID for correlation';
COMMENT ON COLUMN email_logs.user_email IS 'Recipient email address';
COMMENT ON COLUMN email_logs.user_name IS 'Recipient name';
COMMENT ON COLUMN email_logs.template_name IS 'Email template used (e.g., VerifyEmail, UserSuspended)';
COMMENT ON COLUMN email_logs.context IS 'Template context data (JSON)';
COMMENT ON COLUMN email_logs.status IS 'Email status: queued, sent, failed';
COMMENT ON COLUMN email_logs.sent_at IS 'Timestamp when email was successfully sent';
COMMENT ON COLUMN email_logs.error IS 'Error message if email failed to send';

-- Data retention: Auto-delete logs older than 90 days (optional, uncomment if needed)
-- CREATE OR REPLACE FUNCTION cleanup_old_email_logs() RETURNS void AS $$
-- BEGIN
--   DELETE FROM email_logs WHERE created_at < NOW() - INTERVAL '90 days';
-- END;
-- $$ LANGUAGE plpgsql;

-- Schedule cleanup (requires pg_cron extension)
-- SELECT cron.schedule('cleanup-email-logs', '0 2 * * *', 'SELECT cleanup_old_email_logs()');
