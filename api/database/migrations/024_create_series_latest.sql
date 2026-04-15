-- Migration 024: Create series_latest table for O(1) Prometheus scrape reads
--
-- Replaces the `latest_readings` materialized view as the Prometheus scrape
-- source. Instead of periodic REFRESH MATERIALIZED VIEW CONCURRENTLY (full
-- recompute), ingestion workers upsert into this table inline during batch
-- commit, giving always-fresh data with O(series_count) reads and
-- O(batch_size) amortized writes.
--
-- The materialized view is kept for dashboard consumers that benefit from
-- its broader column set and 1-hour window refresh semantics.

CREATE TABLE IF NOT EXISTS series_latest (
  agent_uuid     uuid             NOT NULL,
  device_name    text             NOT NULL DEFAULT 'unknown',
  metric_name    text             NOT NULL,
  value          double precision,
  quality        text             NOT NULL DEFAULT 'good',
  unit           text,
  protocol       text             NOT NULL,
  time           timestamptz      NOT NULL,
  agent_is_online boolean         NOT NULL DEFAULT true,

  PRIMARY KEY (agent_uuid, device_name, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_series_latest_quality
  ON series_latest (quality);

COMMENT ON TABLE series_latest
  IS 'Latest reading per (agent, device, metric). Updated inline by ingestion workers via ON CONFLICT upsert. Primary consumer: Prometheus /metrics endpoint.';
