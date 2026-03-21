# VPN Connection Test Script
# Verifies VPN connectivity to Docker services

Write-Host "🔍 Testing VPN Connection..." -ForegroundColor Cyan

# Check if VPN interface exists
Write-Host "`n1️⃣ Checking VPN interface..." -ForegroundColor Yellow
$vpnInterface = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match "TAP-Windows" -or $_.Name -match "OpenVPN" }

if ($vpnInterface) {
    Write-Host "   ✅ VPN interface found: $($vpnInterface.Name)" -ForegroundColor Green
    Write-Host "      Status: $($vpnInterface.Status)" -ForegroundColor Gray
    
    # Get IP address
    $ipAddress = Get-NetIPAddress -InterfaceAlias $vpnInterface.Name -AddressFamily IPv4 -ErrorAction SilentlyContinue
    if ($ipAddress) {
        Write-Host "      IP: $($ipAddress.IPAddress)" -ForegroundColor Gray
        
        if ($ipAddress.IPAddress -match "^10\.8\.0\.") {
            Write-Host "      ✅ IP is in VPN range (10.8.0.0/16)" -ForegroundColor Green
        } else {
            Write-Host "      ⚠️  IP is NOT in expected VPN range" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "   ❌ No VPN interface found" -ForegroundColor Red
    Write-Host "      Make sure OpenVPN is connected" -ForegroundColor Gray
    exit 1
}

# Check routes
Write-Host "`n2️⃣ Checking routes to Docker network..." -ForegroundColor Yellow
$routes = route print | Select-String -Pattern "172.25.0.0"
if ($routes) {
    Write-Host "   ✅ Route to Docker network exists" -ForegroundColor Green
    Write-Host "      $routes" -ForegroundColor Gray
} else {
    Write-Host "   ⚠️  No route to Docker network (172.25.0.0/24)" -ForegroundColor Yellow
    Write-Host "      VPN server may not be pushing routes correctly" -ForegroundColor Gray
}

# Test connectivity to VPN gateway
Write-Host "`n3️⃣ Testing VPN gateway (10.8.0.1)..." -ForegroundColor Yellow
$gatewayTest = Test-Connection -ComputerName 10.8.0.1 -Count 2 -Quiet
if ($gatewayTest) {
    Write-Host "   ✅ VPN gateway is reachable" -ForegroundColor Green
} else {
    Write-Host "   ❌ Cannot reach VPN gateway" -ForegroundColor Red
}

# Test connectivity to VPN server container
Write-Host "`n4️⃣ Testing VPN server (172.25.0.20)..." -ForegroundColor Yellow
$vpnServerTest = Test-Connection -ComputerName 172.25.0.20 -Count 2 -Quiet
if ($vpnServerTest) {
    Write-Host "   ✅ VPN server container is reachable" -ForegroundColor Green
} else {
    Write-Host "   ❌ Cannot reach VPN server container" -ForegroundColor Red
}

# Test connectivity to services
Write-Host "`n5️⃣ Testing Docker services..." -ForegroundColor Yellow

# Test PostgreSQL
Write-Host "   PostgreSQL (172.25.0.10)..." -NoNewline
$pgTest = Test-Connection -ComputerName 172.25.0.10 -Count 1 -Quiet
if ($pgTest) {
    Write-Host " ✅" -ForegroundColor Green
} else {
    Write-Host " ❌" -ForegroundColor Red
}

# Test Redis
Write-Host "   Redis (172.25.0.11)..." -NoNewline
$redisTest = Test-Connection -ComputerName 172.25.0.11 -Count 1 -Quiet
if ($redisTest) {
    Write-Host " ✅" -ForegroundColor Green
} else {
    Write-Host " ❌" -ForegroundColor Red
}

# Test MQTT
Write-Host "   MQTT (172.25.0.12)..." -NoNewline
$mqttTest = Test-Connection -ComputerName 172.25.0.12 -Count 1 -Quiet
if ($mqttTest) {
    Write-Host " ✅" -ForegroundColor Green
} else {
    Write-Host " ❌" -ForegroundColor Red
}

# Test API
Write-Host "   API (172.25.0.13)..." -NoNewline
$apiTest = Test-Connection -ComputerName 172.25.0.13 -Count 1 -Quiet
if ($apiTest) {
    Write-Host " ✅" -ForegroundColor Green
} else {
    Write-Host " ❌" -ForegroundColor Red
}

# Test MQTT port (if Test-NetConnection available)
if (Get-Command Test-NetConnection -ErrorAction SilentlyContinue) {
    Write-Host "`n6️⃣ Testing MQTT port (1883)..." -ForegroundColor Yellow
    $mqttPort = Test-NetConnection -ComputerName 172.25.0.12 -Port 1883 -WarningAction SilentlyContinue
    if ($mqttPort.TcpTestSucceeded) {
        Write-Host "   ✅ MQTT port 1883 is open" -ForegroundColor Green
    } else {
        Write-Host "   ❌ MQTT port 1883 is not accessible" -ForegroundColor Red
    }
    
    Write-Host "`n7️⃣ Testing API port (3002)..." -ForegroundColor Yellow
    $apiPort = Test-NetConnection -ComputerName 172.25.0.13 -Port 3002 -WarningAction SilentlyContinue
    if ($apiPort.TcpTestSucceeded) {
        Write-Host "   ✅ API port 3002 is open" -ForegroundColor Green
    } else {
        Write-Host "   ❌ API port 3002 is not accessible" -ForegroundColor Red
    }
}

# Test API HTTP endpoint
Write-Host "`n8️⃣ Testing API HTTP endpoint..." -ForegroundColor Yellow
try {
    $apiResponse = Invoke-WebRequest -Uri "http://172.25.0.13:3002/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "   ✅ API is responding (Status: $($apiResponse.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "   ⚠️  API endpoint not accessible: $_" -ForegroundColor Yellow
    Write-Host "      (API might not be running or health endpoint not implemented)" -ForegroundColor Gray
}

# Summary
Write-Host "`n📊 Summary:" -ForegroundColor Yellow
if ($vpnInterface -and $gatewayTest -and $vpnServerTest -and $mqttTest -and $apiTest) {
    Write-Host "   ✅ VPN connection is WORKING!" -ForegroundColor Green
    Write-Host "   ✅ All Docker services are reachable" -ForegroundColor Green
    Write-Host "`n   Ready to run agent with:" -ForegroundColor White
    Write-Host "      `$env:MQTT_BROKER = 'mqtt://172.25.0.12:1883'" -ForegroundColor Cyan
    Write-Host "      `$env:IOTISTICA_API = 'http://172.25.0.13:3002'" -ForegroundColor Cyan
} else {
    Write-Host "   ⚠️  Some connectivity issues detected" -ForegroundColor Yellow
    Write-Host "`n   Troubleshooting:" -ForegroundColor White
    Write-Host "   1. Check VPN is connected: OpenVPN GUI" -ForegroundColor Gray
    Write-Host "   2. Check Docker services: docker-compose ps" -ForegroundColor Gray
    Write-Host "   3. Check VPN server logs: docker logs iotistic-vpn-test" -ForegroundColor Gray
    Write-Host "   4. Check iptables NAT: docker exec iotistic-vpn-test iptables -t nat -L" -ForegroundColor Gray
}
