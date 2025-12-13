#!/usr/bin/env pwsh
<#
.SYNOPSIS
Enable discovered devices in the agent database for sensor publishing

.DESCRIPTION
Updates all discovered devices to enabled=1 so Sensor Publish feature starts polling them.
By default, discovered devices are saved with enabled=0 until user approves.

.PARAMETER AgentPod
Name of the agent pod (default: uses first pod with "agent" in name)

.PARAMETER Namespace
Kubernetes namespace (default: agent-fleet-test)

.PARAMETER Protocol
Filter by protocol (modbus, opcua, snmp, can). If omitted, enables all protocols.

.PARAMETER DryRun
Show what would be changed without making changes

.EXAMPLE
# Enable all discovered devices
.\enable-discovered-devices.ps1

.EXAMPLE
# Enable only Modbus devices
.\enable-discovered-devices.ps1 -Protocol modbus

.EXAMPLE
# Dry run to see what would change
.\enable-discovered-devices.ps1 -DryRun
#>

param(
    [string]$AgentPod = "",
    [string]$Namespace = "agent-fleet-test",
    [string]$Protocol = "",
    [switch]$DryRun
)

# Find agent pod if not specified
if (-not $AgentPod) {
    Write-Host "🔍 Finding agent pod..." -ForegroundColor Cyan
    $pods = kubectl get pods -n $Namespace -o json | ConvertFrom-Json
    $agentPod = $pods.items | Where-Object { $_.metadata.name -like "*agent*" } | Select-Object -First 1
    
    if (-not $agentPod) {
        Write-Error "No agent pod found in namespace '$Namespace'"
        exit 1
    }
    
    $AgentPod = $agentPod.metadata.name
    Write-Host "✓ Found pod: $AgentPod" -ForegroundColor Green
}

Write-Host "`n📊 Current Device Status:" -ForegroundColor Yellow
Write-Host "=" * 60

# Show current status
$statusQuery = @"
SELECT 
    id,
    name,
    protocol,
    enabled,
    datetime(lastSeenAt/1000, 'unixepoch') as last_seen
FROM device_endpoints
ORDER BY protocol, id;
"@

kubectl exec -n $Namespace $AgentPod -c agent -- sqlite3 /app/data/agent.db "$statusQuery" | ForEach-Object {
    Write-Host $_
}

Write-Host "`n"

# Build UPDATE query
$whereClause = if ($Protocol) { "WHERE protocol = '$Protocol'" } else { "WHERE 1=1" }

if ($DryRun) {
    Write-Host "🔍 DRY RUN - Would enable these devices:" -ForegroundColor Cyan
    
    $dryRunQuery = @"
SELECT 
    id,
    name,
    protocol,
    enabled
FROM device_endpoints
$whereClause AND enabled = 0;
"@
    
    kubectl exec -n $Namespace $AgentPod -c agent -- sqlite3 /app/data/agent.db "$dryRunQuery" | ForEach-Object {
        Write-Host "  $_" -ForegroundColor Yellow
    }
    
    Write-Host "`n⚠️  No changes made (dry run mode)" -ForegroundColor Yellow
    exit 0
}

# Actually enable devices
Write-Host "🔧 Enabling discovered devices..." -ForegroundColor Cyan

$updateQuery = "UPDATE device_endpoints SET enabled = 1 $whereClause AND enabled = 0;"

$result = kubectl exec -n $Namespace $AgentPod -c agent -- sqlite3 /app/data/agent.db "$updateQuery"

# Count enabled devices
$countQuery = "SELECT COUNT(*) FROM device_endpoints WHERE enabled = 1;"
$enabledCount = kubectl exec -n $Namespace $AgentPod -c agent -- sqlite3 /app/data/agent.db "$countQuery"

Write-Host "`n✅ Enabled devices successfully!" -ForegroundColor Green
Write-Host "📊 Total enabled devices: $enabledCount" -ForegroundColor Cyan

Write-Host "`n📊 Updated Device Status:" -ForegroundColor Yellow
Write-Host "=" * 60

kubectl exec -n $Namespace $AgentPod -c agent -- sqlite3 /app/data/agent.db "$statusQuery" | ForEach-Object {
    Write-Host $_
}

Write-Host "`n"
Write-Host "💡 Next steps:" -ForegroundColor Yellow
Write-Host "  1. Wait for agent to reload endpoints (~30s auto-reconciliation)" -ForegroundColor Gray
Write-Host "  2. Check logs for 'Sensor Publish feature' initialization" -ForegroundColor Gray
Write-Host "  3. Monitor MQTT topics: sensor/{protocol}/{name}/{metric}" -ForegroundColor Gray
Write-Host "`n  Watch logs:" -ForegroundColor Gray
Write-Host "    kubectl logs -f $AgentPod -c agent -n $Namespace | grep -i 'sensor'" -ForegroundColor DarkGray
