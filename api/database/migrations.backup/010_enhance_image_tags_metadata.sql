-- Enhance image_tags table with metadata from Docker Hub
-- This stores detailed information about each tag after approval

-- Add metadata JSONB column to store additional Docker Hub information
ALTER TABLE image_tags 
ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Add last_updated timestamp from Docker Hub
ALTER TABLE image_tags
ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP;

-- Update existing digest column to be more flexible (some old images don't have it)
ALTER TABLE image_tags
ALTER COLUMN digest DROP NOT NULL;

-- Create GIN index on metadata for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_image_tags_metadata ON image_tags USING GIN (metadata);

-- Add index on last_updated for sorting by recency
CREATE INDEX IF NOT EXISTS idx_image_tags_last_updated ON image_tags(last_updated DESC);

COMMENT ON COLUMN image_tags.metadata IS 'Additional metadata from Docker Hub (architectures, layers, etc.)';
COMMENT ON COLUMN image_tags.last_updated IS 'Last update timestamp from Docker Hub (not our DB update time)';

-- Example metadata structure:
-- {
--   "architectures": ["amd64", "arm64", "arm/v7"],
--   "full_size": 123456789,
--   "layers_count": 5,
--   "auto_detected": true,
--   "source": "image_monitor",
--   "docker_hub_url": "https://hub.docker.com/layers/redis/library/redis/7.2-alpine/images/sha256-..."
-- }
