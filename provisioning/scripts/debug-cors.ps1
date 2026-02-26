#!/usr/bin/env pwsh
# Debug CORS configuration for a customer deployment

param(
    [Parameter(Mandatory=$true)]
    [string]$ClientId
)

$namespace = "client-$ClientId"

Write-Host "`n=== Checking CORS Configuration for $namespace ===" -ForegroundColor Cyan

# 1. Check if pod exists
Write-Host "`n1. Checking API pod status..." -ForegroundColor Yellow
kubectl get pods -n $namespace -l app=api

# 2. Get CORS_ORIGINS environment variable from pod
Write-Host "`n2. Checking CORS_ORIGINS environment variable..." -ForegroundColor Yellow
$apiPod = kubectl get pods -n $namespace -l app=api -o jsonpath='{.items[0].metadata.name}' 2>$null

if ($apiPod) {
    kubectl exec -n $namespace $apiPod -- env | Select-String "CORS"
} else {
    Write-Host "No API pod found in namespace $namespace" -ForegroundColor Red
}

# 3. Check API logs for CORS messages
Write-Host "`n3. Checking API logs for CORS..." -ForegroundColor Yellow
if ($apiPod) {
    kubectl logs -n $namespace $apiPod --tail=50 | Select-String -Pattern "CORS|cors|origin" -Context 1
}

# 4. Check values.yaml from GitOps repo
Write-Host "`n4. Checking generated values.yaml..." -ForegroundColor Yellow
$valuesPath = "iot-k8s-main/charts/iotistica-app/values/client-$ClientId/values.yaml"
if (Test-Path $valuesPath) {
    Get-Content $valuesPath | Select-String -Pattern "corsOrigins" -Context 2
} else {
    Write-Host "Values file not found: $valuesPath" -ForegroundColor Red
}

# 5. Test CORS with curl (if API is accessible)
Write-Host "`n5. Testing CORS headers..." -ForegroundColor Yellow
$apiUrl = "https://api-client-$ClientId.iotistica.com"
$dashboardUrl = "https://client-$ClientId.iotistica.com"

Write-Host "Testing: $apiUrl/api/v1/profiles?protocol=modbus" -ForegroundColor Gray
Write-Host "Origin: $dashboardUrl" -ForegroundColor Gray

# Preflight OPTIONS request
try {
    $response = curl -X OPTIONS "$apiUrl/api/v1/profiles?protocol=modbus" `
        -H "Origin: $dashboardUrl" `
        -H "Access-Control-Request-Method: GET" `
        -H "Access-Control-Request-Headers: content-type" `
        -v 2>&1 | Select-String "Access-Control"
    
    if ($response) {
        Write-Host "CORS Headers found:" -ForegroundColor Green
        $response
    } else {
        Write-Host "No CORS headers in response!" -ForegroundColor Red
    }
} catch {
    Write-Host "Failed to test CORS: $_" -ForegroundColor Red
}

Write-Host "`n=== Troubleshooting Tips ===" -ForegroundColor Cyan
Write-Host "If CORS_ORIGINS is wrong or missing:"
Write-Host "  1. Check if ArgoCD has synced the latest changes"
Write-Host "  2. Force sync: kubectl exec -n argocd argocd-server -- argocd app sync client-$ClientId"
Write-Host "  3. Restart API pod: kubectl rollout restart -n $namespace deployment/client-$ClientId-api"
Write-Host ""
Write-Host "If CORS_ORIGINS is correct but still failing:"
Write-Host "  1. Check API logs for startup errors"
Write-Host "  2. Verify the API is using the correct CORS middleware"
Write-Host "  3. Check for ingress/load balancer stripping headers"
