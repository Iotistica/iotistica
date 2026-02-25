# Setup Azure Service Principal for Billing Service K8s Access
# Run this script to create credentials for the billing container to access AKS

Write-Host "`n🔐 Creating Service Principal for Billing Service..." -ForegroundColor Cyan
Write-Host "============================================`n" -ForegroundColor Cyan

# Configuration
$RESOURCE_GROUP = "node-red-demo-aks-rg"
$CLUSTER_NAME = "aks-demo"
$SP_NAME = "iotistic-billing-k8s"

# Create service principal
Write-Host "📝 Creating Service Principal: $SP_NAME..." -ForegroundColor Yellow
$SP = az ad sp create-for-rbac --name $SP_NAME --skip-assignment --output json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to create Service Principal. Check if you're logged in: az login" -ForegroundColor Red
    exit 1
}

$APP_ID = $SP.appId
$PASSWORD = $SP.password
$TENANT_ID = $SP.tenant

Write-Host "✅ Service Principal created successfully!" -ForegroundColor Green
Write-Host "   APP_ID: $APP_ID" -ForegroundColor Gray
Write-Host "   TENANT_ID: $TENANT_ID" -ForegroundColor Gray

# Get AKS resource ID
Write-Host "`n📋 Getting AKS cluster info..." -ForegroundColor Yellow
$CLUSTER_ID = az aks show --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME --query id -o tsv

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to get AKS cluster info. Check resource group and cluster name." -ForegroundColor Red
    exit 1
}

Write-Host "   Cluster ID: $CLUSTER_ID" -ForegroundColor Gray

# Grant permissions to AKS cluster
Write-Host "`n🔑 Granting AKS Cluster Admin Role to Service Principal..." -ForegroundColor Yellow
az role assignment create `
  --assignee $APP_ID `
  --role "Azure Kubernetes Service Cluster Admin Role" `
  --scope $CLUSTER_ID | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to assign role. You may need 'Owner' or 'User Access Administrator' role." -ForegroundColor Red
    exit 1
}

Write-Host "✅ Role assigned successfully!" -ForegroundColor Green

# Get AKS credentials for the service principal
Write-Host "`n📥 Getting AKS credentials..." -ForegroundColor Yellow
$KUBECONFIG_PATH = "$env:USERPROFILE\.kube\config-aks-billing"

# Login as service principal and get credentials
$env:AZURE_CLIENT_ID = $APP_ID
$env:AZURE_CLIENT_SECRET = $PASSWORD
$env:AZURE_TENANT_ID = $TENANT_ID

az login --service-principal `
  --username $APP_ID `
  --password $PASSWORD `
  --tenant $TENANT_ID `
  --output none

az aks get-credentials `
  --resource-group $RESOURCE_GROUP `
  --name $CLUSTER_NAME `
  --file $KUBECONFIG_PATH `
  --overwrite-existing

# Logout service principal, login back as user
az logout
az login --output none

Write-Host "✅ Kubeconfig saved to: $KUBECONFIG_PATH" -ForegroundColor Green

# Create .env entries
$ENV_FILE = Join-Path (Split-Path $PSScriptRoot) ".env.azure"
@"
# Azure Service Principal Configuration
# Generated: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

AZURE_TENANT_ID=$TENANT_ID
AZURE_CLIENT_ID=$APP_ID
AZURE_CLIENT_SECRET=$PASSWORD
AKS_RESOURCE_GROUP=$RESOURCE_GROUP
AKS_CLUSTER_NAME=$CLUSTER_NAME

# Disable K8s simulation to use real AKS
SIMULATE_K8S_DEPLOYMENT=false
"@ | Out-File -FilePath $ENV_FILE -Encoding UTF8

Write-Host "`n✅ Setup complete!" -ForegroundColor Green
Write-Host "`n📝 Configuration saved to: $ENV_FILE" -ForegroundColor Cyan
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "1. Copy credentials from $ENV_FILE to billing/.env" -ForegroundColor White
Write-Host "2. Update docker-compose.yml to mount kubeconfig:" -ForegroundColor White
Write-Host "   volumes:" -ForegroundColor Gray
Write-Host "     - ${USERPROFILE}/.kube/config-aks-billing:/root/.kube/config:ro" -ForegroundColor Gray
Write-Host "3. Rebuild billing container with kubectl/helm:" -ForegroundColor White
Write-Host "   cd billing && docker-compose down && docker-compose up -d --build" -ForegroundColor Gray
Write-Host "4. Test deployment with a new customer signup" -ForegroundColor White
Write-Host "`n⚠️  IMPORTANT: Keep $ENV_FILE secure - it contains credentials!" -ForegroundColor Red
