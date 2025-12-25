#!/usr/bin/env pwsh
# Test script to trigger Modbus simulator logging
# This will send Modbus read requests to see the enhanced logging

Write-Host "Testing Modbus Simulator Enhanced Logging..." -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Use Docker to run a temporary Python container with pymodbus
Write-Host "📤 Sending Modbus READ request (Holding Registers 1-10, Slave 1)..." -ForegroundColor Yellow

docker run --rm --network zemfyre-sensor_iotistic-net python:3.11-slim sh -c "
pip install -q pymodbus &&
python << 'EOF'
from pymodbus.client import ModbusTcpClient

print('Connecting to modbus-simulator:502...')
client = ModbusTcpClient(host='modbus-simulator', port=502, timeout=3)
if client.connect():
    print('✅ Connected!')
    
    # Read holding registers
    print('\n📊 Reading Holding Registers (1-10) from Slave 1...')
    result = client.read_holding_registers(address=1, count=10, slave=1)
    if hasattr(result, 'registers'):
        print(f'   Values: {result.registers}')
    else:
        print(f'   Error: {result}')
    
    # Read input registers
    print('\n📊 Reading Input Registers (1-5) from Slave 1...')
    result = client.read_input_registers(address=1, count=5, slave=1)
    if hasattr(result, 'registers'):
        print(f'   Values: {result.registers}')
    else:
        print(f'   Error: {result}')
    
    # Write to holding register
    print('\n📥 Writing to Holding Register 10 (value=500) on Slave 1...')
    result = client.write_register(address=10, value=500, slave=1)
    if hasattr(result, 'value'):
        print(f'   ✅ Write successful: value={result.value}')
    else:
        print(f'   Error: {result}')
    
    client.close()
    print('\n✅ Test complete! Check Modbus simulator logs above.')
else:
    print('❌ Failed to connect')
EOF
"

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "Now check the simulator logs:" -ForegroundColor Green
Write-Host "  docker logs iotistic-modbus-sim --tail 50" -ForegroundColor White
Write-Host ""
Write-Host "You should see logs like:" -ForegroundColor Yellow
Write-Host "  📤 SENDING DATA - Poll: profile=COMAP, slave=1..." -ForegroundColor Gray
Write-Host "    → 📊 1: 1850 (COMAP.EngineSpeed, base=1800, R/W)" -ForegroundColor Gray
Write-Host "  ✅ RESPONSE SENT: 10 values - [...]" -ForegroundColor Gray
Write-Host "  📥 RECEIVING WRITE - profile=COMAP, type=holding..." -ForegroundColor Gray
Write-Host "    → 💾 Register 10: 100 → 500" -ForegroundColor Gray
Write-Host "  ✅ WRITE COMPLETE: 1 changes - [...]" -ForegroundColor Gray
