# Configure Kubecost Azure Integration
# This script creates the necessary Kubernetes secret for Kubecost to access Azure cost data

param(
    [Parameter(Mandatory=$false)]
    [string]$SubscriptionId = "833accc2-1856-4e07-bcef-06cef4efdef2",
    
    [Parameter(Mandatory=$false)]
    [string]$StorageAccountName = "iotisticacosts9057",
    
    [Parameter(Mandatory=$true)]
    [string]$StorageAccountResourceGroup,
    
    [Parameter(Mandatory=$false)]
    [string]$ContainerName = "cost-exports",
    
    [Parameter(Mandatory=$false)]
    [string]$ContainerPath = "kubecost-daily-export",
    
    [Parameter(Mandatory=$false)]
    [string]$KubecostNamespace = "kubecost",
    
    [Parameter(Mandatory=$false)]
    [string]$SecretName = "kubecost-cloud-integration"
)

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Kubecost Azure Integration Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Step 1: Check kubectl
# ============================================================================
Write-Host "[1/5] Checking kubectl..." -ForegroundColor Green
$kubectlCommand = Get-Command kubectl -ErrorAction SilentlyContinue
if (-not $kubectlCommand) {
    Write-Error "kubectl not found. Please install kubectl first."
    exit 1
}
Write-Host "  ✓ kubectl found" -ForegroundColor Gray

# ============================================================================
# Step 2: Get Storage Account Key
# ============================================================================
Write-Host "[2/5] Getting storage account key..." -ForegroundColor Green

$storageKey = az storage account keys list `
    --resource-group $StorageAccountResourceGroup `
    --account-name $StorageAccountName `
    --query "[0].value" -o tsv 2>&1

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($storageKey)) {
    Write-Error "Failed to retrieve storage account key"
    Write-Host "Error: $storageKey" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Storage key retrieved" -ForegroundColor Gray

# ============================================================================
# Step 3: Create cloud-integration.json
# ============================================================================
Write-Host "[3/5] Creating cloud-integration.json..." -ForegroundColor Green

$cloudIntegration = @{
    azure = @(
        @{
            azureSubscriptionID = $SubscriptionId
            azureStorageAccount = $StorageAccountName
            azureStorageAccessKey = $storageKey
            azureStorageContainer = $ContainerName
            azureContainerPath = $ContainerPath
            azureCloud = "public"
        }
    )
} | ConvertTo-Json -Depth 10

$jsonFile = Join-Path $PSScriptRoot "cloud-integration.json"
$cloudIntegration | Out-File -FilePath $jsonFile -Encoding utf8 -NoNewline

if (Test-Path $jsonFile) {
    Write-Host "  ✓ Created: $jsonFile" -ForegroundColor Gray
} else {
    Write-Error "Failed to create cloud-integration.json"
    exit 1
}

# ============================================================================
# Step 4: Create Kubernetes Secret
# ============================================================================
Write-Host "[4/5] Creating Kubernetes secret..." -ForegroundColor Green

# Check if namespace exists
$namespaceCheck = kubectl get namespace $KubecostNamespace 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Namespace '$KubecostNamespace' not found. Creating it..."
    kubectl create namespace $KubecostNamespace
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create namespace"
        exit 1
    }
}

# Delete existing secret if it exists
$existingSecret = kubectl get secret $SecretName -n $KubecostNamespace 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Deleting existing secret..." -ForegroundColor Yellow
    kubectl delete secret $SecretName -n $KubecostNamespace
}

# Create new secret
kubectl create secret generic $SecretName `
    --from-file=$jsonFile `
    --namespace $KubecostNamespace

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create Kubernetes secret"
    exit 1
}
Write-Host "  ✓ Secret '$SecretName' created in namespace '$KubecostNamespace'" -ForegroundColor Gray

# ============================================================================
# Step 5: Cleanup and Instructions
# ============================================================================
Write-Host "[5/5] Cleanup..." -ForegroundColor Green

# Remove the JSON file (it contains sensitive data)
Remove-Item $jsonFile -Force -ErrorAction SilentlyContinue
Write-Host "  ✓ Removed cloud-integration.json (contains secrets)" -ForegroundColor Gray

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Add the following to your Kubecost Helm values.yaml:" -ForegroundColor White
Write-Host ""
Write-Host "   kubecostProductConfigs:" -ForegroundColor Yellow
Write-Host "     cloudIntegrationSecret: $SecretName" -ForegroundColor Yellow
Write-Host ""
Write-Host "2. Upgrade Kubecost:" -ForegroundColor White
Write-Host ""
Write-Host "   helm upgrade kubecost kubecost/cost-analyzer \" -ForegroundColor Yellow
Write-Host "     --namespace $KubecostNamespace \" -ForegroundColor Yellow
Write-Host "     -f values.yaml" -ForegroundColor Yellow
Write-Host ""
Write-Host "3. Wait 5-10 minutes for Kubecost to sync Azure cost data" -ForegroundColor White
Write-Host ""
Write-Host "4. Verify in Kubecost UI: Settings → Cloud Integrations → Azure" -ForegroundColor White
Write-Host ""
Write-Host "Configuration Summary:" -ForegroundColor Cyan
Write-Host "  Subscription ID:      $SubscriptionId" -ForegroundColor Gray
Write-Host "  Storage Account:      $StorageAccountName" -ForegroundColor Gray
Write-Host "  Container:            $ContainerName" -ForegroundColor Gray
Write-Host "  Container Path:       $ContainerPath" -ForegroundColor Gray
Write-Host "  Secret Name:          $SecretName" -ForegroundColor Gray
Write-Host "  Namespace:            $KubecostNamespace" -ForegroundColor Gray
Write-Host ""
