-- Migration 018: Add device_current_state_history audit table
--
-- Purpose:
-- - Preserve historical snapshots of device_current_state over time
-- - Mirror device_target_state_history pattern for current/runtime state tracking
--
-- Design:
-- - Snapshot table stores apps/config/system_info/version with timestamp
-- - Trigger writes snapshot on INSERT and when meaningful runtime state changes
-- - Meaningful changes are: apps, config, or version
--   (reported_at and volatile system_info-only updates are intentionally excluded
--    to avoid high-volume history noise from heartbeat/uptime updates)

BEGIN;

CREATE TABLE IF NOT EXISTS public.device_current_state_history (
    id SERIAL PRIMARY KEY,
    device_uuid uuid NOT NULL,
    version integer NOT NULL DEFAULT 0,
    apps jsonb NOT NULL DEFAULT '{}'::jsonb,
    config jsonb DEFAULT '{}'::jsonb,
    system_info jsonb DEFAULT '{}'::jsonb,
    reported_at timestamp without time zone NOT NULL,
    captured_at timestamp without time zone NOT NULL DEFAULT now(),
    metadata jsonb
);

COMMENT ON TABLE public.device_current_state_history
    IS 'Historical snapshots of device current/runtime state for audit and troubleshooting';

COMMENT ON COLUMN public.device_current_state_history.version
    IS 'Version of target_state that the device reported as applied';

COMMENT ON COLUMN public.device_current_state_history.reported_at
    IS 'Original reported_at from device_current_state row when snapshot was captured';

CREATE INDEX IF NOT EXISTS idx_current_history_device_reported_at
    ON public.device_current_state_history (device_uuid, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_current_history_device_version
    ON public.device_current_state_history (device_uuid, version DESC);

CREATE OR REPLACE FUNCTION public.create_current_state_history_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Capture initial row, then only capture meaningful state changes.
    IF TG_OP = 'INSERT' OR (
        NEW.apps IS DISTINCT FROM OLD.apps OR
        NEW.config IS DISTINCT FROM OLD.config OR
        NEW.version IS DISTINCT FROM OLD.version
    ) THEN
        INSERT INTO public.device_current_state_history (
            device_uuid,
            version,
            apps,
            config,
            system_info,
            reported_at,
            metadata
        ) VALUES (
            NEW.device_uuid,
            COALESCE(NEW.version, 0),
            COALESCE(NEW.apps, '{}'::jsonb),
            COALESCE(NEW.config, '{}'::jsonb),
            COALESCE(NEW.system_info, '{}'::jsonb),
            COALESCE(NEW.reported_at, now()),
            jsonb_build_object(
                'trigger_op', TG_OP,
                'captured_from', 'device_current_state'
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_current_state_history ON public.device_current_state;

CREATE TRIGGER trigger_current_state_history
AFTER INSERT OR UPDATE ON public.device_current_state
FOR EACH ROW
EXECUTE FUNCTION public.create_current_state_history_snapshot();

COMMIT;
