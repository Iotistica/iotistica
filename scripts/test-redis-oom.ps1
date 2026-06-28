param(
    [ValidateSet('start', 'status', 'restore')]
    [string]$Mode = 'start',

    [string]$RedisContainer = 'iotistic-redis',
    [string]$ApiContainer = 'iotistic-api',

    [int]$OomMaxMemoryMb = 32,
    [int]$NormalMaxMemoryMb = 512,
    [int]$FillKeys = 400,
    [int]$PayloadBytes = 65536,
    [int]$ApiLogSinceMinutes = 5,

    [switch]$ShowApiLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Section {
    param([string]$Title)

    Write-Host ''
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * $Title.Length) -ForegroundColor Cyan
}

function Test-DockerContainer {
    param([string]$ContainerName)

    docker inspect $ContainerName *> $null
    return $LASTEXITCODE -eq 0
}

function Invoke-RedisCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & docker exec $RedisContainer redis-cli @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "redis-cli failed: $($output | Out-String)"
    }

    return ($output | Out-String).Trim()
}

function Get-RedisMemorySummary {
    $info = Invoke-RedisCli -Arguments @('INFO', 'memory')
    $lines = $info -split "`r?`n"
    $wanted = @('used_memory:', 'used_memory_human:', 'maxmemory:', 'maxmemory_human:', 'maxmemory_policy:')

    return $lines | Where-Object {
        $line = $_
        $wanted | Where-Object { $line.StartsWith($_) }
    }
}

function Write-RedisStatus {
    Write-Section 'Redis Status'
    Get-RedisMemorySummary | ForEach-Object { Write-Host $_ -ForegroundColor White }

    $dbSize = Invoke-RedisCli -Arguments @('DBSIZE')
    Write-Host "dbsize:$dbSize" -ForegroundColor White
}

function Remove-OomTestKeys {
    Write-Section 'Removing Existing OOM Test Keys'

    $scanOutput = (& docker exec $RedisContainer redis-cli --scan --pattern 'oom:test:*' 2>&1 | Out-String).Trim()
    $keys = @()

    if ($scanOutput) {
        $keys = @($scanOutput -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*$' })
    }

    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to scan existing oom:test:* keys.'
    }

    if ($keys.Count -eq 0) {
        Write-Host 'No existing oom:test:* keys found.' -ForegroundColor DarkGray
        return
    }

    foreach ($key in $keys) {
        Invoke-RedisCli -Arguments @('DEL', $key) *> $null
    }

    Write-Host "Removed $($keys.Count) existing oom:test:* keys." -ForegroundColor Green
}

function Set-RedisMemoryProfile {
    param(
        [int]$MaxMemoryMb,
        [string]$Policy = 'noeviction'
    )

    Write-Section "Setting Redis maxmemory to ${MaxMemoryMb}mb"
    Invoke-RedisCli -Arguments @('CONFIG', 'SET', 'maxmemory', "${MaxMemoryMb}mb") *> $null
    Invoke-RedisCli -Arguments @('CONFIG', 'SET', 'maxmemory-policy', $Policy) *> $null
    Write-Host "Applied runtime Redis settings: maxmemory=${MaxMemoryMb}mb, policy=$Policy" -ForegroundColor Green
}

function Invoke-OomFill {
    param(
        [int]$KeyCount,
        [int]$BytesPerKey
    )

    Write-Section 'Filling Redis Until OOM Pressure'
    $payload = 'x' * $BytesPerKey
    $successfulWrites = 0
    $firstOomAt = $null

    for ($i = 1; $i -le $KeyCount; $i++) {
        $result = $payload | & docker exec -i $RedisContainer redis-cli -x SET "oom:test:$i" 2>&1
        $resultText = ($result | Out-String).Trim()

        if ($LASTEXITCODE -ne 0 -or $resultText -match 'OOM') {
            $firstOomAt = $i
            Write-Host "OOM reached at write $i" -ForegroundColor Yellow
            Write-Host $resultText -ForegroundColor Yellow
            break
        }

        $successfulWrites += 1

        if (($i % 25) -eq 0) {
            Write-Host "Wrote $i test keys..." -ForegroundColor DarkGray
        }
    }

    if ($null -eq $firstOomAt) {
        Write-Host "Completed $successfulWrites writes without a direct OOM response." -ForegroundColor Green
    } else {
        Write-Host "Successful writes before first OOM: $successfulWrites" -ForegroundColor White
    }
}

function Show-RecentApiLogs {
    param([int]$SinceMinutes)

    Write-Section "Recent API Logs (${SinceMinutes}m)"
    $logs = & docker logs --since "${SinceMinutes}m" $ApiContainer 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read API logs for container $ApiContainer"
    }

    $logText = ($logs | Out-String).Trim()
    if (-not $logText) {
        Write-Host 'No API logs in requested time window.' -ForegroundColor DarkGray
        return
    }

    Write-Host $logText
}

if (-not (Test-DockerContainer -ContainerName $RedisContainer)) {
    throw "Redis container '$RedisContainer' was not found."
}

if ($ShowApiLogs -and -not (Test-DockerContainer -ContainerName $ApiContainer)) {
    throw "API container '$ApiContainer' was not found."
}

switch ($Mode) {
    'status' {
        Write-RedisStatus
        if ($ShowApiLogs) {
            Show-RecentApiLogs -SinceMinutes $ApiLogSinceMinutes
        }
    }

    'restore' {
        Remove-OomTestKeys
        Set-RedisMemoryProfile -MaxMemoryMb $NormalMaxMemoryMb
        Write-RedisStatus
        if ($ShowApiLogs) {
            Show-RecentApiLogs -SinceMinutes $ApiLogSinceMinutes
        }
    }

    'start' {
        Remove-OomTestKeys
        Set-RedisMemoryProfile -MaxMemoryMb $OomMaxMemoryMb
        Write-RedisStatus
        Invoke-OomFill -KeyCount $FillKeys -BytesPerKey $PayloadBytes
        Write-RedisStatus

        if ($ShowApiLogs) {
            Show-RecentApiLogs -SinceMinutes $ApiLogSinceMinutes
        } else {
            Write-Host ''
            Write-Host 'Use -ShowApiLogs to print recent API logs after the OOM fill.' -ForegroundColor DarkGray
        }
    }
}