Write-Host "=== Setting up Modbus Protocol Adapter ===" -ForegroundColor Cyan

$dbPath = "C:\Users\Dan\zemfyre-sensor\agent\data\device.sqlite"

# 1. Check if endpoint_outputs table exists and has Modbus entry
Write-Host "`n1. Checking endpoint_outputs table..." -ForegroundColor Yellow
$hasOutput = node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); const row = db.prepare('SELECT COUNT(*) as count FROM endpoint_outputs WHERE protocol = ?').get('modbus'); console.log(row.count);" 2>$null

if ($hasOutput -eq "0") {
    Write-Host "✗ No Modbus output configuration found" -ForegroundColor Red
    Write-Host "  Creating default Modbus output configuration..." -ForegroundColor Yellow
    
    # Determine socket path based on platform (Windows named pipe)
    $socketPath = "\\.\pipe\modbus"
    
    # Insert default Modbus output configuration
    node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); db.prepare('INSERT INTO endpoint_outputs (protocol, socket_path, data_format, delimiter, include_timestamp, include_device_name) VALUES (?, ?, ?, ?, ?, ?)').run('modbus', '$($socketPath.Replace('\','\\'))', 'json', ',', 1, 1); console.log('✓ Created Modbus output configuration');"
    
    Write-Host "✓ Modbus output configured: $socketPath" -ForegroundColor Green
} else {
    Write-Host "✓ Modbus output configuration exists" -ForegroundColor Green
    
    # Show current config
    node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); const row = db.prepare('SELECT * FROM endpoint_outputs WHERE protocol = ?').get('modbus'); console.log(JSON.stringify(row, null, 2));"
}

# 2. Verify sensor exists
Write-Host "`n2. Checking Modbus sensor..." -ForegroundColor Yellow
$sensorCount = node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); const row = db.prepare('SELECT COUNT(*) as count FROM sensors WHERE protocol = ? AND enabled = 1').get('modbus'); console.log(row.count);" 2>$null

if ($sensorCount -eq "0") {
    Write-Host "✗ No enabled Modbus sensors found" -ForegroundColor Red
    Write-Host "  Please create a sensor via the API or dashboard" -ForegroundColor Yellow
} else {
    Write-Host "✓ Found $sensorCount enabled Modbus sensor(s)" -ForegroundColor Green
    
    # Show sensors
    node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); const sensors = db.prepare('SELECT id, name, enabled, poll_interval FROM sensors WHERE protocol = ?').all('modbus'); console.log(JSON.stringify(sensors, null, 2));"
}

# 3. Set environment variable
Write-Host "`n3. Enabling protocol adapters..." -ForegroundColor Yellow
$env:ENABLE_PROTOCOL_ADAPTERS = "true"
Write-Host "✓ Set ENABLE_PROTOCOL_ADAPTERS=true" -ForegroundColor Green

# 4. Instructions
Write-Host "`n=== Next Steps ===" -ForegroundColor Cyan
Write-Host "1. Restart your agent (in Debug Agent terminal):" -ForegroundColor White
Write-Host "   - Stop the current agent (Ctrl+C)" -ForegroundColor Yellow
Write-Host "   - Set environment: `$env:ENABLE_PROTOCOL_ADAPTERS='true'" -ForegroundColor Yellow
Write-Host "   - Run: cd agent && npm run dev" -ForegroundColor Yellow
Write-Host ""
Write-Host "2. Watch for these log messages:" -ForegroundColor White
Write-Host "   - 'Modbus socket server started at: \\.\pipe\modbus'" -ForegroundColor Gray
Write-Host "   - 'Modbus adapter started'" -ForegroundColor Gray
Write-Host "   - 'Modbus device connected: sensor 11'" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Verify pipe created:" -ForegroundColor White
Write-Host "   cd agent\src\scripts" -ForegroundColor Yellow
Write-Host "   .\check-pipe.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "4. If you see connection errors, check:" -ForegroundColor White
Write-Host "   - Modbus simulator running: docker ps | Select-String modbus" -ForegroundColor Yellow
Write-Host "   - Simulator accessible: Test-NetConnection localhost -Port 502" -ForegroundColor Yellow
