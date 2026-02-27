-- Migration: Fix API key history trigger to handle NULL old keys
-- Created: 2025-10-23
-- Purpose: Prevent NOT NULL constraint violation when archiving device API keys during initial provisioning

-- Update the trigger function to only archive if old key exists
CREATE OR REPLACE FUNCTION archive_device_api_key()
RETURNS TRIGGER AS $$
BEGIN
    -- Only archive if:
    -- 1. Key actually changed
    -- 2. Old key is NOT NULL (avoid constraint violation on first provisioning)
    IF OLD.device_api_key_hash IS DISTINCT FROM NEW.device_api_key_hash 
       AND OLD.device_api_key_hash IS NOT NULL THEN
        INSERT INTO device_api_key_history (
            device_uuid,
            key_hash,
            issued_at,
            expires_at,
            is_active
        ) VALUES (
            OLD.uuid,
            OLD.device_api_key_hash,
            OLD.api_key_last_rotated_at,
            OLD.api_key_expires_at,
            false  -- Old key is no longer active
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No need to recreate trigger, function update is sufficient
COMMENT ON FUNCTION archive_device_api_key() IS 'Archives old device API key when changed (skips if old key is NULL)';
