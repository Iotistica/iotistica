# Script to configure local DNS for customer instances
# Run as Administrator

$customersToMap = @(
    "customer-407c7bd3",
    "customer-6f60b3ef",
    "customer-c7e190b5",
    "customer-d5f8c71b"
)

$baseDomain = "iotistic.local"
$hostsPath = "C:\Windows\System32\drivers\etc\hosts"

Write-Host "Configuring local DNS entries..." -ForegroundColor Cyan

# Backup hosts file
Copy-Item $hostsPath "$hostsPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

# Get current hosts content
$hostsContent = Get-Content $hostsPath

# Remove old iotistic.local entries
$hostsContent = $hostsContent | Where-Object { $_ -notmatch "iotistic\.local" }

# Add header comment
$newEntries = @("", "# Iotistic Customer Instances (Local K8s)")

# Add entries for each customer
foreach ($customer in $customersToMap) {
    # Extract customer ID (remove 'customer-' prefix)
    $customerId = $customer -replace "^customer-", ""
    $entry = "127.0.0.1    $customerId.$baseDomain"
    $newEntries += $entry
    Write-Host "  Adding: $entry" -ForegroundColor Green
}

# Write updated content
$hostsContent + $newEntries | Set-Content $hostsPath

Write-Host "`nHosts file updated successfully!" -ForegroundColor Green
Write-Host "`nYou can now access customer instances at:" -ForegroundColor Yellow
foreach ($customer in $customersToMap) {
    $customerId = $customer -replace "^customer-", ""
    Write-Host "  http://$customerId.$baseDomain" -ForegroundColor White
}

Write-Host "`nNote: Make sure nginx ingress controller is running!" -ForegroundColor Cyan
Write-Host "Check with: kubectl get pods -n ingress-nginx" -ForegroundColor Gray
