-- Migration: Install TimescaleDB extension
-- Must run before migration 006 which creates hypertables and continuous aggregates.
-- Uses IF NOT EXISTS so it is safe to re-run (idempotent).

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
