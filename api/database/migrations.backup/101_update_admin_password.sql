-- Migration 101: Update default admin password
-- Purpose: Update admin user password to stronger default
-- Note: Password should be changed immediately after first login

DO $$
BEGIN
  -- Update admin password if user exists
  IF EXISTS (SELECT 1 FROM users WHERE username = 'admin') THEN
    UPDATE users 
    SET 
      password_hash = '$2b$10$biUD3u9Gufxh8c1ccHJgNeagkFuvOzyTyDu/YQpah5Uz6jhHXIuxa',
      updated_at = NOW()
    WHERE username = 'admin';
    
    RAISE NOTICE 'Admin password updated (username: admin, password: iotistic2024)';
    RAISE NOTICE 'SECURITY WARNING: Change the default admin password immediately!';
  ELSE
    RAISE NOTICE 'Admin user does not exist, skipping password update';
  END IF;
END $$;
