#!/usr/bin/env pwsh
# Start BACnet simulator natively on Windows

$env:BACPYPES_IFACE = "0.0.0.0:47808"

Write-Host "Starting BACnet simulator on 0.0.0.0:47808 (accessible via host.docker.internal)..." -ForegroundColor Green

python bacnet_simulator.py
