#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Run the BACnet simulator directly on Windows for YABE / 3rd-party tool testing.

.DESCRIPTION
    The Docker instance of sim-bacnet lives on the Docker Desktop VM network and
    is not reachable from Windows tools like YABE.  This script runs the same
    Python simulator directly on the Windows host so any BACnet client on this
    machine can discover it on port 47808.

    Uses the project .venv (bacpypes3 0.0.91 must be installed there).

    YABE setup:
      - BACnet/IP Local endpoint: pick your Windows Ethernet adapter IP
        e.g. 10.0.0.60  (shown in ipconfig)
      - Port: BAC0  (47808, default)
      - Click Start → Send Who-Is

    NOTE: The Docker sim-bacnet and this Windows instance are on completely
    separate network namespaces so there is no port conflict between them.
#>

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent (Split-Path -Parent $scriptDir)
$python    = Join-Path $repoRoot ".venv\Scripts\python.exe"
$sim       = Join-Path $scriptDir "bacnet_simulator.py"

if (-not (Test-Path $python)) {
    Write-Error "venv not found at $python — run: python -m venv .venv && .venv\Scripts\pip install bacpypes3==0.0.91"
    exit 1
}

# Auto-detect the best Windows IP for BACnet binding.
# Preference order: physical Ethernet/Wi-Fi > virtual adapters.
# Excludes: loopback, APIPA, Hyper-V Default Switch (172.x), WSL (192.168.240.x),
#           VirtualBox host-only (192.168.56.x), and any other 192.168.x adapters
#           that are virtual (identified by InterfaceDescription containing "Virtual"
#           or "VirtualBox").
$localIp = (
    Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '127.*'          -and
        $_.IPAddress -notlike '169.254.*'       -and
        $_.IPAddress -notlike '172.*'           -and
        $_.IPAddress -notlike '192.168.240.*'   -and
        $_.IPAddress -notlike '192.168.56.*'
    } |
    ForEach-Object {
        $alias = $_.InterfaceAlias
        $desc  = (Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue).InterfaceDescription
        if ($desc -notmatch 'Virtual|VirtualBox|Hyper-V') { $_ }
    } |
    Sort-Object -Property InterfaceMetric |
    Select-Object -First 1
).IPAddress

if (-not $localIp) {
    $localIp = '0.0.0.0'
}

Write-Host ""
Write-Host "BACnet Simulator (Windows / YABE mode)"
Write-Host "  Binding to : $localIp`:47808"
Write-Host "  Device ID  : 1001"
Write-Host "  Device name: Condo-Building-1"
Write-Host ""
Write-Host "YABE: set Local endpoint to $localIp and click Start"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

$env:BACPYPES_IFACE = "$localIp`:47808"
$env:PYTHONUTF8    = "1"          # force UTF-8 stdout so checkmark chars don't crash on Windows cp1252
& $python $sim
