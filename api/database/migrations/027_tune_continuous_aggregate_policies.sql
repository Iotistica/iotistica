-- Tune continuous aggregate refresh policies.
--
-- Background: On CNPG with a 1000m CPU limit (vs. Docker with no limit) the
-- hourly aggregate jobs became visibly expensive:
--
--   readings_1h            - hourly, start_offset=1 day  -> 15.6s per run
--   readings_hourly        - hourly, start_offset=3h     ->  7.5s per run
--   device_logs_hourly     - hourly, start_offset=1 day  -> scans full day
--   mqtt_broker_stats_hourly   - hourly, start_offset=1 day
--   mqtt_topic_metrics_hourly  - hourly, start_offset=1 day
--   readings_1m            - every 1 min, start_offset=1h (fine: 42ms, but wasteful)
--
-- Root cause: A large start_offset on an hourly-scheduled job causes
-- TimescaleDB to scan many extra chunks every run, even when the data in that
-- range has not changed. This was invisible in Docker (no CPU cap) but causes
-- steady elevated CPU on K8s with a 1 vCPU limit.
--
-- Fix: set start_offset = 3 hours on all hourly aggregates (covers the refresh
-- window plus 2h of late-arriving data). Reduce readings_1m to 10-min window /
-- 2-min schedule. Data freshness is unchanged; scan work drops by ~8x on the
-- 1-day aggregates.

DO $$
DECLARE
  v_views TEXT[] := ARRAY[
    'readings_1h',
    'readings_hourly',
    'device_logs_hourly',
    'mqtt_broker_stats_hourly',
    'mqtt_topic_metrics_hourly'
  ];
  v_view TEXT;
BEGIN
  FOREACH v_view IN ARRAY v_views LOOP
    BEGIN
      PERFORM remove_continuous_aggregate_policy(v_view, if_not_exists => TRUE);
      PERFORM add_continuous_aggregate_policy(v_view,
        start_offset      => INTERVAL '3 hours',
        end_offset        => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour',
        if_not_exists     => TRUE);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Could not tune % policy: %', v_view, SQLERRM;
    END;
  END LOOP;

  -- readings_1m: tighter window, half the schedule frequency
  BEGIN
    PERFORM remove_continuous_aggregate_policy('readings_1m', if_not_exists => TRUE);
    PERFORM add_continuous_aggregate_policy('readings_1m',
      start_offset      => INTERVAL '10 minutes',
      end_offset        => INTERVAL '1 minute',
      schedule_interval => INTERVAL '2 minutes',
      if_not_exists     => TRUE);
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Could not tune readings_1m policy: %', SQLERRM;
  END;
END $$;
