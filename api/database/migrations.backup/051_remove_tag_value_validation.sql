-- Migration: Remove Tag Value Validation Trigger
-- Description: Allow free-text tag values instead of enforcing allowed_values
-- Author: System
-- Date: 2025-11-06
-- Feature: Make tag definitions suggestive rather than restrictive

-- ============================================================================
-- OVERVIEW
-- ============================================================================
-- This migration removes the strict validation trigger that enforces allowed_values
-- from tag_definitions. The system now treats allowed_values as SUGGESTIONS shown
-- in the UI, not strict requirements. This gives users flexibility while still
-- providing guidance through the tag definitions.
--
-- Behavior BEFORE this migration:
--   - Tag values MUST be in allowed_values array (if defined)
--   - Database raises exception for non-allowed values
--   - Users cannot add custom values
--
-- Behavior AFTER this migration:
--   - Tag values are free-text (any value allowed)
--   - UI shows allowed_values as suggestions
--   - UI warns if value doesn't match suggestions
--   - Users have full flexibility

-- ============================================================================
-- STEP 1: Drop the validation trigger
-- ============================================================================

DROP TRIGGER IF EXISTS trigger_validate_device_tag_value ON device_tags;

-- ============================================================================
-- STEP 2: Drop the validation function
-- ============================================================================

DROP FUNCTION IF EXISTS validate_device_tag_value();

-- ============================================================================
-- STEP 3: Update tag_definitions description
-- ============================================================================

COMMENT ON COLUMN tag_definitions.allowed_values IS 'Suggested values shown in UI (NULL = no suggestions). Values are NOT enforced - users can enter any value.';

-- ============================================================================
-- COMPLETION
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '✅ Migration complete: Tag value validation removed';
    RAISE NOTICE '   Changes:';
    RAISE NOTICE '     - Removed trigger: trigger_validate_device_tag_value';
    RAISE NOTICE '     - Removed function: validate_device_tag_value()';
    RAISE NOTICE '     - Updated documentation for allowed_values';
    RAISE NOTICE '';
    RAISE NOTICE '   Behavior change:';
    RAISE NOTICE '     - Tag values are now free-text (any value allowed)';
    RAISE NOTICE '     - allowed_values are shown as UI suggestions only';
    RAISE NOTICE '     - Users can override suggestions with custom values';
    RAISE NOTICE '';
    RAISE NOTICE '   Example:';
    RAISE NOTICE '     Tag definition: environment with allowed_values [development, staging, production]';
    RAISE NOTICE '     BEFORE: User cannot add environment=testing (database rejects it)';
    RAISE NOTICE '     AFTER:  User CAN add environment=testing (UI warns but allows it)';
END $$;
