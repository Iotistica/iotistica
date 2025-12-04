#!/usr/bin/env pwsh
# Test COMAP Simulator Fault Injection

param(
    [ValidateSet('overspeed', 'low_oil', 'high_temp', 'overload', 'multiple', 'clear')]
    [string]$Fault = 'overspeed'
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "COMAP Simulator Fault Injection Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Stop current container
Write-Host "Stopping current simulator..." -ForegroundColor Yellow
docker-compose -f docker-compose.e2e.yml stop comap-simulator | Out-Null
docker-compose -f docker-compose.e2e.yml rm -f comap-simulator | Out-Null
Write-Host "✓ Stopped" -ForegroundColor Green
Write-Host ""

# Configure fault injection
$env_vars = @(
    'AUTO_START=true',
    'MODBUS_SLAVES=3',
    'GENERATOR_RATED_KW=100'
)

switch ($Fault) {
    'overspeed' {
        Write-Host "Injecting: Overspeed Alarm" -ForegroundColor Red
        $env_vars += 'INJECT_OVERSPEED=true'
    }
    'low_oil' {
        Write-Host "Injecting: Low Oil Pressure Alarm" -ForegroundColor Red
        $env_vars += 'INJECT_LOW_OIL=true'
    }
    'high_temp' {
        Write-Host "Injecting: High Temperature Alarm" -ForegroundColor Red
        $env_vars += 'INJECT_HIGH_TEMP=true'
    }
    'overload' {
        Write-Host "Injecting: Overload Alarm" -ForegroundColor Red
        $env_vars += 'INJECT_OVERLOAD=true'
    }
    'multiple' {
        Write-Host "Injecting: Multiple Faults (Overspeed + High Temp)" -ForegroundColor Red
        $env_vars += 'INJECT_OVERSPEED=true'
        $env_vars += 'INJECT_HIGH_TEMP=true'
    }
    'clear' {
        Write-Host "Clearing all faults - Normal operation" -ForegroundColor Green
        # No fault flags added
    }
}
Write-Host ""

# Build docker run command with environment variables
$env_args = $env_vars | ForEach-Object { "-e $_" }
$docker_cmd = "docker run -d --name iotistic-comap-simulator --network zemfyre-sensor_iotistic-net -p 5502:502 $($env_args -join ' ') zemfyre-sensor-comap-simulator:latest"

Write-Host "Starting simulator with fault injection..." -ForegroundColor Yellow
Invoke-Expression $docker_cmd | Out-Null

Start-Sleep -Seconds 3

# Check if container is running
$status = docker ps --filter "name=iotistic-comap-simulator" --format "{{.Status}}"
if ($status) {
    Write-Host "✓ Simulator started: $status" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to start simulator" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Wait for startup sequence
Write-Host "Waiting for generator startup (15 seconds)..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

# Check logs
Write-Host ""
Write-Host "Recent logs:" -ForegroundColor Yellow
Write-Host "----------------------------------------" -ForegroundColor Gray
docker logs --tail 5 iotistic-comap-simulator | ForEach-Object {
    Write-Host $_ -ForegroundColor Gray
}
Write-Host "----------------------------------------" -ForegroundColor Gray
Write-Host ""

# Try to read alarm coils
Write-Host "Checking alarm status..." -ForegroundColor Yellow

# Check if mbpoll is available
$mbpoll = Get-Command mbpoll -ErrorAction SilentlyContinue
if ($mbpoll) {
    Write-Host ""
    Write-Host "Alarm Coils (0=OK, 1=FAULT):" -ForegroundColor Cyan
    $alarms = mbpoll -a 1 -r 0 -c 4 -t 0 localhost -p 5502 2>&1
    $alarms | ForEach-Object {
        if ($_ -match '\[0\]:.*1') {
            Write-Host "  [0] Overspeed:        🔴 ACTIVE" -ForegroundColor Red
        } elseif ($_ -match '\[0\]:.*0') {
            Write-Host "  [0] Overspeed:        ✅ OK" -ForegroundColor Green
        }
        
        if ($_ -match '\[1\]:.*1') {
            Write-Host "  [1] Low Oil Pressure: 🔴 ACTIVE" -ForegroundColor Red
        } elseif ($_ -match '\[1\]:.*0') {
            Write-Host "  [1] Low Oil Pressure: ✅ OK" -ForegroundColor Green
        }
        
        if ($_ -match '\[2\]:.*1') {
            Write-Host "  [2] High Temperature: 🔴 ACTIVE" -ForegroundColor Red
        } elseif ($_ -match '\[2\]:.*0') {
            Write-Host "  [2] High Temperature: ✅ OK" -ForegroundColor Green
        }
        
        if ($_ -match '\[3\]:.*1') {
            Write-Host "  [3] Overload:         🔴 ACTIVE" -ForegroundColor Red
        } elseif ($_ -match '\[3\]:.*0') {
            Write-Host "  [3] Overload:         ✅ OK" -ForegroundColor Green
        }
    }
} else {
    Write-Host "⚠ mbpoll not installed - cannot read alarm status" -ForegroundColor Yellow
    Write-Host "Install with: scoop install mbpoll" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Complete!" -ForegroundColor Green
Write-Host ""
Write-Host "To monitor logs:       docker logs -f iotistic-comap-simulator" -ForegroundColor Gray
Write-Host "To read alarms:        mbpoll -a 1 -r 0 -c 4 -t 0 localhost -p 5502" -ForegroundColor Gray
Write-Host "To test another fault: .\test-faults.ps1 -Fault <fault_name>" -ForegroundColor Gray
Write-Host ""
Write-Host "Available faults: overspeed, low_oil, high_temp, overload, multiple, clear" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
