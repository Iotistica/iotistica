<#
.SYNOPSIS
    CPU-profile the ingestion service under MQTT load.

.DESCRIPTION
    1. Restarts ingestion with --cpu-prof enabled (via docker-compose.profile.yml overlay).
    2. Waits for the container health check to pass.
    3. Runs the MQTT load test for the specified duration at the specified rate.
    4. Stops ingestion cleanly (SIGTERM triggers the V8 CPU profile write).
    5. Copies the .cpuprofile file from the container to ./profiles/.
    6. Reopens ingestion at normal settings.
    7. Opens the profile in VS Code (built-in JavaScript Profile Viewer).

.PARAMETER RatePerSecond
    Target message rate for the load test (default: 300 msg/s).

.PARAMETER DurationSec
    How long to run the load test in seconds (default: 60).

.PARAMETER AgentCount
    Number of simulated agents (default: 20).

.PARAMETER BatchSize
    MQTT batch size per agent flush (default: 200).

.PARAMETER BatchTimeMs
    Max dwell time before forcing a batch flush, ms (default: 0 = immediate).

.PARAMETER SkipReopen
    Do not restart ingestion in normal mode after profiling. Useful when you want
    to inspect the container before bringing it back.

.EXAMPLE
    # 60-second burst at 300 msg/s, 20 agents
    .\scripts\profile-ingestion.ps1

.EXAMPLE
    # 2-minute ramp, 500 msg/s, 50 agents
    .\scripts\profile-ingestion.ps1 -DurationSec 120 -RatePerSecond 500 -AgentCount 50
#>
[CmdletBinding()]
param(
    [int]    $RatePerSecond = 300,
    [int]    $DurationSec   = 60,
    [int]    $AgentCount    = 20,
    [int]    $BatchSize     = 200,
    [int]    $BatchTimeMs   = 0,
    [switch] $SkipReopen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path $PSScriptRoot -Parent
$ProfileDir  = Join-Path $RepoRoot 'profiles'
$ComposeBase = Join-Path $RepoRoot 'docker-compose.yml'
$ComposeProf = Join-Path $RepoRoot 'docker-compose.profile.yml'
$LoadTest    = Join-Path $RepoRoot 'scripts\perfomance\load-test-mqtt.ps1'

$MessageCount = $RatePerSecond * $DurationSec

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

function Wait-Healthy([string]$Container, [int]$TimeoutSec = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline) {
        $status = docker inspect $Container --format '{{.State.Health.Status}}' 2>$null
        if ($status -eq 'healthy') { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Container $Container did not become healthy within ${TimeoutSec}s"
}

# ── Preflight ────────────────────────────────────────────────────────────────

Write-Step "Preflight"

if (-not (Test-Path $LoadTest)) {
    throw "Load test script not found: $LoadTest"
}

if (-not (Test-Path $ComposeProf)) {
    throw "Compose overlay not found: $ComposeProf"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Write-Host "  Profile output: $ProfileDir"
Write-Host "  Messages      : $MessageCount  ($RatePerSecond msg/s x ${DurationSec}s)"
Write-Host "  Agents        : $AgentCount"

# ── Start ingestion with profiling enabled ───────────────────────────────────

Write-Step "Starting ingestion with --cpu-prof"

Push-Location $RepoRoot
try {
    docker compose -f $ComposeBase -f $ComposeProf up -d ingestion 2>&1 | Write-Host
} finally {
    Pop-Location
}

Write-Step "Waiting for ingestion to be healthy..."
Wait-Healthy 'iotistic-ingestion' 60
Write-Host "  OK - ingestion is healthy"

# ── Run load test ─────────────────────────────────────────────────────────────

Write-Step "Running load test ($DurationSec s, $RatePerSecond msg/s)"

& $LoadTest `
    -MessageCount  $MessageCount `
    -AgentCount    $AgentCount `
    -RatePerSecond $RatePerSecond `
    -BatchSize     $BatchSize `
    -BatchTimeMs   $BatchTimeMs

# ── Stop ingestion cleanly (triggers .cpuprofile write) ──────────────────────

Write-Step "Stopping ingestion (triggers CPU profile write)"

# Use 30s timeout: gives Node's 10s graceful shutdown plenty of margin before
# Docker falls back to SIGKILL (which would prevent the profile from being written).
docker stop --time 30 iotistic-ingestion | Out-Null
Write-Host "  Container stopped."

# ── Copy profile file out ─────────────────────────────────────────────────────

Write-Step "Copying .cpuprofile from container"

# Copy the entire /tmp directory; filter for .cpuprofile files
$TmpDump = Join-Path $env:TEMP "ingestion-profile-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $TmpDump | Out-Null

docker cp "iotistic-ingestion:/tmp/." $TmpDump 2>&1 | Out-Null

$profiles = @(Get-ChildItem $TmpDump -Filter "*.cpuprofile")

if ($profiles.Count -eq 0) {
    Write-Warning "No .cpuprofile file found in container /tmp. Node may not have exited cleanly."
    Write-Host "  Check: docker logs iotistic-ingestion --tail 30"
} else {
    foreach ($pf in $profiles) {
        $dest = Join-Path $ProfileDir $pf.Name
        Copy-Item $pf.FullName $dest -Force
        Write-Host "  Saved: $dest" -ForegroundColor Green
    }

    # Open the most recent one in VS Code
    $latest = $profiles | Sort-Object LastWriteTime | Select-Object -Last 1
    $destLatest = Join-Path $ProfileDir $latest.Name
    Write-Host "  Opening $destLatest in VS Code..." -ForegroundColor Green
    code $destLatest
}

# ── Reopen ingestion at normal settings ──────────────────────────────────────

if (-not $SkipReopen) {
    Write-Step "Restarting ingestion (normal mode)"
    Push-Location $RepoRoot
    try {
        docker compose up -d ingestion 2>&1 | Write-Host
    } finally {
        Pop-Location
    }
    Write-Host "  Ingestion restarted without profiling." -ForegroundColor Green
}

Write-Step "Done"
Write-Host "  Profile files in: $ProfileDir"
Write-Host "  View in VS Code : code <file>.cpuprofile"
Write-Host "  Or open Chrome DevTools -> Performance -> Load profile"
