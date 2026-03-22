#!/bin/bash
set -e

EXCLUDES=$(psql -U postgres -d iotistic -Atc "
SELECT '--exclude-table=' || viewname FROM pg_views WHERE schemaname = 'public'
UNION ALL
SELECT '--exclude-table=' || matviewname FROM pg_matviews WHERE schemaname = 'public'
")

EXCLUDE_FLAGS=$(echo "$EXCLUDES" | tr '\n' ' ')

pg_dump -U postgres -d iotistic \
  --schema-only --no-comments --no-owner --no-privileges --schema=public \
  $EXCLUDE_FLAGS \
  -f /tmp/schema_v3.sql

echo "lines=$(wc -l < /tmp/schema_v3.sql)" > /tmp/schema_v3_status.txt
echo "view_refs=$(grep -c 'CREATE VIEW\|CREATE MATERIALIZED VIEW' /tmp/schema_v3.sql || true)" >> /tmp/schema_v3_status.txt
echo "internal_refs=$(grep -c '_materialized_hypertable_' /tmp/schema_v3.sql || true)" >> /tmp/schema_v3_status.txt
echo "done=1" >> /tmp/schema_v3_status.txt
