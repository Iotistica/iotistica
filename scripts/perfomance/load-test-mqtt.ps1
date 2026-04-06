<#
.SYNOPSIS
    Seam-3 ingestion load test: publishes DeviceDataEntry messages through the MQTT
    broker, exercising the full MQTT → API → Redis Stream → Worker → DB pipeline.

.DESCRIPTION
    Discovers the tenant ID from the live Redis stream key, encodes agent UUIDs to
    base64url (matching the API's MQTT topic format), then fires batched mosquitto_pub
    calls grouped by agent.  Health metrics are polled identically to load-test-ingestion.ps1.

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

# ─── Shared helpers (identical to load-test-ingestion.ps1) ───────────────────

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

function Get-ConsumerLag {
    param([string]$Key)
    $info = Invoke-Redis @("XINFO", "GROUPS", $Key)
    $lag = 0; $pending = 0
    $lines = @(($info -join "`n") -split "`n" |
               ForEach-Object { $_.Trim() } |
               Where-Object   { $_ })
    if ($lines.Count -eq 0 -or ($lines.Count -eq 1 -and $lines[0] -match 'empty')) {
        return @{ lag = -1; pending = -1 }
    }
    for ($i = 0; $i -lt $lines.Count - 1; $i++) {
        if ($lines[$i] -eq 'lag')     { $lag     = [int]($lines[$i+1] -replace '\(integer\)\s*', '') }
        if ($lines[$i] -eq 'pending') { $pending = [int]($lines[$i+1] -replace '\(integer\)\s*', '') }
    }
    return @{ lag = $lag; pending = $pending }
}

function Get-StreamKey {
    param([string]$TenantHexId)
    "tenant:{$TenantHexId}:agent:devices:ingestion"
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

function Write-HealthRow {
    param($h, [int]$Injected, [int]$Total, [double]$ElapsedSec)
    if (-not $h) { Write-Host "  [health poll failed]" -ForegroundColor DarkGray; return }

    $rate = if ($ElapsedSec -gt 0) { [int]($Injected / $ElapsedSec) } else { 0 }

    $streamLen = $h.streamLength     ?? $h.data.streamLength     ?? "?"
    $workers   = $h.workerCount      ?? $h.data.workerCount      ?? "?"
    $lag       = $h.workerLag        ?? $h.data.workerLag        ?? "?"
    $processed = $h.messagesProcessed ?? $h.data.messagesProcessed ?? "?"
    $inserted  = $h.readingsInserted  ?? $h.data.readingsInserted  ?? "?"
    $dropped   = $h.messagesDropped   ?? $h.data.messagesDropped   ?? "?"
    $dwellP95  = $h.dwellP95Ms       ?? $h.data.dwellP95Ms       ?? "?"
    $batchP95  = $h.batchLatP95Ms    ?? $h.data.batchLatP95Ms    ?? "?"

    $droppedColor = if ($dropped -gt 0) { "Red" } else { "Green" }
    $lagColor     = if ($lag -gt 20000) { "Red" } elseif ($lag -gt 5000) { "Yellow" } else { "Cyan" }

    Write-Host ("{0,8} | {1,6}/{2} msg/s | stream={3,5}  lag=" -f `
        (Get-Date -Format "HH:mm:ss"), $Injected, $Total, $streamLen) -NoNewline
    Write-Host ("{0,6}ms" -f $lag) -ForegroundColor $lagColor -NoNewline
    Write-Host ("  workers={0,2}  processed={1,6}  inserted={2,7}  dropped=" -f `
        $workers, $processed, $inserted) -NoNewline
    Write-Host ("{0,4}" -f $dropped) -ForegroundColor $droppedColor -NoNewline
    Write-Host ("  dwellP95={0}ms  batchP95={1}ms" -f $dwellP95, $batchP95)
}

# ─── MQTT message builder ─────────────────────────────────────────────────────

function Build-EndpointsPayload {
    param([string]$AgentUuid, [string]$AgentName, [int]$MetricCount)

    $now = (Get-Date).ToUniversalTime().ToString("o")
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
        @{ metric=$name; value=$value; unit=$units[$name]; quality="good"; timestamp=$now; protocol="mqtt" }
    }

    # Payload shape consumed by MQTT handler (handleEndpointsData → handleDeviceData)
    return @{
        deviceName = $AgentName
        timestamp  = $now
        data       = @{
            protocol   = "mqtt"
            readings   = $readings
            deviceName = $AgentName
            deviceUuid = $AgentUuid
        }
    }
}

# ─── MQTT publisher via docker exec mosquitto_pub ────────────────────────────
#
# Uses -l (line-per-message from stdin) so a whole agent's batch is a single
# docker exec call instead of one call per message.  Parallelising across all
# agents with ForEach-Object -Parallel reduces wall-clock time from
# O(batches × latency) to O(rounds × latency_per_single_exec).

function Publish-AgentBatch {
    param(
        [string]   $Topic,
        [string[]] $JsonLines,
        [string]   $User,
        [string]   $Pass
    )
    # mosquitto_pub runs inside the iotistic-mosquitto container via docker exec,
    # so the broker is reachable at 127.0.0.1:1883 (container-internal port).
    $payload = $JsonLines -join "`n"
    $result  = $payload | docker exec -i iotistic-mosquitto mosquitto_pub `
        --host 127.0.0.1 --port 1883 `
        --username $User --pw $Pass `
        --topic "$Topic" --qos 1 -l 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "mosquitto_pub failed (topic=$Topic): $result"
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
$streamKey     = Get-StreamKey $TenantId

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
Write-Host "  Broker      : $MqttHost`:$MqttPort  user=$MqttUsername"
Write-Host "  Tenant      : $TenantId  (encoded: $encodedTenant)"
$sampleTopic = Get-DeviceTopic -EncodedTenant $encodedTenant -EncodedAgent (Encode-Uuid $agentUuids[0])
Write-Host "  Topic fmt   : $($sampleTopic -replace (Encode-Uuid $agentUuids[0]), '{encodedAgentUuid}')  (e.g. $sampleTopic)"
$healthPollDesc = if ($JwtToken) { "enabled" } else { "disabled (no JWT token)" }
Write-Host "  Health poll : every ${PollIntervalSec}s — $healthPollDesc"
Write-Host ""

# ─── Header row ───────────────────────────────────────────────────────────────
if ($JwtToken) {
    Write-Host ("{0,8} | {1,13}       | {2,14}  {3,15}  {4,14}  {5,9}  {6,20}" -f `
        "Time", "Injected/Total", "streamLen lag", "workers processed", "inserted dropped", "dwellP95", "batchP95")
    Write-Host ("-" * 130)
} else {
    Write-Host "(health polling disabled — no JWT token)" -ForegroundColor DarkGray
}

# ─── Injection loop ───────────────────────────────────────────────────────────
#
# Strategy: fill messages round-robin across agents up to $batchSize per agent,
# then flush ALL agents simultaneously with ForEach-Object -Parallel (one docker
# exec per agent at the same time).  This cuts wall-clock time from
# O(rounds × AgentCount × exec_latency) to O(rounds × exec_latency).
#
# $batchSize controls messages per agent per round.
# A "round" = $batchSize × $AgentCount total messages.

$batchSize    = 200   # messages per agent per parallel round
$roundSize    = $batchSize * $AgentCount   # total messages that trigger a flush
$stopwatch    = [System.Diagnostics.Stopwatch]::StartNew()
$lastPollAt   = 0.0
$delayMs      = if ($RatePerSecond -gt 0) { [int](1000.0 / $RatePerSecond) } else { 0 }
$injected     = 0
$totalPending = 0

# Per-agent pending batch buffers (uuid → List<string>)
$pendingBatches = @{}
foreach ($uuid in ($agentUuids | Select-Object -Unique)) {
    $pendingBatches[$uuid] = [System.Collections.Generic.List[string]]::new()
}

# Flush all agents in parallel — one docker exec per agent, all concurrent.
# Snapshots and clears buffers before launching runspaces so the main thread
# can continue accumulating for the next round immediately after.
function Flush-AllBatchesParallel {
    # Snapshot non-empty buffers and clear them
    $batches = @($pendingBatches.GetEnumerator() | Where-Object { $_.Value.Count -gt 0 } | ForEach-Object {
        [pscustomobject]@{ Topic = $agentTopics[$_.Key]; Lines = $_.Value.ToArray() }
        $_.Value.Clear()
    })
    if ($batches.Count -eq 0) { return }

    $user = $MqttUsername
    $pass = $MqttPassword

    $batches | ForEach-Object -Parallel {
        $payload = ($_.Lines -join "`n")
        $result  = $payload | docker exec -i iotistic-mosquitto mosquitto_pub `
            --host 127.0.0.1 --port 1883 `
            --username $using:user --pw $using:pass `
            --topic $_.Topic --qos 1 -l 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "mosquitto_pub failed (topic=$($_.Topic)): $result"
        }
    } -ThrottleLimit 20
}

for ($i = 0; $i -lt $MessageCount; $i++) {
    $uuid    = $agentUuids[$i % $AgentCount]
    $name    = "agent-" + $uuid.Substring(0, 8)
    $payload = Build-EndpointsPayload -AgentUuid $uuid -AgentName $name -MetricCount $MetricsPerMessage
    $json    = $payload | ConvertTo-Json -Depth 10 -Compress
    $pendingBatches[$uuid].Add($json)
    $injected++
    $totalPending++

    # Flush all agents in parallel when a full round is accumulated
    if ($totalPending -ge $roundSize) {
        Flush-AllBatchesParallel
        $totalPending = 0
    }

    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }

    if ($JwtToken) {
        $elapsedSec = $stopwatch.Elapsed.TotalSeconds
        if (($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
            $health = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
            Write-HealthRow -h $health -Injected $injected -Total $MessageCount -ElapsedSec $elapsedSec
            $lastPollAt = $elapsedSec
        }
    }
}

Flush-AllBatchesParallel  # drain remaining partial batches

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
Write-Host "Waiting for worker to drain stream (lag=0, pending=0)..." -ForegroundColor Yellow
$drainTimeout = [System.Diagnostics.Stopwatch]::StartNew()

while ($drainTimeout.Elapsed.TotalSeconds -lt 120) {
    Start-Sleep -Seconds $PollIntervalSec
    $cgState    = Get-ConsumerLag $streamKey
    $currentLen = [int](Invoke-Redis @("XLEN", $streamKey))

    if ($JwtToken) {
        $health = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
        Write-HealthRow -h $health -Injected $injected -Total $MessageCount `
            -ElapsedSec ($totalSec + $drainTimeout.Elapsed.TotalSeconds)
    } else {
        Write-Host ("  [{0:HH:mm:ss}] stream={1}  lag={2}  pending={3}" -f `
            (Get-Date), $currentLen, $cgState.lag, $cgState.pending)
    }

    if ($cgState.lag -eq 0 -and $cgState.pending -eq 0) {
        Write-Host ""
        Write-Host "Worker caught up (lag=0, pending=0)." -ForegroundColor Green
        break
    }
}

# ─── Final summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Final Stats ===" -ForegroundColor Cyan
$finalCgState = Get-ConsumerLag $streamKey
Write-Host ("  Consumer lag    : {0}  pending: {1}" -f $finalCgState.lag, $finalCgState.pending)

$finalHealth = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
if ($finalHealth) {
    $processed = $finalHealth.messagesProcessed ?? $finalHealth.data.messagesProcessed ?? "?"
    $inserted  = $finalHealth.readingsInserted  ?? $finalHealth.data.readingsInserted  ?? "?"
    $dropped   = $finalHealth.messagesDropped   ?? $finalHealth.data.messagesDropped   ?? "?"
    $dlq       = $finalHealth.dlqLength         ?? $finalHealth.data.dlqLength         ?? "?"
    Write-Host ("  Processed       : {0}" -f $processed)
    Write-Host ("  Readings in DB  : {0}" -f $inserted)
    $droppedColor = if ($dropped -gt 0) { "Red" } else { "Green" }
    Write-Host ("  Dropped         : {0}" -f $dropped) -ForegroundColor $droppedColor
    Write-Host ("  DLQ length      : {0}" -f $dlq)
}

# Check DLQ
$dlqKeys = Invoke-Redis @("KEYS", "*:agent:devices:dlq*")
if ($dlqKeys -and $dlqKeys -ne "(empty array)") {
    $dlqLen = Invoke-Redis @("XLEN", (($dlqKeys -split "`n")[0]).Trim())
    if ([int]$dlqLen -gt 0) {
        $dlqKey  = $streamKey -replace ":ingestion$", ":dlq"
        Write-Host ""
        Write-Host "  WARNING: $dlqLen messages landed in the DLQ!" -ForegroundColor Red
        Write-Host "  Inspect with: docker exec iotistic-redis redis-cli XRANGE $dlqKey - + COUNT 5" -ForegroundColor Yellow
    }
}

Write-Host ""
