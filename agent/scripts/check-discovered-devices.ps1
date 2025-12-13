# Check discovered devices in agent database (PowerShell)

param(
    [string]$AgentPod = "agent-fleet-test-59-0",
    [string]$Namespace = "agent-fleet-test"
)

Write-Host "Checking discovered devices in pod: $AgentPod (namespace: $Namespace)" -ForegroundColor Cyan
Write-Host ""

# SQL query to check devices
$sqlQuery = @"
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
"@

# Execute query in pod
kubectl exec -it $AgentPod -n $Namespace -c agent -- sqlite3 /app/data/agent.db $sqlQuery

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
