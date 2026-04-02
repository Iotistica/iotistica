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
    # Optional explicit fleet UUID override. If empty (default), script auto-resolves
    # an existing default fleet or creates one in the database.
    [string]$FleetUuid = "",
    [bool]$UseDirectDb = $true,
    [string]$DbHost = "localhost",
    [int]$DbPort = 5432,
    [string]$DbName = "iotistica",
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
    #[string]$IOTISTICA_API = "https://api.iotistica.com",
    [string]$IOTISTICA_API = "https://api:3443",
    #[string]$IOTISTICA_API = "https://api-client-b07708418f4e.iotistica.com",
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
    [string]$AnomalyDetectionEnabled = "true",
    [string]$FirewallEnabled = "false",
    [string]$UseMsgpackPoc = "false",
    [string]$UseKeyCompactionPoc = "false",
    [string]$UseDeflateCompression = "false",
    [string]$EnableHeapProfiling = "true",
    [string]$PipelineFlowsFile = "/app/data/flows/opcua-transform.flows.json",
    
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
    [switch]$EnableSimulation = $false,
    [string]$SimulationAnomalyMetrics = "",
    [string]$SimulationAnomalyExcludeMetrics = "",
    [string]$SimulationAnomalyValueSource = "",
    [string]$SimulationAnomalyPattern = "",
    [string]$SimulationAnomalyMode = "",
    [string]$SimulationAnomalyStrictBaseline = "",
    [int]$SimulationAnomalyBaselineMinSamples = 0,
    [string]$SimulationAnomalyBaselineDeviceId = "",
    [string]$SimulationAnomalyBaselineDeviceState = "",

    
    # Container Resources
    [string]$MemLimit = "512m",
    [string]$MemReservation = "256m",


    #VPN
    [string]$EnableTailscale = "false",

    [string]$LogLevel = "debug"
)

$ErrorActionPreference = "Stop"

# Simulation sample variables (reference only)
# Use these as a quick template when manually setting environment variables.
$SimulationSampleVariables = @{
    SIMULATION_MODE = "true"
    SIMULATION_PROFILE = "intercept-custom"
    SIMULATION_CONFIG = (
        @{
            scenarios = @{
                anomaly_injection = @{
                    enabled = $true
                    mode = "intercept"
                    metrics = @("8602805f-50b1-40cb-acdc-3f4eb084bfcf_c11224a6-61c3-423f-a0a4-4e72b965aa26_temperature")
                    pattern = "spike"
                }
            }
        } | ConvertTo-Json -Depth 10 -Compress
    )
}

function New-DbConnectionString {
    param(
        [string]$DbHost,
        [int]$DbPort,
        [string]$DbName,
        [string]$DbUser,
        [string]$DbSslMode,
        [string]$DatabaseUrl
    )

    if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
        return $DatabaseUrl
    }

    $sslPart = if ([string]::IsNullOrWhiteSpace($DbSslMode)) { "" } else { " sslmode=$DbSslMode" }
    return "host=$DbHost port=$DbPort dbname=$DbName user=$DbUser$sslPart"
}

function Get-OrCreateDefaultFleetUuid {
    param(
        [string]$PreferredFleetUuid,
        [string]$DbHost,
        [int]$DbPort,
        [string]$DbName,
        [string]$DbUser,
        [string]$DbPassword,
        [string]$DbSslMode,
        [string]$DatabaseUrl
    )

    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
        Write-Error "psql is required for direct provisioning. Install PostgreSQL client tools or add psql to PATH."
        exit 1
    }

    $env:PGPASSWORD = $DbPassword
    $connectionString = New-DbConnectionString -DbHost $DbHost -DbPort $DbPort -DbName $DbName -DbUser $DbUser -DbSslMode $DbSslMode -DatabaseUrl $DatabaseUrl

    # Ensure fleets table exists before trying to resolve/create a fleet.
    $hasFleetsTable = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='fleets'" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to inspect database schema: $hasFleetsTable"
        exit 1
    }
    if (-not ($hasFleetsTable -match '1')) {
        Write-Error "Table 'fleets' was not found. Run API database migrations first."
        exit 1
    }

    # 1) If caller provided a fleet UUID and it exists, use it.
    if (-not [string]::IsNullOrWhiteSpace($PreferredFleetUuid)) {
        $escapedPreferredUuid = $PreferredFleetUuid -replace "'", "''"
        $existingPreferred = psql -d "$connectionString" -t -A -q -c "SELECT fleet_uuid::text FROM fleets WHERE fleet_uuid = '$escapedPreferredUuid'::uuid LIMIT 1" 2>&1
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingPreferred)) {
            return $existingPreferred.Trim()
        }

        Write-Host "⚠️  Provided FleetUuid '$PreferredFleetUuid' not found. Falling back to default fleet lookup/create." -ForegroundColor Yellow
    }

    # 2) Try to find an existing default fleet by fleet_id or fleet_name.
    $defaultFleetQuery = @"
SELECT fleet_uuid::text
FROM fleets
WHERE
    lower(COALESCE(fleet_id, '')) IN ('default', 'default-fleet')
    OR lower(COALESCE(fleet_name, '')) IN ('default', 'default fleet')
ORDER BY
    CASE
        WHEN lower(COALESCE(fleet_id, '')) = 'default-fleet' THEN 1
        WHEN lower(COALESCE(fleet_name, '')) = 'default fleet' THEN 2
        WHEN lower(COALESCE(fleet_id, '')) = 'default' THEN 3
        ELSE 4
    END,
    created_at ASC
LIMIT 1;
"@

    $existingDefault = psql -d "$connectionString" -t -A -q -c $defaultFleetQuery 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to query default fleet: $existingDefault"
        exit 1
    }
    if (-not [string]::IsNullOrWhiteSpace($existingDefault)) {
        return $existingDefault.Trim()
    }

    # 3) Create default fleet when missing.
    $newFleetUuid = [guid]::NewGuid().ToString()
    $escapedNewFleetUuid = $newFleetUuid -replace "'", "''"
    $defaultCustomerId = '00000000-0000-0000-0000-000000000001'

    $createDefaultSql = @"
INSERT INTO fleets (
    fleet_uuid,
    fleet_id,
    fleet_name,
    customer_id,
    fleet_type,
    description,
    status,
    created_by,
    created_at,
    updated_at
)
VALUES (
    '$escapedNewFleetUuid'::uuid,
    'default-fleet',
    'Default Fleet',
    '$defaultCustomerId'::uuid,
    'mixed',
    'Auto-created by scripts/generate-agents.ps1 for provisioning keys',
    'active',
    'generate-agents.ps1',
    NOW(),
    NOW()
);
"@

    $createResult = psql -d "$connectionString" -v ON_ERROR_STOP=1 -q -c $createDefaultSql 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create default fleet: $createResult"
        exit 1
    }

    return $newFleetUuid
}

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
        $connectionString = New-DbConnectionString -DbHost $DbHost -DbPort $DbPort -DbName $DbName -DbUser $DbUser -DbSslMode $DbSslMode -DatabaseUrl $DatabaseUrl

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

        $columns = @('key_hash', 'description', 'max_agents', 'expires_at', 'created_by')
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

function New-SimulationProfile {
    param(
        [string]$ProfileName,
        [hashtable]$Scenarios
    )

    return @{
        name = $ProfileName
        enabled = 'true'
        config = (Convert-SimulationScenariosToJson -Scenarios $Scenarios)
        configObject = @{ scenarios = $Scenarios }
        scenarioNames = @($Scenarios.Keys | Sort-Object)
    }
}

function Convert-SimulationScenariosToJson {
    param(
        [hashtable]$Scenarios
    )

    $exportScenarios = @{}

    foreach ($entry in $Scenarios.GetEnumerator()) {
        $exportScenarios[$entry.Key] = $entry.Value
    }

    $anomalyConfig = $exportScenarios['anomaly_injection']

    if ($anomalyConfig -and $anomalyConfig.enabled -and $anomalyConfig.mode -eq 'intercept') {
        $compactAnomaly = @{
            enabled = $true
            mode = 'intercept'
            metrics = @($anomalyConfig.metrics)
            pattern = $anomalyConfig.pattern
        }

        if ($anomalyConfig.ContainsKey('magnitude') -and $anomalyConfig.magnitude -ne 3) {
            $compactAnomaly.magnitude = $anomalyConfig.magnitude
        }
        if ($anomalyConfig.ContainsKey('baselineDeviceId') -and -not [string]::IsNullOrWhiteSpace($anomalyConfig.baselineDeviceId) -and $anomalyConfig.baselineDeviceId -ne 'unknown-device') {
            $compactAnomaly.baselineDeviceId = $anomalyConfig.baselineDeviceId
        }
        if ($anomalyConfig.ContainsKey('baselineDeviceState') -and -not [string]::IsNullOrWhiteSpace($anomalyConfig.baselineDeviceState) -and $anomalyConfig.baselineDeviceState -ne 'unknown') {
            $compactAnomaly.baselineDeviceState = $anomalyConfig.baselineDeviceState
        }

        $exportScenarios['anomaly_injection'] = $compactAnomaly

    }

    return (@{ scenarios = $exportScenarios } | ConvertTo-Json -Depth 10 -Compress)
}

function ConvertTo-StringList {
    param(
        [string]$InputValue
    )

    if ([string]::IsNullOrWhiteSpace($InputValue)) {
        return @()
    }

    return @(
        $InputValue.Split(',; ') |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { $_.Trim() }
    )
}

function ConvertTo-NullableBool {
    param(
        [string]$RawValue
    )

    if ([string]::IsNullOrWhiteSpace($RawValue)) {
        return $null
    }

    switch ($RawValue.Trim().ToLowerInvariant()) {
        'true' { return $true }
        '1' { return $true }
        'yes' { return $true }
        'y' { return $true }
        'false' { return $false }
        '0' { return $false }
        'no' { return $false }
        'n' { return $false }
        default {
            Write-Warning "Invalid boolean value '$RawValue' for simulation override. Expected true/false."
            return $null
        }
    }
}

function Apply-AnomalySimulationOverrides {
    param(
        [hashtable]$SimulationProfile,
        [string]$Metrics,
        [string]$ExcludeMetrics,
        [string]$ValueSource,
        [string]$Pattern,
        [string]$Mode,
        [string]$StrictBaseline,
        [int]$BaselineMinSamples,
        [string]$BaselineDeviceId,
        [string]$BaselineDeviceState
    )

    if (-not $SimulationProfile.enabled -or $SimulationProfile.enabled -ne 'true') {
        return $SimulationProfile
    }

    $scenarios = $SimulationProfile.configObject.scenarios
    if (-not $scenarios -or -not $scenarios.ContainsKey('anomaly_injection')) {
        return $SimulationProfile
    }

    $anomalyConfig = $scenarios.anomaly_injection
    if (-not $anomalyConfig) {
        return $SimulationProfile
    }

    $includeList = ConvertTo-StringList -InputValue $Metrics
    if ($includeList.Count -gt 0) {
        $anomalyConfig.metrics = $includeList
    }

    $excludeList = ConvertTo-StringList -InputValue $ExcludeMetrics
    if ($excludeList.Count -gt 0) {
        $excluded = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($metric in $excludeList) {
            [void]$excluded.Add($metric)
        }

        $anomalyConfig.metrics = @($anomalyConfig.metrics | Where-Object { -not $excluded.Contains($_) })
    }

    $modeNorm = ""
    if (-not [string]::IsNullOrWhiteSpace($Mode)) {
        $modeNorm = $Mode.Trim().ToLowerInvariant()
    }

    # Intercept mode is intended to run against real live data with baseline-driven adjustments.
    # If the caller did not explicitly provide these values, apply sensible defaults.
    if ($modeNorm -eq 'intercept') {
        if ([string]::IsNullOrWhiteSpace($ValueSource)) {
            $ValueSource = 'baseline'
        }
        if ([string]::IsNullOrWhiteSpace($StrictBaseline)) {
            $StrictBaseline = 'true'
        }
        if ($BaselineMinSamples -le 0) {
            $BaselineMinSamples = 10
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($ValueSource)) {
        $source = $ValueSource.Trim().ToLowerInvariant()
        if ($source -eq 'static' -or $source -eq 'baseline') {
            $anomalyConfig.valueSource = $source
        } else {
            Write-Warning "Invalid SimulationAnomalyValueSource '$ValueSource'. Expected static|baseline."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Pattern)) {
        $patternNorm = $Pattern.Trim().ToLowerInvariant()
        if (@('spike', 'drift', 'cyclic', 'noisy', 'extreme', 'random', 'realistic', 'alert') -contains $patternNorm) {
            $anomalyConfig.pattern = $patternNorm
        } else {
            Write-Warning "Invalid SimulationAnomalyPattern '$Pattern'. Expected spike|drift|cyclic|noisy|extreme|random|realistic|alert."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Mode)) {
        if ($modeNorm -eq 'inject' -or $modeNorm -eq 'intercept') {
            $anomalyConfig.mode = $modeNorm
        } else {
            Write-Warning "Invalid SimulationAnomalyMode '$Mode'. Expected inject|intercept."
        }
    }

    $strictBool = ConvertTo-NullableBool -RawValue $StrictBaseline
    if ($null -ne $strictBool) {
        $anomalyConfig.strictBaseline = $strictBool
    }

    if ($BaselineMinSamples -gt 0) {
        $anomalyConfig.baselineMinSamples = $BaselineMinSamples
    }

    if (-not [string]::IsNullOrWhiteSpace($BaselineDeviceId)) {
        $anomalyConfig.baselineDeviceId = $BaselineDeviceId.Trim()
    }

    if (-not [string]::IsNullOrWhiteSpace($BaselineDeviceState)) {
        $candidateState = $BaselineDeviceState.Trim().ToLowerInvariant()
        if (@('running', 'idle', 'fault', 'unknown') -contains $candidateState) {
            $anomalyConfig.baselineDeviceState = $candidateState
        } else {
            Write-Warning "Invalid SimulationAnomalyBaselineDeviceState '$BaselineDeviceState'. Expected running|idle|fault|unknown."
        }
    }

    $SimulationProfile.config = (Convert-SimulationScenariosToJson -Scenarios $scenarios)
    $SimulationProfile.configObject = @{ scenarios = $scenarios }
    return $SimulationProfile
}

# Get simulation configuration based on agent index (varied scenario profiles)
function Get-SimulationConfig {
    param(
        [int]$Index,
        [bool]$SimulationEnabled,
        [string]$AnomalyMetrics,
        [string]$AnomalyExcludeMetrics,
        [string]$AnomalyValueSource,
        [string]$AnomalyPattern,
        [string]$AnomalyMode,
        [string]$AnomalyStrictBaseline,
        [int]$AnomalyBaselineMinSamples,
        [string]$AnomalyBaselineDeviceId,
        [string]$AnomalyBaselineDeviceState
    )
    
    # If simulation is disabled globally, return disabled config
    if (-not $SimulationEnabled) {
        return @{
            name = 'disabled'
            enabled = "false"
            config = '{}'
            configObject = @{ scenarios = @{} }
            scenarioNames = @()
        }
    }

    $profiles = @(
        @{
            name = 'normal-operation'
            enabled = 'false'
            config = '{}'
            configObject = @{ scenarios = @{} }
            scenarioNames = @()
        },
        (New-SimulationProfile -ProfileName 'baseline-realistic' -Scenarios @{
            anomaly_injection = @{
                enabled = $true
                metrics = @('cpu_temp', 'memory_percent')
                pattern = 'spike'
                intervalMs = 60000
                severity = 'warning'
                magnitude = 2
                valueSource = 'static'
                strictBaseline = $false
                baselineMinSamples = 10
                baselineDeviceId = 'unknown-device'
                baselineDeviceState = 'unknown'
            }
        }),
        (New-SimulationProfile -ProfileName 'high-frequency-drift' -Scenarios @{
            anomaly_injection = @{
                enabled = $true
                metrics = @('cpu_temp')
                pattern = 'drift'
                intervalMs = 120000
                severity = 'warning'
                magnitude = 4
                valueSource = 'static'
                strictBaseline = $false
                baselineMinSamples = 10
                baselineDeviceId = 'unknown-device'
                baselineDeviceState = 'unknown'
            }
        }),
        (New-SimulationProfile -ProfileName 'stress-spike' -Scenarios @{
            anomaly_injection = @{
                enabled = $true
                metrics = @('cpu_temp', 'memory_percent', 'disk_usage')
                pattern = 'spike'
                intervalMs = 30000
                severity = 'critical'
                magnitude = 5
                valueSource = 'static'
                strictBaseline = $false
                baselineMinSamples = 10
                baselineDeviceId = 'unknown-device'
                baselineDeviceState = 'unknown'
            }
        }),
        (New-SimulationProfile -ProfileName 'production-collected' -Scenarios @{
            anomaly_injection = @{
                enabled = $true
                mode = 'intercept'
                metrics = @('cpu_usage', 'memory_percent', 'temperature', 'humidity')
                pattern = 'realistic'
                intervalMs = 45000
                severity = 'warning'
                magnitude = 1.5
                valueSource = 'baseline'
                strictBaseline = $true
                baselineMinSamples = 10
                baselineDeviceId = '8602805f-50b1-40cb-acdc-3f4eb084bfcf'
                baselineDeviceState = 'running'
            }
        })
    )

    $mode = $Index % $profiles.Count
    $selected = $profiles[$mode]

    $selected = Apply-AnomalySimulationOverrides -SimulationProfile $selected `
        -Metrics $AnomalyMetrics `
        -ExcludeMetrics $AnomalyExcludeMetrics `
        -ValueSource $AnomalyValueSource `
        -Pattern $AnomalyPattern `
        -Mode $AnomalyMode `
        -StrictBaseline $AnomalyStrictBaseline `
        -BaselineMinSamples $AnomalyBaselineMinSamples `
        -BaselineDeviceId $AnomalyBaselineDeviceId `
        -BaselineDeviceState $AnomalyBaselineDeviceState

    return $selected
}

# Execute cleanup or generation based on mode
if ($Cleanup) {
    Remove-AgentResources -StartIndex $StartIndex -Count $Count
    exit 0
}

Write-Host "Generating $Count agents (indices $StartIndex to $($StartIndex + $Count - 1))..." -ForegroundColor Cyan
if ($EnableSimulation) {
    Write-Host "Simulation profiles: normal-operation, baseline-realistic, high-frequency-drift, stress-spike, production-collected" -ForegroundColor Gray
} else {
    Write-Host "Simulation: DISABLED (all agents in normal operation mode)" -ForegroundColor Gray
}
Write-Host "🔑 Generating provisioning keys via direct DB access..." -ForegroundColor Cyan

$resolvedFleetUuid = Get-OrCreateDefaultFleetUuid -PreferredFleetUuid $FleetUuid -DbHost $DbHost -DbPort $DbPort -DbName $DbName -DbUser $DbUser -DbPassword $DbPassword -DbSslMode $DbSslMode -DatabaseUrl $DatabaseUrl
Write-Host "📦 Using fleet UUID: $resolvedFleetUuid" -ForegroundColor Gray

$services = @()
$volumes = @()
$provisioningKeys = @()

for ($i = $StartIndex; $i -lt ($StartIndex + $Count); $i++) {
    $agentName = "agent-$i"
    $port = Get-UniquePort $i
    
    # Generate provisioning key via API
    Write-Host "  Generating key for $agentName..." -ForegroundColor Gray
    $apiKey = New-ProvisioningKey -ApiUrl $ApiUrl -FleetUuid $resolvedFleetUuid -UseDirectDb $UseDirectDb `
        -DbHost $DbHost -DbPort $DbPort -DbName $DbName -DbUser $DbUser -DbPassword $DbPassword `
        -DbSslMode $DbSslMode -DatabaseUrl $DatabaseUrl
    $provisioningKeys += "${agentName}: $apiKey"
    
    $volumeName = "$agentName-data"
    $simConfig = Get-SimulationConfig -Index $i -SimulationEnabled ([bool]$EnableSimulation) `
        -AnomalyMetrics $SimulationAnomalyMetrics `
        -AnomalyExcludeMetrics $SimulationAnomalyExcludeMetrics `
        -AnomalyValueSource $SimulationAnomalyValueSource `
        -AnomalyPattern $SimulationAnomalyPattern `
        -AnomalyMode $SimulationAnomalyMode `
        -AnomalyStrictBaseline $SimulationAnomalyStrictBaseline `
        -AnomalyBaselineMinSamples $SimulationAnomalyBaselineMinSamples `
        -AnomalyBaselineDeviceId $SimulationAnomalyBaselineDeviceId `
        -AnomalyBaselineDeviceState $SimulationAnomalyBaselineDeviceState

    if ($simConfig.enabled -eq 'true') {
        Write-Host "    Simulation profile: $($simConfig.name) [$($simConfig.scenarioNames -join ', ')]" -ForegroundColor DarkGray
    }
    
    # Adjust IOTISTICA_API based on network mode
    # Host mode: use localhost (shares host network stack)
    # Bridge mode: use service name (container networking)
    $cloudApiEndpoint = if ($UseHostNetwork) {
        $IOTISTICA_API -replace "api:", "localhost:"
    } else {
        $IOTISTICA_API
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

    $agentShellHmacKeyEnv = '${AGENT_SHELL_HMAC_KEY}'
    
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
      - ./mosquitto-agent/auth:/app/data/mosquitto-auth  # shared with iotistic-mosquitto-agent for file auth
    environment:
      - DEVICE_API_PORT=$port
      - IOTISTICA_API=$cloudApiEndpoint
      - NODE_ENV=$NodeEnv
      - MQTT_AUTH_DIR=/app/data/mosquitto-auth
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
      - SIMULATION_PROFILE=$($simConfig.name)
      - SIMULATION_CONFIG='$($simConfig.config)'
      - USE_MSGPACK_POC=$UseMsgpackPoc
      - USE_KEY_COMPACTION_POC=$UseKeyCompactionPoc
      - USE_DEFLATE_COMPRESSION=$UseDeflateCompression
      - ENABLE_HEAP_PROFILING=$EnableHeapProfiling
      - PIPELINE_FLOWS_FILE=$PipelineFlowsFile
      # Shell security (HMAC signature verification)
      - AGENT_SHELL_HMAC_KEY=$agentShellHmacKeyEnv
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
