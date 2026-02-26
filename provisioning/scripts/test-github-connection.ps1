#!/usr/bin/env pwsh
# Test GitHub API connectivity from provisioning container

Write-Host "`n=== Testing GitHub API Connection ===" -ForegroundColor Cyan

# Test 1: Basic curl from host
Write-Host "`n1. Testing from HOST machine..." -ForegroundColor Yellow
try {
    $response = curl -s https://api.github.com/repos/Iotistica/iotistic/releases/latest
    Write-Host "   ✓ Connection successful from host" -ForegroundColor Green
    $release = $response | ConvertFrom-Json
    Write-Host "   Latest release: $($release.tag_name)" -ForegroundColor Green
} catch {
    Write-Host "   ✗ Failed from host: $_" -ForegroundColor Red
}

# Test 2: DNS resolution
Write-Host "`n2. Testing DNS resolution..." -ForegroundColor Yellow
try {
    $dns = Resolve-DnsName api.github.com -ErrorAction Stop
    Write-Host "   ✓ DNS resolved: $($dns.IPAddress -join ', ')" -ForegroundColor Green
} catch {
    Write-Host "   ✗ DNS resolution failed: $_" -ForegroundColor Red
}

# Test 3: Curl from provisioning-api container
Write-Host "`n3. Testing from provisioning-api container..." -ForegroundColor Yellow
$apiTest = docker exec provisioning-api curl -s -w "\n%{http_code}" https://api.github.com/repos/Iotistica/iotistic/releases/latest 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ Connection successful from provisioning-api" -ForegroundColor Green
    $lines = $apiTest -split "`n"
    $statusCode = $lines[-1]
    Write-Host "   HTTP Status: $statusCode" -ForegroundColor Green
    if ($statusCode -eq "200") {
        $json = $lines[0..($lines.Length-2)] -join "`n" | ConvertFrom-Json
        Write-Host "   Latest release: $($json.tag_name)" -ForegroundColor Green
    }
} else {
    Write-Host "   ✗ Failed from provisioning-api:" -ForegroundColor Red
    Write-Host "   $apiTest" -ForegroundColor Red
}

# Test 4: Curl from worker container
Write-Host "`n4. Testing from provisioning-worker container..." -ForegroundColor Yellow
$workerTest = docker exec provisioning-worker curl -s -w "\n%{http_code}" https://api.github.com/repos/Iotistica/iotistic/releases/latest 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ Connection successful from provisioning-worker" -ForegroundColor Green
    $lines = $workerTest -split "`n"
    $statusCode = $lines[-1]
    Write-Host "   HTTP Status: $statusCode" -ForegroundColor Green
    if ($statusCode -eq "200") {
        $json = $lines[0..($lines.Length-2)] -join "`n" | ConvertFrom-Json
        Write-Host "   Latest release: $($json.tag_name)" -ForegroundColor Green
    }
} else {
    Write-Host "   ✗ Failed from provisioning-worker:" -ForegroundColor Red
    Write-Host "   $workerTest" -ForegroundColor Red
}

# Test 5: Check Docker network settings
Write-Host "`n5. Checking Docker network configuration..." -ForegroundColor Yellow
$network = docker inspect provisioning-worker --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}'
Write-Host "   Network ID: $network" -ForegroundColor Gray
$gateway = docker inspect provisioning-worker --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'
Write-Host "   Gateway: $gateway" -ForegroundColor Gray

# Test 6: Check DNS in container
Write-Host "`n6. Testing DNS from container..." -ForegroundColor Yellow
$dnsTest = docker exec provisioning-worker nslookup api.github.com 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ DNS works in container" -ForegroundColor Green
    Write-Host "   $dnsTest" -ForegroundColor Gray
} else {
    Write-Host "   ✗ DNS failed in container" -ForegroundColor Red
    Write-Host "   $dnsTest" -ForegroundColor Red
}

# Test 7: Check if curl exists in container
Write-Host "`n7. Checking if curl is installed in container..." -ForegroundColor Yellow
$curlCheck = docker exec provisioning-worker which curl 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ curl installed at: $curlCheck" -ForegroundColor Green
} else {
    Write-Host "   ✗ curl not found in container" -ForegroundColor Red
}

# Test 8: Check container connectivity to external network
Write-Host "`n8. Testing basic internet connectivity..." -ForegroundColor Yellow
$pingTest = docker exec provisioning-worker curl -s -I https://google.com 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✓ Container can reach external internet" -ForegroundColor Green
} else {
    Write-Host "   ✗ Container cannot reach external internet" -ForegroundColor Red
    Write-Host "   This suggests a network/firewall issue" -ForegroundColor Yellow
}

Write-Host "`n=== Diagnosis ===" -ForegroundColor Cyan
Write-Host "If host works but container doesn't:"
Write-Host "  - Check Docker network mode (bridge/host)"
Write-Host "  - Check corporate firewall/proxy settings"
Write-Host "  - Check Docker DNS settings in daemon.json"
Write-Host ""
Write-Host "If both fail:"
Write-Host "  - Check internet connectivity"
Write-Host "  - Check if GitHub is blocked by firewall"
Write-Host "  - Check proxy configuration"
Write-Host ""
