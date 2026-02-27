-- Migration: Drop protocol_adapter_health_history table
-- Purpose: Remove obsolete protocol adapter health history table
-- Reason: Replaced by device_sensors table and new sensor health architecture
-- Date: 2025-11-02

-- ============================================================================
-- Drop Table: protocol_adapter_health_history
-- ============================================================================

-- Drop the table if it exists
DROP TABLE IF EXISTS protocol_adapter_health_history CASCADE;

-- ============================================================================
-- Comments
-- ============================================================================
-- Note: This table has been replaced by the device_sensors table architecture.
-- Health tracking is now handled through separate sensor health monitoring.
