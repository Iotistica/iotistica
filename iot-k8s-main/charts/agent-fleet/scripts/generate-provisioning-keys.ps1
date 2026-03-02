# Generate provisioning keys for agent fleet deployment
#
# Usage: .\generate-provisioning-keys.ps1 -Count 100 [-ApiUrl "https://api.iotistic.com"] [-AuthToken "token"]
#
# Example:
#   .\generate-provisioning-keys.ps1 -Count 100 -ApiUrl "https://api.iotistic.com" -AuthToken $env:API_TOKEN

param(
    [Parameter(Mandatory=$true)]
    [ValidateRange(1, 1000)]
    [int]$Count,
    
    [Parameter(Mandatory=$false)]
    [string]$ApiUrl = "https://api.iotistic.com",
    
    [Parameter(Mandatory=$false)]
    [string]$FleetId = "k8s-fleet-default",
    
    [Parameter(Mandatory=$false)]
    [string]$AuthToken = ""
)

# Colors
$Red = "Red"
$Green = "Green"
$Yellow = "Yellow"

Write-Host "Generating $Count provisioning keys..." -ForegroundColor $Yellow

# Check if API is accessible
try {
    $healthCheck = Invoke-RestMethod -Uri "$ApiUrl/health" -Method Get -TimeoutSec 5 -ErrorAction Stop
    Write-Host "API endpoint is accessible" -ForegroundColor $Green
} catch {
    Write-Host "Error: API endpoint $ApiUrl is not accessible" -ForegroundColor $Red
    Write-Host $_.Exception.Message -ForegroundColor $Red
    exit 1
}

# Prepare headers
$headers = @{
    "Content-Type" = "application/json"
}

if ($AuthToken) {
    $headers["Authorization"] = "Bearer $AuthToken"
}

# Generate keys
$keys = @()
$success = 0
$failed = 0

for ($i = 0; $i -lt $Count; $i++) {
    # Show progress every 10 keys
    if ($i % 10 -eq 0) {
        Write-Host "Progress: $i/$Count keys generated..." -ForegroundColor $Yellow
    }
    
    # Prepare request body
    $body = @{
        fleetId = $FleetId
        newKey = $false
        metadata = @{
            index = $i
        }
    } | ConvertTo-Json
    
    try {
        # Make API request
        $response = Invoke-RestMethod -Uri "$ApiUrl/api/v1/provisioning-keys/generate" `
            -Method Post `
            -Headers $headers `
            -Body $body `
            -ErrorAction Stop
        
        # Extract provisioning key (API returns .key field)
        $keyValue = if ($response.key) { $response.key } elseif ($response.provisioningKey) { $response.provisioningKey } else { $null }
        
        if ($keyValue) {
            $keys += "PROVISIONING_KEY_$i=$keyValue"
            $success++
        } else {
            Write-Host "Failed to generate key $i (no key in response)" -ForegroundColor $Red
            $failed++
        }
    } catch {
        Write-Host "Failed to generate key $i : $($_.Exception.Message)" -ForegroundColor $Red
        $failed++
    }
}

Write-Host "`nSuccessfully generated: $success keys" -ForegroundColor $Green
if ($failed -gt 0) {
    Write-Host "Failed to generate: $failed keys" -ForegroundColor $Red
}

# Output keys
$keys | ForEach-Object { Write-Output $_ }

# Show usage instructions
Write-Host "`nKeys generated. To create Kubernetes secret:" -ForegroundColor $Yellow
Write-Host ".\generate-provisioning-keys.ps1 -Count $Count | Out-File -Encoding utf8 keys.env" -ForegroundColor $Green
Write-Host "kubectl create secret generic agent-provisioning-keys --from-env-file=keys.env -n agent-fleet" -ForegroundColor $Green
