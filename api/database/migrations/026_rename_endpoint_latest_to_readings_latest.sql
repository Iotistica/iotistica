-- Migration 025: Rename endpoint_latest to readings_latest
--
-- Better name: the table tracks the latest reading per series, not per endpoint.
-- Renames table and index; comment updated to reflect new name.
-- Idempotent: safe to run whether or not the rename has already been applied.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'endpoint_latest') THEN
    ALTER TABLE endpoint_latest RENAME TO readings_latest;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_endpoint_latest_quality') THEN
    ALTER INDEX idx_endpoint_latest_quality RENAME TO idx_readings_latest_quality;
  END IF;
END $$;

-- Create table on fresh databases where neither endpoint_latest nor readings_latest exists.
-- On existing databases the rename above already produced readings_latest, so this is a no-op.
CREATE TABLE IF NOT EXISTS public.readings_latest (
    agent_uuid      uuid                     NOT NULL,
    device_name     text                     NOT NULL DEFAULT 'unknown',
    metric_name     text                     NOT NULL,
    value           double precision,
    quality         text                     NOT NULL DEFAULT 'good',
    unit            text,
    protocol        text                     NOT NULL,
    time            timestamp with time zone NOT NULL,
    agent_is_online boolean                  NOT NULL DEFAULT true,
    CONSTRAINT readings_latest_pkey PRIMARY KEY (agent_uuid, device_name, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_readings_latest_quality
    ON public.readings_latest USING btree (quality);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'readings_latest') THEN
    COMMENT ON TABLE readings_latest
      IS 'Latest reading per (agent, device, metric). Updated inline by ingestion workers via ON CONFLICT upsert. Primary consumer: Prometheus /metrics endpoint.';
  END IF;
END $$;
