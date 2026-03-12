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
    [int]$StartIndex = 1,
    [string]$OutputFile = "docker-compose.agents.yml",
    #[string]$ApiUrl = "https://api.iotistica.com",
    [string]$ApiUrl = "https://localhost:3443",
    #[string]$ApiUrl = "https://api-client-b07708418f4e.iotistica.com",
    [string]$FleetUuid = "9dba5910-040d-4544-862e-32d47dc18290",
    [bool]$UseDirectDb = $true,
    [string]$DbHost = "localhost",
    [int]$DbPort = 5432,
    [string]$DbName = "iotistic",
    [string]$DbUser = "postgres",
    [string]$DbPassword = "postgres",
    [string]$DbSslMode = "",
    [string]$DatabaseUrl = "",
    
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
    #[string]$CLOUD_API_ENDPOINT = "https://api.iotistica.com",
    [string]$CLOUD_API_ENDPOINT = "https://api:3443",
    #[string]$CLOUD_API_ENDPOINT = "https://api-client-b07708418f4e.iotistica.com",
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
    [string]$MqttBrokerUrl = "mqtt://localhost:5884",
    [string]$MqttUsername = "admin",
    [string]$MqttPassword = "iotistic42!",
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
    [string]$MemReservation = "256m",


    #VPN
    [string]$EnableTailscale = "false",

    [string]$LogLevel = "debug"
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

    # Discover existing Docker volumes once so cleanup can remove volumes regardless
    # of compose project prefix (e.g. iotistica_, zemfyre-sensor_, etc.).
    $allDockerVolumes = @()
    try {
        $allDockerVolumes = @(docker volume ls --format "{{.Name}}" 2>$null)
    }
    catch {
        $allDockerVolumes = @()
    }
    
    for ($i = $StartIndex; $i -le $endIndex; $i++) {
        # Agent container
        $containerNames += "agent-$i"
        
        # Agent data volume (match exact and prefixed compose names)
        $baseVolumeName = "agent-$i-data"
        $volumeNames += $baseVolumeName
        $volumeNames += "zemfyre-sensor_$baseVolumeName"

        $matchingVolumes = $allDockerVolumes | Where-Object {
            $_ -eq $baseVolumeName -or $_ -like "*_$baseVolumeName"
        }
        if ($matchingVolumes) {
            $volumeNames += $matchingVolumes
        }
        
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
    
    $volumeNames = $volumeNames | Sort-Object -Unique

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
    param(
        [string]$ApiUrl,
        [string]$FleetUuid,
        [bool]$UseDirectDb,
        [string]$DbHost,
        [int]$DbPort,
        [string]$DbName,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$DbSslMode,
        [string]$DatabaseUrl
    )
    
    try {
        if (-not $UseDirectDb) {
            Write-Error "UseDirectDb is disabled. Enable -UseDirectDb to generate keys directly in the database."
            exit 1
        }

        if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
            Write-Error "psql is required for direct provisioning. Install PostgreSQL client tools or add psql to PATH."
            exit 1
        }

        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        $key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

        $env:PGPASSWORD = $DbPassword
        $connectionString = $DatabaseUrl
        if ([string]::IsNullOrWhiteSpace($connectionString)) {
            $sslPart = if ([string]::IsNullOrWhiteSpace($DbSslMode)) { "" } else { " sslmode=$DbSslMode" }
            $connectionString = "host=$DbHost port=$DbPort dbname=$DbName user=$DbUser$sslPart"
        }

        $schemaSql = @"
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE provisioning_keys ADD COLUMN IF NOT EXISTS key_hash_fast VARCHAR(64);
ALTER TABLE provisioning_keys ADD COLUMN IF NOT EXISTS fleet_uuid UUID;
"@

        $schemaResult = psql -d "$connectionString" -v ON_ERROR_STOP=1 -q -c $schemaSql 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to prepare provisioning_keys schema: $schemaResult"
            exit 1
        }

        $hasKeyHashFast = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='key_hash_fast'" 2>&1
        $hasFleetUuid = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_uuid'" 2>&1
        $hasFleetId = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_id'" 2>&1

        $escapedKey = $key -replace "'", "''"
        $escapedDescription = "Script-generated provisioning key" -replace "'", "''"
        $escapedCreatedBy = "script" -replace "'", "''"
        $escapedFleetUuid = $FleetUuid -replace "'", "''"

        $columns = @('key_hash', 'description', 'max_devices', 'expires_at', 'created_by')
        $values = @(
            "crypt('$escapedKey', gen_salt('bf', 10))",
            "'$escapedDescription'",
            "1",
            "NOW() + (30 || ' days')::interval",
            "'$escapedCreatedBy'"
        )

        if ($hasKeyHashFast -match '1') {
            $columns += 'key_hash_fast'
            $values += "encode(digest('$escapedKey','sha256'),'hex')"
        }
        if ($hasFleetUuid -match '1') {
            $columns += 'fleet_uuid'
            if ([string]::IsNullOrWhiteSpace($escapedFleetUuid)) {
                $values += "NULL"
            } else {
                $values += "'$escapedFleetUuid'::uuid"
            }
        }
        if ($hasFleetId -match '1') {
            $columns += 'fleet_id'
            if ([string]::IsNullOrWhiteSpace($escapedFleetUuid)) {
                $values += "NULL"
            } else {
                $values += "'$escapedFleetUuid'"
            }
        }

        $insertSql = "INSERT INTO provisioning_keys ($($columns -join ', ')) VALUES ($($values -join ', ')) RETURNING id;"

        $insertResult = psql -d "$connectionString" -v ON_ERROR_STOP=1 -t -A -q -c $insertSql 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to insert provisioning key: $insertResult"
            exit 1
        }

        return $key
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
Write-Host "🔑 Generating provisioning keys via direct DB access..." -ForegroundColor Cyan

$services = @()
$volumes = @()
$provisioningKeys = @()

for ($i = $StartIndex; $i -lt ($StartIndex + $Count); $i++) {
    $agentName = "agent-$i"
    $port = Get-UniquePort $i
    
    # Generate provisioning key via API
    Write-Host "  Generating key for $agentName..." -ForegroundColor Gray
    $apiKey = New-ProvisioningKey -ApiUrl $ApiUrl -FleetUuid $FleetUuid -UseDirectDb $UseDirectDb `
        -DbHost $DbHost -DbPort $DbPort -DbName $DbName -DbUser $DbUser -DbPassword $DbPassword `
        -DbSslMode $DbSslMode -DatabaseUrl $DatabaseUrl
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
      - MQTT_BROKER_URL=$MqttBrokerUrl
      - MQTT_USERNAME=$MqttUsername
      - MQTT_PASSWORD=$MqttPassword
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
      # Shell security (HMAC signature verification)
      - AGENT_SHELL_HMAC_KEY=wcw3eFT/zyVZ7HYwP+bApLjJX2gW/e1mHW2+WPG2gBk=
      - AGENT_SHELL_MAX_SESSION_MS=3600000
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

# Skip saving provisioning keys to file (available in console output only)
# $keysFile = Join-Path $PSScriptRoot ".." "provisioning-keys-batch.txt"
# $keyHeader = "`n# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
# $keyHeader += "`n# Agents: $StartIndex to $($StartIndex + $Count - 1)"
# $keyHeader += "`n# Fleet: $FleetId`n"
# Add-Content -Path $keysFile -Value $keyHeader
# foreach ($keyEntry in $provisioningKeys) {
#     Add-Content -Path $keysFile -Value $keyEntry
# }

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
# Write-Host "📝 Provisioning keys saved to: provisioning-keys-batch.txt" -ForegroundColor Magenta
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
