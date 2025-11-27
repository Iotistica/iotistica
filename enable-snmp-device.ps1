#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Enable discovered SNMP device in agent database
#>

Write-Host "=== Enable SNMP Device ===" -ForegroundColor Cyan

# Copy database from container
Write-Host "`nCopying database from agent-25..." -ForegroundColor Yellow
docker cp agent-25:/app/data/device.sqlite ./temp-device.sqlite

if (-not (Test-Path ./temp-device.sqlite)) {
  Write-Host "ERROR: Failed to copy database" -ForegroundColor Red
  exit 1
}

# Check current SNMP devices
Write-Host "`nCurrent SNMP devices:" -ForegroundColor Yellow
sqlite3 ./temp-device.sqlite "SELECT id, name, protocol, enabled FROM endpoints WHERE protocol='snmp';"

# Enable all SNMP devices
Write-Host "`nEnabling all SNMP devices..." -ForegroundColor Yellow
sqlite3 ./temp-device.sqlite "UPDATE endpoints SET enabled=1 WHERE protocol='snmp';"

# Verify
Write-Host "`nUpdated SNMP devices:" -ForegroundColor Green
sqlite3 ./temp-device.sqlite "SELECT id, name, protocol, enabled FROM endpoints WHERE protocol='snmp';"

# Copy back to container
Write-Host "`nCopying database back to agent-25..." -ForegroundColor Yellow
docker cp ./temp-device.sqlite agent-25:/app/data/device.sqlite

# Cleanup
Remove-Item ./temp-device.sqlite

Write-Host "`nSUCCESS! Restart agent to apply changes:" -ForegroundColor Green
Write-Host "  docker restart agent-25" -ForegroundColor Gray

Write-Host "`nOr wait for config reload (agent polls every 30s)" -ForegroundColor Yellow
