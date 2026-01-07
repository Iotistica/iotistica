#!/usr/bin/env pwsh
# Generate self-signed certificates for Mosquitto on Windows
# Usage: .\mosquitto\generate-mosquitto-certs.ps1 -CommonName "mosquitto" -DaysValid 365

param(
    [string]$CommonName = "mosquitto",
    [int]$DaysValid = 365
)

$CertDir = "mosquitto\certs"
$ServerKey = Join-Path $CertDir "server.key"
$ServerCsr = Join-Path $CertDir "server.csr"
$ServerCrt = Join-Path $CertDir "server.crt"

Write-Host "🔐 Generating self-signed Mosquitto TLS certificates..." -ForegroundColor Cyan
Write-Host "   Common Name: $CommonName"
Write-Host "   Days Valid: $DaysValid"
Write-Host "   Certificate Directory: $CertDir"
Write-Host ""

# Create certs directory if it doesn't exist
if (-not (Test-Path $CertDir)) {
    New-Item -ItemType Directory -Path $CertDir -Force | Out-Null
    Write-Host "Created directory: $CertDir" -ForegroundColor Green
}

# Use Docker to generate certificates
Write-Host "1️⃣  Generating private key..." -ForegroundColor Cyan
docker run --rm `
  -v "$((Get-Location).Path)\$($CertDir):/certs" `
  alpine/openssl `
  genrsa -out /certs/server.key 4096 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to generate private key" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Private key generated" -ForegroundColor Green

Write-Host "2️⃣  Generating certificate signing request..." -ForegroundColor Cyan
docker run --rm `
  -v "$((Get-Location).Path)\$($CertDir):/certs" `
  alpine/openssl `
  req -new `
  -key /certs/server.key `
  -out /certs/server.csr `
  -subj "/CN=$CommonName/O=IoT/C=US" `
  -addext "subjectAltName=DNS:$CommonName,DNS:mosquitto,DNS:localhost,IP:127.0.0.1" 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to generate CSR" -ForegroundColor Red
    exit 1
}
Write-Host "✅ CSR generated" -ForegroundColor Green

Write-Host "3️⃣  Self-signing certificate..." -ForegroundColor Cyan
docker run --rm `
  -v "$((Get-Location).Path)\$($CertDir):/certs" `
  alpine/openssl `
  x509 -req `
  -days $DaysValid `
  -in /certs/server.csr `
  -signkey /certs/server.key `
  -out /certs/server.crt `
  -extensions "subjectAltName=DNS:$CommonName,DNS:mosquitto,DNS:localhost,IP:127.0.0.1" 2>&1 | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to create certificate" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Certificate signed" -ForegroundColor Green

# Set proper permissions (Windows)
Write-Host "4️⃣  Setting file permissions..." -ForegroundColor Cyan
$Acl = Get-Acl $ServerKey
$Acl.SetAccessRuleProtection($true, $false)
Set-Acl -Path $ServerKey -AclObject $Acl
Write-Host "✅ Permissions set" -ForegroundColor Green

Write-Host ""
Write-Host "✅ Certificates generated successfully!" -ForegroundColor Green
Write-Host ""

# Display certificate info
Write-Host "📋 Certificate Details:" -ForegroundColor Cyan
docker run --rm `
  -v "$((Get-Location).Path)\$($CertDir):/certs" `
  alpine/openssl `
  x509 -in /certs/server.crt -text -noout | Select-String "Subject:|Not Before|Not After|Subject Alternative Name" -A 2

Write-Host ""
Write-Host "⚡ Quick Start:" -ForegroundColor Cyan
Write-Host "   Broker: mosquitto (port 8883/TLS or 9002/WebSocket+TLS)"
Write-Host "   Client: Use insecure/skip-verify mode"
Write-Host "   Example (mosquitto_sub):"
Write-Host "     mosquitto_sub -h localhost -p 8883 --insecure -t test/topic"
Write-Host ""
Write-Host "📝 Next Steps:" -ForegroundColor Cyan
Write-Host "   1. Verify files exist: dir $CertDir"
Write-Host "   2. Start Mosquitto: docker-compose up mosquitto"
Write-Host "   3. Test connection: mosquitto_sub -h localhost -p 8883 --insecure -t test/topic"
