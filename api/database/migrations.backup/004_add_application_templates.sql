-- Migration 004: Add application template support
-- Enhances applications table to store docker-compose-like templates

-- Add template configuration field to applications table
ALTER TABLE applications 
ADD COLUMN IF NOT EXISTS default_config JSONB DEFAULT '{}';

-- Add comment explaining the field
COMMENT ON COLUMN applications.default_config IS 
'Docker-compose-like template for this application. Contains default services configuration that can be customized per device.';

-- Example structure:
-- {
--   "services": [
--     {
--       "serviceName": "prometheus",
--       "image": "prom/prometheus:latest",
--       "defaultPorts": ["9090:9090"],
--       "defaultEnvironment": {},
--       "defaultVolumes": []
--     }
--   ]
-- }

-- Create index for faster application lookups by slug
CREATE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);

-- Create index for app name searches
CREATE INDEX IF NOT EXISTS idx_applications_app_name ON applications(app_name);

COMMENT ON TABLE applications IS 
'Application catalog/library - stores docker-compose-like templates that can be deployed to devices with customization';
