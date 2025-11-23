# Quick script to add hosts entries for current customer instances
# Run as Administrator

$hostsPath = "C:\Windows\System32\drivers\etc\hosts"

# Backup hosts file
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $hostsPath "$hostsPath.backup-$timestamp"

# Get current hosts content
$hostsContent = Get-Content $hostsPath

# Remove old iotistic entries
$hostsContent = $hostsContent | Where-Object { $_ -notmatch "\.localhost.*# Iotistic" }

# Add new entries
$newEntries = @(
    "",
    "# Iotistic Customer Instances",
    "127.0.0.1    01d5b2ec.localhost    # Iotistic",
    "127.0.0.1    65160a0f.localhost    # Iotistic"
)

# Write updated content
$hostsContent + $newEntries | Set-Content $hostsPath

Write-Host "Hosts file updated!" -ForegroundColor Green
Write-Host "`nYou can now access:" -ForegroundColor Cyan
Write-Host "  http://01d5b2ec.localhost" -ForegroundColor White
Write-Host "  http://65160a0f.localhost" -ForegroundColor White
