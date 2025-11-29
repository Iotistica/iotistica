Write-Host "=== Protocol Adapter Diagnostics ===" -ForegroundColor Cyan

# 1. Check sensors table
Write-Host "`n1. Sensors in Database:" -ForegroundColor Yellow
$dbPath = "C:\Users\Dan\zemfyre-sensor\agent\data\device.sqlite"
if (Test-Path $dbPath) {
    Write-Host "✓ Database found at $dbPath" -ForegroundColor Green
    node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); console.log(db.prepare('SELECT id, name, protocol, enabled, poll_interval FROM sensors').all());"
} else {
    Write-Host "✗ Database not found at $dbPath" -ForegroundColor Red
    exit 1
}

# 2. Check endpoint_outputs table
Write-Host "`n2. Sensor Outputs (socket configuration):" -ForegroundColor Yellow
node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); console.log(db.prepare('SELECT protocol, socket_path, data_format FROM endpoint_outputs').all());"

# 3. Check if protocol adapters feature is enabled
Write-Host "`n3. Checking target state config:" -ForegroundColor Yellow
$deviceUuid = (node -e "const db = require('better-sqlite3')('$($dbPath.Replace('\','\\'))'); const row = db.prepare('SELECT value FROM config WHERE key = ?').get('device_uuid'); if(row) console.log(row.value);" 2>$null)
if ($deviceUuid) {
    Write-Host "Device UUID: $deviceUuid" -ForegroundColor White
    
    # Check cloud config
    Write-Host "`nFetching target state from API..." -ForegroundColor Yellow
    try {
        $targetState = Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/$deviceUuid/state" -Method Get
        
        if ($targetState.config.features.enableProtocolAdapters) {
            Write-Host "✓ Protocol Adapters ENABLED in cloud config" -ForegroundColor Green
        } else {
            Write-Host "✗ Protocol Adapters DISABLED in cloud config" -ForegroundColor Red
            Write-Host "  Enable via: config.features.enableProtocolAdapters = true" -ForegroundColor Yellow
        }
        
        if ($targetState.config.protocolAdapters) {
            Write-Host "`nProtocol Adapter Config:" -ForegroundColor Cyan
            $targetState.config.protocolAdapters | ConvertTo-Json -Depth 5
        } else {
            Write-Host "✗ No protocolAdapters config found" -ForegroundColor Red
        }
    } catch {
        Write-Host "✗ Failed to fetch from API: $_" -ForegroundColor Red
    }
} else {
    Write-Host "✗ No device UUID found in database" -ForegroundColor Red
}

# 4. Check for protocol adapter processes/pipes
Write-Host "`n4. Named Pipes (should include modbus):" -ForegroundColor Yellow
try {
    $pipes = [System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match "modbus|sensor|protocol" }
    if ($pipes) {
        $pipes | ForEach-Object { Write-Host "  ✓ $_" -ForegroundColor Green }
    } else {
        Write-Host "  ✗ No protocol adapter pipes found" -ForegroundColor Red
        Write-Host "  This means the protocol adapter is NOT running" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Error listing pipes: $_" -ForegroundColor Red
}

# 5. Check agent logs (if running)
Write-Host "`n5. Agent Status:" -ForegroundColor Yellow
Write-Host "Check your Debug Agent terminal for:" -ForegroundColor Cyan
Write-Host "  - 'Initializing Protocol Adapters' or 'ProtocolAdapters'" -ForegroundColor White
Write-Host "  - 'Modbus adapter starting'" -ForegroundColor White
Write-Host "  - 'Creating named pipe: \\.\pipe\modbus'" -ForegroundColor White
Write-Host "  - Any errors about 'Protocol Adapters'" -ForegroundColor White

Write-Host "`n6. Environment Variables (should include ENABLE_PROTOCOL_ADAPTERS):" -ForegroundColor Yellow
if ($env:ENABLE_PROTOCOL_ADAPTERS) {
    Write-Host "  ✓ ENABLE_PROTOCOL_ADAPTERS = $env:ENABLE_PROTOCOL_ADAPTERS" -ForegroundColor Green
} else {
    Write-Host "  ✗ ENABLE_PROTOCOL_ADAPTERS not set" -ForegroundColor Red
    Write-Host "  Set it with: `$env:ENABLE_PROTOCOL_ADAPTERS='true'" -ForegroundColor Yellow
}

Write-Host "`n=== Troubleshooting Steps ===" -ForegroundColor Cyan
Write-Host "If protocol adapters are not running:" -ForegroundColor White
Write-Host "1. Enable in cloud config: PUT /api/v1/devices/{uuid}/state" -ForegroundColor Yellow
Write-Host "   { config: { features: { enableProtocolAdapters: true } } }" -ForegroundColor Gray
Write-Host "2. Set environment variable: `$env:ENABLE_PROTOCOL_ADAPTERS='true'" -ForegroundColor Yellow
Write-Host "3. Restart agent (stop Debug Agent terminal, npm run dev again)" -ForegroundColor Yellow
Write-Host "4. Check agent logs for 'Protocol Adapters' initialization" -ForegroundColor Yellow
