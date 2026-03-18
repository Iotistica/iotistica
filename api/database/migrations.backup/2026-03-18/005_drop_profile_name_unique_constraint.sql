-- Migration 005: Drop legacy single-column unique constraint on profile_configs
-- The old constraint vendor_configs_vendor_name_key enforces uniqueness on
-- profile_name alone, which prevents the same profile name from existing for
-- different protocols (e.g. "Generic" for both modbus and mqtt).
-- The correct composite constraint (profile_name, protocol) already exists as
-- profile_configs_profile_name_protocol_key and must be kept.

ALTER TABLE profile_configs
  DROP CONSTRAINT IF EXISTS vendor_configs_vendor_name_key;
