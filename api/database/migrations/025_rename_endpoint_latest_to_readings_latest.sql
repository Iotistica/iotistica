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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'readings_latest') THEN
    COMMENT ON TABLE readings_latest
      IS 'Latest reading per (agent, device, metric). Updated inline by ingestion workers via ON CONFLICT upsert. Primary consumer: Prometheus /metrics endpoint.';
  END IF;
END $$;
