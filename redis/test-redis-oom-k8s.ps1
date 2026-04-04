param(
    [ValidateSet('start', 'status', 'restore')]
    [string]$Mode = 'start',

    [string]$Namespace = 'demo',
    [string]$RedisDeployment = '',
    [string]$ApiDeployment = '',
    [string]$RedisPassword = '',
    [string]$RedisSecretName = '',

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

function Test-KubectlAvailable {
    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
        throw 'kubectl is required but was not found in PATH.'
    }
}

function Get-FirstDeploymentName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$Selector
    )

    $name = (& kubectl get deployment -n $Namespace -l $Selector -o jsonpath='{.items[0].metadata.name}' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($name)) {
        throw "Failed to resolve deployment in namespace '$Namespace' with selector '$Selector'."
    }

    return $name
}

function Get-RedisPasswordFromSecret {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [string]$SecretName
    )

    $targetSecret = $SecretName
    if ([string]::IsNullOrWhiteSpace($targetSecret)) {
        $targetSecret = (& kubectl get secret -n $Namespace -l app.kubernetes.io/component=redis -o jsonpath='{.items[0].metadata.name}' 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            return ''
        }
    }

    if ([string]::IsNullOrWhiteSpace($targetSecret)) {
        return ''
    }

    $encoded = (& kubectl get secret $targetSecret -n $Namespace -o jsonpath='{.data.password}' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($encoded)) {
        return ''
    }

    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
}

function Invoke-RedisCli {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [string]$RedisPassword
    )

    $commandArgs = @('exec', '-n', $Namespace, "deployment/$RedisDeployment", '--', 'redis-cli')
    if (-not [string]::IsNullOrWhiteSpace($RedisPassword)) {
        $commandArgs += @('--no-auth-warning', '-a', $RedisPassword)
    }
    $commandArgs += $Arguments

    $output = & kubectl @commandArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "redis-cli failed: $($output | Out-String)"
    }

    return ($output | Out-String).Trim()
}

function Get-RedisMemorySummary {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [string]$RedisPassword
    )

    $info = Invoke-RedisCli -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword -Arguments @('INFO', 'memory')
    $lines = $info -split "`r?`n"
    $wanted = @('used_memory:', 'used_memory_human:', 'maxmemory:', 'maxmemory_human:', 'maxmemory_policy:')

    return $lines | Where-Object {
        $line = $_
        $wanted | Where-Object { $line.StartsWith($_) }
    }
}

function Write-RedisStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [string]$RedisPassword
    )

    Write-Section 'Redis Status'
    Get-RedisMemorySummary -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword | ForEach-Object {
        Write-Host $_ -ForegroundColor White
    }

    $dbSize = Invoke-RedisCli -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword -Arguments @('DBSIZE')
    Write-Host "dbsize:$dbSize" -ForegroundColor White
}

function Remove-OomTestKeys {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [string]$RedisPassword
    )

    Write-Section 'Removing Existing OOM Test Keys'

    $deleteScript = @"
local cursor = '0'
local deleted = 0
repeat
  local result = redis.call('SCAN', cursor, 'MATCH', ARGV[1], 'COUNT', ARGV[2])
  cursor = result[1]
  local keys = result[2]
  if #keys > 0 then
    deleted = deleted + redis.call('DEL', unpack(keys))
  end
until cursor == '0'
return deleted
"@

    $deletedCount = Invoke-RedisCli -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword -Arguments @(
        'EVAL',
        $deleteScript,
        '0',
        'oom:test:*',
        '200'
    )

    if ([string]::IsNullOrWhiteSpace($deletedCount) -or $deletedCount -eq '0') {
        Write-Host 'No existing oom:test:* keys found.' -ForegroundColor DarkGray
        return
    }

    Write-Host "Removed $deletedCount existing oom:test:* keys." -ForegroundColor Green
}

function Set-RedisMemoryProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [int]$MaxMemoryMb,
        [string]$Policy = 'noeviction',
        [string]$RedisPassword
    )

    Write-Section "Setting Redis maxmemory to ${MaxMemoryMb}mb"
    Invoke-RedisCli -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword -Arguments @('CONFIG', 'SET', 'maxmemory', "${MaxMemoryMb}mb") *> $null
    Invoke-RedisCli -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword -Arguments @('CONFIG', 'SET', 'maxmemory-policy', $Policy) *> $null
    Write-Host "Applied runtime Redis settings: maxmemory=${MaxMemoryMb}mb, policy=$Policy" -ForegroundColor Green
}

function Invoke-OomFill {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$RedisDeployment,
        [int]$KeyCount,
        [int]$BytesPerKey,
        [string]$RedisPassword
    )

    Write-Section 'Filling Redis Until OOM Pressure'
    $payload = 'x' * $BytesPerKey
    $successfulWrites = 0
    $firstOomAt = $null

    for ($i = 1; $i -le $KeyCount; $i++) {
        $kubectlArgs = @('exec', '-i', '-n', $Namespace, "deployment/$RedisDeployment", '--', 'redis-cli')
        if (-not [string]::IsNullOrWhiteSpace($RedisPassword)) {
            $kubectlArgs += @('--no-auth-warning', '-a', $RedisPassword)
        }
        $kubectlArgs += @('-x', 'SET', "oom:test:$i")

        $result = $payload | & kubectl @kubectlArgs 2>&1
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
    param(
        [Parameter(Mandatory = $true)]
        [string]$Namespace,
        [Parameter(Mandatory = $true)]
        [string]$ApiDeployment,
        [int]$SinceMinutes
    )

    Write-Section "Recent API Logs (${SinceMinutes}m)"
    $logs = & kubectl logs -n $Namespace "deployment/$ApiDeployment" --since "${SinceMinutes}m" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read API logs for deployment $ApiDeployment"
    }

    $logText = ($logs | Out-String).Trim()
    if (-not $logText) {
        Write-Host 'No API logs in requested time window.' -ForegroundColor DarkGray
        return
    }

    Write-Host $logText
}

Test-KubectlAvailable

if ([string]::IsNullOrWhiteSpace($RedisDeployment)) {
    $RedisDeployment = Get-FirstDeploymentName -Namespace $Namespace -Selector 'app.kubernetes.io/component=redis'
}

if ($ShowApiLogs -and [string]::IsNullOrWhiteSpace($ApiDeployment)) {
    $ApiDeployment = Get-FirstDeploymentName -Namespace $Namespace -Selector 'app.kubernetes.io/component=api'
}

if ([string]::IsNullOrWhiteSpace($RedisPassword)) {
    $RedisPassword = Get-RedisPasswordFromSecret -Namespace $Namespace -SecretName $RedisSecretName
}

Write-Host "Using namespace: $Namespace" -ForegroundColor Gray
Write-Host "Redis deployment: $RedisDeployment" -ForegroundColor Gray
if ($ShowApiLogs) {
    Write-Host "API deployment: $ApiDeployment" -ForegroundColor Gray
}
if ([string]::IsNullOrWhiteSpace($RedisPassword)) {
    Write-Host 'Redis auth: disabled or secret not found' -ForegroundColor Gray
} else {
    Write-Host 'Redis auth: enabled' -ForegroundColor Gray
}

switch ($Mode) {
    'status' {
        Write-RedisStatus -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword
        if ($ShowApiLogs) {
            Show-RecentApiLogs -Namespace $Namespace -ApiDeployment $ApiDeployment -SinceMinutes $ApiLogSinceMinutes
        }
    }

    'restore' {
        Remove-OomTestKeys -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword
        Set-RedisMemoryProfile -Namespace $Namespace -RedisDeployment $RedisDeployment -MaxMemoryMb $NormalMaxMemoryMb -RedisPassword $RedisPassword
        Write-RedisStatus -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword
        if ($ShowApiLogs) {
            Show-RecentApiLogs -Namespace $Namespace -ApiDeployment $ApiDeployment -SinceMinutes $ApiLogSinceMinutes
        }
    }

    'start' {
        Remove-OomTestKeys -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword
        Set-RedisMemoryProfile -Namespace $Namespace -RedisDeployment $RedisDeployment -MaxMemoryMb $OomMaxMemoryMb -RedisPassword $RedisPassword
        Write-RedisStatus -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword
        Invoke-OomFill -Namespace $Namespace -RedisDeployment $RedisDeployment -KeyCount $FillKeys -BytesPerKey $PayloadBytes -RedisPassword $RedisPassword
        Write-RedisStatus -Namespace $Namespace -RedisDeployment $RedisDeployment -RedisPassword $RedisPassword

        if ($ShowApiLogs) {
            Show-RecentApiLogs -Namespace $Namespace -ApiDeployment $ApiDeployment -SinceMinutes $ApiLogSinceMinutes
        } else {
            Write-Host ''
            Write-Host 'Use -ShowApiLogs to print recent API logs after the OOM fill.' -ForegroundColor DarkGray
        }
    }
}