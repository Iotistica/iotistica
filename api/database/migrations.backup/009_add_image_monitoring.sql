-- Add image monitoring capabilities
-- This allows the system to automatically poll Docker Hub for new tags

-- Add watch_for_updates flag to images table
ALTER TABLE images 
ADD COLUMN IF NOT EXISTS watch_for_updates BOOLEAN DEFAULT true;

-- Add columns to track monitoring status
ALTER TABLE images
ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMP;

-- Update existing images to enable monitoring for approved images
UPDATE images 
SET watch_for_updates = true,
    last_checked_at = NULL,
    next_check_at = NOW()
WHERE approval_status = 'approved';

-- Add index for monitoring queries
CREATE INDEX IF NOT EXISTS idx_images_watch_updates 
ON images(watch_for_updates, approval_status) 
WHERE watch_for_updates = true AND approval_status = 'approved';

-- Modify image_approval_requests to support tag-level approvals
ALTER TABLE image_approval_requests
ADD COLUMN IF NOT EXISTS image_id INTEGER REFERENCES images(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS tag_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Add index for tag approval lookups
CREATE INDEX IF NOT EXISTS idx_approval_requests_image_tag 
ON image_approval_requests(image_id, tag_name) 
WHERE status = 'pending';

COMMENT ON COLUMN images.watch_for_updates IS 'Whether to automatically check Docker Hub for new tags';
COMMENT ON COLUMN images.last_checked_at IS 'Last time Docker Hub was polled for this image';
COMMENT ON COLUMN images.next_check_at IS 'Next scheduled check time';
COMMENT ON COLUMN image_approval_requests.image_id IS 'Reference to approved image (for tag approvals)';
COMMENT ON COLUMN image_approval_requests.tag_name IS 'Specific tag requiring approval';
COMMENT ON COLUMN image_approval_requests.metadata IS 'Additional metadata from Docker Hub (digest, architectures, etc)';
