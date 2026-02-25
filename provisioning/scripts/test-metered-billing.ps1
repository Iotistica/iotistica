#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test Stripe metered billing usage reporting

.DESCRIPTION
    Tests the complete flow of reporting usage metrics to the billing API
    and verifying they appear in Stripe.

.PARAMETER CustomerId
    Customer ID to test with (e.g., cust_abc123...)

.PARAMETER DeviceCount
    Number of devices to report (default: 3)

.EXAMPLE
    .\test-metered-billing.ps1 -CustomerId "cust_b4c867f4..."
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$CustomerId,
    
    [Parameter(Mandatory=$false)]
    [int]$DeviceCount = 3,
    
    [Parameter(Mandatory=$false)]
    [string]$BillingApiUrl = "http://localhost:3100"
)

$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Stripe Metered Billing Test" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Step 1: Get or select customer
if (-not $CustomerId) {
    Write-Host "▶ Fetching customers..." -ForegroundColor Yellow
    
    $response = Invoke-RestMethod -Uri "$BillingApiUrl/api/customers" -Method Get
    $activeCustomers = $response.customers | Where-Object { 
        $_.deployment_status -eq 'ready' -and $_.stripe_customer_id 
    }
    
    if ($activeCustomers.Count -eq 0) {
        Write-Host "❌ No active customers with Stripe subscriptions found" -ForegroundColor Red
        Write-Host "   Please create a customer first with: .\complete-signup-workflow.ps1" -ForegroundColor Yellow
        exit 1
    }
    
    Write-Host "`nActive customers with Stripe subscriptions:" -ForegroundColor Green
    $activeCustomers | ForEach-Object -Begin { $i = 1 } -Process {
        Write-Host "  $i. $($_.customer_id) - $($_.email)" -ForegroundColor White
        $i++
    }
    
    $selection = Read-Host "`nSelect customer number"
    $CustomerId = $activeCustomers[$selection - 1].customer_id
}

Write-Host "`n✅ Testing with customer: $CustomerId`n" -ForegroundColor Green

# Step 2: Verify customer exists and has Stripe subscription
Write-Host "▶ Verifying customer..." -ForegroundColor Yellow

$customerResponse = Invoke-RestMethod -Uri "$BillingApiUrl/api/customers" -Method Get
$customer = $customerResponse.customers | Where-Object { $_.customer_id -eq $CustomerId }

if (-not $customer) {
    Write-Host "❌ Customer not found: $CustomerId" -ForegroundColor Red
    exit 1
}

if (-not $customer.stripe_customer_id) {
    Write-Host "❌ Customer has no Stripe subscription" -ForegroundColor Red
    Write-Host "   This customer needs to be created via Stripe checkout flow" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Customer verified:" -ForegroundColor Green
Write-Host "   Email: $($customer.email)" -ForegroundColor White
Write-Host "   Stripe ID: $($customer.stripe_customer_id)" -ForegroundColor White
Write-Host "   Status: $($customer.deployment_status)" -ForegroundColor White

# Step 3: Generate usage metrics
Write-Host "`n▶ Generating usage metrics..." -ForegroundColor Yellow

$usageData = @{
    customer_id = $CustomerId
    instance_id = "test-cluster"
    active_devices = $DeviceCount
    total_devices = $DeviceCount + 2
    metrics = @{
        devices = $DeviceCount
        mqtt_messages = Get-Random -Minimum 1000 -Maximum 50000
        storage_gb = [math]::Round((Get-Random -Minimum 1 -Maximum 10) + (Get-Random) / 2, 2)
        api_requests = Get-Random -Minimum 100 -Maximum 10000
    }
}

Write-Host "   Devices: $($usageData.metrics.devices)" -ForegroundColor Cyan
Write-Host "   MQTT Messages: $($usageData.metrics.mqtt_messages)" -ForegroundColor Cyan
Write-Host "   Storage: $($usageData.metrics.storage_gb) GB" -ForegroundColor Cyan
Write-Host "   API Requests: $($usageData.metrics.api_requests)" -ForegroundColor Cyan

# Step 4: Report usage to billing API
Write-Host "`n▶ Reporting usage to billing API..." -ForegroundColor Yellow

try {
    $reportResponse = Invoke-RestMethod `
        -Uri "$BillingApiUrl/api/usage/report" `
        -Method Post `
        -ContentType "application/json" `
        -Body ($usageData | ConvertTo-Json)
    
    Write-Host "✅ Usage reported successfully!" -ForegroundColor Green
    Write-Host "   Report ID: $($reportResponse.report.id)" -ForegroundColor White
    Write-Host "   Stripe Reported: $($reportResponse.stripe_reported)" -ForegroundColor White
    
    if ($reportResponse.stripe_reported) {
        Write-Host "`n✅ Usage successfully sent to Stripe!" -ForegroundColor Green
    } else {
        Write-Host "`n⚠️  Usage saved but not sent to Stripe" -ForegroundColor Yellow
        Write-Host "   Possible reasons:" -ForegroundColor Yellow
        Write-Host "   - No active subscription" -ForegroundColor Yellow
        Write-Host "   - Subscription doesn't have metered prices" -ForegroundColor Yellow
        Write-Host "   - Stripe API error (check billing service logs)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "❌ Failed to report usage: $_" -ForegroundColor Red
    exit 1
}

# Step 5: Verify in Stripe (manual step)
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Next Steps - Verify in Stripe Dashboard" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "1. Go to: https://dashboard.stripe.com/test/customers" -ForegroundColor White
Write-Host "2. Search for: $($customer.stripe_customer_id)" -ForegroundColor White
Write-Host "3. Click on their subscription" -ForegroundColor White
Write-Host "4. Scroll to 'Usage-based charges' section" -ForegroundColor White
Write-Host "5. You should see:" -ForegroundColor White
Write-Host "   - Device usage: $($usageData.metrics.devices) devices" -ForegroundColor Cyan
Write-Host "   - MQTT messages: $([math]::Round($usageData.metrics.mqtt_messages / 1000, 2)) (thousands)" -ForegroundColor Cyan
Write-Host "   - Storage: $([math]::Ceiling($usageData.metrics.storage_gb)) GB (rounded up)" -ForegroundColor Cyan

Write-Host "`n📊 View usage history:" -ForegroundColor Yellow
Write-Host "   GET $BillingApiUrl/api/usage/$CustomerId`n" -ForegroundColor White

Write-Host "✅ Test complete!`n" -ForegroundColor Green

# Optional: Fetch and display usage history
$viewHistory = Read-Host "View usage history? (y/n)"
if ($viewHistory -eq 'y') {
    Write-Host "`n▶ Fetching usage history..." -ForegroundColor Yellow
    
    $historyResponse = Invoke-RestMethod -Uri "$BillingApiUrl/api/usage/$CustomerId" -Method Get
    
    Write-Host "`nUsage Reports (Last $($historyResponse.reports.Count)):" -ForegroundColor Green
    $historyResponse.reports | Select-Object -First 5 | ForEach-Object {
        Write-Host "  • $($_.created_at) - Devices: $($_.active_devices)/$($_.total_devices)" -ForegroundColor White
    }
}

Write-Host ""
