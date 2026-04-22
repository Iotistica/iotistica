# PowerShell Script: Get AKS Admin Kubeconfig for Billing Container

Write-Host "📋 Getting AKS admin kubeconfig..." -ForegroundColor Cyan

# Get admin kubeconfig (doesn't require kubelogin)
az aks get-credentials `
  --resource-group node-red-demo-aks-rg `
  --name aks-demo `
  --admin `
  --file "$env:USERPROFILE\.kube\config-aks-admin" `
  --overwrite-existing

Write-Host "✅ Admin kubeconfig saved to: $env:USERPROFILE\.kube\config-aks-admin" -ForegroundColor Green
Write-Host ""
Write-Host "📝 Update docker-compose.yml to use this kubeconfig:" -ForegroundColor Yellow
Write-Host "   volumes:"
Write-Host "     - `${USERPROFILE}/.kube/config-aks-admin:/root/.kube/config:ro"
Write-Host ""
Write-Host "   environment:"
Write-Host "     KUBECONFIG: /root/.kube/config"
