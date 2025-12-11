-- Migration: Add level column to device_logs table
-- Created: 2025-12-10
-- Purpose: Add log level field for better filtering and sampling
-- Dependencies: Requires device_logs table to exist

DO $$
BEGIN
    -- Add level column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'device_logs' 
        AND column_name = 'level'
    ) THEN
        ALTER TABLE device_logs ADD COLUMN level VARCHAR(50) DEFAULT 'info';
        RAISE NOTICE 'Added level column to device_logs';
        
        -- Create index on level for fast filtering
        CREATE INDEX IF NOT EXISTS idx_device_logs_level ON device_logs(level);
        RAISE NOTICE 'Created index on level column';
        
        -- Update existing rows to have level based on message content or is_stderr
        UPDATE device_logs 
        SET level = CASE
            WHEN is_stderr = true THEN 'error'
            WHEN message ~* 'error|fatal|critical|\[error\]|\[crit\]|\[alert\]|\[emerg\]' THEN 'error'
            WHEN message ~* 'warn|warning|\[warn\]' THEN 'warn'
            WHEN message ~* 'debug|trace|\[debug\]' THEN 'debug'
            ELSE 'info'
        END
        WHERE level = 'info';  -- Only update rows with default value
        
        RAISE NOTICE 'Updated existing rows with detected log levels';
        
        RAISE NOTICE '✓ Level column migration complete';
    ELSE
        RAISE NOTICE 'Level column already exists, skipping migration';
    END IF;
END $$;
