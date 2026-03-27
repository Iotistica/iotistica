DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dashboard_layouts'
      AND column_name = 'device_uuid'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dashboard_layouts'
      AND column_name = 'agent_uuid'
  ) THEN
    ALTER TABLE public.dashboard_layouts
      RENAME COLUMN device_uuid TO agent_uuid;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dashboard_layouts_device_uuid_fkey'
      AND conrelid = 'public.dashboard_layouts'::regclass
  ) THEN
    ALTER TABLE public.dashboard_layouts
      RENAME CONSTRAINT dashboard_layouts_device_uuid_fkey TO dashboard_layouts_agent_uuid_fkey;
  END IF;
END $$;

ALTER INDEX IF EXISTS public.idx_dashboard_layouts_device
  RENAME TO idx_dashboard_layouts_agent;

ALTER INDEX IF EXISTS public.idx_dashboard_layouts_owner_device
  RENAME TO idx_dashboard_layouts_owner_agent;