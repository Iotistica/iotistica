#!/usr/bin/env pwsh
# Iotistic Helm Chart - Quick Install Script

param(
    [string]$Namespace = "iotistic",
    [string]$ReleaseName = "iotistic",
    [string]$ValuesFile = "",
    [switch]$WaitReady = $false,
    [switch]$Uninstall = $false
)

$ChartPath = "$PSScriptRoot"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Iotistic Helm Chart Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if ($Uninstall) {
    Write-Host "Uninstalling release '$ReleaseName' from namespace '$Namespace'..." -ForegroundColor Yellow
    helm uninstall $ReleaseName --namespace $Namespace
    
    Write-Host ""
    Write-Host "Do you want to delete the namespace? (y/N): " -ForegroundColor Yellow -NoNewline
    $response = Read-Host
    if ($response -eq "y" -or $response -eq "Y") {
        kubectl delete namespace $Namespace
        Write-Host "Namespace deleted." -ForegroundColor Green
    }
    exit 0
}

# Check if Helm is installed
if (-not (Get-Command helm -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: Helm is not installed" -ForegroundColor Red
    Write-Host "Please install Helm: https://helm.sh/docs/intro/install/" -ForegroundColor Yellow
    exit 1
}

# Check if kubectl is installed
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: kubectl is not installed" -ForegroundColor Red
    Write-Host "Please install kubectl: https://kubernetes.io/docs/tasks/tools/" -ForegroundColor Yellow
    exit 1
}

# Create namespace if it doesn't exist
Write-Host "📦 Creating namespace '$Namespace'..." -ForegroundColor Cyan
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f -

# Build Helm command
$helmArgs = @(
    "upgrade",
    "--install",
    $ReleaseName,
    $ChartPath,
    "--namespace", $Namespace
)

if ($ValuesFile) {
    if (Test-Path $ValuesFile) {
        $helmArgs += "--values"
        $helmArgs += $ValuesFile
        Write-Host "📝 Using values file: $ValuesFile" -ForegroundColor Cyan
    } else {
        Write-Host "❌ Error: Values file not found: $ValuesFile" -ForegroundColor Red
        exit 1
    }
}

# Install/upgrade chart
Write-Host ""
Write-Host "🚀 Installing/upgrading chart..." -ForegroundColor Cyan
Write-Host "Command: helm $($helmArgs -join ' ')" -ForegroundColor Gray
Write-Host ""

& helm $helmArgs

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Installation failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Chart installed successfully!" -ForegroundColor Green

# Wait for pods to be ready
if ($WaitReady) {
    Write-Host ""
    Write-Host "⏳ Waiting for pods to be ready..." -ForegroundColor Cyan
    kubectl wait --for=condition=ready pod -l "app.kubernetes.io/instance=$ReleaseName" -n $Namespace --timeout=300s
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ All pods are ready!" -ForegroundColor Green
    } else {
        Write-Host "⚠️  Some pods may not be ready yet" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "ℹ️  Database migrations are automatically applied on API startup" -ForegroundColor Cyan

# Show access information
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🔗 Access Information" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Dashboard: http://localhost:30000" -ForegroundColor Green
Write-Host "API:       http://localhost:30002" -ForegroundColor Green
Write-Host "MQTT:      mqtt://localhost:30883" -ForegroundColor Green
Write-Host ""
Write-Host "📊 View status:" -ForegroundColor Cyan
Write-Host "  kubectl get pods -n $Namespace" -ForegroundColor Gray
Write-Host ""
Write-Host "📝 View logs:" -ForegroundColor Cyan
Write-Host "  kubectl logs -n $Namespace -l app.kubernetes.io/instance=$ReleaseName -f --all-containers" -ForegroundColor Gray
Write-Host ""
Write-Host "🗑️  Uninstall:" -ForegroundColor Cyan
Write-Host "  .\install.ps1 -Uninstall" -ForegroundColor Gray
Write-Host ""
