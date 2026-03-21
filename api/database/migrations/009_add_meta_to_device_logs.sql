-- Migration 009: Add structured metadata column to agent_logs
-- Purpose: Persist JSON log context (protocol, operation, extra details) from agent uploads.

ALTER TABLE IF EXISTS public.agent_logs
  ADD COLUMN IF NOT EXISTS meta jsonb;

COMMENT ON COLUMN public.agent_logs.meta IS
  'Structured log metadata/context from agent logs (e.g., protocol, operation, correlation fields).';
