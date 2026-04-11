<#
.SYNOPSIS
    Seam-3 ingestion load test: publishes DeviceDataEntry messages through the MQTT
    broker, exercising the full MQTT → API → Redis Stream → Worker → DB pipeline.

.DESCRIPTION
    Discovers the tenant ID from the live Redis stream key, encodes agent UUIDs to
    base64url (matching the API's MQTT topic format), then publishes through long-lived
    mqtt.js sessions grouped by agent. Health metrics are polled identically to
    load-test-ingestion.ps1.

    Topology under test:
      [this script] --MQTT--> iotistic-mosquitto --broker--> iotistic-api (MQTT handler)
        --> Redis Stream --> ingestion worker --> TimescaleDB

    Requires:
      - docker running with iotistic-mosquitto, iotistic-redis, and iotistic-api containers
      - .env file in the repo root with REDIS_PASSWORD, MQTT_PASSWORD (and optionally MQTT_USERNAME,
        MOSQUITTO_PORT_EXT, API_URL / JWT_TOKEN)

.PARAMETER MessageCount
    Total messages to inject (default: 1000).

.PARAMETER AgentCount
    Number of distinct agent UUIDs to spread messages across (default: 10).

.PARAMETER MetricsPerMessage
    Number of metric readings inside each DeviceDataEntry (default: 5).

.PARAMETER RatePerSecond
    Target injection rate in messages per second (default: 0 = max speed).
    Applied as a sleep between agent batches; fine-grained rate limiting for MQTT
    is inherently coarser than Redis due to docker exec overhead.

.PARAMETER PollIntervalSec
    How often (seconds) to poll /metrics/ingestion-health (default: 2).

.PARAMETER ApiUrl
    Base URL of the API (default: http://localhost:4002).

.PARAMETER JwtToken
    Bearer token for the health endpoint.
    For Auth0 environments copy a token from the browser DevTools Network tab.
    Omit to attempt local username/password login; omit both for no health polling.

.PARAMETER MqttHost
    Hostname for the MQTT broker reachable from the host (default: localhost).

.PARAMETER MqttPort
    External port of the MQTT broker (default: env MOSQUITTO_PORT_EXT or 5883).

.PARAMETER MqttClientIdPrefix
    Optional client ID prefix. When omitted, uses device_<agentUuid> like the agent default.

.PARAMETER MqttCleanSession
    MQTT clean session flag. Defaults to true to match the agent's cloud manager default.

.PARAMETER MqttKeepAliveSec
    MQTT keepalive interval in seconds. Defaults to 60 to match the agent's cloud manager default.

.PARAMETER MqttReconnectPeriodMs
    MQTT reconnect period in milliseconds. Defaults to 5000 to match the agent's cloud manager default.

.PARAMETER MqttConnectTimeoutMs
    MQTT connect timeout in milliseconds. Defaults to 30000 to match the agent's cloud manager default.

.PARAMETER MqttUseTls
    Use MQTTS/TLS for publish. Defaults to false for the local non-TLS broker port.

.PARAMETER MqttInsecureTls
    Skip certificate verification for publish client. Defaults to true.

.PARAMETER BatchSize
    Maximum messages per agent batch before forcing a publish.

.PARAMETER BatchTimeMs
    Maximum batch dwell time in milliseconds before forcing a publish.

.PARAMETER MqttUsername
    MQTT broker username (default: env MQTT_USERNAME or "admin").

.PARAMETER MqttPassword
    MQTT broker password (default: env MQTT_PASSWORD or "iotistic42!").

.PARAMETER TenantId
    12-char hex tenant ID (e.g. "73eddd385ce8").
    Auto-discovered from Redis stream key when omitted.

.PARAMETER Username
    API username for local-auth JWT acquisition (default: env LOAD_TEST_USERNAME or "admin").
    Ignored when -JwtToken is provided.

.PARAMETER Password
    API password for local-auth JWT acquisition (default: env LOAD_TEST_PASSWORD or "admin123").
    Ignored when -JwtToken is provided.

.EXAMPLE
    # Basic test — auto-discovers tenant, uses .env credentials
    .\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 2000

.EXAMPLE
    # Sustained ramp with Auth0 token
    .\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 10000 -AgentCount 20 -RatePerSecond 200 -JwtToken "eyJhbGci..."

.EXAMPLE
    # Explicit tenant and port
    .\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 5000 -TenantId "73eddd385ce8" -MqttPort 5883
#>
[CmdletBinding()]
param(
    [int]    $MessageCount     = 1000,
    [int]    $AgentCount      = 10,
    [int]    $MetricsPerMessage = 5,
    [int]    $RatePerSecond    = 0,
    [int]    $PollIntervalSec  = 2,
    [string] $ApiUrl           = "http://localhost:4002",
    [string] $JwtToken         = "",
    [string] $MqttHost         = "localhost",
    [int]    $MqttPort         = 0,      # resolved from env / default below
    [string] $MqttClientIdPrefix = "",
    [bool]   $MqttCleanSession = $true,
    [int]    $MqttKeepAliveSec = 60,
    [int]    $MqttReconnectPeriodMs = 5000,
    [int]    $MqttConnectTimeoutMs = 30000,
    [bool]   $MqttUseTls       = $false,
    [bool]   $MqttInsecureTls  = $true,
    [int]    $BatchSize        = 200,
    [int]    $BatchTimeMs      = 0,
    [string] $MqttUsername     = "",
    [string] $MqttPassword     = "",
    [string] $TenantId         = "",
    [string] $Username         = "",
    [string] $Password         = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Helpers: base64url encoding (mirrors api/src/mqtt/codec.ts) ─────────────

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

# 12-char hex tenant ID → 8-char base64url
function Encode-HexId {
    param([string]$Hex)
    $bytes = [byte[]]@(for ($i = 0; $i -lt $Hex.Length; $i += 2) {
        [Convert]::ToByte($Hex.Substring($i, 2), 16)
    })
    ConvertTo-Base64Url $bytes
}

# Standard UUID string → 22-char base64url
function Encode-Uuid {
    param([string]$Uuid)
    $hex = $Uuid.Replace('-', '')
    $bytes = [byte[]]@(for ($i = 0; $i -lt $hex.Length; $i += 2) {
        [Convert]::ToByte($hex.Substring($i, 2), 16)
    })
    ConvertTo-Base64Url $bytes
}

# Build MQTT topic from already-encoded parts.
# Sub-topic is required: API subscribes to i/{tenant}/a/{agent}/endpoints/+
function Get-DeviceTopic {
    param([string]$EncodedTenant, [string]$EncodedAgent)
    "i/$EncodedTenant/a/$EncodedAgent/endpoints/load-test"
}

function New-RequestId {
    [guid]::NewGuid().ToString('N')
}

function Get-AgentStyleClientId {
    param(
        [string]$AgentUuid,
        [string]$ClientIdPrefix
    )

    if (-not [string]::IsNullOrWhiteSpace($ClientIdPrefix)) {
        return "${ClientIdPrefix}_$AgentUuid"
    }

    return "device_$AgentUuid"
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

function Invoke-Redis {
    param([string[]]$RedisArgs)
    $result = docker exec iotistic-redis redis-cli --no-auth-warning `
        -a "$env:REDIS_PASSWORD" @RedisArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "redis-cli failed: $result" }
    return $result
}

function Get-TenantIdFromRedis {
    $keys = Invoke-Redis @("KEYS", "*:agent:devices:ingestion")
    if (-not $keys -or $keys -eq "(empty array)") {
        Write-Error @"
No ingestion stream key found in Redis.
Make sure the API container is running and has processed at least one message.
Expected pattern: tenant:{<tenantId>}:agent:devices:ingestion
"@
        exit 1
    }
    $key = (($keys -split "`n")[0]).Trim()
    # Extract the hex ID from  tenant:{73eddd385ce8}:agent:...
    if ($key -match 'tenant:\{([0-9a-f]+)\}') { return $Matches[1] }
    Write-Error "Could not parse tenant ID from key: $key"; exit 1
}

function Get-JwtToken {
    param([string]$Url, [string]$User, [string]$Pass)
    try {
        $body = @{ username = $User; password = $Pass } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Uri "$Url/api/v1/auth/login" `
            -Method Post -ContentType "application/json" -Body $body -TimeoutSec 10 -ErrorAction Stop
        $token = $response.data.accessToken
        if (-not $token) { throw "accessToken missing in login response" }
        return $token
    } catch {
        throw "JWT login failed ($Url): $_"
    }
}

function Get-IngestionHealth {
    param([string]$Url, [string]$Token)
    try {
        $headers = @{}
        if ($Token) { $headers["Authorization"] = "Bearer $Token" }
        return Invoke-RestMethod -Uri "$Url/api/v1/metrics/ingestion-health" `
            -Headers $headers -TimeoutSec 5 -ErrorAction Stop
    } catch { return $null }
}

function Get-PrometheusGaugeValue {
    param(
        [string]$Content,
        [string]$MetricName
    )

    $pattern = "(?m)^" + [Regex]::Escape($MetricName) + "(?:\{[^\}]*\})?\s+([-+0-9.eE]+)\s*$"
    $match = [Regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        return $null
    }

    [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Get-IngestionSnapshotViaDocker {
    $nodeScript = @'
fetch('http://127.0.0.1:3003/metrics')
  .then(async (response) => {
    const text = await response.text();
    if (!response.ok) {
      console.error(`HTTP ${response.status} ${text}`);
      process.exit(1);
    }

    process.stdout.write(text);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
'@

    $rawContent = docker exec iotistic-ingestion node -e $nodeScript 2>&1
    $content = if ($rawContent -is [System.Array]) {
        ($rawContent -join "`n")
    } else {
        [string]$rawContent
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to scrape ingestion metrics from local container 'iotistic-ingestion': $content"
    }

    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "Local ingestion metrics scrape returned no content from container 'iotistic-ingestion'"
    }

    $snapshot = [pscustomobject]@{
        streamLength      = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_stream_length'
        workerLag         = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_worker_lag'
        pendingMessages   = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_pending_count'
        dlqLength         = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_dlq_length'
        workerCount       = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_worker_count'
        dwellP95Ms        = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_dwell_latency_p95_ms'
        batchLatP95Ms     = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_batch_latency_p95_ms'
        messagesProcessed = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_messages_processed_total'
        readingsInserted  = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_readings_inserted_total'
        messagesDropped   = Get-PrometheusGaugeValue -Content $content -MetricName 'iotistic_ingestion_messages_dropped_total'
    }

    if ($null -eq $snapshot.streamLength -and
        $null -eq $snapshot.workerLag -and
        $null -eq $snapshot.pendingMessages -and
        $null -eq $snapshot.workerCount) {
        throw "Local ingestion metrics scrape succeeded but did not return expected iotistic_ingestion_* metrics"
    }

    return $snapshot
}

function Get-IngestionSnapshot {
    return Get-IngestionSnapshotViaDocker
}

function Get-HealthValue {
    param(
        [object]$Health,
        [string[]]$Names,
        [object]$Default = $null
    )

    foreach ($name in $Names) {
        $property = $Health.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return $property.Value
        }
    }

    return $Default
}

function Get-HealthDeltaValue {
    param(
        [object]$Health,
        [object]$BaselineHealth,
        [string[]]$Names,
        [object]$Default = $null
    )

    $current = Get-HealthValue -Health $Health -Names $Names -Default $null
    if ($null -eq $current) {
        return $Default
    }

    $baseline = Get-HealthValue -Health $BaselineHealth -Names $Names -Default 0

    try {
        return [int64]$current - [int64]$baseline
    } catch {
        return $Default
    }
}

function Write-HealthRow {
    param($Health, $BaselineHealth, [int]$Injected, [int]$Total, [int]$MetricsPerMessage, [double]$ElapsedSec)
    if (-not $Health) { Write-Host "  [health poll failed]" -ForegroundColor DarkGray; return }

    $rate = if ($ElapsedSec -gt 0) { [math]::Round($Injected / $ElapsedSec, 1) } else { 0 }
    $streamLen = Get-HealthValue -Health $Health -Names @('streamLength') -Default '?'
    $workers   = Get-HealthValue -Health $Health -Names @('workerCount', 'workers') -Default '?'
    $lag       = Get-HealthValue -Health $Health -Names @('workerLag', 'lagMs', 'maxDwellMs') -Default '?'
    $processed = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('messagesProcessed') -Default '?'
    $inserted  = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('readingsInserted') -Default '?'
    $dropped   = Get-HealthDeltaValue -Health $Health -BaselineHealth $BaselineHealth -Names @('messagesDropped') -Default '?'
    $pending   = Get-HealthValue -Health $Health -Names @('pendingMessages') -Default '?'
    $dwellP95  = Get-HealthValue -Health $Health -Names @('dwellP95Ms') -Default '?'
    $batchP95  = Get-HealthValue -Health $Health -Names @('batchLatP95Ms') -Default '?'

    $droppedValue = 0
    try { $droppedValue = [int]$dropped } catch { $droppedValue = 0 }

    $lagValue = 0
    try { $lagValue = [int]$lag } catch { $lagValue = 0 }

    $droppedColor = if ($droppedValue -gt 0) { 'Red' } else { 'Green' }
    $lagColor = if ($lagValue -gt 20000) { 'Red' } elseif ($lagValue -gt 5000) { 'Yellow' } else { 'Cyan' }
    $injectedReadings = $Injected * $MetricsPerMessage
    $totalReadings = $Total * $MetricsPerMessage

    Write-Host ("{0,8} | msg={1,5}/{2,-5} rd={3,6}/{4,-6} | rate={5,7}/s | stream={6,5} lag=" -f `
        (Get-Date -Format 'HH:mm:ss'), $Injected, $Total, $injectedReadings, $totalReadings, $rate, $streamLen) -NoNewline
    Write-Host ("{0,6}" -f $lag) -ForegroundColor $lagColor -NoNewline
    Write-Host ("  pending={0,5} workers={1,2} procΔ={2,7} insΔ={3,7} dropΔ=" -f `
        $pending, $workers, $processed, $inserted) -NoNewline
    Write-Host ("{0,4}" -f $dropped) -ForegroundColor $droppedColor -NoNewline
    Write-Host ("  dwellP95={0}ms batchP95={1}ms" -f $dwellP95, $batchP95)
}

function Write-FlushRow {
    param(
        [int]$Injected,
        [int]$Total,
        [int]$MetricsPerMessage,
        [double]$ElapsedSec,
        [int]$PendingMessages,
        [int]$TopicCount,
        [string]$Phase
    )

    $rate = if ($ElapsedSec -gt 0) { [math]::Round($Injected / $ElapsedSec, 1) } else { 0 }
    $injectedReadings = $Injected * $MetricsPerMessage
    $totalReadings = $Total * $MetricsPerMessage
    Write-Host ("{0,8} | msg={1,5}/{2,-5} rd={3,6}/{4,-6} | rate={5,7}/s | publishing {6,5} msgs across {7,2} topics | {8}" -f `
        (Get-Date -Format 'HH:mm:ss'), $Injected, $Total, $injectedReadings, $totalReadings, $rate, $PendingMessages, $TopicCount, $Phase) -ForegroundColor DarkGray
}

# ─── MQTT message builder ─────────────────────────────────────────────────────

function Build-EndpointsPayload {
    param(
        [string]$AgentUuid,
        [string]$AgentName,
        [int]$MetricCount,
        [datetime]$BaseTimestamp,
        [int]$Sequence
    )

    $timestamp = $BaseTimestamp.AddMilliseconds($Sequence).ToUniversalTime().ToString('o')
    $metricNames = @("temperature","humidity","pressure","vibration","current","voltage","co2","flow","rpm","power")
    $baseValues  = @{
        temperature=23.0; humidity=45.0; pressure=101.3; vibration=5.0
        current=2.5;      voltage=230.0; co2=400.0;      flow=12.5; rpm=1450.0; power=575.0
    }
    $units = @{
        temperature="C"; humidity="%"; pressure="kPa"; vibration="mm/s"
        current="A";     voltage="V";  co2="ppm";      flow="L/min"; rpm="RPM"; power="W"
    }

    $readings = 1..$MetricCount | ForEach-Object {
        $name  = $metricNames[($_ - 1) % $metricNames.Length]
        $base  = $baseValues[$name]
        $value = [math]::Round($base + (Get-Random -Minimum -5 -Maximum 5) * 0.1 * $base / 100, 4)
        @{ metric=$name; value=$value; unit=$units[$name]; quality="good"; timestamp=$timestamp; protocol="mqtt" }
    }

    # Canonical agent-style endpoint message: top-level readings payload.
    return @{
        protocol   = "mqtt"
        deviceUuid = $AgentUuid
        deviceName = $AgentName
        timestamp  = $timestamp
        readings   = $readings
    }
}

function Read-MqttPublisherMessage {
    param(
        [pscustomobject]$Publisher,
        [string]$ExpectedRequestId,
        [string]$Phase
    )

    while ($true) {
        $line = $Publisher.Process.StandardOutput.ReadLine()
        if ($null -eq $line) {
            $stderr = $Publisher.Process.StandardError.ReadToEnd()
            throw "MQTT publisher helper exited during $Phase. $stderr"
        }

        $message = $line | ConvertFrom-Json
        if ($message.type -eq 'log') {
            $color = switch ($message.level) {
                'error' { 'Red' }
                'warn' { 'Yellow' }
                default { 'DarkGray' }
            }

            Write-Host ("[publisher] {0} ({1})" -f $message.message, $message.clientId) -ForegroundColor $color
            continue
        }

        if ($message.type -eq 'ready') {
            if ($ExpectedRequestId) {
                continue
            }

            return $message
        }

        if ($message.type -eq 'response') {
            if ($ExpectedRequestId -and $message.requestId -ne $ExpectedRequestId) {
                continue
            }

            if (-not $message.ok) {
                throw "MQTT publisher helper $Phase failed: $($message.error)"
            }

            return $message
        }
    }
}

function Start-MqttPublisherProcess {
    param(
        [string]$BrokerHost,
        [int]$Port,
        [bool]$UseTls,
        [bool]$InsecureTls,
        [string]$Username,
        [string]$Password,
        [bool]$CleanSession,
        [int]$KeepAliveSec,
        [int]$ReconnectPeriodMs,
        [int]$ConnectTimeoutMs,
        [object[]]$Agents,
        [string]$ClientIdPrefix
    )

    $helperPath = Join-Path $PSScriptRoot 'mqtt-persistent-publisher.cjs'
    $brokerScheme = if ($UseTls) { 'mqtts' } else { 'mqtt' }
    $config = [ordered]@{
        brokerUrl = "${brokerScheme}://$BrokerHost`:$Port"
        username = $Username
        password = $Password
        cleanSession = $CleanSession
        keepAlive = $KeepAliveSec
        reconnectPeriod = $ReconnectPeriodMs
        connectTimeout = $ConnectTimeoutMs
        rejectUnauthorized = -not $InsecureTls
        agents = @($Agents | ForEach-Object {
            [ordered]@{
                agentUuid = $_.Uuid
                clientId = Get-AgentStyleClientId -AgentUuid $_.Uuid -ClientIdPrefix $ClientIdPrefix
                topic = $_.Topic
            }
        })
    }

    $configJson = $config | ConvertTo-Json -Depth 10 -Compress
    $configBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($configJson))

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'node'
    $startInfo.ArgumentList.Add($helperPath)
    $startInfo.ArgumentList.Add('--config')
    $startInfo.ArgumentList.Add($configBase64)
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = (Split-Path $helperPath -Parent)

    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
        throw 'Failed to start MQTT publisher helper process'
    }

    $publisher = [pscustomobject]@{
        Process = $process
        Writer = $process.StandardInput
        IsStopped = $false
    }

    $ready = Read-MqttPublisherMessage -Publisher $publisher -ExpectedRequestId '' -Phase 'startup'
    Write-Host ("Publisher helper ready with {0} persistent client(s)" -f $ready.clientCount) -ForegroundColor DarkGray
    return $publisher
}

function Invoke-MqttPublisherCommand {
    param(
        [pscustomobject]$Publisher,
        [string]$Command,
        [object]$Payload
    )

    $requestId = New-RequestId
    $commandPayload = [ordered]@{
        command = $Command
        requestId = $requestId
    }

    if ($Payload) {
        foreach ($property in $Payload.PSObject.Properties) {
            $commandPayload[$property.Name] = $property.Value
        }
    }

    $Publisher.Writer.WriteLine(($commandPayload | ConvertTo-Json -Depth 20 -Compress))
    $Publisher.Writer.Flush()
    Read-MqttPublisherMessage -Publisher $Publisher -ExpectedRequestId $requestId -Phase $Command
}

function Stop-MqttPublisherProcess {
    param([pscustomobject]$Publisher)

    if ($null -eq $Publisher) {
        return
    }

    if ($Publisher.IsStopped) {
        return
    }

    $Publisher.IsStopped = $true

    try {
        if (-not $Publisher.Process.HasExited) {
            Invoke-MqttPublisherCommand -Publisher $Publisher -Command 'shutdown' -Payload ([pscustomobject]@{}) | Out-Null
        }
    } finally {
        try {
            $Publisher.Writer.Dispose()
        } catch {
        }

        try {
            if (-not $Publisher.Process.HasExited) {
                $Publisher.Process.WaitForExit(5000) | Out-Null
            }
        } catch {
        }

        try {
            $Publisher.Process.Dispose()
        } catch {
        }
    }
}

# ─── Setup ────────────────────────────────────────────────────────────────────

$envFile = Join-Path $PSScriptRoot ".." ".." ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^[^#].*=.*' } | ForEach-Object {
        $parts = $_ -split '=', 2
        if ($parts.Length -eq 2 -and -not (Get-Item "Env:$($parts[0].Trim())" -ErrorAction SilentlyContinue)) {
            Set-Item "Env:$($parts[0].Trim())" $parts[1].Trim()
        }
    }
}

if (-not $env:REDIS_PASSWORD) {
    Write-Warning "REDIS_PASSWORD not set. Attempting unauthenticated Redis connection."
    $env:REDIS_PASSWORD = ""
}

# Resolve MQTT connection params: param > env var > default
if ($MqttPort -eq 0)       { $MqttPort    = if ($env:MOSQUITTO_PORT_EXT) { [int]$env:MOSQUITTO_PORT_EXT } else { 5883 } }
if (-not $MqttUsername)    { $MqttUsername = if ($env:MQTT_USERNAME)      { $env:MQTT_USERNAME }           else { "admin" } }
if (-not $MqttPassword)    { $MqttPassword = if ($env:MQTT_PASSWORD)      { $env:MQTT_PASSWORD }           else { "iotistic42!" } }
if (-not $Username)        { $Username     = if ($env:LOAD_TEST_USERNAME) { $env:LOAD_TEST_USERNAME }      else { "admin" } }
if (-not $Password)        { $Password     = if ($env:LOAD_TEST_PASSWORD) { $env:LOAD_TEST_PASSWORD }      else { "admin123" } }

# Resolve tenant ID
if ($TenantId) {
    Write-Host "Using tenant ID: $TenantId" -ForegroundColor Green
} else {
    Write-Host "Discovering tenant ID from Redis..." -NoNewline
    $TenantId = Get-TenantIdFromRedis
    Write-Host " $TenantId" -ForegroundColor Green
}
$encodedTenant = Encode-HexId $TenantId

# Resolve agent UUIDs (same as ingestion script: real UUIDs from DB, synthetic fallback)
$dbUuids = @()
try {
    $rawUuids = docker exec iotistic-postgres psql -U postgres -d iotistica -t -c `
        "SELECT uuid FROM agents ORDER BY random() LIMIT $AgentCount;" 2>&1
    $dbUuids  = $rawUuids | Where-Object { $_.Trim() -match '^[0-9a-f-]{36}$' } | ForEach-Object { $_.Trim() }
} catch {}

if ($dbUuids.Count -gt 0) {
    $agentUuids = 1..$AgentCount | ForEach-Object { $dbUuids[($_ - 1) % $dbUuids.Count] }
    Write-Host "Using $($dbUuids.Count) real agent UUIDs from DB (cycling to $AgentCount slots)" -ForegroundColor DarkGray
} else {
    $agentUuids = 1..$AgentCount | ForEach-Object { "00000000-0000-4000-a000-{0:X12}" -f $_ }
    Write-Warning "Could not fetch agent UUIDs from DB — using synthetic UUIDs (readings may be rejected by FK constraint)"
}

# Precompute per-agent: encoded UUID and MQTT topic
$agentTopics = @{}
foreach ($uuid in ($agentUuids | Select-Object -Unique)) {
    $encodedUuid         = Encode-Uuid $uuid
    $agentTopics[$uuid]  = Get-DeviceTopic -EncodedTenant $encodedTenant -EncodedAgent $encodedUuid
}

$publisherAgents = @($agentTopics.GetEnumerator() | ForEach-Object {
    [pscustomobject]@{
        Uuid = $_.Key
        Topic = $_.Value
    }
})

# Acquire JWT token for health polling
if ($JwtToken) {
    Write-Host "Using provided JWT token." -ForegroundColor Green
} else {
    Write-Host "Acquiring JWT token for '$Username'..." -NoNewline
    try {
        $JwtToken = Get-JwtToken -Url $ApiUrl -User $Username -Pass $Password
        Write-Host " OK" -ForegroundColor Green
    } catch {
        Write-Host " FAILED" -ForegroundColor DarkYellow
        Write-Warning "$_"
        Write-Warning "Health polling will be skipped. For Auth0 environments, pass -JwtToken `"<token>`"."
        $JwtToken = ""
    }
}

Write-Host ""
Write-Host "=== Iotistica Seam-3 MQTT Load Test ===" -ForegroundColor Cyan
Write-Host "  Messages    : $MessageCount"
Write-Host "  Agents      : $AgentCount  ($($agentTopics.Count) unique topics)"
Write-Host "  Metrics/msg : $MetricsPerMessage  ($($MetricsPerMessage * $MessageCount) total readings)"
Write-Host "  Rate target : $(if ($RatePerSecond -gt 0) { "$RatePerSecond msg/s" } else { "max speed" })"
Write-Host "  Broker      : $(if ($MqttUseTls) { 'mqtts' } else { 'mqtt' })://$MqttHost`:$MqttPort  user=$MqttUsername"
Write-Host "  Client IDs  : $(if ([string]::IsNullOrWhiteSpace($MqttClientIdPrefix)) { 'device_<agentUuid>' } else { "$MqttClientIdPrefix`_<agentUuid>" })"
Write-Host "  Session     : clean=$MqttCleanSession keepalive=${MqttKeepAliveSec}s reconnect=${MqttReconnectPeriodMs}ms timeout=${MqttConnectTimeoutMs}ms"
Write-Host "  Tenant      : $TenantId  (encoded: $encodedTenant)"
$sampleTopic = Get-DeviceTopic -EncodedTenant $encodedTenant -EncodedAgent (Encode-Uuid $agentUuids[0])
Write-Host "  Topic fmt   : $($sampleTopic -replace (Encode-Uuid $agentUuids[0]), '{encodedAgentUuid}')  (e.g. $sampleTopic)"
$healthPollDesc = if ($JwtToken) { "API health endpoint" } else { "direct ingestion scrape" }
Write-Host "  Health poll : every ${PollIntervalSec}s — $healthPollDesc"
Write-Host ""

$mqttPublisher = $null

function Flush-AllBatchesParallel {
    param(
        [hashtable]$PendingBatches,
        [hashtable]$Topics,
        [pscustomobject]$Publisher
    )

    $batches = @($PendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 } | ForEach-Object {
        [pscustomobject]@{
            AgentUuid = $_.Key
            Topic = $Topics[$_.Key]
            Messages = $_.Value.ToArray()
        }
        $_.Value.Clear()
    })

    if ($batches.Count -eq 0) {
        return
    }

    $payload = [pscustomobject]@{
        batches = @($batches | ForEach-Object {
            [ordered]@{
                agentUuid = $_.AgentUuid
                topic = $_.Topic
                payload = (@{
                    sensor    = 'load-test'
                    timestamp = (Get-Date).ToUniversalTime().ToString('o')
                    protocol  = 'mqtt'
                    messages  = $_.Messages
                    msgId     = New-RequestId
                } | ConvertTo-Json -Depth 20 -Compress)
            }
        })
    }

    Invoke-MqttPublisherCommand -Publisher $Publisher -Command 'publish' -Payload $payload | Out-Null
}

try {
    $baselineHealth = if ($JwtToken) { $null } else { Get-IngestionSnapshot }

    Write-Host ("{0,8} | {1,27} | {2,12} | {3,18} | {4,24} | {5,22}" -f `
        'Time', 'Msgs/Total  Readings/Total', 'rate/stream', 'lag/pending/workers', 'procΔ/insΔ/dropΔ', 'dwellP95/batchP95')
    Write-Host ('-' * 130)

    $batchSize    = [Math]::Max(1, $BatchSize)
    $roundSize    = $batchSize * $AgentCount
    Write-Host "  Flush size  : $roundSize msgs ($batchSize per agent x $AgentCount agents)" -ForegroundColor DarkGray
    if ($BatchTimeMs -gt 0) {
        Write-Host "  Flush time  : ${BatchTimeMs}ms max batch age" -ForegroundColor DarkGray
    }
    $stopwatch    = [System.Diagnostics.Stopwatch]::StartNew()
    $lastPollAt   = 0.0
    $lastFlushAtMs = 0.0
    $delayMs      = if ($RatePerSecond -gt 0) { [int](1000.0 / $RatePerSecond) } else { 0 }
    $injected     = 0
    $totalPending = 0
    $runBaseTimestamp = (Get-Date).ToUniversalTime()

    $pendingBatches = @{}
    foreach ($uuid in ($agentUuids | Select-Object -Unique)) {
        $pendingBatches[$uuid] = [System.Collections.Generic.List[object]]::new()
    }

    $mqttPublisher = Start-MqttPublisherProcess -BrokerHost $MqttHost -Port $MqttPort -UseTls $MqttUseTls -InsecureTls $MqttInsecureTls -Username $MqttUsername -Password $MqttPassword -CleanSession $MqttCleanSession -KeepAliveSec $MqttKeepAliveSec -ReconnectPeriodMs $MqttReconnectPeriodMs -ConnectTimeoutMs $MqttConnectTimeoutMs -Agents $publisherAgents -ClientIdPrefix $MqttClientIdPrefix

    for ($i = 0; $i -lt $MessageCount; $i++) {
        $uuid    = $agentUuids[$i % $AgentCount]
        $name    = "agent-" + $uuid.Substring(0, 8)
        $payload = Build-EndpointsPayload -AgentUuid $uuid -AgentName $name -MetricCount $MetricsPerMessage -BaseTimestamp $runBaseTimestamp -Sequence $i
        $pendingBatches[$uuid].Add($payload)
        $injected++
        $totalPending++

        $maxBatchDepth = @($pendingBatches.GetEnumerator() | ForEach-Object { $_.Value.Count } | Measure-Object -Maximum).Maximum
        $elapsedMs = $stopwatch.Elapsed.TotalMilliseconds
        $batchAgeExceeded = $BatchTimeMs -gt 0 -and $totalPending -gt 0 -and (($elapsedMs - $lastFlushAtMs) -ge $BatchTimeMs)

        if ($maxBatchDepth -ge $batchSize -or $batchAgeExceeded) {
            $flushTopicCount = @($pendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 }).Count
            Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages $totalPending -TopicCount $flushTopicCount -Phase 'flush start'
            Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -Publisher $mqttPublisher
            $totalPending = 0
            $lastFlushAtMs = $stopwatch.Elapsed.TotalMilliseconds

            $elapsedSec = $stopwatch.Elapsed.TotalSeconds
            Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec -PendingMessages 0 -TopicCount $flushTopicCount -Phase 'flush done'

            if (($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
                $health = if ($JwtToken) { Get-IngestionHealth -Url $ApiUrl -Token $JwtToken } else { Get-IngestionSnapshot }
                Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec
                $lastPollAt = $elapsedSec
            }
        }

        if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }

        $elapsedSec = $stopwatch.Elapsed.TotalSeconds
        if ($totalPending -eq 0 -and ($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
            $health = if ($JwtToken) { Get-IngestionHealth -Url $ApiUrl -Token $JwtToken } else { Get-IngestionSnapshot }
            Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $elapsedSec
            $lastPollAt = $elapsedSec
        }
    }

    if ($totalPending -gt 0) {
        $flushTopicCount = @($pendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 }).Count
        Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages $totalPending -TopicCount $flushTopicCount -Phase 'final flush start'
        Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -Publisher $mqttPublisher
        Write-FlushRow -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage -ElapsedSec $stopwatch.Elapsed.TotalSeconds -PendingMessages 0 -TopicCount $flushTopicCount -Phase 'final flush done'
    } else {
        Flush-AllBatchesParallel -PendingBatches $pendingBatches -Topics $agentTopics -Publisher $mqttPublisher
    }

    $stopwatch.Stop()
    $totalSec     = $stopwatch.Elapsed.TotalSeconds
    $actualRate   = [math]::Round($MessageCount / $totalSec, 1)
    $totalReadings = $MessageCount * $MetricsPerMessage

    Write-Host ""
    Write-Host "=== Injection complete ===" -ForegroundColor Cyan
    Write-Host ("  Injected : {0} messages ({1} readings) in {2:F2}s = {3} msg/s actual" -f `
        $MessageCount, $totalReadings, $totalSec, $actualRate)

# ─── Drain wait ───────────────────────────────────────────────────────────────
Write-Host ""
} finally {
    Stop-MqttPublisherProcess -Publisher $mqttPublisher
}
$drainTimeout = [System.Diagnostics.Stopwatch]::StartNew()

if ($JwtToken) {
    Write-Host "Waiting for worker to drain stream (lag=0, pending=0)..." -ForegroundColor Yellow
    while ($drainTimeout.Elapsed.TotalSeconds -lt 120) {
        Start-Sleep -Seconds $PollIntervalSec
        $health = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
        Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage `
            -ElapsedSec ($totalSec + $drainTimeout.Elapsed.TotalSeconds)

        $wlag    = [int]($health.workerLag     ?? -1)
        $pending = [int]($health.pendingMessages ?? -1)
        if ($wlag -eq 0 -and $pending -eq 0) {
            Write-Host ""
            Write-Host "Worker caught up (lag=0, pending=0)." -ForegroundColor Green
            break
        }
    }
} else {
    Write-Host "Waiting for worker to drain stream (lag=0, pending=0)..." -ForegroundColor Yellow
    while ($drainTimeout.Elapsed.TotalSeconds -lt 120) {
        Start-Sleep -Seconds $PollIntervalSec
        $health = Get-IngestionSnapshot
        Write-HealthRow -Health $health -BaselineHealth $baselineHealth -Injected $injected -Total $MessageCount -MetricsPerMessage $MetricsPerMessage `
            -ElapsedSec ($totalSec + $drainTimeout.Elapsed.TotalSeconds)

        $wlag = [int](Get-HealthValue -Health $health -Names @('workerLag') -Default -1)
        $pending = [int](Get-HealthValue -Health $health -Names @('pendingMessages') -Default -1)
        if ($wlag -eq 0 -and $pending -eq 0) {
            Write-Host ""
            Write-Host "Worker caught up (lag=0, pending=0)." -ForegroundColor Green
            break
        }
    }
}

# ─── Final summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Final Stats ===" -ForegroundColor Cyan

$finalHealth = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
if (-not $finalHealth -and -not $JwtToken) {
    $finalHealth = Get-IngestionSnapshot
}
if ($finalHealth) {
    $processed = if ($baselineHealth) { Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('messagesProcessed') -Default '?' } else { Get-HealthValue -Health $finalHealth -Names @('messagesProcessed') -Default '?' }
    $inserted  = if ($baselineHealth) { Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('readingsInserted') -Default '?' } else { Get-HealthValue -Health $finalHealth -Names @('readingsInserted') -Default '?' }
    $dropped   = if ($baselineHealth) { Get-HealthDeltaValue -Health $finalHealth -BaselineHealth $baselineHealth -Names @('messagesDropped') -Default '?' } else { Get-HealthValue -Health $finalHealth -Names @('messagesDropped') -Default '?' }
    $lag       = Get-HealthValue -Health $finalHealth -Names @('workerLag') -Default '?'
    $pending   = Get-HealthValue -Health $finalHealth -Names @('pendingMessages') -Default '?'
    $dlq       = Get-HealthValue -Health $finalHealth -Names @('dlqLength') -Default '?'
    Write-Host ("  Consumer lag    : {0}  pending: {1}" -f $lag, $pending)
    Write-Host ("  Processed       : {0}" -f $processed)
    Write-Host ("  Readings in DB  : {0}" -f $inserted)
    $droppedColor = if ([int]$dropped -gt 0) { "Red" } else { "Green" }
    Write-Host ("  Dropped         : {0}" -f $dropped) -ForegroundColor $droppedColor
    Write-Host ("  DLQ length      : {0}" -f $dlq)

    if ([int]($dlq) -gt 0) {
        $dlqKey = "tenant:{$TenantId}:agent:devices:dlq"
        Write-Host ""
        Write-Host "  WARNING: $dlq messages landed in the DLQ!" -ForegroundColor Red
        Write-Host "  Inspect with: docker exec iotistic-redis redis-cli XRANGE $dlqKey - + COUNT 5" -ForegroundColor Yellow
    }
} else {
    Write-Host "  (ingestion metrics unavailable for final stats)" -ForegroundColor DarkGray
}

Write-Host ""
