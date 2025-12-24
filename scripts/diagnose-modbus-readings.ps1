#!/usr/bin/env pwsh
# Modbus Reading Diagnostic Script
# Checks MQTT messages and PostgreSQL data for Modbus readings

Write-Host "=== Modbus Reading Diagnostic ===" -ForegroundColor Cyan
Write-Host ""

# 1. Check if Modbus simulator is running
Write-Host "[1/5] Checking Modbus simulator status..." -ForegroundColor Yellow
docker ps --filter "name=modbus-sim" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Write-Host ""

# 2. Check recent MQTT messages on sensor/modbus topic
Write-Host "[2/5] Checking recent MQTT messages (10 seconds)..." -ForegroundColor Yellow
Write-Host "Subscribing to sensor/modbus/# and sensor/modbus..." -ForegroundColor Gray

$mqttJob = Start-Job -ScriptBlock {
    docker exec iotistic-mosquitto mosquitto_sub -h localhost -p 1883 -u admin -P iotistic42! -t 'sensor/modbus/#' -t 'sensor/modbus' -C 5 -W 10
}

Wait-Job $mqttJob -Timeout 12 | Out-Null
$mqttMessages = Receive-Job $mqttJob
Remove-Job $mqttJob -Force

if ($mqttMessages) {
    Write-Host "Recent MQTT messages:" -ForegroundColor Green
    $mqttMessages | ForEach-Object { 
        Write-Host "  $_" -ForegroundColor White
        # Try to parse JSON
        try {
            $json = $_ | ConvertFrom-Json
            Write-Host "    Parsed: readings count = $($json.readings.Count), first value = $($json.readings[0].value)" -ForegroundColor Gray
        } catch {
            # Not JSON
        }
    }
} else {
    Write-Host "  No MQTT messages received on sensor/modbus topics" -ForegroundColor Red
    Write-Host "  This indicates the simulator is not publishing data" -ForegroundColor Red
}
Write-Host ""

# 3. Check PostgreSQL for recent Modbus readings
Write-Host "[3/5] Checking PostgreSQL for recent Modbus readings..." -ForegroundColor Yellow
$pgQuery = @"
SELECT 
    time,
    metric_name,
    value,
    quality,
    unit,
    protocol,
    extra->>'sensor_name' as sensor_name,
    extra
FROM endpoint_readings 
WHERE protocol = 'modbus' 
ORDER BY time DESC 
LIMIT 10;
"@

docker exec iotistic-postgres psql -U postgres -d iotistic -c "$pgQuery"
Write-Host ""

# 4. Check value statistics
Write-Host "[4/5] Checking Modbus reading value statistics..." -ForegroundColor Yellow
$statsQuery = @"
SELECT 
    COUNT(*) as total_readings,
    COUNT(CASE WHEN value = 0 THEN 1 END) as zero_readings,
    COUNT(CASE WHEN value != 0 THEN 1 END) as non_zero_readings,
    MIN(value) as min_value,
    MAX(value) as max_value,
    AVG(value) as avg_value
FROM endpoint_readings 
WHERE protocol = 'modbus' 
AND time > NOW() - INTERVAL '1 hour';
"@

docker exec iotistic-postgres psql -U postgres -d iotistic -c "$statsQuery"
Write-Host ""

# 5. Check Modbus simulator configuration
Write-Host "[5/5] Checking Modbus simulator configuration..." -ForegroundColor Yellow
docker exec iotistic-modbus-sim printenv | Select-String "MODBUS"
Write-Host ""

# 6. Check simulator logs for errors
Write-Host "[BONUS] Recent Modbus simulator logs (last 20 lines)..." -ForegroundColor Yellow
docker logs --tail 20 iotistic-modbus-sim
Write-Host ""

Write-Host "=== Diagnostic Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. If no MQTT messages: Check simulator is running and publishing" -ForegroundColor Gray
Write-Host "  2. If MQTT has values but DB has zeros: Check API parsing logic" -ForegroundColor Gray
Write-Host "  3. If MQTT has zeros: Check simulator configuration/register values" -ForegroundColor Gray
Write-Host "  4. Check simulator web GUI at http://localhost:5001" -ForegroundColor Gray
