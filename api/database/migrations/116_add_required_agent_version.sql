-- Migration: Add required agent version to system config
-- This enables cloud-controlled agent version policy

-- Add required_agent_version to system_config (if not exists)
-- Note: system_config.value is JSONB, so we cast the version string
INSERT INTO system_config (key, value, updated_at)
VALUES (
  'required_agent_version',
  '"1.0.230"'::jsonb,
  NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Add comment
COMMENT ON TABLE system_config IS 'System-wide configuration (cloud state, not env vars). Use configService.get/set to access.';
