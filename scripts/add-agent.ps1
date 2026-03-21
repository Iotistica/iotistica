#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Adds a new agent service to docker-compose.yml
.DESCRIPTION
    Automates the process of adding a new agent service by:
    - Finding the next agent number
    - Automatically generating provisioning API key via API
    - Adding the service definition to docker-compose.yml
    - Adding the corresponding volume
.PARAMETER AgentNumber
    Optional. Specific agent number to add. If not provided, finds next available number.
.PARAMETER ProvisioningKey
    Optional. Provisioning API key. If not provided, generates one via API.
.PARAMETER ApiUrl
    Optional. API base URL. Defaults to http://localhost:4002
.PARAMETER FleetId
    Optional. Fleet ID for the provisioning key. Defaults to 'default-fleet'.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [int]$AgentNumber,

    [Parameter(Mandatory=$false)]
    [string]$ProvisioningKey,

    [Parameter(Mandatory=$false)]
    [string]$ApiUrl = "http://localhost:4002",

    [Parameter(Mandatory=$false)]
    [string]$FleetId = "default-fleet"
)

# Configuration
$dockerComposeFile = Join-Path $PSScriptRoot ".." "docker-compose.yml"

# Function to find next available agent number
function Get-NextAgentNumber {
    param([string]$content)
    $maxNumber = 0
    $matches = [regex]::Matches($content, 'agent-(\d+):')
    foreach ($match in $matches) {
        $num = [int]$match.Groups[1].Value
        if ($num -gt $maxNumber) { $maxNumber = $num }
    }
    return $maxNumber + 1
}

# Check docker-compose.yml exists
if (-not (Test-Path $dockerComposeFile)) {
    Write-Error "docker-compose.yml not found at: $dockerComposeFile"
    exit 1
}

# Read file
$content = Get-Content $dockerComposeFile -Raw

# Determine agent number
if (-not $AgentNumber) {
    $AgentNumber = Get-NextAgentNumber -content $content
    Write-Host "Auto-detected next agent number: $AgentNumber" -ForegroundColor Cyan
} else {
    if ($content -match "agent-$AgentNumber`:") {
        Write-Error "Agent-$AgentNumber already exists"
        exit 1
    }
}

# Get or generate provisioning key
if (-not $ProvisioningKey) {
    Write-Host "🔑 Generating provisioning key via API..." -ForegroundColor Cyan
    
    try {
        # Call API to generate provisioning key
        $body = @{
            fleetUuid = $FleetId
            newKey = $false
        } | ConvertTo-Json

        $response = Invoke-RestMethod -Uri "$ApiUrl/api/v1/provisioning-keys/generate" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -ErrorAction Stop

        $ProvisioningKey = $response.key
        $keyId = $response.id
        $expiresAt = $response.expiresAt

        Write-Host "✅ Provisioning key generated successfully!" -ForegroundColor Green
        Write-Host "   Key ID: $keyId" -ForegroundColor Gray
        Write-Host "   Expires: $expiresAt" -ForegroundColor Gray
        Write-Host "   Fleet: $FleetId" -ForegroundColor Gray
    }
    catch {
        Write-Error "Failed to generate provisioning key via API: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "💡 Make sure the API is running at: $ApiUrl" -ForegroundColor Yellow
        Write-Host "   You can manually provide a key with: -ProvisioningKey <key>" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "Using provided provisioning key: $($ProvisioningKey.Substring(0, 16))..." -ForegroundColor Green
}

# Agent template
$template = @"
    agent-{AGENT_NUMBER}:
            container_name: agent-{AGENT_NUMBER}
            image: zemfyre-sensor-agent:latest
            restart: always
            volumes:
                - /var/run/docker.sock:/var/run/docker.sock
                - agent-{AGENT_NUMBER}-data:/app/data
            environment:
                - DEVICE_API_PORT=4848{AGENT_NUMBER}
                - IOTISTICA_API=http://host.docker.internal:4002
                - NODE_ENV=development
                - MQTT_PERSIST_TO_DB=true
                - MQTT_DB_SYNC_INTERVAL=70000
                - REPORT_INTERVAL_MS=20000
                - METRICS_INTERVAL_MS=30000
                - LOG_COMPRESSION=true
                - REQUIRE_PROVISIONING=false
                - PROVISIONING_API_KEY={PROVISIONING_KEY}
                # Memory monitoring (edge-appropriate thresholds)
                - MEMORY_CHECK_INTERVAL_MS=30000
                - MEMORY_THRESHOLD_MB=15
                # Data resilience (IoT best practices)
                - LOG_FILE_PERSISTANCE=true
                - LOG_MAX_AGE=86400000
                - MAX_LOG_FILE_SIZE=52428800
                - MAX_LOGS=10000
                # Memory leak simulation 
                - SIMULATE_MEMORY_LEAK=false
                - LEAK_TYPE=sudden
                - LEAK_RATE_MB=50
                - LEAK_INTERVAL_MS=2000
                - LEAK_MAX_MB=30
                - ANOMALY_DETECTION_ENABLED=true
                 # NEW: Simulation mode (unified testing framework)
                - SIMULATION_MODE=false
                - SIMULATION_CONFIG={"scenarios":{"anomaly_injection":{"enabled":true,"metrics":["cpu_temp","memory_percent"],"pattern":"spike","intervalMs":30000,"magnitude":3},"sensor_data":{"enabled":true,"pattern":"realistic","publishIntervalMs":10000}}}
                
                
            depends_on:
                api:
                    condition: service_healthy
            networks:
                - iotistic-net

"@

# Replace placeholders
$newAgentService = $template.Replace("{AGENT_NUMBER}", $AgentNumber).Replace("{PROVISIONING_KEY}", $ProvisioningKey)

# Insert new agent after last agent
$agentMatches = [regex]::Matches($content, '(?ms)^ {4}agent-\d+:.*?(?=^ {4}[a-zA-Z])')
if ($agentMatches.Count -eq 0) {
    Write-Error "No existing agent services found"
    exit 1
}
$lastAgent = $agentMatches[$agentMatches.Count - 1]
$before = $content.Substring(0, $lastAgent.Index + $lastAgent.Length)
$after  = $content.Substring($lastAgent.Index + $lastAgent.Length)
$content = $before + $newAgentService + $after

# Add volume block
$newVolume = "  agent-$AgentNumber-data:`n    driver: local"

# Find the volumes section and add after last agent volume
if ($content -match '(?ms)^volumes:.*') {
    $volumeMatches = [regex]::Matches($content, '(?m)^\s*agent-\d+-data:\s*\n\s*driver: local')
    if ($volumeMatches.Count -gt 0) {
        $lastVolume = $volumeMatches[$volumeMatches.Count - 1]
        $insertIndex = $lastVolume.Index + $lastVolume.Length
        $content = $content.Insert($insertIndex, "`n$newVolume")
    } else {
        # No agent volumes with driver found, add after wg-data
        $wgDataMatch = [regex]::Match($content, '(?m)^\s*wg-data:')
        if ($wgDataMatch.Success) {
            $insertIndex = $content.IndexOf("`n", $wgDataMatch.Index) + 1
            $content = $content.Insert($insertIndex, "$newVolume`n")
        }
    }
}

# Write back
Set-Content -Path $dockerComposeFile -Value $content -NoNewline

Write-Host "`n✅ Successfully added agent-$AgentNumber to docker-compose.yml" -ForegroundColor Green

# Save provisioning key
$keysFile = Join-Path $PSScriptRoot ".." "provisioning-keys.txt"
$keyEntry = "agent-${AgentNumber}: $ProvisioningKey (Added: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), Fleet: $FleetId)"
Add-Content -Path $keysFile -Value $keyEntry
Write-Host "📝 Provisioning key saved to: provisioning-keys.txt" -ForegroundColor Magenta
Write-Host ""
Write-Host "🚀 Next steps:" -ForegroundColor Cyan
Write-Host "   1. Run: docker compose up -d agent-$AgentNumber" -ForegroundColor White
Write-Host "   2. Check logs: docker logs agent-$AgentNumber --follow" -ForegroundColor White
Write-Host "   3. Device will auto-provision and connect to cloud" -ForegroundColor White
