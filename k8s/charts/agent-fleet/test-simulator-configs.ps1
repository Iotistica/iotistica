# Test Helm chart rendering with different simulator configurations

Write-Host "Testing Helm chart simulator configurations..." -ForegroundColor Cyan

# Test 1: No simulators (minimal)
Write-Host "`nTest 1: Minimal (no simulators)" -ForegroundColor Yellow
helm template agent-fleet . --set simulator.modbusCount=0 --set opcuaSimulator.count=0 --set sensorSimulator.enabled=false | Select-String -Pattern "modbus-simulator|opcua-simulator|sensor-simulator|MODBUS_SIMULATOR_PORTS|OPCUA_DISCOVERY_URLS|SENSOR_SIMULATOR_ENABLED" -Context 0,2

# Test 2: 1 Modbus only
Write-Host "`nTest 2: Modbus-only (1 instance)" -ForegroundColor Yellow
helm template agent-fleet . --set simulator.modbusCount=1 --set opcuaSimulator.count=0 --set sensorSimulator.enabled=false | Select-String -Pattern "modbus-simulator|MODBUS_SIMULATOR_PORTS|MODBUS_TCP_PORT" -Context 0,2

# Test 3: 2 Modbus + OPC-UA
Write-Host "`nTest 3: Full-stack (2 Modbus + OPC-UA + Sensors)" -ForegroundColor Yellow
helm template agent-fleet . --set simulator.modbusCount=2 --set opcuaSimulator.count=2 --set sensorSimulator.enabled=true | Select-String -Pattern "name: modbus-simulator-|name: opcua-simulator-|name: sensor-simulator|MODBUS_SIMULATOR_PORTS|OPCUA_DISCOVERY_URLS" -Context 0,1

# Test 4: Heavy load (3 Modbus)
Write-Host "`nTest 4: Heavy-load (3 Modbus only)" -ForegroundColor Yellow
helm template agent-fleet . --set simulator.modbusCount=3 --set opcuaSimulator.count=0 --set sensorSimulator.enabled=false | Select-String -Pattern "modbus-simulator-|MODBUS_TCP_PORT" -Context 0,1

# Test 5: OPC-UA only
Write-Host "`nTest 5: OPC-UA only" -ForegroundColor Yellow
helm template agent-fleet . --set simulator.modbusCount=0 --set opcuaSimulator.count=2 --set sensorSimulator.enabled=false | Select-String -Pattern "name: opcua-simulator-|OPCUA_DISCOVERY_URLS" -Context 0,1

Write-Host "`nAll tests complete!" -ForegroundColor Green
