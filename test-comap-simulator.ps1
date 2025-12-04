# Test COMAP Simulator
# Quick script to verify Modbus TCP connectivity and read register values

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "COMAP Generator Simulator Test Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if simulator container is running
Write-Host "1. Checking simulator status..." -ForegroundColor Yellow
$container = docker ps --filter "name=iotistic-comap-simulator" --format "{{.Status}}"
if ($container) {
    Write-Host "   ✓ Simulator container is running: $container" -ForegroundColor Green
} else {
    Write-Host "   ✗ Simulator container not found!" -ForegroundColor Red
    Write-Host "   Run: docker-compose -f docker-compose.e2e.yml up -d comap-simulator" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# Check logs for startup
Write-Host "2. Checking simulator logs..." -ForegroundColor Yellow
Write-Host "   Last 5 log lines:" -ForegroundColor Gray
docker logs --tail 5 iotistic-comap-simulator 2>&1 | ForEach-Object {
    Write-Host "   $_" -ForegroundColor Gray
}
Write-Host ""

# Test TCP connectivity
Write-Host "3. Testing TCP connectivity to port 5502..." -ForegroundColor Yellow
try {
    $connection = Test-NetConnection -ComputerName localhost -Port 5502 -InformationLevel Quiet
    if ($connection) {
        Write-Host "   ✓ Port 5502 is accessible" -ForegroundColor Green
    } else {
        Write-Host "   ✗ Cannot connect to port 5502" -ForegroundColor Red
    }
} catch {
    Write-Host "   ✗ Error testing connection: $_" -ForegroundColor Red
}
Write-Host ""

# Check if mbpoll is available
Write-Host "4. Checking for mbpoll (Modbus client)..." -ForegroundColor Yellow
$mbpoll = Get-Command mbpoll -ErrorAction SilentlyContinue
if ($mbpoll) {
    Write-Host "   ✓ mbpoll is installed" -ForegroundColor Green
    Write-Host ""
    
    # Test Modbus reads
    Write-Host "5. Testing Modbus register reads..." -ForegroundColor Yellow
    
    # Read engine RPM (register 100, slave 1)
    Write-Host "   Reading Engine RPM (register 100, slave 1)..." -ForegroundColor Gray
    try {
        $rpm = mbpoll -a 1 -r 100 -c 1 -t 4 -1 localhost -p 5502 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✓ Engine RPM: $rpm" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Failed to read RPM" -ForegroundColor Red
        }
    } catch {
        Write-Host "   ✗ Error: $_" -ForegroundColor Red
    }
    
    # Read frequency (register 130, slave 1)
    Write-Host "   Reading Frequency (register 130, slave 1)..." -ForegroundColor Gray
    try {
        $freq = mbpoll -a 1 -r 130 -c 1 -t 4 -1 localhost -p 5502 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✓ Frequency: $freq (raw value, divide by 100 for Hz)" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Failed to read frequency" -ForegroundColor Red
        }
    } catch {
        Write-Host "   ✗ Error: $_" -ForegroundColor Red
    }
    
    # Read alarms (coils 0-3, slave 1)
    Write-Host "   Reading Alarms (coils 0-3, slave 1)..." -ForegroundColor Gray
    try {
        $alarms = mbpoll -a 1 -r 0 -c 4 -t 0 -1 localhost -p 5502 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✓ Alarms: $alarms" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Failed to read alarms" -ForegroundColor Red
        }
    } catch {
        Write-Host "   ✗ Error: $_" -ForegroundColor Red
    }
    
} else {
    Write-Host "   ⚠ mbpoll not installed - skipping Modbus tests" -ForegroundColor Yellow
    Write-Host "   Install: scoop install mbpoll (or download from https://github.com/epsilonrt/mbpoll)" -ForegroundColor Gray
}
Write-Host ""

# Test with Python if available
Write-Host "6. Testing with Python (pymodbus)..." -ForegroundColor Yellow
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    Write-Host "   ✓ Python is available" -ForegroundColor Green
    
    # Create temporary Python test script
    $testScript = @"
from pymodbus.client import ModbusTcpClient
import sys

try:
    client = ModbusTcpClient('localhost', port=5502)
    if client.connect():
        print('   ✓ Connected to Modbus TCP server')
        
        # Read engine RPM (register 100, slave 1)
        result = client.read_holding_registers(100, 1, slave=1)
        if not result.isError():
            print(f'   ✓ Engine RPM: {result.registers[0]} RPM')
        else:
            print(f'   ✗ Error reading RPM: {result}')
        
        # Read 3-phase voltages (registers 110-112, slave 1)
        result = client.read_holding_registers(110, 3, slave=1)
        if not result.isError():
            print(f'   ✓ Voltages: Phase A={result.registers[0]}V, Phase B={result.registers[1]}V, Phase C={result.registers[2]}V')
        else:
            print(f'   ✗ Error reading voltages: {result}')
        
        # Read frequency (register 130, slave 1)
        result = client.read_holding_registers(130, 1, slave=1)
        if not result.isError():
            freq_hz = result.registers[0] / 100.0
            print(f'   ✓ Frequency: {freq_hz:.2f} Hz')
        else:
            print(f'   ✗ Error reading frequency: {result}')
        
        # Read alarms (coils 0-3, slave 1)
        result = client.read_coils(0, 4, slave=1)
        if not result.isError():
            alarms = ['Overspeed', 'Low Oil', 'High Temp', 'Overload']
            active_alarms = [alarms[i] for i, bit in enumerate(result.bits[:4]) if bit]
            if active_alarms:
                print(f'   ⚠ Active alarms: {", ".join(active_alarms)}')
            else:
                print(f'   ✓ No alarms active')
        else:
            print(f'   ✗ Error reading alarms: {result}')
        
        client.close()
        sys.exit(0)
    else:
        print('   ✗ Failed to connect to Modbus TCP server')
        sys.exit(1)
except Exception as e:
    print(f'   ✗ Error: {e}')
    sys.exit(1)
"@
    
    $tempFile = [System.IO.Path]::GetTempFileName() + ".py"
    Set-Content -Path $tempFile -Value $testScript
    
    try {
        python $tempFile
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   ✓ Python Modbus test completed successfully" -ForegroundColor Green
        } else {
            Write-Host "   ✗ Python Modbus test failed" -ForegroundColor Red
            Write-Host "   Try: pip install pymodbus" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "   ✗ Error running Python test: $_" -ForegroundColor Red
    } finally {
        Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "   ⚠ Python not available - skipping Python tests" -ForegroundColor Yellow
}
Write-Host ""

# Summary
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Simulator Endpoint: localhost:5502" -ForegroundColor White
Write-Host "Slave IDs: 1, 2, 3" -ForegroundColor White
Write-Host "Protocol: Modbus TCP" -ForegroundColor White
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Test agent discovery:" -ForegroundColor Gray
Write-Host "     docker exec iotistic-agent python -m agent.device-api.discovery" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. View simulator logs:" -ForegroundColor Gray
Write-Host "     docker logs -f iotistic-comap-simulator" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. Monitor real-time values:" -ForegroundColor Gray
Write-Host "     watch -n 1 'mbpoll -a 1 -r 130 -c 1 -t 4 localhost -p 5502'" -ForegroundColor Gray
Write-Host ""
Write-Host "  4. Inject fault for testing:" -ForegroundColor Gray
Write-Host "     docker-compose -f docker-compose.e2e.yml up -d --force-recreate \" -ForegroundColor Gray
Write-Host "       --build -e INJECT_OVERSPEED=true comap-simulator" -ForegroundColor Gray
Write-Host ""
