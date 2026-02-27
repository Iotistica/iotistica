-- Migration: Update user roles for RBAC system
-- Created: 2025-10-31
-- Purpose: Add proper role-based access control with owner, admin, manager, operator, viewer roles
-- Updates the existing users table role constraint

-- Drop old role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_role;

-- Add new role constraint with RBAC roles
ALTER TABLE users ADD CONSTRAINT valid_role 
  CHECK (role IN ('owner', 'admin', 'manager', 'operator', 'viewer', 'device'));

-- Add comment explaining roles
COMMENT ON COLUMN users.role IS 'User role: owner (full access + billing), admin (full access), manager (read all + write devices/users), operator (read + control devices), viewer (read-only), device (machine account)';

-- Update existing 'admin' users to 'owner' (first admin becomes owner)
-- This assumes the first created admin is the account owner
DO $$
DECLARE
  first_admin_id INTEGER;
BEGIN
  -- Find the first admin user (by id)
  SELECT id INTO first_admin_id
  FROM users
  WHERE role = 'admin'
  ORDER BY id ASC
  LIMIT 1;

  -- Update first admin to owner
  IF first_admin_id IS NOT NULL THEN
    UPDATE users 
    SET role = 'owner' 
    WHERE id = first_admin_id;
    
    RAISE NOTICE 'Updated user % to owner role', first_admin_id;
  END IF;
END $$;

-- Update existing 'user' role to 'viewer' (safe default for regular users)
UPDATE users 
SET role = 'viewer' 
WHERE role = 'user';

-- Create index on role if not exists (already exists, but safe to try)
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
