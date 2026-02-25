# Test Cancellation and Deactivation Flow
# Tests all cancellation endpoints and scenarios

param(
    [Parameter(Mandatory=$true)]
    [string]$CustomerId,
    
    [Parameter(Mandatory=$false)]
    [string]$BaseUrl = "http://localhost:3100",
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("graceful", "immediate", "immediate-refund", "deactivate", "reactivate")]
    [string]$Scenario
)

$ErrorActionPreference = "Stop"

# If no scenario provided, prompt user to select one
if (-not $Scenario) {
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  Select Cancellation Scenario" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan
    
    Write-Host "Available scenarios:" -ForegroundColor Yellow
    Write-Host "  [1] graceful          - Cancel at period end (customer keeps access)" -ForegroundColor White
    Write-Host "  [2] immediate         - Cancel now without refund" -ForegroundColor White
    Write-Host "  [3] immediate-refund  - Cancel now with pro-rated refund" -ForegroundColor White
    Write-Host "  [4] deactivate        - Complete deactivation (cancel + refund + data deletion)" -ForegroundColor White
    Write-Host "  [5] reactivate        - Restore deactivated customer" -ForegroundColor White
    
    Write-Host "`nEnter selection [1-5] (default: 1): " -ForegroundColor Cyan -NoNewline
    $selection = Read-Host
    
    if ([string]::IsNullOrWhiteSpace($selection)) {
        $selection = "1"
    }
    
    switch ($selection) {
        "1" { $Scenario = "graceful" }
        "2" { $Scenario = "immediate" }
        "3" { $Scenario = "immediate-refund" }
        "4" { $Scenario = "deactivate" }
        "5" { $Scenario = "reactivate" }
        default {
            Write-Host "Invalid selection. Using default: graceful" -ForegroundColor Yellow
            $Scenario = "graceful"
        }
    }
    
    Write-Host "`n✓ Selected scenario: $Scenario`n" -ForegroundColor Green
}

# Color output helpers
function Write-Header($text) {
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan
}

function Write-Step($text) {
    Write-Host "➜ $text" -ForegroundColor Yellow
}

function Write-Success($text) {
    Write-Host "✓ $text" -ForegroundColor Green
}

function Write-Error($text) {
    Write-Host "✗ $text" -ForegroundColor Red
}

function Write-Info($text) {
    Write-Host "ℹ $text" -ForegroundColor Blue
}

# API call helper
function Invoke-ApiCall {
    param(
        [string]$Method = "GET",
        [string]$Endpoint,
        [object]$Body = $null
    )
    
    $url = "$BaseUrl$Endpoint"
    $headers = @{
        "Content-Type" = "application/json"
    }
    
    try {
        if ($Body) {
            $jsonBody = $Body | ConvertTo-Json
            $response = Invoke-RestMethod -Uri $url -Method $Method -Headers $headers -Body $jsonBody
        } else {
            $response = Invoke-RestMethod -Uri $url -Method $Method -Headers $headers
        }
        return $response
    }
    catch {
        # Get the actual response body for better error messages
        $statusCode = "Unknown"
        $errorMessage = $_.Exception.Message
        
        # Check if there's an ErrorDetails with a message
        if ($_.ErrorDetails.Message) {
            try {
                $errorObj = $_.ErrorDetails.Message | ConvertFrom-Json
                if ($errorObj.error) {
                    $errorMessage = $errorObj.error
                } else {
                    $errorMessage = $_.ErrorDetails.Message
                }
            }
            catch {
                $errorMessage = $_.ErrorDetails.Message
            }
        }
        
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        
        throw "API Error ($statusCode): $errorMessage"
    }
}

# Get current subscription
Write-Header "Current Subscription Status"
Write-Step "Fetching subscription for: $CustomerId"
Write-Host "  URL: $BaseUrl/api/subscriptions/$CustomerId" -ForegroundColor DarkGray

try {
    $subscription = Invoke-ApiCall -Method GET -Endpoint "/api/subscriptions/$CustomerId"
    
    Write-Success "Subscription found"
    Write-Info "Plan: $($subscription.subscription.plan)"
    Write-Info "Status: $($subscription.subscription.status)"
    Write-Info "Created: $($subscription.subscription.created_at)"
    
    if ($subscription.subscription.stripe_subscription_id) {
        Write-Info "Stripe ID: $($subscription.subscription.stripe_subscription_id)"
    }
    
    if ($subscription.subscription.trial_end) {
        Write-Info "Trial End: $($subscription.subscription.trial_end)"
    }
}
catch {
    Write-Error "Failed to fetch subscription: $_"
    exit 1
}

# Execute selected scenario
switch ($Scenario) {
    "graceful" {
        Write-Header "Scenario: Graceful Cancellation (Cancel at Period End)"
        
        Write-Step "Canceling subscription at period end..."
        
        $result = Invoke-ApiCall -Method POST -Endpoint "/api/subscriptions/cancel-at-period-end" -Body @{
            customer_id = $CustomerId
        }
        
        Write-Success "Subscription will cancel at period end"
        Write-Info "Customer can continue using service until: $($result.subscription.current_period_end)"
        Write-Info "Cancel at period end: $($result.subscription.cancel_at_period_end)"
        
        # Show how to undo
        Write-Host "`nTo undo this cancellation, run:" -ForegroundColor Magenta
        Write-Host "  .\test-cancellation-flow.ps1 -CustomerId $CustomerId -Scenario reactivate" -ForegroundColor Magenta
    }
    
    "immediate" {
        Write-Header "Scenario: Immediate Cancellation (No Refund)"
        
        Write-Step "Canceling subscription immediately..."
        
        $result = Invoke-ApiCall -Method POST -Endpoint "/api/subscriptions/cancel-immediate" -Body @{
            customer_id = $CustomerId
            issue_refund = $false
        }
        
        Write-Success "Subscription canceled immediately"
        Write-Info "Access ended: Now"
        Write-Info "Refund issued: No"
    }
    
    "immediate-refund" {
        Write-Header "Scenario: Immediate Cancellation with Pro-Rated Refund"
        
        Write-Step "Calculating pro-rated refund..."
        
        $result = Invoke-ApiCall -Method POST -Endpoint "/api/subscriptions/cancel-immediate" -Body @{
            customer_id = $CustomerId
            issue_refund = $true
            refund_reason = "requested_by_customer"
        }
        
        Write-Success "Subscription canceled immediately"
        
        if ($result.refund) {
            $refundAmount = $result.refund.amount / 100
            Write-Success "Refund issued: $$refundAmount"
            Write-Info "Refund ID: $($result.refund.refundId)"
            Write-Info "Status: $($result.refund.status)"
        } else {
            Write-Info "No refund issued (may be trial or no payment)"
        }
    }
    
    "deactivate" {
        Write-Header "Scenario: Complete Customer Deactivation"
        
        Write-Step "Deactivating customer (cancel + refund + schedule deletion)..."
        
        $result = Invoke-ApiCall -Method POST -Endpoint "/api/subscriptions/deactivate" -Body @{
            customer_id = $CustomerId
            cancel_subscription = $true
            issue_refund = $true
            refund_reason = "requested_by_customer"
            delete_data = $true
            retention_days = 30
            cancel_at_period_end = $false
        }
        
        Write-Success "Customer deactivated"
        Write-Info "Subscription canceled: $($result.result.subscriptionCanceled)"
        Write-Info "Refund issued: $($result.result.refundIssued)"
        
        if ($result.result.refundAmount) {
            $refundAmount = $result.result.refundAmount / 100
            Write-Info "Refund amount: $$refundAmount"
        }
        
        Write-Info "Data scheduled for deletion: $($result.result.dataScheduledForDeletion)"
        
        if ($result.result.scheduledDeletionDate) {
            Write-Info "Deletion date: $($result.result.scheduledDeletionDate)"
        }
        
        Write-Info "License revoked: $($result.result.licenseRevoked)"
        
        Write-Host "`nCustomer has 30 days to reactivate. After that, all data will be permanently deleted." -ForegroundColor Yellow
    }
    
    "reactivate" {
        Write-Header "Scenario: Reactivate Customer"
        
        Write-Step "Reactivating customer..."
        
        $result = Invoke-ApiCall -Method POST -Endpoint "/api/subscriptions/reactivate" -Body @{
            customer_id = $CustomerId
        }
        
        Write-Success "Customer reactivated"
        Write-Info "Scheduled deletion: Canceled"
        Write-Info "Account status: Active"
    }
}

# Show refund history
Write-Header "Refund History"
Write-Step "Fetching refunds for: $CustomerId"

try {
    $refunds = Invoke-ApiCall -Method GET -Endpoint "/api/subscriptions/$CustomerId/refunds"
    
    if ($refunds.refunds.Count -gt 0) {
        Write-Success "Found $($refunds.refunds.Count) refund(s)"
        
        foreach ($refund in $refunds.refunds) {
            $amount = $refund.amount / 100
            Write-Host "`n  Refund ID: $($refund.stripe_refund_id)" -ForegroundColor Cyan
            Write-Host "  Amount: $$amount" -ForegroundColor Cyan
            Write-Host "  Reason: $($refund.reason)" -ForegroundColor Cyan
            Write-Host "  Status: $($refund.status)" -ForegroundColor Cyan
            Write-Host "  Date: $($refund.created_at)" -ForegroundColor Cyan
        }
    } else {
        Write-Info "No refunds found"
    }
}
catch {
    Write-Info "No refunds found"
}

# Show scheduled deletions
if ($Scenario -eq "deactivate") {
    Write-Header "Scheduled Deletions"
    Write-Step "Fetching all scheduled deletions..."
    
    try {
        $deletions = Invoke-ApiCall -Method GET -Endpoint "/api/subscriptions/scheduled-deletions"
        
        if ($deletions.deletions.Count -gt 0) {
            Write-Success "Found $($deletions.deletions.Count) scheduled deletion(s)"
            
            foreach ($deletion in $deletions.deletions) {
                Write-Host "`n  Customer: $($deletion.customer_id)" -ForegroundColor Yellow
                Write-Host "  Email: $($deletion.email)" -ForegroundColor Yellow
                Write-Host "  Company: $($deletion.company_name)" -ForegroundColor Yellow
                Write-Host "  Deleted: $($deletion.deleted_at)" -ForegroundColor Yellow
                Write-Host "  Scheduled Deletion: $($deletion.scheduled_deletion)" -ForegroundColor Yellow
            }
        } else {
            Write-Info "No scheduled deletions"
        }
    }
    catch {
        Write-Info "No scheduled deletions"
    }
}

Write-Host "`n"
Write-Header "Test Complete"

Write-Host "Available Scenarios:" -ForegroundColor Cyan
Write-Host "  graceful          - Cancel at period end (customer keeps access)" -ForegroundColor Gray
Write-Host "  immediate         - Cancel now without refund" -ForegroundColor Gray
Write-Host "  immediate-refund  - Cancel now with pro-rated refund" -ForegroundColor Gray
Write-Host "  deactivate        - Complete deactivation (cancel + refund + data deletion)" -ForegroundColor Gray
Write-Host "  reactivate        - Restore deactivated customer" -ForegroundColor Gray

Write-Host "`nExample Usage:" -ForegroundColor Cyan
Write-Host "  .\test-cancellation-flow.ps1 -CustomerId cust_abc123 -Scenario graceful" -ForegroundColor Gray
Write-Host "  .\test-cancellation-flow.ps1 -CustomerId cust_abc123 -Scenario deactivate" -ForegroundColor Gray
