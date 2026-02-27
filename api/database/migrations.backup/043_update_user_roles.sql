-- Migration: Update user roles to match permission system
-- Created: 2025-11-03
-- Purpose: Fix role constraint to use owner/admin/manager/operator/viewer instead of admin/user/viewer/device
-- ============================================================================

-- Step 1: Drop the old constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_role;

-- Step 2: Update any existing 'user' roles to 'operator' (closest match)
UPDATE users SET role = 'operator' WHERE role = 'user';

-- Step 3: Update any existing 'device' roles to 'operator' (devices shouldn't be users)
UPDATE users SET role = 'operator' WHERE role = 'device';

-- Step 4: Add the new constraint with correct roles
ALTER TABLE users ADD CONSTRAINT valid_role 
  CHECK (role IN ('owner', 'admin', 'manager', 'operator', 'viewer'));

-- Step 5: Add comment
COMMENT ON CONSTRAINT valid_role ON users IS 'Valid roles: owner (full access + billing), admin (full access), manager (read all + write devices/users), operator (read all + control devices), viewer (read-only)';
