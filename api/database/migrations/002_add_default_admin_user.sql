-- Migration 002: Add initial admin user without static credentials
-- Purpose: Create a bootstrap admin account for first access
-- Security: No hardcoded password; supports optional injected initial password

DO $$
DECLARE
  injected_password TEXT;
  admin_password_hash TEXT;
BEGIN
  -- Optional deployment-injected setting.
  -- If not present, an unusable random password is generated.
  injected_password := NULLIF(current_setting('app.initial_admin_password', true), '');

  IF injected_password IS NOT NULL THEN
    admin_password_hash := crypt(injected_password, gen_salt('bf', 10));
  ELSE
    admin_password_hash := crypt(gen_random_uuid()::text, gen_salt('bf', 10));
  END IF;

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
      admin_password_hash,
      'admin@iotistic.local',
      'admin',
      NOW(),
      NOW()
    );

    RAISE NOTICE 'Initial admin user created (username: admin)';
    IF injected_password IS NULL THEN
      RAISE NOTICE 'No injected initial password found (app.initial_admin_password); generated random bootstrap password.';
    ELSE
      RAISE NOTICE 'Initial admin password injected by deployment and should be rotated on first login.';
    END IF;
  ELSE
    RAISE NOTICE 'Admin user already exists, skipping creation';
  END IF;
END $$;

