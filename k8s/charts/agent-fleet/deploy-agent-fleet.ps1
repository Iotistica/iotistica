# Quick Agent Fleet Deployment Script
# Usage: .\deploy-agent-fleet.ps1

param(
    [int]$AgentCount = 5,
    [string]$ApiUrl = "http://23.233.80.107:30002",
    [string]$FleetId = "k8s-fleet-test",
    [string]$Namespace = "agent-fleet-test"
)

Write-Host " Agent Fleet Deployment" -ForegroundColor Cyan
Write-Host "  Agents: $AgentCount" -ForegroundColor Gray
Write-Host "  API: $ApiUrl" -ForegroundColor Gray
Write-Host "  Fleet ID: $FleetId" -ForegroundColor Gray
Write-Host "  Namespace: $Namespace" -ForegroundColor Gray
Write-Host ""

# Step 1: Generate provisioning keys
Write-Host "1  Generating provisioning keys..." -ForegroundColor Yellow
.\scripts\generate-provisioning-keys.ps1 -Count $AgentCount -ApiUrl $ApiUrl -FleetId $FleetId | Out-File -Encoding utf8 keys-temp.env
if ($LASTEXITCODE -ne 0) {
    Write-Host " Failed to generate provisioning keys" -ForegroundColor Red
    exit 1
}
Write-Host " Generated $AgentCount keys" -ForegroundColor Green

# Step 2: Create namespace
Write-Host "2  Creating namespace..." -ForegroundColor Yellow
kubectl create namespace $Namespace --dry-run=client -o yaml | kubectl apply -f - 2>$null
Write-Host " Namespace ready" -ForegroundColor Green

# Step 3: Create secret
Write-Host "3  Creating provisioning keys secret..." -ForegroundColor Yellow
kubectl create secret generic agent-provisioning-keys `
    --from-env-file=keys-temp.env `
    -n $Namespace `
    --dry-run=client -o yaml | kubectl apply -f -
if ($LASTEXITCODE -ne 0) {
    Write-Host " Failed to create secret" -ForegroundColor Red
    exit 1
}
Write-Host " Secret created" -ForegroundColor Green

# Step 4: Deploy with Helm
Write-Host "4️⃣  Deploying fleet with Helm..." -ForegroundColor Yellow
helm upgrade --install agent-fleet-test . `
    --namespace $Namespace `
    --set fleet.replicaCount=$AgentCount `
    --set fleet.cloudApiEndpoint=$ApiUrl `
    --set fleet.fleetId=$FleetId `
    --set provisioning.existingSecret=agent-provisioning-keys `
    --set provisioning.required=true `
    --set monitoring.serviceMonitor.enabled=false `
    --set podDisruptionBudget.enabled=false `
    --wait `
    --timeout 5m

if ($LASTEXITCODE -ne 0) {
    Write-Host " Deployment failed" -ForegroundColor Red
    exit 1
}

Write-Host " Fleet deployed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host " Check status:" -ForegroundColor Cyan
Write-Host "  kubectl get pods -n $Namespace" -ForegroundColor Gray
Write-Host "  kubectl logs -n $Namespace agent-fleet-test-0 -c agent" -ForegroundColor Gray
Write-Host ""
Write-Host " Cleanup:" -ForegroundColor Cyan
Write-Host "  helm uninstall agent-fleet-test -n $Namespace" -ForegroundColor Gray
Write-Host "  kubectl delete namespace $Namespace" -ForegroundColor Gray

# Cleanup temp file
Remove-Item keys-temp.env -ErrorAction SilentlyContinue
