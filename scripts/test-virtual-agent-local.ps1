# Virtual Agent Local Testing Script
# Automates end-to-end testing of virtual agent deployment on Docker Desktop K8s

param(
    [string]$AgentName = "test-agent-$(Get-Random -Maximum 9999)",
    [string]$FleetId = "default",
    [string]$Namespace = "virtual-agents",
    [string]$ApiUrl = "http://localhost:4002"
)

$ErrorActionPreference = "Stop"

Write-Host "🧪 Virtual Agent Local Testing Script" -ForegroundColor Cyan
Write-Host "======================================`n" -ForegroundColor Cyan

# Function to check command success
function Test-Command {
    param($Command, $Description)
    Write-Host "▶ $Description..." -NoNewline
    try {
        Invoke-Expression $Command | Out-Null
        Write-Host " ✅" -ForegroundColor Green
        return $true
    } catch {
        Write-Host " ❌" -ForegroundColor Red
        Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Phase 1: Prerequisites Check
Write-Host "`n📋 Phase 1: Prerequisites Check" -ForegroundColor Yellow

# Check kubectl
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Write-Host "❌ kubectl not found - ensure Docker Desktop K8s is enabled" -ForegroundColor Red
    exit 1
}
Write-Host "✅ kubectl found" -ForegroundColor Green

# Check K8s cluster
Write-Host "▶ Checking K8s cluster..." -NoNewline
try {
    $clusterInfo = kubectl cluster-info 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host " ✅" -ForegroundColor Green
    } else {
        Write-Host " ❌" -ForegroundColor Red
        Write-Host "  Error: K8s cluster not running. Enable in Docker Desktop Settings > Kubernetes" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host " ❌" -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor Red
    exit 1
}

# Check namespace
Write-Host "▶ Checking namespace '$Namespace'..." -NoNewline
$namespaceExists = kubectl get namespace $Namespace 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host " Creating..." -ForegroundColor Yellow
    kubectl create namespace $Namespace | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host " ✅" -ForegroundColor Green
    } else {
        Write-Host " ❌" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host " ✅" -ForegroundColor Green
}

# Check API is running
Write-Host "▶ Checking API at $ApiUrl..." -NoNewline
try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 5
    Write-Host " ✅" -ForegroundColor Green
} catch {
    Write-Host " ❌" -ForegroundColor Red
    Write-Host "  Error: API not responding. Run 'docker compose up -d api'" -ForegroundColor Red
    exit 1
}

# Phase 2: Create Virtual Agent
Write-Host "`n🚀 Phase 2: Create Virtual Agent" -ForegroundColor Yellow

Write-Host "▶ Creating virtual agent '$AgentName'..." -NoNewline
try {
    $body = @{
        name = $AgentName
        fleetId = $FleetId
        tags = @("test", "automated")
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$ApiUrl/api/v1/devices/virtual" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 10

    $deviceUuid = $response.deviceUuid
    Write-Host " ✅" -ForegroundColor Green
    Write-Host "  Device UUID: $deviceUuid" -ForegroundColor Cyan
    Write-Host "  Status: $($response.deploymentStatus)" -ForegroundColor Cyan
} catch {
    Write-Host " ❌" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "  Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
    exit 1
}

# Phase 3: Wait for Deployment
Write-Host "`n⏳ Phase 3: Wait for Deployment" -ForegroundColor Yellow

Write-Host "▶ Waiting for deployment (max 60s)..." -NoNewline
$maxWait = 60
$waited = 0
$deploymentReady = $false

while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 5
    $waited += 5
    
    try {
        $status = Invoke-RestMethod -Uri "$ApiUrl/api/v1/devices/$deviceUuid/deployment-status" -TimeoutSec 5
        
        if ($status.status -eq "running") {
            Write-Host " ✅" -ForegroundColor Green
            Write-Host "  Deployment: $($status.deploymentName)" -ForegroundColor Cyan
            Write-Host "  Pod: $($status.podName)" -ForegroundColor Cyan
            Write-Host "  Namespace: $($status.namespace)" -ForegroundColor Cyan
            $deploymentReady = $true
            break
        } elseif ($status.status -eq "failed") {
            Write-Host " ❌" -ForegroundColor Red
            Write-Host "  Error: $($status.error)" -ForegroundColor Red
            break
        }
        
        Write-Host "." -NoNewline -ForegroundColor Yellow
    } catch {
        Write-Host "." -NoNewline -ForegroundColor Yellow
    }
}

if (-not $deploymentReady) {
    Write-Host "`n  ⚠ Deployment not ready after ${waited}s" -ForegroundColor Yellow
}

# Phase 4: Verify K8s Resources
Write-Host "`n🔍 Phase 4: Verify K8s Resources" -ForegroundColor Yellow

# Check deployment
Write-Host "▶ Checking deployment..." -NoNewline
$deploymentName = "agent-$($deviceUuid.Substring(0, 8))"
$deployment = kubectl get deployment -n $Namespace $deploymentName 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host " ✅" -ForegroundColor Green
    kubectl get deployment -n $Namespace $deploymentName | Write-Host
} else {
    Write-Host " ❌ (not found)" -ForegroundColor Red
}

# Check pod
Write-Host "▶ Checking pod..." -NoNewline
$pods = kubectl get pods -n $Namespace -l app=$deploymentName -o json 2>&1 | ConvertFrom-Json
if ($pods.items.Count -gt 0) {
    $pod = $pods.items[0]
    $podName = $pod.metadata.name
    $podPhase = $pod.status.phase
    
    if ($podPhase -eq "Running") {
        Write-Host " ✅" -ForegroundColor Green
    } else {
        Write-Host " ⚠ ($podPhase)" -ForegroundColor Yellow
    }
    
    Write-Host "  Pod Name: $podName" -ForegroundColor Cyan
    Write-Host "  Phase: $podPhase" -ForegroundColor Cyan
    
    # Get pod logs (last 10 lines)
    Write-Host "`n📜 Pod Logs (last 10 lines):" -ForegroundColor Cyan
    Write-Host "----------------------------" -ForegroundColor Gray
    kubectl logs -n $Namespace $podName --tail=10 2>&1 | Write-Host
    Write-Host "----------------------------`n" -ForegroundColor Gray
} else {
    Write-Host " ❌ (not found)" -ForegroundColor Red
}

# Check secret
Write-Host "▶ Checking provisioning key secret..." -NoNewline
$secretName = "$deploymentName-prov-key"
$secret = kubectl get secret -n $Namespace $secretName 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host " ✅" -ForegroundColor Green
} else {
    Write-Host " ❌ (not found)" -ForegroundColor Red
}

# Phase 5: Cleanup (Optional)
Write-Host "`n🧹 Phase 5: Cleanup" -ForegroundColor Yellow
$cleanup = Read-Host "Delete virtual agent? (y/n)"

if ($cleanup -eq "y") {
    Write-Host "▶ Deleting virtual agent..." -NoNewline
    try {
        Invoke-RestMethod -Uri "$ApiUrl/api/v1/devices/$deviceUuid/virtual" `
            -Method DELETE `
            -TimeoutSec 10 | Out-Null
        Write-Host " ✅" -ForegroundColor Green
        
        # Wait for resources to be deleted
        Write-Host "▶ Waiting for K8s resources to be deleted..." -NoNewline
        Start-Sleep -Seconds 5
        
        $remainingPods = kubectl get pods -n $Namespace -l app=$deploymentName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host " ✅" -ForegroundColor Green
        } else {
            Write-Host " ⚠ (may take a few seconds)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host " ❌" -ForegroundColor Red
        Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "  Skipping cleanup. Device UUID: $deviceUuid" -ForegroundColor Cyan
    Write-Host "  To delete later: Invoke-RestMethod -Uri '$ApiUrl/api/v1/devices/$deviceUuid/virtual' -Method DELETE" -ForegroundColor Gray
}

# Summary
Write-Host "`n📊 Test Summary" -ForegroundColor Cyan
Write-Host "===============" -ForegroundColor Cyan
Write-Host "Device UUID: $deviceUuid"
Write-Host "Agent Name: $AgentName"
Write-Host "Namespace: $Namespace"
Write-Host "Deployment: $deploymentName"
if ($podName) {
    Write-Host "Pod: $podName"
}

Write-Host "`n✅ Testing complete!" -ForegroundColor Green
Write-Host "`nUseful commands:" -ForegroundColor Yellow
Write-Host "  View deployment: kubectl get deployment -n $Namespace $deploymentName" -ForegroundColor Gray
Write-Host "  View pod: kubectl get pods -n $Namespace -l app=$deploymentName" -ForegroundColor Gray
Write-Host "  View logs: kubectl logs -n $Namespace <pod-name> -f" -ForegroundColor Gray
Write-Host "  Check status: Invoke-RestMethod '$ApiUrl/api/v1/devices/$deviceUuid/deployment-status'" -ForegroundColor Gray
