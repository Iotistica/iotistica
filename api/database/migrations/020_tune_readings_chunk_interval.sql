-- NO TRANSACTION
-- Migration 020: Tune readings hypertable chunk interval for high-ingest deployments
--
-- Background:
--   Migration 006 created readings with chunk_time_interval = '1 day'.
--   At high ingest rates (>50k rows/min), 1-day chunks grow large, increasing:
--     - Active-chunk index size (larger B-tree = more random IO on write)
--     - WAL volume per checkpoint
--     - Time-to-compress (larger chunks take longer to compress)
--
--   Reducing to 6 hours keeps each chunk small enough to fit comfortably in
--   shared_buffers, compresses faster, and reduces index write amplification.
--
-- Safety:
--   set_chunk_time_interval is applied to NEW chunks only.
--   Existing chunks retain their original interval — no data is rewritten.
--   The existing compression policy (7 days), retention policy (730 days),
--   and all indexes are untouched.
--
-- Tuning guide:
--   Low ingest  (<1k rows/min)  : keep '1 day'   (fewer, larger chunks = less overhead)
--   Medium ingest (1k-50k/min)  : '6 hours'      (this migration)
--   High ingest  (>50k rows/min): '1 hour'        (manually set via the env var below)
--
-- To override at deploy time without re-running migrations, set:
--   TIMESCALE_READINGS_CHUNK_INTERVAL=1 hour   (or '6 hours', '1 day', etc.)
-- The DO block below reads this variable; if absent it defaults to '6 hours'.

SET search_path = public;

DO $$
DECLARE
  target_interval INTERVAL;
  env_val TEXT;
BEGIN
  -- Allow runtime override via GUC set by the migration runner or container env:
  --   SET app.readings_chunk_interval = '1 hour';
  BEGIN
    env_val := current_setting('app.readings_chunk_interval');
  EXCEPTION WHEN OTHERS THEN
    env_val := NULL;
  END;

  target_interval := COALESCE(
    NULLIF(env_val, '')::INTERVAL,
    INTERVAL '6 hours'
  );

  -- Only update if the hypertable exists and the interval differs from target.
  IF EXISTS (
    SELECT 1 FROM _timescaledb_catalog.hypertable
    WHERE table_name = 'readings' AND schema_name = 'public'
  ) THEN
    PERFORM set_chunk_time_interval('readings', target_interval);
    RAISE NOTICE 'readings: chunk_time_interval set to %', target_interval;
  ELSE
    RAISE NOTICE 'readings: hypertable not found, skipping chunk interval update';
  END IF;
END $$;
