# Cleanup Customer Namespace from Kubernetes
# Removes customer namespace and all associated resources

param(
    [Parameter(Mandatory=$false)]
    [string]$CustomerId = "a18ada74"
)

$namespace = "customer-$CustomerId"

Write-Host "🧹 Cleaning up customer namespace..." -ForegroundColor Cyan
Write-Host "   Namespace: $namespace" -ForegroundColor Gray
Write-Host ""

# Check if namespace exists
$namespaceCheck = kubectl get namespace $namespace 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  Namespace $namespace does not exist" -ForegroundColor Yellow
    exit 0
}

Write-Host "Found namespace: $namespace" -ForegroundColor Green
Write-Host ""

# List resources in namespace
Write-Host "📋 Resources in namespace:" -ForegroundColor Cyan
kubectl get all -n $namespace
Write-Host ""

# Confirm deletion
$confirm = Read-Host "Are you sure you want to delete namespace '$namespace' and all its resources? (yes/no)"

if ($confirm -ne "yes") {
    Write-Host "❌ Cleanup cancelled" -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Deleting namespace and all resources..." -ForegroundColor Yellow

# Delete the namespace (this will delete all resources in it)
kubectl delete namespace $namespace

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ Namespace $namespace deleted successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Cleaned up:" -ForegroundColor Cyan
    Write-Host "   - Namespace: $namespace" -ForegroundColor Gray
    Write-Host "   - All pods, services, deployments" -ForegroundColor Gray
    Write-Host "   - All ConfigMaps, Secrets" -ForegroundColor Gray
    Write-Host "   - All PersistentVolumeClaims" -ForegroundColor Gray
    Write-Host "   - Helm release data" -ForegroundColor Gray
    Write-Host ""
    Write-Host "💡 You can now deploy a new customer" -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "❌ Failed to delete namespace" -ForegroundColor Red
    Write-Host "Exit code: $LASTEXITCODE" -ForegroundColor Red
}

Write-Host ""
Write-Host "Remaining namespaces:" -ForegroundColor Cyan
kubectl get namespaces | Select-String customer-
