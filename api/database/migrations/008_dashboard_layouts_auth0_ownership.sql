-- Migrate dashboard layout ownership from legacy users.id FK to Auth0/federated owner key
-- This removes hard dependency on local users table for dashboard persistence.

BEGIN;

-- 1) Add new owner_key identity column
ALTER TABLE public.dashboard_layouts
  ADD COLUMN IF NOT EXISTS owner_key character varying(255);

-- 2) Backfill existing rows deterministically from legacy user_id when present
UPDATE public.dashboard_layouts
SET owner_key = COALESCE(owner_key, 'legacy:' || user_id::text)
WHERE owner_key IS NULL AND user_id IS NOT NULL;

-- 3) Ensure all rows have an owner key (safety fallback for historical anomalies)
UPDATE public.dashboard_layouts
SET owner_key = COALESCE(owner_key, 'orphan:' || id::text)
WHERE owner_key IS NULL;

ALTER TABLE public.dashboard_layouts
  ALTER COLUMN owner_key SET NOT NULL;

-- 4) Remove dependency on users table and allow user_id to be nullable legacy metadata
ALTER TABLE public.dashboard_layouts
  DROP CONSTRAINT IF EXISTS dashboard_layouts_user_id_fkey;

ALTER TABLE public.dashboard_layouts
  ALTER COLUMN user_id DROP NOT NULL;

-- 5) Replace user_id-based indexes/uniqueness with owner_key-based equivalents
DROP INDEX IF EXISTS public.idx_dashboard_layouts_global;
DROP INDEX IF EXISTS public.idx_dashboard_layouts_one_default;
DROP INDEX IF EXISTS public.idx_dashboard_layouts_unique_name;
DROP INDEX IF EXISTS public.idx_dashboard_layouts_user;
DROP INDEX IF EXISTS public.idx_dashboard_layouts_user_device;

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_owner
  ON public.dashboard_layouts USING btree (owner_key);

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_owner_global
  ON public.dashboard_layouts USING btree (owner_key)
  WHERE (device_uuid IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_owner_one_default
  ON public.dashboard_layouts USING btree (owner_key, COALESCE((device_uuid)::text, 'global'::text))
  WHERE (is_default = true);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_owner_unique_name
  ON public.dashboard_layouts USING btree (owner_key, COALESCE((device_uuid)::text, 'global'::text), layout_name);

CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_owner_device
  ON public.dashboard_layouts USING btree (owner_key, device_uuid)
  WHERE (device_uuid IS NOT NULL);

COMMIT;
