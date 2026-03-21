param(
    [string]$ImageName = "iotistic-agent-systemd-ci",
    [string]$ContainerName = "iotistic-agent-systemd-ci",
    [int]$DeviceApiPort = 48484,
    [switch]$KeepContainer,
    [ValidateSet('working-tree', 'generated')]
    [string]$InstallerMode = 'working-tree',
    [string]$AgentVersion = 'local',
    [string]$ApiUrl = "https://localhost:3443",
    [string]$CloudApiEndpoint = "https://api:3443",
    [string]$FleetUuid = "9dba5910-040d-4544-862e-32d47dc18290",
    [bool]$UseDirectDb = $true,
    [string]$DbHost = "localhost",
    [int]$DbPort = 5432,
    [string]$DbName = "iotistic",
    [string]$DbUser = "postgres",
    [string]$DbPassword = "postgres",
    [string]$DbSslMode = "",
    [string]$DatabaseUrl = "",
    [string]$ProvisioningKey = "",
    [switch]$GenerateProvisioningKey,
    [switch]$ShowProvisioningKey
)

$ErrorActionPreference = 'Stop'

# Avoid terminating on non-zero exit from native commands we explicitly handle.
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempDir = Join-Path $env:TEMP ("iotistic-systemd-" + [guid]::NewGuid().ToString('N'))

function Get-AgentPackageVersion {
    $packageJsonPath = Join-Path $repoRoot 'agent/package.json'
    if (-not (Test-Path $packageJsonPath)) {
        throw "Agent package.json not found at $packageJsonPath"
    }

    $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($packageJson.version)) {
        throw "agent/package.json does not contain a version"
    }

    return [string]$packageJson.version
}

function New-ProvisioningKeyDirect {
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

    if (-not $UseDirectDb) {
        throw "UseDirectDb is disabled. Enable -UseDirectDb to generate keys directly in the database."
    }

    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
        throw "psql is required for direct provisioning. Install PostgreSQL client tools or add psql to PATH."
    }

    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

    $previousPassword = $env:PGPASSWORD
    $env:PGPASSWORD = $DbPassword

    try {
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
            throw "Failed to prepare provisioning_keys schema: $schemaResult"
        }

        $hasKeyHashFast = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='key_hash_fast'" 2>&1
        $hasFleetUuid = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_uuid'" 2>&1
        $hasFleetId = psql -d "$connectionString" -t -A -q -c "SELECT 1 FROM information_schema.columns WHERE table_name='provisioning_keys' AND column_name='fleet_id'" 2>&1

        $escapedKey = $key -replace "'", "''"
        $escapedDescription = "Script-generated systemd-docker provisioning key" -replace "'", "''"
        $escapedCreatedBy = "run-agent-systemd-ci-docker" -replace "'", "''"
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
                $values += 'NULL'
            }
            else {
                $values += "'$escapedFleetUuid'::uuid"
            }
        }
        if ($hasFleetId -match '1') {
            $columns += 'fleet_id'
            if ([string]::IsNullOrWhiteSpace($escapedFleetUuid)) {
                $values += 'NULL'
            }
            else {
                $values += "'$escapedFleetUuid'"
            }
        }

        $insertSql = "INSERT INTO provisioning_keys ($($columns -join ', ')) VALUES ($($values -join ', ')) RETURNING id;"
        $insertResult = psql -d "$connectionString" -v ON_ERROR_STOP=1 -t -A -q -c $insertSql 2>&1

        if ($LASTEXITCODE -ne 0) {
            throw "Failed to insert provisioning key: $insertResult"
        }

        return $key
    }
    catch {
        throw "Failed to generate provisioning key via API/database path. Make sure the API/database is reachable at $ApiUrl. $($_.Exception.Message)"
    }
    finally {
        if ($null -eq $previousPassword) {
            Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        }
        else {
            $env:PGPASSWORD = $previousPassword
        }
    }
}

if ([string]::IsNullOrWhiteSpace($ProvisioningKey) -and $GenerateProvisioningKey) {
    Write-Host "Generating live provisioning key..."
    $ProvisioningKey = New-ProvisioningKeyDirect `
        -ApiUrl $ApiUrl `
        -FleetUuid $FleetUuid `
        -UseDirectDb $UseDirectDb `
        -DbHost $DbHost `
        -DbPort $DbPort `
        -DbName $DbName `
        -DbUser $DbUser `
        -DbPassword $DbPassword `
        -DbSslMode $DbSslMode `
        -DatabaseUrl $DatabaseUrl

    if ($ShowProvisioningKey) {
        Write-Host "Provisioning key: $ProvisioningKey"
    }
    else {
        Write-Host "Provisioning key generated successfully. Use -ShowProvisioningKey to print it."
    }
}

$effectiveCloudApiEndpoint = if ([string]::IsNullOrWhiteSpace($CloudApiEndpoint)) { $ApiUrl } else { $CloudApiEndpoint }

New-Item -ItemType Directory -Path $tempDir | Out-Null

$resolvedAgentVersion = if ($InstallerMode -eq 'generated' -and $AgentVersion -eq 'local') {
    Get-AgentPackageVersion
}
else {
    $AgentVersion
}

$installScriptHostPath = Join-Path $repoRoot 'agent/bin/install.sh'
$installScriptContainerPath = '/workspace/agent/bin/install.sh'
$installScriptBootstrap = ''

if ($InstallerMode -eq 'generated') {
    $installScriptSource = Get-Content -Path $installScriptHostPath -Raw
    $generatedInstallScriptHostPath = Join-Path $tempDir 'install.generated.sh'
    $installScriptSource = $installScriptSource.Replace('AGENT_VERSION_PLACEHOLDER', $resolvedAgentVersion)
    Set-Content -Path $generatedInstallScriptHostPath -Value $installScriptSource -NoNewline
    $installScriptContainerPath = '/workspace/agent/bin/install.generated.sh'
    $installScriptBootstrap = "cp /installer/install.generated.sh $installScriptContainerPath && "
}

$dockerfile = @"
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus sudo curl ca-certificates gnupg \
    iproute2 iptables net-tools iputils-ping procps jq sqlite3 git \
    build-essential python3 make g++ xz-utils docker.io && \
    rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
"@

Set-Content -Path (Join-Path $tempDir 'Dockerfile') -Value $dockerfile -NoNewline

try {
    Write-Host "Building temporary systemd test image..."
    docker build -t $ImageName $tempDir

    Write-Host "Removing any previous test container..."
    $existingContainerId = (docker ps -aq -f "name=^/${ContainerName}$" | Select-Object -First 1)
    if ($existingContainerId) {
        docker rm -f $ContainerName *> $null
    }

    Write-Host "Starting privileged systemd container..."
    docker run --privileged --cgroupns=host -d `
        --name $ContainerName `
        --tmpfs /tmp `
        --tmpfs /run `
        --tmpfs /run/lock `
        -v /sys/fs/cgroup:/sys/fs/cgroup:rw `
        -v /var/run/docker.sock:/var/run/docker.sock `
        -v "${repoRoot}:/workspace" `
        -v "${tempDir}:/installer" `
        -w /workspace `
        $ImageName /sbin/init | Out-Null

    Start-Sleep -Seconds 5

    Write-Host "Creating stub docker.service backed by the host Docker socket..."
    docker exec $ContainerName bash -lc @'
cat >/etc/systemd/system/docker.service <<'EOF'
[Unit]
Description=Stub Docker service for CI reproduction

[Service]
Type=oneshot
ExecStart=/bin/true
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable docker >/dev/null 2>&1 || true
systemctl start docker
'@

    Write-Host "Running install.sh in CI systemd mode..."
    Write-Host "  Installer mode: $InstallerMode"
    Write-Host "  Agent version: $resolvedAgentVersion"
    Write-Host "  Cloud API endpoint: $effectiveCloudApiEndpoint"
    Write-Host "  Provisioning: $(if ([string]::IsNullOrWhiteSpace($ProvisioningKey)) { 'local mode (no key)' } else { 'live provisioning key present' })"
    docker exec `
        -e CI=true `
        -e IOTISTIC_INSTALL_METHOD=systemd `
        -e IOTISTIC_AGENT_VERSION=$resolvedAgentVersion `
        -e IOTISTIC_DEVICE_PORT=$DeviceApiPort `
        -e IOTISTICA_API=$effectiveCloudApiEndpoint `
        -e PROVISIONING_KEY=$ProvisioningKey `
        $ContainerName bash -lc "cd /workspace && ${installScriptBootstrap}chmod +x $installScriptContainerPath && $installScriptContainerPath"

    $installExitCode = $LASTEXITCODE

    Write-Host ""
    Write-Host "Systemd status:"
    docker exec $ContainerName bash -lc 'systemctl status iotistic-agent --no-pager -l || true'

    Write-Host ""
    Write-Host "Agent journal:"
    docker exec $ContainerName bash -lc 'journalctl -u iotistic-agent -n 200 --no-pager || true'

    Write-Host ""
    Write-Host "Agent init phase logs:"
    docker exec $ContainerName bash -lc "journalctl -u iotistic-agent --no-pager | grep '\[INIT\]' || true"

    Write-Host ""
    Write-Host "Persisted agent environment:"
    docker exec $ContainerName bash -lc "if [ -f /etc/iotistic/agent.env ]; then sed 's/^PROVISIONING_KEY=.*/PROVISIONING_KEY=<redacted>/' /etc/iotistic/agent.env; else echo '/etc/iotistic/agent.env not created'; fi"

    if ($installExitCode -ne 0) {
        throw "install.sh failed with exit code $installExitCode"
    }
}
finally {
    if (-not $KeepContainer) {
        $existingContainerId = (docker ps -aq -f "name=^/${ContainerName}$" | Select-Object -First 1)
        if ($existingContainerId) {
            docker rm -f $ContainerName *> $null
        }
    }

    if (Test-Path $tempDir) {
        Remove-Item -Recurse -Force $tempDir
    }
}