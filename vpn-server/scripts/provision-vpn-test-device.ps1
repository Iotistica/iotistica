# Test Device Provisioning for VPN
# Creates a test device and retrieves VPN configuration

param(
    [string]$DeviceUuid = "test-windows-agent-$(Get-Random -Maximum 999)",
    [string]$ApiUrl = "http://localhost:3002",
    [string]$OutputDir = "$env:USERPROFILE\openvpn-config"
)

Write-Host "🔐 Provisioning Test Device for VPN..." -ForegroundColor Cyan
Write-Host "   Device UUID: $DeviceUuid" -ForegroundColor Gray
Write-Host "   API URL: $ApiUrl" -ForegroundColor Gray

# Create output directory
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Host "   Created: $OutputDir" -ForegroundColor Gray
}

# Step 1: Create provisioning key (if needed)
Write-Host "`n1️⃣ Creating provisioning key..." -ForegroundColor Yellow

$keyBody = @{
    name = "VPN Test Key"
    fleetId = 1
    maxUses = 100
    validDuration = 86400
} | ConvertTo-Json

$keyResponse = Invoke-RestMethod -Uri "$ApiUrl/api/v1/provisioning-keys" `
    -Method POST `
    -ContentType "application/json" `
    -Body $keyBody `
    -ErrorAction SilentlyContinue

if ($keyResponse) {
    $provisioningKeyId = $keyResponse.key.id
    $provisioningKeySecret = $keyResponse.key.secret
    Write-Host "   ✅ Provisioning key created: $provisioningKeyId" -ForegroundColor Green
    Write-Host "      Secret: $provisioningKeySecret" -ForegroundColor Gray
} else {
    # Use existing key (hardcoded for testing)
    Write-Host "   ⚠️  Using existing provisioning key (ID: 1)" -ForegroundColor Yellow
    $provisioningKeyId = 1
    $provisioningKeySecret = "existing-secret"  # Replace with actual secret from DB
}

# Step 2: Register device
Write-Host "`n2️⃣ Registering device..." -ForegroundColor Yellow

$deviceBody = @{
    deviceUuid = $DeviceUuid
    deviceName = "Windows VPN Test Agent"
    deviceType = "windows-pc"
    provisioningKeyId = $provisioningKeyId
    provisioningKeySecret = $provisioningKeySecret
} | ConvertTo-Json

try {
    $deviceResponse = Invoke-RestMethod -Uri "$ApiUrl/api/v1/agent/register" `
        -Method POST `
        -ContentType "application/json" `
        -Body $deviceBody `
        -ErrorAction Stop

    Write-Host "   ✅ Device registered successfully" -ForegroundColor Green
    Write-Host "      UUID: $($deviceResponse.device.uuid)" -ForegroundColor Gray
    Write-Host "      Name: $($deviceResponse.device.device_name)" -ForegroundColor Gray
} catch {
    Write-Host "   ❌ Device registration failed: $_" -ForegroundColor Red
    exit 1
}

# Step 3: Extract VPN configuration
Write-Host "`n3️⃣ Extracting VPN configuration..." -ForegroundColor Yellow

if ($deviceResponse.vpn -and $deviceResponse.vpn.enabled) {
    Write-Host "   ✅ VPN is enabled" -ForegroundColor Green
    
    $vpnConfig = $deviceResponse.vpn
    Write-Host "      Server: $($vpnConfig.server_host):$($vpnConfig.server_port)" -ForegroundColor Gray
    Write-Host "      Username: $($vpnConfig.credentials.username)" -ForegroundColor Gray
    Write-Host "      Password: $($vpnConfig.credentials.password)" -ForegroundColor Gray
    
    # Save .ovpn config file
    $ovpnPath = Join-Path $OutputDir "iotistic-$DeviceUuid.ovpn"
    $vpnConfig.config | Out-File -FilePath $ovpnPath -Encoding UTF8
    Write-Host "      Config saved: $ovpnPath" -ForegroundColor Green
    
    # Save credentials separately (for reference)
    $credsPath = Join-Path $OutputDir "iotistic-$DeviceUuid-credentials.txt"
    @"
VPN Credentials for Device: $DeviceUuid
Generated: $(Get-Date)

Server: $($vpnConfig.server_host):$($vpnConfig.server_port)
Protocol: $($vpnConfig.protocol)
Username: $($vpnConfig.credentials.username)
Password: $($vpnConfig.credentials.password)

MQTT Credentials:
Username: $($deviceResponse.mqtt.username)
Password: $($deviceResponse.mqtt.password)
Broker: $($deviceResponse.mqtt.broker_url)

To connect:
1. Import $ovpnPath into OpenVPN GUI
2. Or run: openvpn --config "$ovpnPath"
"@ | Out-File -FilePath $credsPath -Encoding UTF8
    
    Write-Host "      Credentials saved: $credsPath" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  VPN is not enabled or not configured" -ForegroundColor Yellow
    Write-Host "      Check environment variables: VPN_ENABLED, VPN_SERVER_HOST" -ForegroundColor Gray
}

# Step 4: Extract MQTT configuration
Write-Host "`n4️⃣ MQTT Configuration:" -ForegroundColor Yellow
if ($deviceResponse.mqtt) {
    Write-Host "      Broker: $($deviceResponse.mqtt.broker_url)" -ForegroundColor Gray
    Write-Host "      Username: $($deviceResponse.mqtt.username)" -ForegroundColor Gray
    Write-Host "      Password: $($deviceResponse.mqtt.password)" -ForegroundColor Gray
}

# Step 5: Show next steps
Write-Host "`n✅ Device provisioning complete!" -ForegroundColor Green
Write-Host "`n📝 Next Steps:" -ForegroundColor Yellow
Write-Host "   1. Connect to VPN:" -ForegroundColor White
Write-Host "      - OpenVPN GUI: Import $ovpnPath" -ForegroundColor Gray
Write-Host "      - Or: openvpn --config `"$ovpnPath`"" -ForegroundColor Gray
Write-Host ""
Write-Host "   2. Verify VPN connection:" -ForegroundColor White
Write-Host "      ipconfig | Select-String -Pattern 'OpenVPN'" -ForegroundColor Gray
Write-Host "      # Should show IP: 10.8.0.x" -ForegroundColor Gray
Write-Host ""
Write-Host "   3. Test connectivity:" -ForegroundColor White
Write-Host "      ping 172.25.0.12  # MQTT broker" -ForegroundColor Gray
Write-Host "      ping 172.25.0.13  # API server" -ForegroundColor Gray
Write-Host ""
Write-Host "   4. Configure agent:" -ForegroundColor White
Write-Host "      `$env:DEVICE_UUID = '$DeviceUuid'" -ForegroundColor Gray
Write-Host "      `$env:MQTT_BROKER = 'mqtt://172.25.0.12:1883'" -ForegroundColor Gray
Write-Host "      `$env:MQTT_USERNAME = '$($deviceResponse.mqtt.username)'" -ForegroundColor Gray
Write-Host "      `$env:MQTT_PASSWORD = '$($deviceResponse.mqtt.password)'" -ForegroundColor Gray
Write-Host "      `$env:IOTISTICA_API = 'http://172.25.0.13:3002'" -ForegroundColor Gray
Write-Host ""
Write-Host "   5. Run agent:" -ForegroundColor White
Write-Host "      cd agent && npm start" -ForegroundColor Gray

Write-Host "`n📂 Output directory: $OutputDir" -ForegroundColor Cyan
