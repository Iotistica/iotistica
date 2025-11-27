#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Test SNMP discovery against the simulator
  
.DESCRIPTION
  1. Ensures SNMP simulator is running
  2. Runs discovery with SNMP protocol
  3. Shows discovered devices
  
.NOTES
  Prerequisites:
  - docker-compose.dev.yml running with snmp-simulator
  - Agent built and ready to run
#>

Write-Host "=== SNMP Discovery Test ===" -ForegroundColor Cyan

# Check if simulator is running
Write-Host "`nChecking SNMP simulator..." -ForegroundColor Yellow
$simulatorRunning = docker ps --filter "name=snmp-simulator" --format "{{.Names}}" | Select-String "snmp-simulator"

if (-not $simulatorRunning) {
  Write-Host "SNMP simulator not running. Starting..." -ForegroundColor Yellow
  docker-compose -f docker-compose.dev.yml up -d snmp-simulator
  Start-Sleep -Seconds 3
}

# Get simulator IP
Write-Host "`nGetting simulator IP address..." -ForegroundColor Yellow
$simulatorIP = docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' iotistic-snmp-simulator

if (-not $simulatorIP) {
  Write-Host "ERROR: Could not get simulator IP" -ForegroundColor Red
  exit 1
}

Write-Host "Simulator IP: $simulatorIP" -ForegroundColor Green

# Test SNMP connection
Write-Host "`nTesting SNMP connection..." -ForegroundColor Yellow
try {
  $testResult = snmpget -v2c -c public ${simulatorIP}:1161 1.3.6.1.2.1.1.1.0 2>&1
  if ($testResult -match "Timeout") {
    Write-Host "WARNING: SNMP timeout - simulator may not be ready" -ForegroundColor Yellow
  } else {
    Write-Host "SNMP response: $testResult" -ForegroundColor Green
  }
} catch {
  Write-Host "NOTE: snmpget not installed (optional)" -ForegroundColor Yellow
}

# Set environment for discovery
Write-Host "`nConfiguring discovery environment..." -ForegroundColor Yellow
$env:SNMP_IP_RANGES = "$simulatorIP"
$env:SNMP_PORT = "1161"
$env:SNMP_COMMUNITY = "public"
$env:SNMP_VERSION = "v2c"
$env:SNMP_TIMEOUT = "2000"
$env:SNMP_CONCURRENCY = "5"

Write-Host "Environment:" -ForegroundColor Cyan
Write-Host "  SNMP_IP_RANGES: $env:SNMP_IP_RANGES"
Write-Host "  SNMP_PORT: $env:SNMP_PORT"
Write-Host "  SNMP_COMMUNITY: $env:SNMP_COMMUNITY"
Write-Host "  SNMP_VERSION: $env:SNMP_VERSION"

# Run discovery via agent API
Write-Host "`nRunning SNMP discovery..." -ForegroundColor Yellow
Write-Host "(Make sure agent is running: cd agent && npm run dev)" -ForegroundColor Gray

$discoveryPayload = @{
  trigger = "manual"
  validate = $true
  forceRun = $true
  protocols = @("snmp")
} | ConvertTo-Json

Write-Host "`nDiscovery request:" -ForegroundColor Cyan
Write-Host $discoveryPayload -ForegroundColor Gray

try {
  $response = Invoke-RestMethod -Uri "http://localhost:48484/v2/discovery/run" `
    -Method POST `
    -ContentType "application/json" `
    -Body $discoveryPayload `
    -TimeoutSec 60
  
  Write-Host "`n=== Discovery Results ===" -ForegroundColor Green
  $response | ConvertTo-Json -Depth 10 | Write-Host
  
  $deviceCount = $response.devices.Count
  if ($deviceCount -gt 0) {
    Write-Host "`nSUCCESS: Discovered $deviceCount SNMP device(s)!" -ForegroundColor Green
    
    # Show device details
    foreach ($device in $response.devices) {
      Write-Host "`nDevice:" -ForegroundColor Cyan
      Write-Host "  Name: $($device.name)"
      Write-Host "  Protocol: $($device.protocol)"
      Write-Host "  Host: $($device.connection.host):$($device.connection.port)"
      Write-Host "  Fingerprint: $($device.fingerprint)"
      Write-Host "  Validated: $($device.validated)"
      
      if ($device.metadata.sysDescr) {
        Write-Host "  sysDescr: $($device.metadata.sysDescr.Substring(0, [Math]::Min(60, $device.metadata.sysDescr.Length)))..."
      }
    }
  } else {
    Write-Host "`nWARNING: No devices discovered" -ForegroundColor Yellow
  }
  
} catch {
  Write-Host "`nERROR: Discovery request failed" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "`nMake sure agent is running:" -ForegroundColor Yellow
  Write-Host "  cd agent && npm run dev" -ForegroundColor Gray
  exit 1
}

Write-Host "`n=== Test Complete ===" -ForegroundColor Cyan
