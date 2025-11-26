#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Rebuild and redeploy the dashboard with the correct API URL from values.yaml

.DESCRIPTION
    This script automates the process of rebuilding the dashboard Docker image
    with the VITE_API_URL build argument from the Helm chart values, and then
    restarts the Kubernetes deployment to use the new image.

.PARAMETER Namespace
    The Kubernetes namespace where the chart is deployed. Default: iotistic

.PARAMETER Release
    The Helm release name. Default: iotistic

.EXAMPLE
    .\rebuild-dashboard.ps1
    
.EXAMPLE
    .\rebuild-dashboard.ps1 -Namespace my-namespace -Release my-release
#>

param(
    [string]$Namespace = "iotistic",
    [string]$Release = "iotistic"
)

$ErrorActionPreference = "Stop"

Write-Host "🔨 Rebuilding Dashboard for Kubernetes Deployment" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

# Get the API URL from values.yaml
$valuesFile = Join-Path $PSScriptRoot "values.yaml"
if (-not (Test-Path $valuesFile)) {
    Write-Error "values.yaml not found at: $valuesFile"
    exit 1
}

Write-Host "`n📄 Reading values.yaml..." -ForegroundColor Yellow
$apiUrl = (Select-String -Path $valuesFile -Pattern 'apiUrl:\s*"([^"]+)"' | ForEach-Object { $_.Matches.Groups[1].Value })

if ([string]::IsNullOrEmpty($apiUrl)) {
    Write-Error "Could not find dashboard.apiUrl in values.yaml"
    exit 1
}

Write-Host "   API URL: $apiUrl" -ForegroundColor Green

# Navigate to dashboard directory
$dashboardDir = Join-Path (Split-Path $PSScriptRoot -Parent) ".." ".." "dashboard"
$dashboardDir = Resolve-Path $dashboardDir

Write-Host "`n🏗️  Building Docker image..." -ForegroundColor Yellow
Write-Host "   Directory: $dashboardDir" -ForegroundColor Gray
Write-Host "   Build arg: VITE_API_URL=$apiUrl" -ForegroundColor Gray

Push-Location $dashboardDir
try {
    docker build --build-arg "VITE_API_URL=$apiUrl" -t iotistic/dashboard:latest .
    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed"
    }
    Write-Host "   ✅ Image built successfully" -ForegroundColor Green
}
finally {
    Pop-Location
}

# Restart the deployment
Write-Host "`n🔄 Restarting Kubernetes deployment..." -ForegroundColor Yellow
kubectl rollout restart "deployment/$Release-dashboard" -n $Namespace
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to restart deployment"
    exit 1
}

Write-Host "`n⏳ Waiting for rollout to complete..." -ForegroundColor Yellow
kubectl rollout status "deployment/$Release-dashboard" -n $Namespace --timeout=120s
if ($LASTEXITCODE -ne 0) {
    Write-Error "Rollout failed or timed out"
    exit 1
}

Write-Host "`n✅ Dashboard rebuilt and redeployed successfully!" -ForegroundColor Green
Write-Host "`n🌐 Access your dashboard at:" -ForegroundColor Cyan

# Get the NodePort
$nodePort = kubectl get svc -n $Namespace "$Release-dashboard" -o jsonpath='{.spec.ports[0].nodePort}' 2>$null
if ($nodePort) {
    Write-Host "   http://localhost:$nodePort" -ForegroundColor White
}
else {
    Write-Host "   (Run 'kubectl get svc -n $Namespace' to find the access URL)" -ForegroundColor Gray
}

Write-Host ""
