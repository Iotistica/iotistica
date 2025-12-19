-- Add User Feedback Fields to Anomaly Incidents
-- Allows users to provide feedback on incident quality (confirmed, false positive, expected, ignored)
-- Helps improve ML model training and reduce alert fatigue

-- Add feedback columns
ALTER TABLE anomaly_incidents
ADD COLUMN IF NOT EXISTS feedback VARCHAR(20),
ADD COLUMN IF NOT EXISTS feedback_reason TEXT,
ADD COLUMN IF NOT EXISTS feedback_by VARCHAR(255),
ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;

-- Add constraint for valid feedback values
DO $$
BEGIN
    ALTER TABLE anomaly_incidents
    ADD CONSTRAINT anomaly_incidents_feedback_check
    CHECK (feedback IN ('confirmed', 'false_positive', 'expected', 'ignored'));
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'Constraint anomaly_incidents_feedback_check already exists, skipping';
END $$;

-- Create index for querying incidents by feedback status
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_feedback 
ON anomaly_incidents(feedback) 
WHERE feedback IS NOT NULL;

-- Create index for feedback analysis by time
CREATE INDEX IF NOT EXISTS idx_anomaly_incidents_feedback_at 
ON anomaly_incidents(feedback_at DESC) 
WHERE feedback_at IS NOT NULL;

-- Add comment explaining the feedback values
COMMENT ON COLUMN anomaly_incidents.feedback IS 'User feedback on incident quality: confirmed (real issue), false_positive (bad detection), expected (known behavior like maintenance), ignored (user does not care)';
COMMENT ON COLUMN anomaly_incidents.feedback_reason IS 'Optional explanation for the feedback';
COMMENT ON COLUMN anomaly_incidents.feedback_by IS 'User who provided the feedback (username or email)';
COMMENT ON COLUMN anomaly_incidents.feedback_at IS 'Timestamp when feedback was provided';
