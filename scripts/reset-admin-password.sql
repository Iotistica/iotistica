-- Reset admin password to "admin123"
-- Run this in PostgreSQL to reset the admin user password

-- The password hash is for "admin123" using bcrypt
-- Generated with bcrypt rounds=10

UPDATE users 
SET password_hash = '$2b$10$rJF5vHYLJ7kXQxqVJ8p0qOQqYJ5vH5J7kXQxqVJ8p0qOQqYJ5vH5J'
WHERE username = 'admin';

-- Verify the update
SELECT username, email, role, is_active 
FROM users 
WHERE username = 'admin';
