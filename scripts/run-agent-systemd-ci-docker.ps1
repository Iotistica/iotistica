param(
    [string]$ImageName = "iotistic-agent-systemd-ci",
    [string]$ContainerName = "iotistic-agent-systemd-ci",
    [int]$DeviceApiPort = 48484,
    [switch]$KeepContainer
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempDir = Join-Path $env:TEMP ("iotistic-systemd-" + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $tempDir | Out-Null

$dockerfile = @"
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus sudo curl ca-certificates gnupg \
    iproute2 iptables net-tools iputils-ping procps jq sqlite3 git \
    build-essential python3 make g++ xz-utils && \
    rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
"@

Set-Content -Path (Join-Path $tempDir 'Dockerfile') -Value $dockerfile -NoNewline

try {
    Write-Host "Building temporary systemd test image..."
    docker build -t $ImageName $tempDir

    Write-Host "Removing any previous test container..."
    docker rm -f $ContainerName 2>$null | Out-Null

    Write-Host "Starting privileged systemd container..."
    docker run --privileged --cgroupns=host -d `
        --name $ContainerName `
        --tmpfs /tmp `
        --tmpfs /run `
        --tmpfs /run/lock `
        -v /sys/fs/cgroup:/sys/fs/cgroup:rw `
        -v /var/run/docker.sock:/var/run/docker.sock `
        -v "${repoRoot}:/workspace" `
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
    docker exec `
        -e CI=true `
        -e IOTISTIC_INSTALL_METHOD=systemd `
        -e IOTISTIC_AGENT_VERSION=local `
        -e IOTISTIC_DEVICE_PORT=$DeviceApiPort `
        -e CLOUD_API_ENDPOINT= `
        -e PROVISIONING_KEY= `
        $ContainerName bash -lc 'cd /workspace && chmod +x agent/bin/install.sh && ./agent/bin/install.sh'

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

    if ($installExitCode -ne 0) {
        throw "install.sh failed with exit code $installExitCode"
    }
}
finally {
    if (-not $KeepContainer) {
        docker rm -f $ContainerName 2>$null | Out-Null
    }

    if (Test-Path $tempDir) {
        Remove-Item -Recurse -Force $tempDir
    }
}