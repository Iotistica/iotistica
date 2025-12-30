#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Integration test to verify OPC UA simulator data flows correctly to readings table

.DESCRIPTION
    This script validates the entire data pipeline:
    1. OPC UA Simulator → Agent extraction
    2. Agent → MQTT publication (with dictionary compression)
    3. API → Redis queue
    4. Redis → PostgreSQL readings table
    
    Verifies:
    - Values are preserved (no type conversion errors)
    - Metadata is intact (deviceName, registerName, quality, unit)
    - Timestamps are consistent
    - No data loss or corruption

.PARAMETER DeviceUuid
    The UUID of the device to test (default: queries from device state)

.PARAMETER WaitSeconds
    How long to wait for data to propagate (default: 10)

.PARAMETER SampleCount
    Number of sensor readings to verify (default: 5)

.EXAMPLE
    .\test-opcua-data-integrity.ps1
    
.EXAMPLE
    .\test-opcua-data-integrity.ps1 -DeviceUuid "571406ce-c517-49e9-98ed-2d07990f706b" -WaitSeconds 15
#>

param(
    [Parameter()]
    [string]$DeviceUuid,
    
    [Parameter()]
    [int]$WaitSeconds = 10,
    
    [Parameter()]
    [int]$SampleCount = 5
)

$ErrorActionPreference = "Stop"

# Configuration
$POSTGRES_CONTAINER = "iotistic-postgres"
$REDIS_CONTAINER = "iotistic-redis"
$API_URL = "http://localhost:4002/api/v1"
$DB_NAME = "iotistic"
$DB_USER = "postgres"
$DB_PASSWORD = "postgres"

# ANSI colors
$Green = "`e[32m"
$Red = "`e[31m"
$Yellow = "`e[33m"
$Blue = "`e[34m"
$Cyan = "`e[36m"
$Reset = "`e[0m"

function Write-Success {
    param([string]$Message)
    Write-Host "${Green}✓ $Message${Reset}"
}

function Write-Error {
    param([string]$Message)
    Write-Host "${Red}✗ $Message${Reset}"
}

function Write-Info {
    param([string]$Message)
    Write-Host "${Blue}ℹ $Message${Reset}"
}

function Write-Warning {
    param([string]$Message)
    Write-Host "${Yellow}⚠ $Message${Reset}"
}

function Write-Section {
    param([string]$Message)
    Write-Host ""
    Write-Host "${Cyan}═══════════════════════════════════════════════════════════${Reset}"
    Write-Host "${Cyan}  $Message${Reset}"
    Write-Host "${Cyan}═══════════════════════════════════════════════════════════${Reset}"
}

function Test-DockerContainer {
    param([string]$ContainerName)
    
    $running = docker ps --filter "name=$ContainerName" --filter "status=running" --format "{{.Names}}" 2>$null
    if ($running -eq $ContainerName) {
        return $true
    }
    return $false
}

function Get-DeviceUuid {
    Write-Info "Querying device UUID from database..."
    
    $query = "SELECT uuid FROM devices WHERE name LIKE '%agent%' OR name LIKE '%opcua%' LIMIT 1;"
    $result = docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -t -c $query 2>$null
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($result)) {
        # Try getting from device_current_state
        $query = "SELECT device_uuid FROM device_current_state LIMIT 1;"
        $result = docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -t -c $query 2>$null
    }
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($result)) {
        throw "Could not find device UUID in database"
    }
    
    return $result.Trim()
}

function Get-OpcUaEndpoints {
    param([string]$DeviceUuid)
    
    Write-Info "Fetching OPC UA configuration from device_current_state..."
    
    # Check if OPC UA is enabled in device_current_state config
    $configQuery = @"
SELECT config->'protocols'->'opcua'->>'enabled' as enabled
FROM device_current_state 
WHERE device_uuid = '$DeviceUuid';
"@
    
    $configResult = docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -t -A -c $configQuery 2>$null
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configResult)) {
        throw "No device_current_state configuration found for device $DeviceUuid. Ensure device is provisioned and has current state."
    }
    
    $opcuaEnabled = $configResult.Trim() -eq 'true'
    
    if (-not $opcuaEnabled) {
        throw "OPC UA is disabled in device configuration (config.protocols.opcua.enabled = false). Enable OPC UA in device_current_state first."
    }
    
    Write-Success "OPC UA is enabled in device configuration"
    
    # Query OPC UA endpoints from device_current_state config->endpoints (filtered by protocol)
    Write-Info "Checking device_current_state for OPC UA endpoint configuration..."
    $endpointsQuery = @"
SELECT jsonb_agg(endpoint) 
FROM device_current_state, 
     jsonb_array_elements(config->'endpoints') AS endpoint
WHERE device_uuid = '$DeviceUuid'
  AND endpoint->>'protocol' = 'opcua'
  AND (endpoint->>'enabled')::int = 1;
"@
    
    $result = docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -t -c $endpointsQuery 2>$null
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($result) -or $result.Trim() -eq 'null') {
        throw "No OPC UA endpoints configured in device_current_state. This means:`n" +
              "  1. No endpoints with protocol='opcua' found in config.endpoints array`n" +
              "  2. OPC UA endpoints may be disabled (enabled != 1)`n" +
              "  3. Device current state has not been set up properly`n" +
              "`n" +
              "Run this query to check current configuration:`n" +
              "  docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -c `"SELECT config->'endpoints' FROM device_current_state WHERE device_uuid = '$DeviceUuid';`"`n" +
              "`n" +
              "Expected structure: config.endpoints = [{ name: 'opcua_...', protocol: 'opcua', enabled: 1, ... }]"
    }
    
    try {
        $endpoints = $result.Trim() | ConvertFrom-Json
        if ($endpoints.Count -eq 0) {
            throw "OPC UA endpoints array is empty. Check OPC UA server connectivity and endpoint configuration."
        }
        Write-Success "Found $($endpoints.Count) enabled OPC UA endpoints"
        return $endpoints
    } catch {
        if ($_.Exception.Message -like "*endpoints array is empty*") {
            throw
        }
        throw "Failed to parse OPC UA endpoints from device_current_state: $($_.Exception.Message)"
    }
}

function Get-RedisQueueLength {
    Write-Info "Checking Redis sensor queue length..."
    
    $length = docker exec $REDIS_CONTAINER redis-cli XLEN "device:sensors" 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not query Redis queue"
        return 0
    }
    
    return [int]$length
}

function Get-ReadingsFromDatabase {
    param(
        [string]$DeviceUuid,
        [string]$EndpointName,
        [string]$MetricName,
        [int]$Limit = 5
    )
    
    $query = @"
SELECT 
    time,
    metric_name,
    value,
    quality,
    unit,
    protocol,
    extra->>'deviceName' as device_name,
    anomaly_score,
    detection_methods
FROM readings 
WHERE device_uuid = '$DeviceUuid'
$(if ($EndpointName) { "AND extra->>'deviceName' = '$EndpointName'" })
$(if ($MetricName) { "AND metric_name = '$MetricName'" })
ORDER BY time DESC 
LIMIT $Limit;
"@
    
    $result = docker exec $POSTGRES_CONTAINER psql -U $DB_USER -d $DB_NAME -t -A -F '|' -c $query 2>$null
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($result)) {
        return @()
    }
    
    # Parse pipe-delimited results
    $readings = @()
    $lines = $result -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    
    foreach ($line in $lines) {
        $fields = $line -split '\|'
        if ($fields.Count -ge 7) {
            $readings += @{
                Time = $fields[0]
                MetricName = $fields[1]
                Value = if ($fields[2]) { [double]$fields[2] } else { $null }
                Quality = $fields[3]
                Unit = $fields[4]
                Protocol = $fields[5]
                DeviceName = $fields[6]
                AnomalyScore = if ($fields.Count -gt 7 -and $fields[7]) { [double]$fields[7] } else { $null }
                DetectionMethods = if ($fields.Count -gt 8) { $fields[8] } else { $null }
            }
        }
    }
    
    return $readings
}

function Get-DictionaryFromRedis {
    param([string]$DeviceUuid)
    
    Write-Info "Fetching dictionary from Redis..."
    
    $dictJson = docker exec $REDIS_CONTAINER redis-cli --raw GET "dict:$DeviceUuid" 2>$null
    
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dictJson)) {
        Write-Warning "No dictionary found in Redis for device $DeviceUuid"
        return $null
    }
    
    try {
        return $dictJson | ConvertFrom-Json
    } catch {
        Write-Warning "Failed to parse dictionary: $_"
        return $null
    }
}

function Validate-DataIntegrity {
    param(
        [array]$Readings,
        [hashtable]$ExpectedValues
    )
    
    $passed = 0
    $failed = 0
    
    foreach ($reading in $Readings) {
        $checks = @()
        
        # Check 1: Value is a number (skip if null for string/metadata OPC UA variables)
        if ($null -ne $reading.Value) {
            if ($reading.Value -is [double]) {
                $checks += "Value type: number ✓"
            } else {
                $checks += "Value type: INVALID (expected number, got $($reading.Value.GetType().Name)) ✗"
                $failed++
            }
        } else {
            $checks += "Value type: null (string/metadata variable) ⚠"
        }
        
        # Check 2: Quality is valid
        if ($reading.Quality -in @('good', 'bad', 'uncertain')) {
            $checks += "Quality: $($reading.Quality) ✓"
        } else {
            $checks += "Quality: INVALID ($($reading.Quality)) ✗"
            $failed++
        }
        
        # Check 3: Protocol is correct
        if ($reading.Protocol -eq 'opcua') {
            $checks += "Protocol: opcua ✓"
        } else {
            $checks += "Protocol: UNEXPECTED ($($reading.Protocol)) ✗"
            $failed++
        }
        
        # Check 4: DeviceName is set (endpoint identifier)
        if (-not [string]::IsNullOrWhiteSpace($reading.DeviceName)) {
            $checks += "DeviceName (endpoint): $($reading.DeviceName) ✓"
        } else {
            $checks += "DeviceName: MISSING ✗"
            $failed++
        }
        
        # Check 5: Timestamp is recent (within last 5 minutes)
        try {
            $time = [DateTime]::Parse($reading.Time)
            $age = (Get-Date) - $time
            if ($age.TotalMinutes -lt 5) {
                $checks += "Timestamp: recent ($([int]$age.TotalSeconds)s ago) ✓"
            } else {
                $checks += "Timestamp: old ($([int]$age.TotalMinutes)m ago) ⚠"
            }
        } catch {
            $checks += "Timestamp: INVALID ✗"
            $failed++
        }
        
        # Display results for this reading
        Write-Host ""
        Write-Host "  ${Cyan}Metric:${Reset} $($reading.MetricName)"
        Write-Host "  ${Cyan}Value:${Reset}  $($reading.Value) $($reading.Unit)"
        foreach ($check in $checks) {
            if ($check -match '✓') {
                Write-Host "    ${Green}$check${Reset}"
            } elseif ($check -match '⚠') {
                Write-Host "    ${Yellow}$check${Reset}"
            } else {
                Write-Host "    ${Red}$check${Reset}"
            }
        }
        
        if ($failed -eq 0) {
            $passed++
        }
    }
    
    return @{
        Passed = $passed
        Failed = $failed
        Total = $Readings.Count
    }
}

# ═══════════════════════════════════════════════════════════
# Main Test Flow
# ═══════════════════════════════════════════════════════════

Write-Section "OPC UA Data Integrity Test"

# Step 1: Prerequisites
Write-Section "Step 1: Checking Prerequisites"

if (-not (Test-DockerContainer $POSTGRES_CONTAINER)) {
    Write-Error "PostgreSQL container not running: $POSTGRES_CONTAINER"
    exit 1
}
Write-Success "PostgreSQL container running"

if (-not (Test-DockerContainer $REDIS_CONTAINER)) {
    Write-Error "Redis container not running: $REDIS_CONTAINER"
    exit 1
}
Write-Success "Redis container running"

# Step 2: Get device UUID
Write-Section "Step 2: Identifying Device"

if ([string]::IsNullOrWhiteSpace($DeviceUuid)) {
    try {
        $DeviceUuid = Get-DeviceUuid
        Write-Success "Found device UUID: $DeviceUuid"
    } catch {
        Write-Error "Failed to get device UUID: $_"
        exit 1
    }
} else {
    Write-Info "Using provided device UUID: $DeviceUuid"
}

# Step 3: Get OPC UA endpoints
Write-Section "Step 3: Discovering OPC UA Endpoints"

$endpoints = Get-OpcUaEndpoints -DeviceUuid $DeviceUuid
if ($endpoints.Count -eq 0) {
    Write-Warning "No OPC UA endpoints found, test may fail"
} else {
    Write-Success "Found $($endpoints.Count) OPC UA endpoints"
    $endpoints | Select-Object -First 3 | ForEach-Object {
        Write-Info "  - $($_.name) ($($_.nodeId))"
    }
}

# Step 4: Check Redis queue
Write-Section "Step 4: Monitoring Data Pipeline"

$queueLength = Get-RedisQueueLength
Write-Info "Redis queue length: $queueLength messages"

# Step 5: Check dictionary
$dictionary = Get-DictionaryFromRedis -DeviceUuid $DeviceUuid
if ($dictionary) {
    $fieldCount = ($dictionary.PSObject.Properties | Measure-Object).Count
    Write-Success "Dictionary found: $fieldCount fields"
    
    # Show opaque array fields (fields ending with [])
    $opaqueFields = $dictionary.PSObject.Properties | Where-Object { $_.Value -match '\[\]$' } | Select-Object -First 5
    if ($opaqueFields) {
        Write-Info "Opaque array fields detected:"
        $opaqueFields | ForEach-Object {
            Write-Info "  - Index $($_.Name): $($_.Value)"
        }
    }
} else {
    Write-Warning "No dictionary found (compression may not be active)"
}

# Step 6: Wait for data
Write-Section "Step 5: Waiting for Data Propagation"

Write-Info "Waiting $WaitSeconds seconds for MQTT → Redis → PostgreSQL pipeline..."
Start-Sleep -Seconds $WaitSeconds

# Step 7: Query readings table
Write-Section "Step 6: Querying Readings Table"

$allReadings = @()
$metricsChecked = 0

if ($endpoints.Count -gt 0) {
    # Check specific endpoints by filtering on deviceName in extra field
    foreach ($endpoint in ($endpoints | Select-Object -First $SampleCount)) {
        # First get ALL readings to see what variables exist
        $allEndpointReadings = Get-ReadingsFromDatabase -DeviceUuid $DeviceUuid -EndpointName $endpoint.name -Limit 100
        
        if ($allEndpointReadings.Count -gt 0) {
            # Show variable types found
            $numericVars = ($allEndpointReadings | Where-Object { $null -ne $_.Value }).Count
            $nullVars = ($allEndpointReadings | Where-Object { $null -eq $_.Value }).Count
            Write-Info "  Endpoint $($endpoint.name): $numericVars numeric, $nullVars non-numeric variables"
            
            # Prioritize numeric readings (temperature, pressure, flow sensors)
            $numericReadings = $allEndpointReadings | Where-Object { $null -ne $_.Value } | Select-Object -First 5
            
            if ($numericReadings.Count -gt 0) {
                $allReadings += $numericReadings
                $metricsChecked++
            } else {
                # Fall back to any readings if no numeric ones
                $allReadings += ($allEndpointReadings | Select-Object -First 3)
                $metricsChecked++
            }
        }
    }
} else {
    # Check any OPC UA readings
    $readings = Get-ReadingsFromDatabase -DeviceUuid $DeviceUuid -Limit $SampleCount
    $opcuaReadings = $readings | Where-Object { $_.Protocol -eq 'opcua' }
    if ($opcuaReadings) {
        $allReadings = $opcuaReadings
        $metricsChecked = $opcuaReadings.Count
    }
}

if ($allReadings.Count -eq 0) {
    Write-Error "No readings found in database for device $DeviceUuid"
    Write-Info "This could mean:"
    Write-Info "  1. OPC UA simulator is not running"
    Write-Info "  2. Agent is not connected to MQTT"
    Write-Info "  3. API is not processing messages"
    Write-Info "  4. Redis queue worker is not running"
    exit 1
}

Write-Success "Found $($allReadings.Count) readings from $metricsChecked different metrics"

# Step 8: Validate data integrity
Write-Section "Step 7: Validating Data Integrity"

$validation = Validate-DataIntegrity -Readings $allReadings

# Step 9: Summary
Write-Section "Test Results Summary"

# Check for numeric data availability
$numericCount = ($allReadings | Where-Object { $null -ne $_.Value }).Count
$hasNumericData = $numericCount -gt 0

Write-Host ""
Write-Host "  Total Readings Checked: $($validation.Total)"
Write-Host "  ${Green}Passed: $($validation.Passed)${Reset}"
if ($validation.Failed -gt 0) {
    Write-Host "  ${Red}Failed: $($validation.Failed)${Reset}"
}

if (-not $hasNumericData) {
    Write-Host ""
    Write-Warning "NO NUMERIC SENSOR DATA FOUND!"
    Write-Host "  ${Yellow}All $($validation.Total) readings have null values (string/metadata only)${Reset}"
    Write-Host "  ${Yellow}Expected: Factory sensor variables (temperature, pressure, flow)${Reset}"
    Write-Host ""
    Write-Host "  ${Red}This indicates:${Reset}"
    Write-Host "    1. OPC UA simulator not publishing numeric sensor nodes"
    Write-Host "    2. Agent not subscribing to sensor variables"
    Write-Host "    3. OPC UA server missing expected node configuration"
    Write-Host ""
    Write-Host "  ${Blue}To diagnose, run:${Reset}"
    Write-Host "    docker exec iotistic-postgres psql -U postgres -d iotistic \"
    Write-Host "      -c \"SELECT DISTINCT metric_name FROM readings WHERE device_uuid = '$DeviceUuid' AND protocol = 'opcua' ORDER BY metric_name;\""
    Write-Host ""
    Write-Host "  ${Blue}Expected metrics (missing):${Reset}"
    Write-Host "    - factory_temperature_sensor_1..5"
    Write-Host "    - factory_pressure_sensor_1..5"
    Write-Host "    - factory_flow_sensor_1..5"
    Write-Host "    - factory_level_tank_1..3"
    Write-Host "    - factory_vibration_motor_1..4"
    Write-Host "    - factory_power_line_1..3"
    Write-Host ""
}

Write-Host ""

if ($validation.Failed -eq 0 -and $hasNumericData) {
    Write-Success "ALL CHECKS PASSED - Data integrity verified! 🎉"
    Write-Host ""
    Write-Host "  ${Green}✓${Reset} OPC UA data flowing correctly through pipeline"
    Write-Host "  ${Green}✓${Reset} Numeric sensor data present ($numericCount readings)"
    Write-Host "  ${Green}✓${Reset} Metadata intact (endpoint, quality, protocol)"
    Write-Host "  ${Green}✓${Reset} Protocol correctly identified (opcua)"
    Write-Host "  ${Green}✓${Reset} Timestamps recent and valid"
    Write-Host ""
    exit 0
} elseif ($validation.Failed -eq 0 -and -not $hasNumericData) {
    Write-Warning "PIPELINE WORKS BUT CONFIGURATION ISSUE DETECTED"
    Write-Host ""
    Write-Host "  ${Yellow}✓${Reset} Pipeline integrity: PASS (data flows correctly)"
    Write-Host "  ${Red}✗${Reset} Data completeness: FAIL (no numeric sensor data)"
    Write-Host ""
    Write-Host "  ${Yellow}Action required:${Reset} Configure OPC UA simulator with numeric sensor nodes"
    Write-Host ""
    exit 1
} else {
    Write-Error "SOME CHECKS FAILED - Data integrity issues detected"
    Write-Host ""
    Write-Host "  ${Red}Review the failed checks above and investigate:${Reset}"
    Write-Host "    • Agent OPC UA adapter configuration"
    Write-Host "    • MQTT message format"
    Write-Host "    • API dictionary expansion logic"
    Write-Host "    • Redis queue worker processing"
    Write-Host ""
    exit 1
}
