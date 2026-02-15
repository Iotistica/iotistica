-- ============================================================================
-- Migration: Add 'fleet_created' Event Type
-- ============================================================================
-- Description: Adds 'fleet_created' to the valid_event_type constraint
--              for fleet_usage_events table
-- Author: System
-- Date: 2026-02-14
-- ============================================================================

-- Drop existing constraint
ALTER TABLE fleet_usage_events 
DROP CONSTRAINT IF EXISTS valid_event_type;

-- Recreate constraint with 'fleet_created' added
ALTER TABLE fleet_usage_events
ADD CONSTRAINT valid_event_type CHECK (
    event_type IN (
        'fleet_created',
        'started',
        'stopped',
        'cost_updated',
        'budget_alert',
        'budget_exceeded',
        'device_added',
        'device_removed',
        'deployment_complete',
        'deployment_failed'
    )
);

-- Add comment
COMMENT ON CONSTRAINT valid_event_type ON fleet_usage_events 
IS 'Validates event types for fleet lifecycle tracking. fleet_created marks initial fleet creation.';
