# Test Upgrade Functionality
# This script demonstrates Tier 1 upgrade strategy for a customer instance

param(
    [Parameter(Mandatory=$false)]
    [string]$CustomerId,
    
    [Parameter(Mandatory=$false)]
    [string]$Version = "v1.0.1",
    
    [Parameter(Mandatory=$false)]
    [switch]$DryRun
)

$baseUrl = "http://localhost:3100"

Write-Host "=== Iotistic Upgrade Test ===" -ForegroundColor Cyan
Write-Host ""

# If no customer ID provided, get the first deployed customer
if (-not $CustomerId) {
    Write-Host "🔍 Finding deployed customer..." -ForegroundColor Yellow
    
    try {
        # Get customers from database (would need API endpoint for this)
        # For now, use the recently deployed customer
        $CustomerId = Read-Host "Enter Customer ID (e.g., cust_6ffadffe1ae94)"
    }
    catch {
        Write-Host "❌ Error finding customer" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Customer ID: $CustomerId" -ForegroundColor Green
Write-Host "Target Version: $Version" -ForegroundColor Green
Write-Host "Dry-Run: $DryRun" -ForegroundColor Green
Write-Host ""

# Step 1: Check if customer can be upgraded
Write-Host "📋 Step 1: Checking upgrade eligibility..." -ForegroundColor Cyan

try {
    $checkUrl = "$baseUrl/api/upgrades/${CustomerId}/can-upgrade?version=$Version"
    $eligibility = Invoke-RestMethod -Uri $checkUrl -Method GET
    
    if ($eligibility.canUpgrade) {
        Write-Host "✅ Customer can be upgraded" -ForegroundColor Green
    }
    else {
        Write-Host "❌ Customer cannot be upgraded:" -ForegroundColor Red
        $eligibility.reasons | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
        exit 1
    }
}
catch {
    Write-Host "❌ Error checking eligibility: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Step 2: Execute upgrade
Write-Host "🚀 Step 2: Starting upgrade..." -ForegroundColor Cyan

$upgradeBody = @{
    version = $Version
    dryRun = $DryRun.IsPresent
    force = $false
    timeout = 600
} | ConvertTo-Json

try {
    $upgradeUrl = "$baseUrl/api/upgrades/$CustomerId"
    Write-Host "POST $upgradeUrl" -ForegroundColor Gray
    Write-Host "Body: $upgradeBody" -ForegroundColor Gray
    Write-Host ""
    
    $result = Invoke-RestMethod -Uri $upgradeUrl -Method POST -Body $upgradeBody -ContentType "application/json"
    
    if ($result.success) {
        Write-Host "✅ Upgrade successful!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Results:" -ForegroundColor Cyan
        Write-Host "  Customer ID: $($result.customerId)" -ForegroundColor White
        Write-Host "  Namespace: $($result.namespace)" -ForegroundColor White
        Write-Host "  Version: $($result.version)" -ForegroundColor White
        Write-Host "  Duration: $([Math]::Round($result.duration / 1000, 2))s" -ForegroundColor White
        Write-Host "  Message: $($result.message)" -ForegroundColor White
    }
    else {
        Write-Host "❌ Upgrade failed!" -ForegroundColor Red
        Write-Host ""
        Write-Host "Error: $($result.error)" -ForegroundColor Red
        if ($result.rolledBack) {
            Write-Host "✅ Automatic rollback completed" -ForegroundColor Yellow
        }
        exit 1
    }
}
catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
    
    Write-Host "❌ Upgrade request failed (HTTP $statusCode)" -ForegroundColor Red
    Write-Host "Error: $($errorBody.error)" -ForegroundColor Red
    if ($errorBody.details) {
        Write-Host "Details: $($errorBody.details)" -ForegroundColor Red
    }
    exit 1
}

Write-Host ""

# Step 3: Get upgrade history
Write-Host "📜 Step 3: Viewing upgrade history..." -ForegroundColor Cyan

try {
    $historyUrl = "$baseUrl/api/upgrades/${CustomerId}/history"
    $history = Invoke-RestMethod -Uri $historyUrl -Method GET
    
    Write-Host "Total upgrades: $($history.count)" -ForegroundColor White
    
    if ($history.count -eq 0) {
        Write-Host "  (No upgrade history recorded yet)" -ForegroundColor Gray
    }
    else {
        $history.history | ForEach-Object {
            Write-Host "  - Version: $($_.version), Status: $($_.status), Date: $($_.date)" -ForegroundColor White
        }
    }
}
catch {
    Write-Host "⚠️  Could not fetch history: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Test Complete ===" -ForegroundColor Cyan
Write-Host ""

# Show verification commands
Write-Host "🔍 Verification Commands:" -ForegroundColor Cyan
Write-Host ""
Write-Host "# Check pod status" -ForegroundColor Gray
Write-Host "kubectl get pods -n $($result.namespace)" -ForegroundColor White
Write-Host ""
Write-Host "# Check pod image versions" -ForegroundColor Gray
Write-Host "kubectl get pods -n $($result.namespace) -o jsonpath='{range .items[*]}{.metadata.name}{\`"`\t\`"}{.spec.containers[*].image}{\`"`\n\`"}{end}'" -ForegroundColor White
Write-Host ""
Write-Host "# View API pod logs" -ForegroundColor Gray
Write-Host "kubectl logs -n $($result.namespace) -l app.kubernetes.io/component=api --tail=50" -ForegroundColor White
