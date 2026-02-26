-- Migration: Add simulator API key
-- Description: Creates a dedicated API key for protocol simulators (Modbus, OPC UA, BACnet)
-- Required: Simulators now require API key authentication (no fallback)

-- Add unique constraint on name if not exists (MUST be before INSERT with ON CONFLICT)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'api_keys_name_key'
    ) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_name_key UNIQUE (name);
    END IF;
END $$;

COMMENT ON CONSTRAINT api_keys_name_key ON api_keys IS 'Ensure API key names are unique for easy reference';

-- Generate a secure 64-character API key (can be regenerated if needed)
DO $$
DECLARE
    simulator_api_key TEXT;
BEGIN
    -- Generate random API key (hex format, 64 characters)
    simulator_api_key := encode(gen_random_bytes(32), 'hex');
    
    -- Insert or update simulator API key (now that unique constraint exists)
    INSERT INTO api_keys (name, key, description, is_active, expires_at)
    VALUES (
        'simulator',
        simulator_api_key,
        'API key for protocol simulators (Modbus, OPC UA, BACnet). Used by simulators to access /api/v1/profiles/sim/datapoints endpoint.',
        true,
        NULL  -- Never expires
    )
    ON CONFLICT (name) DO UPDATE SET
        description = EXCLUDED.description,
        is_active = true;
    
    -- Log the API key (only visible in migration output - copy this!)
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Simulator API Key Created';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'API Key: %', simulator_api_key;
    RAISE NOTICE '';
    RAISE NOTICE 'IMPORTANT: Copy this key and set it in your environment:';
    RAISE NOTICE '  export SIMULATOR_API_KEY=%', simulator_api_key;
    RAISE NOTICE '';
    RAISE NOTICE 'Or add to .env file:';
    RAISE NOTICE '  SIMULATOR_API_KEY=%', simulator_api_key;
    RAISE NOTICE '========================================';
END $$;
