# Test Tailscale VPN API Endpoints
# This script demonstrates how to connect to Tailscale outside of provisioning flow

# Configuration - REPLACE THESE WITH YOUR TAILSCALE CREDENTIALS
$AUTH_KEY = "tskey-auth-xxxxxxxxxxxxx"  # Get from provisioning API or Tailscale admin console
$TAILNET_NAME = "yourcompany.com"  # Your Tailscale tailnet name
$DEVICE_HOSTNAME = "test-device-01"  # Optional: Custom hostname

# Agent API endpoint (default port 48484)
$AGENT_API = "http://localhost:48484"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Tailscale VPN API Test" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. Check current VPN status
Write-Host "[1/5] Checking VPN status..." -ForegroundColor Yellow
try {
    $status = Invoke-RestMethod -Uri "$AGENT_API/v1/vpn/tailscale/status" -Method GET
    Write-Host "Status:" -ForegroundColor Green
    $status | ConvertTo-Json -Depth 3
    Write-Host ""
} catch {
    Write-Host "Status check failed (VPN may not be connected): $_" -ForegroundColor Red
    Write-Host ""
}

# 2. Connect to Tailscale
Write-Host "[2/5] Connecting to Tailscale VPN..." -ForegroundColor Yellow
try {
    $connectBody = @{
        authKey = $AUTH_KEY
        tailnetName = $TAILNET_NAME
        hostname = $DEVICE_HOSTNAME
        shieldsUp = $true  # Block all inbound traffic (recommended for IoT)
        acceptRoutes = $false  # Don't accept subnet routes (security)
        acceptDNS = $false  # Don't use Tailscale DNS (avoid DNS hijacking)
    } | ConvertTo-Json

    $connectResult = Invoke-RestMethod -Uri "$AGENT_API/v1/vpn/tailscale/connect" `
        -Method POST `
        -ContentType "application/json" `
        -Body $connectBody

    Write-Host "Connection successful!" -ForegroundColor Green
    $connectResult | ConvertTo-Json -Depth 3
    Write-Host ""
} catch {
    Write-Host "Connection failed: $_" -ForegroundColor Red
    Write-Host "Error details:" -ForegroundColor Red
    $_.Exception.Message
    exit 1
}

# Wait for connection to fully establish
Write-Host "Waiting 5 seconds for connection to stabilize..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# 3. Get updated status
Write-Host "[3/5] Getting updated VPN status..." -ForegroundColor Yellow
try {
    $status = Invoke-RestMethod -Uri "$AGENT_API/v1/vpn/tailscale/status" -Method GET
    Write-Host "Updated status:" -ForegroundColor Green
    $status | ConvertTo-Json -Depth 3
    Write-Host ""
} catch {
    Write-Host "Failed to get status: $_" -ForegroundColor Red
    Write-Host ""
}

# 4. Get Tailscale IP
Write-Host "[4/5] Getting Tailscale IP address..." -ForegroundColor Yellow
try {
    $ipResult = Invoke-RestMethod -Uri "$AGENT_API/v1/vpn/tailscale/ip" -Method GET
    Write-Host "Tailscale IP:" -ForegroundColor Green
    $ipResult | ConvertTo-Json -Depth 3
    Write-Host ""
} catch {
    Write-Host "Failed to get IP: $_" -ForegroundColor Red
    Write-Host ""
}

# 5. Ping test (optional - requires another node on your Tailnet)
Write-Host "[5/5] Ping test (skipped - requires another node)" -ForegroundColor Yellow
Write-Host "To ping another node, use:" -ForegroundColor Gray
Write-Host "  POST $AGENT_API/v1/vpn/tailscale/ping" -ForegroundColor Gray
Write-Host "  Body: { `"hostname`": `"other-device`", `"count`": 3 }" -ForegroundColor Gray
Write-Host ""

# Optional: Disconnect
$disconnect = Read-Host "Do you want to disconnect? (y/N)"
if ($disconnect -eq "y" -or $disconnect -eq "Y") {
    Write-Host "`nDisconnecting from Tailscale..." -ForegroundColor Yellow
    try {
        $disconnectResult = Invoke-RestMethod -Uri "$AGENT_API/v1/vpn/tailscale/disconnect" -Method POST
        Write-Host "Disconnected successfully!" -ForegroundColor Green
        $disconnectResult | ConvertTo-Json -Depth 3
    } catch {
        Write-Host "Disconnect failed: $_" -ForegroundColor Red
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Test Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
