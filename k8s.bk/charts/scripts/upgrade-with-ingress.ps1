# Script to upgrade all customer instances with ingress enabled
# Run this after configuring local DNS

$customers = @(
    @{ namespace = "customer-407c7bd3"; release = "c407c7bd3-customer-instance" },
    @{ namespace = "customer-6f60b3ef"; release = "c6f60b3ef-customer-instance" },
    @{ namespace = "customer-c7e190b5"; release = "cc7e190b5-customer-instance" },
    @{ namespace = "customer-d5f8c71b"; release = "cd5f8c71b-customer-instance" }
)

Write-Host "Upgrading customer instances with ingress configuration..." -ForegroundColor Cyan

foreach ($customer in $customers) {
    Write-Host "`nUpgrading $($customer.release)..." -ForegroundColor Yellow
    
    helm upgrade $customer.release ./charts/customer-instance `
        --namespace $customer.namespace `
        --reuse-values `
        --set ingress.enabled=true `
        --set domain.base=iotistic.local `
        --set ingress.tls.enabled=false `
        --set ingress.annotations."nginx\.ingress\.kubernetes\.io/ssl-redirect"=false
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Successfully upgraded $($customer.release)" -ForegroundColor Green
    } else {
        Write-Host "✗ Failed to upgrade $($customer.release)" -ForegroundColor Red
    }
}

Write-Host "`n" -ForegroundColor White
Write-Host "Waiting for ingress resources to be created..." -ForegroundColor Cyan
Start-Sleep -Seconds 5

Write-Host "`nChecking ingress resources:" -ForegroundColor Yellow
kubectl get ingress --all-namespaces -l managed-by=iotistic

Write-Host "`n" -ForegroundColor White
Write-Host "To complete setup:" -ForegroundColor Cyan
Write-Host "1. Run configure-local-ingress.ps1 as Administrator to update hosts file" -ForegroundColor White
Write-Host "2. Access your customer dashboards at:" -ForegroundColor White
foreach ($customer in $customers) {
    $customerId = $customer.namespace -replace "^customer-", ""
    Write-Host "   http://$customerId.iotistic.local" -ForegroundColor Green
}
