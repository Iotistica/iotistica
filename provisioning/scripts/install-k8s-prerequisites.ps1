# billing/scripts/install-k8s-prerequisites.ps1
# Install required Kubernetes CRDs for customer deployments
# This should be run once before deploying any customer instances

param(
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Iotistic K8s Prerequisites Installer                      ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if kubectl is available
Write-Host "✓ Checking kubectl..." -ForegroundColor Yellow
try {
    $null = kubectl version --client 2>$null
    Write-Host "  ✓ kubectl is installed" -ForegroundColor Green
}
catch {
    Write-Host "  ✗ kubectl not found" -ForegroundColor Red
    Write-Host "    Please install kubectl first: https://kubernetes.io/docs/tasks/tools/" -ForegroundColor Red
    exit 1
}

# Check cluster connection
Write-Host "✓ Checking cluster connection..." -ForegroundColor Yellow
try {
    $null = kubectl cluster-info 2>&1
    Write-Host "  ✓ Connected to Kubernetes cluster" -ForegroundColor Green
}
catch {
    Write-Host "  ✗ Cannot connect to Kubernetes cluster" -ForegroundColor Red
    Write-Host "    Make sure your kubeconfig is configured correctly" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ============================================================
# Install ServiceMonitor CRD (Required for Prometheus monitoring)
# ============================================================

Write-Host "📦 Installing ServiceMonitor CRD..." -ForegroundColor Cyan
Write-Host "   (Required for customer monitoring with Prometheus)" -ForegroundColor Gray
Write-Host ""

# Check if already installed
$servicemonitorExists = $false
try {
    $null = kubectl get crd servicemonitors.monitoring.coreos.com 2>$null
    $servicemonitorExists = $true
}
catch {
    $servicemonitorExists = $false
}

if ($servicemonitorExists -and -not $Force) {
    Write-Host "  ✓ ServiceMonitor CRD already installed" -ForegroundColor Green
    Write-Host "    Use -Force to reinstall" -ForegroundColor Gray
}
else {
    Write-Host "  → Installing ServiceMonitor CRD..." -ForegroundColor Yellow
    
    try {
        $crdUrl = "https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml"
        
        kubectl apply --server-side -f $crdUrl 2>&1 | Out-String | Write-Host
        
        Write-Host "  ✓ ServiceMonitor CRD installed successfully" -ForegroundColor Green
    }
    catch {
        Write-Host "  ✗ Failed to install ServiceMonitor CRD" -ForegroundColor Red
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# ============================================================
# Verify Installation
# ============================================================

Write-Host "🔍 Verifying installation..." -ForegroundColor Cyan
Write-Host ""

# Check ServiceMonitor CRD
try {
    $crd = kubectl get crd servicemonitors.monitoring.coreos.com -o json | ConvertFrom-Json
    $createdAt = $crd.metadata.creationTimestamp
    
    Write-Host "  ✓ ServiceMonitor CRD:" -ForegroundColor Green
    Write-Host "    Name:       servicemonitors.monitoring.coreos.com" -ForegroundColor Gray
    Write-Host "    Version:    $($crd.spec.versions[0].name)" -ForegroundColor Gray
    Write-Host "    Created:    $createdAt" -ForegroundColor Gray
}
catch {
    Write-Host "  ✗ ServiceMonitor CRD verification failed" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ============================================================
# Summary
# ============================================================

Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✓ All prerequisites installed successfully!               ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

Write-Host "📋 Next Steps:" -ForegroundColor Cyan
Write-Host "  1. Run customer signup workflow:" -ForegroundColor White
Write-Host "     .\complete-signup-workflow.ps1" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Or deploy manually:" -ForegroundColor White
Write-Host "     helm install customer-abc123 ../charts/customer-instance --namespace customer-abc123" -ForegroundColor Gray
Write-Host ""

Write-Host "💡 Tip: This script only needs to be run once per cluster" -ForegroundColor Yellow
Write-Host ""
