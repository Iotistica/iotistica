-- Migration 053: Add default admin user
-- Purpose: Create default admin user for initial system access
-- Note: Password should be changed immediately after first login

DO $$
BEGIN
  -- Only create if admin user doesn't exist
  IF NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin') THEN
    INSERT INTO users (
      username,
      password_hash,
      email,
      role,
      created_at,
      updated_at
    ) VALUES (
      'admin',
      -- bcrypt hash of "admin" with salt rounds = 10
      '$2b$10$kUietKa1RQ7p1QET/nxZi.7DzCaEu36VheZGlJ.24EF1NOQH6LW4K',
      'admin@iotistic.local',
      'admin',
      NOW(),
      NOW()
    );
    
    RAISE NOTICE 'Default admin user created (username: admin, password: admin)';
    RAISE NOTICE 'SECURITY WARNING: Change the default admin password immediately!';
  ELSE
    RAISE NOTICE 'Admin user already exists, skipping creation';
  END IF;
END $$;

-- Create index on username for faster login queries (if not exists)
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Add comment
COMMENT ON TABLE users IS 'System users with authentication credentials';
COMMENT ON COLUMN users.username IS 'Unique username for login';
COMMENT ON COLUMN users.password_hash IS 'Bcrypt hashed password';
COMMENT ON COLUMN users.role IS 'User role: admin, user, viewer';
