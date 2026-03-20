-- Migration 009: Add structured metadata column to device_logs
-- Purpose: Persist JSON log context (protocol, operation, extra details) from agent uploads.

ALTER TABLE IF EXISTS public.device_logs
  ADD COLUMN IF NOT EXISTS meta jsonb;

COMMENT ON COLUMN public.device_logs.meta IS
  'Structured log metadata/context from agent logs (e.g., protocol, operation, correlation fields).';
