#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Generate or cleanup multiple agent configurations in docker-compose.yml
.DESCRIPTION
    Creates N agent entries with unique ports, API keys (from API), volume names, and varied simulation modes.
    Can also cleanup agents by stopping containers, removing volumes, and deleting images.
.PARAMETER Count
    Number of agents to generate (default: 10)
.PARAMETER StartIndex
    Starting index for agent naming (default: 47)
.PARAMETER OutputFile
    Output docker-compose file (default: docker-compose.agents.yml)
.PARAMETER ApiUrl
    API base URL for provisioning key generation (default: https://api:3663)
.PARAMETER FleetId
    Fleet ID for provisioning keys (default: default-fleet)
.PARAMETER Cleanup
    Cleanup mode: stop containers, remove volumes, and delete images for specified agent range
.PARAMETER Run
    Automatically run docker-compose up after generating the file
.EXAMPLE
    .\generate-agents.ps1 -Count 100
.EXAMPLE
    .\generate-agents.ps1 -Count 50 -StartIndex 101 -OutputFile docker-compose.agents-101-150.yml
.EXAMPLE
    .\generate-agents.ps1 -Count 3 -Run
.EXAMPLE
    .\generate-agents.ps1 -Cleanup -StartIndex 47 -Count 54
.EXAMPLE
    .\generate-agents.ps1 -Cleanup -StartIndex 2 -Count 45
#>

param(
    [int]$Count = 1,
    [int]$StartIndex = 27,
    [string]$OutputFile = "docker-compose.agents.yml",
    #[string]$ApiUrl = "http://23.233.80.107:30002",
    #[string]$ApiUrl = "https://localhost:3443",
    [string]$ApiUrl = "https://localhost:3443",
    [string]$FleetId = "default-fleet",
    
    # Cleanup Mode
    [switch]$Cleanup,
    
    # Run Mode
    [switch]$Run,
    
    # Build Mode - build from source instead of using pre-built image
    [switch]$BuildFromSource,
    
    # Network Mode - use host network for discovery (default: true)
    [bool]$UseHostNetwork = $true,
    
    # Agent Configuration
    [string]$NodeEnv = "development",
    #[string]$CLOUD_API_ENDPOINT = "http://23.233.80.107:30002",
    #[string]$CLOUD_API_ENDPOINT = "https://api:3443",
    [string]$CLOUD_API_ENDPOINT = "https://api:3443",
    [int]$ReportInterval = 20000,
    [int]$MetricsInterval = 30000,
    [string]$LogCompression = "true",
    [string]$RequireProvisioning = "false",
    [string]$ApiSecurityMode = "LOCALHOST_ONLY",
    [int]$MemoryCheckInterval = 30000,
    [int]$MemoryThreshold = 30,
    [string]$LogFilePersistance = "true",
    [int]$LogMaxAge = 86400000,
    [int]$MaxLogFileSize = 52428800,
    [int]$MaxLogs = 10000,
    [string]$SimulateMemoryLeak = "false",
    [string]$AnomalyDetectionEnabled = "true",
    [string]$FirewallEnabled = "false",
    [string]$UseMsgpackPoc = "true",
    [string]$UseKeyCompactionPoc = "false",
    [string]$UseDeflateCompression = "true",
    [string]$EnableHeapProfiling = "true",
    
    # Protocol Adapter Configuration
    [string]$EnableProtocolAdapters = "true",
    [string]$EnableSensorPublish = "true",
    [string]$EnableFirstBootDiscovery = "true",
    [string]$ModbusTcpHost = "iotistic-modbus-sim",
    [int]$ModbusTcpPort = 502,
    [int]$ModbusSlaveRangeStart = 1,
    [int]$ModbusSlaveRangeEnd = 10,
    [int]$ModbusTimeout = 2000,
    [string]$OpcuaDiscoveryUrls = "",
    [string]$SnmpIpRanges = "iotistic-snmp-sim",
    [int]$SnmpPort = 161,
    
    # Simulation Control
    [switch]$EnableSimulation,
    
    # Container Resources
    [string]$MemLimit = "512m",
    [string]$MemReservation = "256m"
)

$ErrorActionPreference = "Stop"

# Cleanup function - stop containers, remove volumes, and delete images
function Remove-AgentResources {
    param(
        [int]$StartIndex,
        [int]$Count
    )
    
    $endIndex = $StartIndex + $Count - 1
    
    Write-Host "`n🧹 Cleanup Mode: Removing agents $StartIndex to $endIndex" -ForegroundColor Yellow
    
    $containerNames = @()
    $volumeNames = @()
    $imageNames = @()
    $networkNames = @()
    
    # Core service containers (shared, add once)
    $containerNames += "core-services_mosquitto_1"
    $containerNames += "core-services_nodered_2"
    
    # Core service volumes (shared, add once)
    $volumeNames += "1000_mosquitto-data"
    $volumeNames += "1000_mosquitto-config"
    $volumeNames += "1000_mosquitto-log"
    $volumeNames += "1000_nodered-data"
    
    # Core service networks (shared, add once)
    $networkNames += "1000_default"
    
    for ($i = $StartIndex; $i -le $endIndex; $i++) {
        # Agent container
        $containerNames += "agent-$i"
        
        # Agent volumes
        $volumeNames += "zemfyre-sensor_agent-$i-data"
        
        # Agent images - use explicit string formatting to ensure proper expansion
        $imageName = "zemfyre-sensor-agent-{0}:latest" -f $i
        $imageNames += $imageName
    }
    
    # Stop and remove containers
    Write-Host "`n🛑 Stopping containers..." -ForegroundColor Cyan
    try {
        $output = docker stop $containerNames 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ Stopped $($containerNames.Count) containers" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  ⚠️  Some containers may not exist or are already stopped" -ForegroundColor Yellow
    }
    
    Write-Host "`n🗑️  Removing containers..." -ForegroundColor Cyan
    try {
        $output = docker rm $containerNames 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ Removed $($containerNames.Count) containers" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  ⚠️  Some containers may not exist" -ForegroundColor Yellow
    }
    
    # Remove volumes
    Write-Host "`n💾 Removing volumes..." -ForegroundColor Cyan
    $removedCount = 0
    foreach ($volume in $volumeNames) {
        try {
            $output = docker volume rm $volume 2>&1
            if ($LASTEXITCODE -eq 0) {
                $removedCount++
                if ($removedCount % 10 -eq 0) {
                    Write-Host "  Removed $removedCount volumes..." -ForegroundColor Gray
                }
            }
        }
        catch {
            # Volume may not exist, continue
        }
    }
    Write-Host "  ✅ Removed $removedCount volumes" -ForegroundColor Yellow
    
    # Remove networks
    Write-Host "`n🌐 Removing networks..." -ForegroundColor Cyan
    $removedNetworkCount = 0
    foreach ($network in $networkNames) {
        try {
            $output = docker network rm $network 2>&1
            if ($LASTEXITCODE -eq 0) {
                $removedNetworkCount++
            }
        }
        catch {
            # Network may not exist, continue
        }
    }
    Write-Host "  ✅ Removed $removedNetworkCount networks" -ForegroundColor Yellow
    
    # Remove agent images only (not dangling images from other services)
    Write-Host "`n🖼️  Removing agent images..." -ForegroundColor Cyan
    $removedCount = 0
    foreach ($image in $imageNames) {
        try {
            # Force remove image (even if containers exist)
            $result = docker rmi -f $image 2>&1
            if ($LASTEXITCODE -eq 0) {
                $removedCount++
                if ($removedCount % 10 -eq 0) {
                    Write-Host "  Removed $removedCount images..." -ForegroundColor Gray
                }
            } else {
                Write-Host "  ⚠️  Failed to remove image: $image" -ForegroundColor Yellow
                Write-Host "     Error: $result" -ForegroundColor Gray
            }
        }
        catch {
            Write-Host "  ⚠️  Error removing image $image : $_" -ForegroundColor Yellow
        }
    }
    Write-Host "  ✅ Removed $removedCount agent images" -ForegroundColor Green
    
    Write-Host "`n✅ Cleanup complete!" -ForegroundColor Green
    Write-Host "  Agents cleaned: $StartIndex to $endIndex" -ForegroundColor Gray
    Write-Host "  Core services removed: mosquitto, nodered (per agent)" -ForegroundColor Gray
}

# Generate provisioning key via API
function New-ProvisioningKey {
    param([string]$ApiUrl, [string]$FleetId)
    
    try {
        $body = @{
            fleetId = $FleetId
            newKey = $false
        } | ConvertTo-Json

        $response = Invoke-RestMethod -Uri "$ApiUrl/api/v1/provisioning-keys/generate" `
            -Method Post `
            -ContentType "application/json" `
            -Body $body `
            -SkipCertificateCheck `
            -ErrorAction Stop

        return $response.key
    }
    catch {
        Write-Error "Failed to generate provisioning key via API: $($_.Exception.Message)"
        Write-Host "💡 Make sure the API is running at: $ApiUrl" -ForegroundColor Yellow
        exit 1
    }
}

# Calculate port in 48xxx-58xxx range (5 digits)
function Get-UniquePort {
    param([int]$Index)
    # Continue from existing agents: agent-1=48481, agent-46=48546
    # Start at 48547 for agent-47+
    $basePort = 48480
    return $basePort + $Index
}

# Get simulation configuration based on agent index (varied patterns)
function Get-SimulationConfig {
    param([int]$Index, [bool]$SimulationEnabled)
    
    # If simulation is disabled globally, return disabled config
    if (-not $SimulationEnabled) {
        return @{
            enabled = "false"
            config = '{}'
        }
    }
    
    $mode = $Index % 5
    
    switch ($mode) {
        0 {
            # Normal operation - no simulation
            return @{
                enabled = "false"
                config = '{}'
            }
        }
        1 {
            # Realistic sensor data with occasional anomalies
            return @{
                enabled = "true"
                config = '{"scenarios":{"anomaly_injection":{"enabled":true,"metrics":["cpu_temp","memory_percent"],"pattern":"spike","intervalMs":60000,"magnitude":2},"sensor_data":{"enabled":true,"pattern":"realistic","publishIntervalMs":10000}}}'
            }
        }
        2 {
            # High-frequency data with gradual anomalies
            return @{
                enabled = "true"
                config = '{"scenarios":{"anomaly_injection":{"enabled":true,"metrics":["cpu_temp"],"pattern":"gradual","intervalMs":120000,"magnitude":4},"sensor_data":{"enabled":true,"pattern":"realistic","publishIntervalMs":5000}}}'
            }
        }
        3 {
            # Aggressive spike patterns (stress testing)
            return @{
                enabled = "true"
                config = '{"scenarios":{"anomaly_injection":{"enabled":true,"metrics":["cpu_temp","memory_percent","disk_usage"],"pattern":"spike","intervalMs":30000,"magnitude":5},"sensor_data":{"enabled":true,"pattern":"realistic","publishIntervalMs":8000}}}'
            }
        }
        4 {
            # Random walk pattern
            return @{
                enabled = "true"
                config = '{"scenarios":{"anomaly_injection":{"enabled":false},"sensor_data":{"enabled":true,"pattern":"random_walk","publishIntervalMs":15000}}}'
            }
        }
    }
}

# Execute cleanup or generation based on mode
if ($Cleanup) {
    Remove-AgentResources -StartIndex $StartIndex -Count $Count
    exit 0
}

Write-Host "Generating $Count agents (indices $StartIndex to $($StartIndex + $Count - 1))..." -ForegroundColor Cyan
if ($EnableSimulation) {
    Write-Host "Simulation modes: 20% off, 80% varied patterns (realistic, gradual, spike, random_walk)" -ForegroundColor Gray
} else {
    Write-Host "Simulation: DISABLED (all agents in normal operation mode)" -ForegroundColor Gray
}
Write-Host "🔑 Generating provisioning keys via API at $ApiUrl..." -ForegroundColor Cyan

$services = @()
$volumes = @()
$provisioningKeys = @()

for ($i = $StartIndex; $i -lt ($StartIndex + $Count); $i++) {
    $agentName = "agent-$i"
    $port = Get-UniquePort $i
    
    # Generate provisioning key via API
    Write-Host "  Generating key for $agentName..." -ForegroundColor Gray
    $apiKey = New-ProvisioningKey -ApiUrl $ApiUrl -FleetId $FleetId
    $provisioningKeys += "${agentName}: $apiKey"
    
    $volumeName = "$agentName-data"
    $simConfig = Get-SimulationConfig -Index $i -SimulationEnabled $EnableSimulation.IsPresent
    
    # Adjust CLOUD_API_ENDPOINT based on network mode
    # Host mode: use localhost (shares host network stack)
    # Bridge mode: use service name (container networking)
    $cloudApiEndpoint = if ($UseHostNetwork) {
        $CLOUD_API_ENDPOINT -replace "api:", "localhost:"
    } else {
        $CLOUD_API_ENDPOINT
    }
    
    # Build configuration: use build context if -BuildFromSource, otherwise use image
    $buildOrImage = if ($BuildFromSource) {
        @"
    build:
      context: .
      dockerfile: agent/Dockerfile
"@
    } else {
        "    image: iotistic/agent:latest"
    }
    
    # Network configuration: host mode for discovery or bridge for isolation
    $networkConfig = if ($UseHostNetwork) {
        @"
    network_mode: host
"@
    } else {
        @"
    networks:
      - iotistic-net
"@
    }
    
    # Service definition
    $service = @"
  $agentName`:
    container_name: $agentName
$buildOrImage
    restart: always
    mem_limit: $MemLimit
    mem_reservation: $MemReservation
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    devices:
      - /dev/net/tun:/dev/net/tun
$networkConfig
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - $volumeName`:/app/data
      - ./certs/ca.crt:/app/certs/ca.crt:ro
    environment:
      - DEVICE_API_PORT=$port
      - CLOUD_API_ENDPOINT=$cloudApiEndpoint
      - NODE_ENV=$NodeEnv
      # Bootstrap & Security (not dashboard-controlled)
      - REQUIRE_PROVISIONING=$RequireProvisioning
      - PROVISIONING_KEY=$apiKey
      - API_SECURITY_MODE=$ApiSecurityMode
      - FIREWALL_ENABLED=$FirewallEnabled
      # Testing & Development (not dashboard-controlled)
      - SIMULATION_MODE=$($simConfig.enabled)
      - SIMULATION_CONFIG=$($simConfig.config)
      - SIMULATE_MEMORY_LEAK=$SimulateMemoryLeak
      - USE_MSGPACK_POC=$UseMsgpackPoc
      - USE_KEY_COMPACTION_POC=$UseKeyCompactionPoc
      - USE_DEFLATE_COMPRESSION=$UseDeflateCompression
      - ENABLE_HEAP_PROFILING=$EnableHeapProfiling
"@
    
    $services += $service
    $volumes += "  $volumeName`:"
    
    if ($i % 10 -eq 0) {
        Write-Host "  Generated $i agents..." -ForegroundColor Gray
    }
}

# Build complete docker-compose file
$header = @"
# Auto-generated docker-compose file for $Count agents
# Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
# Agents: $StartIndex to $($StartIndex + $Count - 1)
# Ports: $(Get-UniquePort $StartIndex) to $(Get-UniquePort ($StartIndex + $Count - 1))

services:
"@

$volumesHeader = @"

volumes:
"@

$networksFooter = @"

networks:
  iotistic-net:
    driver: bridge
"@

$content = $header + "`n" + ($services -join "`n") + $volumesHeader + "`n" + ($volumes -join "`n    driver: local`n")

if ($volumes.Count -gt 0) {
    $content += "`n    driver: local"
}

$content += $networksFooter

# Write to file
$outputPath = Join-Path $PSScriptRoot ".." $OutputFile
$content | Out-File -FilePath $outputPath -Encoding UTF8 -Force

# Save provisioning keys
$keysFile = Join-Path $PSScriptRoot ".." "provisioning-keys-batch.txt"
$keyHeader = "`n# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$keyHeader += "`n# Agents: $StartIndex to $($StartIndex + $Count - 1)"
$keyHeader += "`n# Fleet: $FleetId`n"
Add-Content -Path $keysFile -Value $keyHeader
foreach ($keyEntry in $provisioningKeys) {
    Add-Content -Path $keysFile -Value $keyEntry
}

# Calculate storage requirements
try {
    $imageSizeStr = docker images zemfyre-sensor-agent:latest --format "{{.Size}}" 2>$null
    if ($imageSizeStr -match '(\d+(?:\.\d+)?)(MB|GB)') {
        $imageSize = [double]$matches[1]
        $unit = $matches[2]
        if ($unit -eq 'GB') {
            $imageSize = $imageSize * 1024  # Convert to MB
        }
    } else {
        $imageSize = 292  # Default fallback
    }
} catch {
    $imageSize = 292  # Default fallback if docker command fails
}

$volumeSize = 100 # MB per agent (estimated: SQLite DB + logs)
$memLimit = [int]($MemLimit -replace '[^\d]', '')  # Extract number from "512m"
$totalImageStorage = [math]::Round($imageSize, 0)
$totalVolumeStorage = $volumeSize * $Count
$totalMemory = $memLimit * $Count
$totalStorage = $totalImageStorage + $totalVolumeStorage

# For single agent, output only the key
if ($Count -eq 1) {
    $keyValue = ($provisioningKeys[0] -split ': ')[1]
    Write-Host $keyValue -ForegroundColor Yellow
    
    # Auto-run if -Run flag is set
    if ($Run) {
        $composeFile = Join-Path $PSScriptRoot ".." $OutputFile
        docker compose -f $composeFile up -d --build
    }
    exit 0
}

# For multiple agents, show full details
Write-Host "`n✅ Generated $Count agents in $OutputFile" -ForegroundColor Green
Write-Host "  Agents: $StartIndex to $($StartIndex + $Count - 1)" -ForegroundColor Gray
Write-Host "  Ports: $(Get-UniquePort $StartIndex) to $(Get-UniquePort ($StartIndex + $Count - 1))" -ForegroundColor Gray

Write-Host "`n🔑 Provisioning Keys:" -ForegroundColor Magenta
foreach ($keyEntry in $provisioningKeys) {
    Write-Host "  $keyEntry" -ForegroundColor Yellow
}

Write-Host "`n💾 Storage Requirements:" -ForegroundColor Cyan
Write-Host "  Docker Image: $totalImageStorage MB (shared by all agents)" -ForegroundColor Gray
Write-Host "  Volumes: $totalVolumeStorage MB ($volumeSize MB × $Count agents)" -ForegroundColor Gray
Write-Host "  Total Disk: ~$totalStorage MB (~$([math]::Round($totalStorage/1024, 2)) GB)" -ForegroundColor Yellow
Write-Host "`n🧠 Memory Requirements:" -ForegroundColor Cyan
Write-Host "  Per Agent: $memLimit MB (limit), $($MemReservation -replace 'm', '') MB (reserved)" -ForegroundColor Gray
Write-Host "  Total Memory: ~$totalMemory MB (~$([math]::Round($totalMemory/1024, 2)) GB) max" -ForegroundColor Yellow
Write-Host "📝 Provisioning keys saved to: provisioning-keys-batch.txt" -ForegroundColor Magenta
Write-Host "`nUsage:" -ForegroundColor Cyan
Write-Host "  docker-compose -f docker-compose.yml -f $OutputFile up -d" -ForegroundColor Yellow
Write-Host "`nTo start only the new agents:" -ForegroundColor Cyan
Write-Host "  docker-compose -f $OutputFile up -d" -ForegroundColor Yellow
Write-Host "`nTo scale down/stop:" -ForegroundColor Cyan
Write-Host "  docker-compose -f $OutputFile down" -ForegroundColor Yellow

# Auto-run if -Run flag is set
if ($Run) {
    Write-Host "`n🚀 Starting agents..." -ForegroundColor Cyan
    $composeFile = Join-Path $PSScriptRoot ".." $OutputFile
    docker compose -f $composeFile up -d --build
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Agents started successfully!" -ForegroundColor Green
        Write-Host "`nView logs:" -ForegroundColor Cyan
        Write-Host "  docker compose -f $OutputFile logs -f" -ForegroundColor Yellow
    } else {
        Write-Host "❌ Failed to start agents (exit code: $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}
