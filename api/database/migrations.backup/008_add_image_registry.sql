-- Add image registry management tables
-- This allows admins to approve and manage public Docker images

-- Images Registry
CREATE TABLE IF NOT EXISTS images (
  id SERIAL PRIMARY KEY,
  image_name VARCHAR(255) NOT NULL,
  registry VARCHAR(100) DEFAULT 'docker.io',
  namespace VARCHAR(100),
  description TEXT,
  category VARCHAR(50),
  is_official BOOLEAN DEFAULT false,
  approval_status VARCHAR(20) DEFAULT 'pending',
  approved_by VARCHAR(100),
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(registry, image_name)
);

-- Image Tags (versions available for deployment)
CREATE TABLE IF NOT EXISTS image_tags (
  id SERIAL PRIMARY KEY,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag VARCHAR(100) NOT NULL,
  digest VARCHAR(255),
  size_bytes BIGINT,
  architecture VARCHAR(50) DEFAULT 'amd64',
  os VARCHAR(50) DEFAULT 'linux',
  pushed_at TIMESTAMP,
  is_recommended BOOLEAN DEFAULT false,
  is_deprecated BOOLEAN DEFAULT false,
  security_scan_status VARCHAR(20),
  vulnerabilities_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(image_id, tag, architecture)
);

-- Image approval workflow tracking
CREATE TABLE IF NOT EXISTS image_approval_requests (
  id SERIAL PRIMARY KEY,
  image_name VARCHAR(255) NOT NULL,
  registry VARCHAR(100) DEFAULT 'docker.io',
  requested_by VARCHAR(100),
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'pending',
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMP,
  notes TEXT,
  rejection_reason TEXT
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_images_name ON images(image_name);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(approval_status);
CREATE INDEX IF NOT EXISTS idx_image_tags_image_id ON image_tags(image_id);
CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON image_approval_requests(status);

-- Insert some commonly used official images
INSERT INTO images (image_name, registry, namespace, description, category, is_official, approval_status, approved_at)
VALUES 
  ('redis', 'docker.io', 'library', 'Redis in-memory data structure store', 'database', true, 'approved', CURRENT_TIMESTAMP),
  ('postgres', 'docker.io', 'library', 'PostgreSQL object-relational database', 'database', true, 'approved', CURRENT_TIMESTAMP),
  ('nginx', 'docker.io', 'library', 'High-performance web server', 'web', true, 'approved', CURRENT_TIMESTAMP),
  ('node', 'docker.io', 'library', 'Node.js JavaScript runtime', 'runtime', true, 'approved', CURRENT_TIMESTAMP),
  ('python', 'docker.io', 'library', 'Python programming language', 'runtime', true, 'approved', CURRENT_TIMESTAMP),
  ('mysql', 'docker.io', 'library', 'MySQL database server', 'database', true, 'approved', CURRENT_TIMESTAMP),
  ('mongo', 'docker.io', 'library', 'MongoDB document database', 'database', true, 'approved', CURRENT_TIMESTAMP),
  ('influxdb', 'docker.io', 'library', 'InfluxDB time-series database', 'database', true, 'approved', CURRENT_TIMESTAMP),
  ('grafana/grafana', 'docker.io', 'grafana', 'Grafana monitoring and visualization', 'monitoring', false, 'approved', CURRENT_TIMESTAMP)
ON CONFLICT (registry, image_name) DO NOTHING;

-- Insert commonly used tags for Redis
INSERT INTO image_tags (image_id, tag, is_recommended)
SELECT id, '7-alpine', true FROM images WHERE image_name = 'redis'
UNION ALL
SELECT id, '7.2-alpine', false FROM images WHERE image_name = 'redis'
UNION ALL
SELECT id, '7.4-alpine', false FROM images WHERE image_name = 'redis'
UNION ALL
SELECT id, 'latest', false FROM images WHERE image_name = 'redis'
ON CONFLICT (image_id, tag, architecture) DO NOTHING;

COMMENT ON TABLE images IS 'Registry of Docker images approved for deployment';
COMMENT ON TABLE image_tags IS 'Available tags/versions for approved images';
COMMENT ON TABLE image_approval_requests IS 'Workflow tracking for image approval process';
