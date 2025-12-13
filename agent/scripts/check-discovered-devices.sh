#!/bin/bash
# Check discovered devices in agent database

AGENT_POD="${1:-agent-fleet-test-59-0}"
NAMESPACE="${2:-agent-fleet-test}"

echo "Checking discovered devices in pod: $AGENT_POD (namespace: $NAMESPACE)"
echo ""

# Execute SQLite query inside the pod
kubectl exec -it "$AGENT_POD" -n "$NAMESPACE" -c agent -- sqlite3 /app/data/agent.db <<'EOF'
.headers on
.mode column

-- Show all discovered devices
SELECT 
  id,
  name,
  protocol,
  enabled,
  datetime(lastSeenAt/1000, 'unixepoch') as last_seen,
  json_extract(connection, '$.host') as host,
  json_extract(connection, '$.port') as port,
  json_extract(metadata, '$.fingerprint') as fingerprint
FROM device_endpoints
ORDER BY lastSeenAt DESC;

-- Show device count by protocol
.print ""
.print "Device Count by Protocol:"
SELECT protocol, COUNT(*) as count, SUM(enabled) as enabled
FROM device_endpoints
GROUP BY protocol;

-- Show recently discovered (last 24 hours)
.print ""
.print "Recently Discovered (last 24 hours):"
SELECT 
  name,
  protocol,
  datetime(lastSeenAt/1000, 'unixepoch') as last_seen
FROM device_endpoints
WHERE lastSeenAt > (strftime('%s', 'now') - 86400) * 1000
ORDER BY lastSeenAt DESC;

EOF

echo ""
echo "Done!"
