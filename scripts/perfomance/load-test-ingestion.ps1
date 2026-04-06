<#
.SYNOPSIS
    Seam-3 ingestion load test: writes DeviceDataEntry messages directly into the
    Redis Stream, bypassing MQTT and the API entirely.

.DESCRIPTION
    Discovers the live ingestion stream key by scanning Redis, then fires a
    configurable burst of messages (or a sustained ramp) and prints live pipeline
    health metrics while the worker drains the stream.

    Requires:
      - docker running with the iotistic-redis container
      - API container running (for /metrics/ingestion-health polling)
      - .env file in the repo root with REDIS_PASSWORD (and optionally API_URL / JWT_TOKEN)

.PARAMETER MessageCount
    Total messages to inject (default: 1000).

.PARAMETER AgentCount
    Number of distinct agent UUIDs to spread messages across (default: 10).

.PARAMETER MetricsPerMessage
    Number of metric readings inside each DeviceDataEntry (default: 5).

.PARAMETER RatePerSecond
    Target injection rate in messages/sec (default: 0 = fire as fast as possible).
    Set to e.g. 200 to do a sustained ramp test.

.PARAMETER PollIntervalSec
    How often (seconds) to poll /metrics/ingestion-health (default: 2).

.PARAMETER ApiUrl
    Base URL of the API (default: http://localhost:4002).

.PARAMETER JwtToken
    Bearer token for the /metrics/ingestion-health endpoint.
    Auth0 environments: copy a token from the browser (DevTools → Network → any API request → Authorization header).
    If omitted, the script tries local username/password login; if that also fails, health polling is skipped.

.PARAMETER StreamKey
    Redis stream key to inject into (e.g. "tenant:{73eddd385ce8}:agent:devices:ingestion").
    Auto-discovered from Redis when omitted.

.PARAMETER Username
    API username for local-auth JWT acquisition (default: env LOAD_TEST_USERNAME or "admin").
    Ignored when -JwtToken is provided.

.PARAMETER Password
    API password for local-auth JWT acquisition (default: env LOAD_TEST_PASSWORD or "admin123").
    Ignored when -JwtToken is provided.

.EXAMPLE
    # Auth0 env: copy a token from the browser and pass it directly
    .\scripts\load-test-ingestion.ps1 -MessageCount 500 -JwtToken "eyJhbGci..."

.EXAMPLE
    # Local-auth env (no Auth0): username/password auto-login
    .\scripts\load-test-ingestion.ps1 -MessageCount 500 -Username admin -Password secret

.EXAMPLE
    # Skip health polling entirely (no auth needed)
    .\scripts\load-test-ingestion.ps1 -MessageCount 500

.EXAMPLE
    # Ramp test, explicit stream key
    .\scripts\load-test-ingestion.ps1 -MessageCount 10000 -AgentCount 20 -RatePerSecond 500 -StreamKey "tenant:{73eddd385ce8}:agent:devices:ingestion" -JwtToken "eyJhbGci..."
#>
[CmdletBinding()]
param(
    [int]    $MessageCount      = 1000,
    [int]    $AgentCount       = 10,
    [int]    $MetricsPerMessage  = 5,
    [int]    $RatePerSecond     = 0,
    [int]    $PollIntervalSec   = 2,
    [string] $ApiUrl            = "http://localhost:4002",
    [string] $JwtToken          = "",
    [string] $StreamKey         = "",
    [string] $Username          = "",
    [string] $Password          = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Helpers ─────────────────────────────────────────────────────────────────

function Invoke-Redis {
    param([string[]]$RedisArgs)
    $result = docker exec iotistic-redis redis-cli --no-auth-warning `
        -a "$env:REDIS_PASSWORD" @RedisArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "redis-cli failed: $result"
    }
    return $result
}

function Get-StreamKey {
    # Scan Redis for the live ingestion stream key
    # Key format: tenant:{<tenantId>}:agent:devices:ingestion
    $keys = Invoke-Redis @("KEYS", "*:agent:devices:ingestion")
    if (-not $keys -or $keys -eq "(empty array)") {
        Write-Error @"
No ingestion stream key found in Redis.
Make sure the API container is running and has processed at least one message
(the consumer group is created lazily on first use).

Expected pattern: tenant:{<tenantId>}:agent:devices:ingestion
"@
        exit 1
    }
    # Take the first match (single-tenant local dev)
    return ($keys -split "`n")[0].Trim()
}

function Get-StreamLength {
    param([string]$Key)
    return [int](Invoke-Redis @("XLEN", $Key))
}

# Returns @{ lag = <int>; pending = <int> } from XINFO GROUPS for the consumer group.
# lag=0 + pending=0 means the worker has delivered and ACKed all injected messages.
# Returns @{ lag = -1; pending = -1 } when no consumer group exists yet (API still starting).
function Get-ConsumerLag {
    param([string]$Key)
    $info = Invoke-Redis @("XINFO", "GROUPS", $Key)
    $lag     = 0
    $pending = 0
    # -join handles docker exec returning an array (one element per line); @() prevents
    # PowerShell scalar-unrolling a single-element pipeline under Set-StrictMode.
    $lines = @(($info -join "`n") -split "`n" |
               ForEach-Object { $_.Trim() } |
               Where-Object   { $_ })
    # No consumer group registered yet (stream key brand-new or API not started)
    if ($lines.Count -eq 0 -or ($lines.Count -eq 1 -and $lines[0] -match 'empty')) {
        return @{ lag = -1; pending = -1 }
    }
    for ($i = 0; $i -lt $lines.Count - 1; $i++) {
        if ($lines[$i] -eq 'lag') {
            $lag     = [int]($lines[$i + 1] -replace '\(integer\)\s*', '')
        }
        if ($lines[$i] -eq 'pending') {
            $pending = [int]($lines[$i + 1] -replace '\(integer\)\s*', '')
        }
    }
    return @{ lag = $lag; pending = $pending }
}

function Build-AgentDataEntry {
    param(
        [string]$AgentUuid,
        [string]$AgentName,
        [int]   $MetricCount
    )

    $now = (Get-Date).ToUniversalTime().ToString("o")

    $messages = 1..$MetricCount | ForEach-Object {
        $metricNames = @("temperature","humidity","pressure","vibration","current","voltage","co2","flow","rpm","power")
        $metricName  = $metricNames[($_ - 1) % $metricNames.Length]
        $baseValues  = @{ temperature=23.0; humidity=45.0; pressure=101.3; vibration=5.0;
                          current=2.5;     voltage=230.0; co2=400.0;       flow=12.5; rpm=1450.0; power=575.0 }
        $base  = $baseValues[$metricName]
        $value = [math]::Round($base + (Get-Random -Minimum -5 -Maximum 5) * 0.1 * $base / 100, 4)
        @{
            metric    = $metricName
            value     = $value
            unit      = @{ temperature="C"; humidity="%"; pressure="kPa"; vibration="mm/s";
                           current="A";    voltage="V";  co2="ppm";       flow="L/min"; rpm="RPM"; power="W" }[$metricName]
            quality   = "good"
            timestamp = $now
            protocol  = "mqtt"
        }
    }

    return @{
        deviceUuid = $AgentUuid
        deviceName = $AgentName
        timestamp  = $now
        data       = @{
            protocol   = "mqtt"
            readings   = $messages
            deviceName = $AgentName
            deviceUuid = $AgentUuid
        }
    }
}

function Get-JwtToken {
    param([string]$Url, [string]$User, [string]$Pass)
    try {
        $body = @{ username = $User; password = $Pass } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -Uri "$Url/api/v1/auth/login" `
            -Method Post -ContentType "application/json" -Body $body -TimeoutSec 10 -ErrorAction Stop
        # Response shape: { data: { accessToken, refreshToken, user } }
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
        $response = Invoke-RestMethod -Uri "$Url/api/v1/metrics/ingestion-health" `
            -Headers $headers -TimeoutSec 5 -ErrorAction Stop
        return $response
    } catch {
        return $null
    }
}

function Write-HealthRow {
    param($h, [int]$Injected, [int]$Total, [double]$ElapsedSec)
    if (-not $h) {
        Write-Host "  [health poll failed]" -ForegroundColor DarkGray
        return
    }

    $rate = if ($ElapsedSec -gt 0) { [int]($Injected / $ElapsedSec) } else { 0 }

    $streamLen = $h.streamLength ?? $h.data.streamLength ?? "?"
    $workers   = $h.workerCount ?? $h.data.workerCount ?? "?"
    $lag       = $h.workerLag   ?? $h.data.workerLag   ?? "?"
    $processed = $h.messagesProcessed ?? $h.data.messagesProcessed ?? "?"
    $inserted  = $h.readingsInserted  ?? $h.data.readingsInserted  ?? "?"
    $dropped   = $h.messagesDropped   ?? $h.data.messagesDropped   ?? "?"
    $dwellP95  = $h.dwellP95Ms ?? $h.data.dwellP95Ms ?? "?"
    $batchP95  = $h.batchLatP95Ms ?? $h.data.batchLatP95Ms ?? "?"

    $droppedColor = if ($dropped -gt 0) { "Red" } else { "Green" }
    $lagColor     = if ($lag -gt 5000) { "Yellow" } elseif ($lag -gt 20000) { "Red" } else { "Cyan" }

    Write-Host ("{0,8} | {1,6}/{2} msg/s | stream={3,5}  lag=" -f `
        (Get-Date -Format "HH:mm:ss"), $Injected, $total, $streamLen) -NoNewline
    Write-Host ("{0,6}ms" -f $lag) -ForegroundColor $lagColor -NoNewline
    Write-Host ("  workers={0,2}  processed={1,6}  inserted={2,7}  dropped=" -f `
        $workers, $processed, $inserted) -NoNewline
    Write-Host ("{0,4}" -f $dropped) -ForegroundColor $droppedColor -NoNewline
    Write-Host ("  dwellP95={0}ms  batchP95={1}ms" -f $dwellP95, $batchP95)
}

# ─── Setup ────────────────────────────────────────────────────────────────────

# Load .env for REDIS_PASSWORD / credentials if not already set
$envFile = Join-Path $PSScriptRoot ".." ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^[^#].*=.*' } | ForEach-Object {
        $parts = $_ -split '=', 2
        if ($parts.Length -eq 2 -and -not (Get-Item "Env:$($parts[0].Trim())" -ErrorAction SilentlyContinue)) {
            Set-Item "Env:$($parts[0].Trim())" $parts[1].Trim()
        }
    }
}

if (-not $env:REDIS_PASSWORD) {
    Write-Warning "REDIS_PASSWORD not set. Attempting unauthenticated connection."
    $env:REDIS_PASSWORD = ""
}

# Resolve credentials: param > env var > default (only needed if no JwtToken provided)
if (-not $Username) { $Username = if ($env:LOAD_TEST_USERNAME) { $env:LOAD_TEST_USERNAME } else { "admin" } }
if (-not $Password) { $Password = if ($env:LOAD_TEST_PASSWORD) { $env:LOAD_TEST_PASSWORD } else { "admin123" } }

# Resolve agent UUIDs: fetch real agent UUIDs from DB, fall back to synthetic
$dbUuids = @()
try {
    $rawUuids = docker exec iotistic-postgres psql -U postgres -d iotistica -t -c `
        "SELECT uuid FROM agents ORDER BY random() LIMIT $AgentCount;" 2>&1
    $dbUuids = $rawUuids | Where-Object { $_.Trim() -match '^[0-9a-f-]{36}$' } | ForEach-Object { $_.Trim() }
} catch {}

if ($dbUuids.Count -gt 0) {
    # Cycle real UUIDs to fill AgentCount slots
    $agentUuids = 1..$AgentCount | ForEach-Object { $dbUuids[($_ - 1) % $dbUuids.Count] }
    Write-Host "Using $($dbUuids.Count) real agent UUIDs from DB (cycling to $AgentCount slots)" -ForegroundColor DarkGray
} else {
    $agentUuids = 1..$AgentCount | ForEach-Object { "00000000-0000-4000-a000-{0:X12}" -f $_ }
    Write-Warning "Could not fetch agent UUIDs from DB — using synthetic UUIDs (readings may not land if FK constraint exists)"
}

Write-Host ""
Write-Host "=== Iotistica Seam-3 Ingestion Load Test ===" -ForegroundColor Cyan
Write-Host "  Messages    : $MessageCount"
Write-Host "  Agents      : $AgentCount"
Write-Host "  Metrics/msg : $MetricsPerMessage  ($(($MetricsPerMessage * $MessageCount)) total readings)"
Write-Host "  Rate target : $(if ($RatePerSecond -gt 0) { "$RatePerSecond msg/s" } else { "max speed" })"
$healthPollDesc = if ($JwtToken) { "enabled (token provided)" }
                  elseif ($Username) { "will try local auth for $Username" }
                  else { "disabled (no token)" }
Write-Host "  Health poll : every ${PollIntervalSec}s — $healthPollDesc"
Write-Host ""

# Acquire JWT token (skip if already provided)
if ($JwtToken) {
    Write-Host "Using provided JWT token for health polling." -ForegroundColor Green
} else {
    Write-Host "Acquiring JWT token for '$Username'..." -NoNewline
    try {
        $JwtToken = Get-JwtToken -Url $ApiUrl -User $Username -Pass $Password
        Write-Host " OK" -ForegroundColor Green
    } catch {
        Write-Host " FAILED" -ForegroundColor DarkYellow
        Write-Warning "$_"
        Write-Warning "Health polling will be skipped. For Auth0 environments, pass -JwtToken `"<token>`" (copy from browser DevTools)."
        $JwtToken = ""
    }
}

# Discover or use provided stream key
if ($StreamKey) {
    Write-Host "Using stream key: $StreamKey" -ForegroundColor Green
} else {
    Write-Host "Discovering ingestion stream key..." -NoNewline
    $StreamKey = Get-StreamKey
    Write-Host " $StreamKey" -ForegroundColor Green
}

# Baseline stream length before inject (informational only)
$startStreamLen = Get-StreamLength $StreamKey
Write-Host "Stream length before test: $startStreamLen"
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
# Batch via Lua EVAL: N XADD calls per docker exec instead of 1.
# JSON values are passed as ARGV[1..N] — no shell escaping needed (PowerShell
# splatting passes them as raw process args, not through a shell interpreter).
$batchSize   = 25  # stay safely under any command-line length limits
$luaScript   = "for i=1,#ARGV do redis.call('XADD',KEYS[1],'MAXLEN','~','50000','*','data',ARGV[i]) end return #ARGV"
$stopwatch   = [System.Diagnostics.Stopwatch]::StartNew()
$lastPollAt  = 0
$delayMs     = if ($RatePerSecond -gt 0) { [int](1000 / $RatePerSecond) } else { 0 }
$injected    = 0
$batchJsons  = [System.Collections.Generic.List[string]]::new()

function Flush-Batch {
    if ($batchJsons.Count -eq 0) { return }
    $cmdArgs = @("EVAL", $luaScript, "1", $StreamKey) + $batchJsons.ToArray()
    Invoke-Redis $cmdArgs | Out-Null
    $batchJsons.Clear()
}

for ($i = 0; $i -lt $MessageCount; $i++) {
    $uuid  = $agentUuids[$i % $AgentCount]
    $name  = "agent-" + $uuid.Substring(0, 8)
    $entry = Build-AgentDataEntry -AgentUuid $uuid -AgentName $name -MetricCount $MetricsPerMessage
    $json  = $entry | ConvertTo-Json -Depth 10 -Compress

    $batchJsons.Add($json)
    $injected++

    # Flush when batch is full
    if ($batchJsons.Count -ge $batchSize) {
        Flush-Batch
    }

    # Rate limiting (applies per-message even with batching)
    if ($delayMs -gt 0) {
        Start-Sleep -Milliseconds $delayMs
    }

    # Health poll
    if ($JwtToken) {
        $elapsedSec = $stopwatch.Elapsed.TotalSeconds
        if (($elapsedSec - $lastPollAt) -ge $PollIntervalSec) {
            $health = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
            Write-HealthRow -h $health -Injected $injected -Total $MessageCount -ElapsedSec $elapsedSec
            $lastPollAt = $elapsedSec
        }
    }
}

Flush-Batch  # flush any remaining

$stopwatch.Stop()
$totalSec    = $stopwatch.Elapsed.TotalSeconds
$actualRate  = [math]::Round($MessageCount / $totalSec, 1)
$totalReadings = $MessageCount * $MetricsPerMessage

Write-Host ""
Write-Host "=== Injection complete ===" -ForegroundColor Cyan
Write-Host ("  Injected : {0} messages ({1} readings) in {2:F2}s = {3} msg/s actual" -f `
    $MessageCount, $totalReadings, $totalSec, $actualRate)

# ─── Drain wait ───────────────────────────────────────────────────────────────
# Uses consumer-group lag + pending to detect completion.
# Redis Streams: XACK does NOT remove entries (XLEN never drops after ACK), so
# lag=0 is the correct signal that all injected messages have been delivered and
# pending=0 confirms they have been ACKed (i.e. DB write succeeded).
Write-Host ""
Write-Host "Waiting for worker to drain stream (lag=0, pending=0)..." -ForegroundColor Yellow
$drainTimeout = [System.Diagnostics.Stopwatch]::StartNew()

while ($drainTimeout.Elapsed.TotalSeconds -lt 120) {
    Start-Sleep -Seconds $PollIntervalSec
    $cgState    = Get-ConsumerLag $StreamKey
    $currentLen = Get-StreamLength $StreamKey

    if ($JwtToken) {
        $health = Get-IngestionHealth -Url $ApiUrl -Token $JwtToken
        Write-HealthRow -h $health -Injected $injected -Total $MessageCount `
            -ElapsedSec ($totalSec + $drainTimeout.Elapsed.TotalSeconds)
    } else {
        Write-Host ("  [{0:HH:mm:ss}] stream={1}  lag={2}  pending={3}" -f `
            (Get-Date), $currentLen, $cgState.lag, $cgState.pending)
    }

    # Done when all injected messages have been delivered (lag=0) and ACKed (pending=0)
    if ($cgState.lag -eq 0 -and $cgState.pending -eq 0) {
        Write-Host ""
        Write-Host "Worker caught up (lag=0, pending=0)." -ForegroundColor Green
        break
    }
}

# ─── Final summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Final Stats ===" -ForegroundColor Cyan
$finalCgState = Get-ConsumerLag $StreamKey
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

# Check for DLQ entries regardless of health endpoint
$dlqKey = $StreamKey -replace ":ingestion$", ":dlq"
$dlqKeys = Invoke-Redis @("KEYS", "*:agent:devices:dlq*")
if ($dlqKeys -and $dlqKeys -ne "(empty array)") {
    $dlqLen = Invoke-Redis @("XLEN", ($dlqKeys -split "`n")[0].Trim())
    if ([int]$dlqLen -gt 0) {
        Write-Host ""
        Write-Host "  WARNING: $dlqLen messages landed in the DLQ!" -ForegroundColor Red
        Write-Host "  Inspect with: docker exec iotistic-redis redis-cli XRANGE $dlqKey - + COUNT 5" -ForegroundColor Yellow
    }
}

Write-Host ""
