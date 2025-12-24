-- Migration: Rename vendor terminology to profile
-- Description: "Profile" better describes device configurations (e.g., COMAP vs ComAp-InteliGen are different profiles)
-- Breaking Change: API endpoints change from /api/v1/vendors to /api/v1/profiles

-- Rename table
ALTER TABLE vendor_configs RENAME TO profile_configs;

-- Rename column
ALTER TABLE profile_configs RENAME COLUMN vendor_name TO profile_name;

-- Update indexes (drop and recreate with new names)
DROP INDEX IF EXISTS idx_vendor_configs_vendor_name;
DROP INDEX IF EXISTS idx_vendor_configs_protocol;

CREATE INDEX idx_profile_configs_profile_name ON profile_configs(profile_name);
CREATE INDEX idx_profile_configs_protocol ON profile_configs(protocol);

-- Update trigger function name
DROP TRIGGER IF EXISTS trigger_vendor_configs_updated_at ON profile_configs;
ALTER FUNCTION update_vendor_configs_updated_at() RENAME TO update_profile_configs_updated_at;

CREATE TRIGGER trigger_profile_configs_updated_at
  BEFORE UPDATE ON profile_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_profile_configs_updated_at();

-- Update comments
COMMENT ON TABLE profile_configs IS 'Centralized protocol configuration profiles (formerly vendor_configs) - replaces static dataPoints.json file';
COMMENT ON COLUMN profile_configs.profile_name IS 'Profile identifier (e.g., COMAP, Generic, ComAp-InteliGen)';
COMMENT ON COLUMN profile_configs.data_points IS 'JSONB array of protocol-specific data point definitions';
COMMENT ON COLUMN profile_configs.metadata IS 'Additional profile information (URLs, descriptions, model, version, etc.)';

-- Log migration
DO $$
BEGIN
  RAISE NOTICE 'Successfully renamed vendor_configs to profile_configs';
  RAISE NOTICE 'Updated indexes, triggers, and comments';
  RAISE NOTICE 'Note: API routes must be updated from /api/v1/vendors to /api/v1/profiles';
END $$;