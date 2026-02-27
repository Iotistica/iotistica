-- Migration: Add share tokens for secure dashboard sharing
-- Purpose: Replace sequential integer IDs in share URLs with UUIDs to prevent enumeration
-- Date: 2026-02-08

BEGIN;

-- ============================================================================
-- Add share_token column to dashboard_layouts table
-- ============================================================================
ALTER TABLE dashboard_layouts 
ADD COLUMN IF NOT EXISTS share_token UUID DEFAULT gen_random_uuid();

-- ============================================================================
-- Ensure all existing dashboards have share tokens
-- ============================================================================
UPDATE dashboard_layouts 
SET share_token = gen_random_uuid() 
WHERE share_token IS NULL;

-- ============================================================================
-- Make share_token NOT NULL and UNIQUE after populating existing rows
-- ============================================================================
ALTER TABLE dashboard_layouts 
ALTER COLUMN share_token SET NOT NULL;

ALTER TABLE dashboard_layouts 
ALTER COLUMN share_token SET DEFAULT gen_random_uuid();

-- Add unique constraint (idempotent)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'unique_share_token' 
    AND conrelid = 'dashboard_layouts'::regclass
  ) THEN
    ALTER TABLE dashboard_layouts 
    ADD CONSTRAINT unique_share_token UNIQUE (share_token);
  END IF;
END $$;

-- ============================================================================
-- Create index for efficient share token lookups
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_share_token 
ON dashboard_layouts(share_token);

-- ============================================================================
-- Add column comment
-- ============================================================================
COMMENT ON COLUMN dashboard_layouts.share_token IS 'UUID token used for secure dashboard sharing via URLs (replaces integer ID to prevent enumeration)';

COMMIT;
