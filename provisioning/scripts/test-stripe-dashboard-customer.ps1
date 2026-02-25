# billing/scripts/test-stripe-dashboard-customer.ps1
# Test Stripe Dashboard Customer Creation Flow
# This script simulates creating a customer directly in Stripe Dashboard
# and verifies that the webhook properly creates the customer in billing DB

param(
    [string]$Plan = "professional",
    [string]$Email = "",
    [string]$Name = "",
    [string]$CompanyName = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Stripe Dashboard Customer Creation Test                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Generate test data if not provided
if ([string]::IsNullOrEmpty($Email)) {
    $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
    $Email = "dashboard-test-$timestamp@example.com"
}

if ([string]::IsNullOrEmpty($Name)) {
    $Name = "Dashboard Test User $(Get-Date -Format 'MMdd-HHmm')"
}

if ([string]::IsNullOrEmpty($CompanyName)) {
    $CompanyName = "Dashboard Test Company"
}

# Validate Stripe CLI is available
try {
    $stripeVersion = stripe --version 2>&1
    Write-Host "✓ Stripe CLI detected: $stripeVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Stripe CLI not found!" -ForegroundColor Red
    Write-Host "   Please install: https://stripe.com/docs/stripe-cli" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "📋 Test Configuration:" -ForegroundColor Cyan
Write-Host "  Email:        $Email" -ForegroundColor Gray
Write-Host "  Name:         $Name" -ForegroundColor Gray
Write-Host "  Company:      $CompanyName" -ForegroundColor Gray
Write-Host "  Plan:         $Plan" -ForegroundColor Gray
Write-Host ""

# Get price ID for plan
$priceId = switch ($Plan) {
    "starter" { $env:STRIPE_PRICE_STARTER }
    "professional" { $env:STRIPE_PRICE_PROFESSIONAL }
    "enterprise" { $env:STRIPE_PRICE_ENTERPRISE }
    default {
        Write-Host "❌ Invalid plan: $Plan" -ForegroundColor Red
        Write-Host "   Valid plans: starter, professional, enterprise" -ForegroundColor Yellow
        exit 1
    }
}

if ([string]::IsNullOrEmpty($priceId)) {
    Write-Host "❌ Price ID not found for plan: $Plan" -ForegroundColor Red
    Write-Host "   Make sure STRIPE_PRICE_${Plan.ToUpper()} environment variable is set" -ForegroundColor Yellow
    exit 1
}

Write-Host "  Price ID:     $priceId" -ForegroundColor Gray
Write-Host ""

# Step 1: Create Stripe Customer
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "STEP 1: Creating Stripe Customer" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

$createCustomerCommand = "stripe customers create --email `"$Email`" --name `"$Name`" --metadata[company_name]=`"$CompanyName`" --metadata[auto_provision]=true"

Write-Host "Running: $createCustomerCommand" -ForegroundColor DarkGray
Write-Host ""

$customerJson = Invoke-Expression $createCustomerCommand | Out-String
$customer = $customerJson | ConvertFrom-Json

if (-not $customer.id) {
    Write-Host "❌ Failed to create Stripe customer" -ForegroundColor Red
    Write-Host $customerJson -ForegroundColor Red
    exit 1
}

$stripeCustomerId = $customer.id

Write-Host "✓ Stripe customer created:" -ForegroundColor Green
Write-Host "  Customer ID:  $stripeCustomerId" -ForegroundColor Gray
Write-Host "  Email:        $($customer.email)" -ForegroundColor Gray
Write-Host "  Name:         $($customer.name)" -ForegroundColor Gray
Write-Host ""

# Step 2: Create Subscription
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "STEP 2: Creating Subscription" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

# Create test payment method
Write-Host "Creating test payment method..." -ForegroundColor DarkGray
$pmJson = stripe payment_methods create --type=card --card[number]=4242424242424242 --card[exp_month]=12 --card[exp_year]=2030 --card[cvc]=123 | Out-String
$paymentMethod = $pmJson | ConvertFrom-Json
$pmId = $paymentMethod.id

Write-Host "✓ Payment method created: $pmId" -ForegroundColor Green
Write-Host ""

# Attach payment method to customer
Write-Host "Attaching payment method to customer..." -ForegroundColor DarkGray
stripe payment_methods attach $pmId --customer=$stripeCustomerId | Out-Null
Write-Host "✓ Payment method attached" -ForegroundColor Green
Write-Host ""

# Set as default payment method
Write-Host "Setting default payment method..." -ForegroundColor DarkGray
stripe customers update $stripeCustomerId --invoice_settings[default_payment_method]=$pmId | Out-Null
Write-Host "✓ Default payment method set" -ForegroundColor Green
Write-Host ""

# Create subscription
Write-Host "Creating subscription..." -ForegroundColor DarkGray
$createSubCommand = "stripe subscriptions create --customer=$stripeCustomerId --items[0][price]=$priceId"

$subscriptionJson = Invoke-Expression $createSubCommand | Out-String
$subscription = $subscriptionJson | ConvertFrom-Json

if (-not $subscription.id) {
    Write-Host "❌ Failed to create subscription" -ForegroundColor Red
    Write-Host $subscriptionJson -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✓ Subscription created:" -ForegroundColor Green
Write-Host "  Subscription ID:  $($subscription.id)" -ForegroundColor Gray
Write-Host "  Status:           $($subscription.status)" -ForegroundColor Gray
Write-Host "  Plan:             $Plan" -ForegroundColor Gray
Write-Host ""

# Step 3: Wait for Webhook Processing
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "STEP 3: Waiting for Webhook Processing" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

Write-Host "⏳ Waiting for webhook to process..." -ForegroundColor Cyan
Write-Host "   (webhook events: customer.created, customer.subscription.created)" -ForegroundColor Gray
Write-Host ""

$maxAttempts = 10
$attempt = 0
$customerFound = $false
$billingCustomerId = $null

while ($attempt -lt $maxAttempts -and -not $customerFound) {
    $attempt++
    Start-Sleep -Seconds 2
    
    Write-Host "  Attempt $attempt/$maxAttempts..." -ForegroundColor DarkGray
    
    try {
        # Query billing API to find customer by Stripe customer ID
        $customers = Invoke-RestMethod -Uri "http://localhost:3100/api/customers" -Method GET -ErrorAction SilentlyContinue
        $billingCustomer = $customers | Where-Object { $_.stripe_customer_id -eq $stripeCustomerId }
        
        if ($billingCustomer) {
            $customerFound = $true
            $billingCustomerId = $billingCustomer.customer_id
        }
    } catch {
        # Continue waiting
    }
}

Write-Host ""

if ($customerFound) {
    Write-Host "✓ Customer found in billing database!" -ForegroundColor Green
    Write-Host "  Billing Customer ID: $billingCustomerId" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "⚠️  Customer not found in database after $maxAttempts attempts" -ForegroundColor Yellow
    Write-Host "   This may indicate webhook is not being received" -ForegroundColor Gray
    Write-Host ""
    Write-Host "🔍 Troubleshooting:" -ForegroundColor Cyan
    Write-Host "  1. Check webhook endpoint is running: http://localhost:3100/api/webhooks/stripe" -ForegroundColor White
    Write-Host "  2. Check Stripe CLI forwarding: stripe listen --forward-to localhost:3100/api/webhooks/stripe" -ForegroundColor White
    Write-Host "  3. Check billing service logs: docker logs billing-billing-1 -f" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Step 4: Verify Subscription in Database
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "STEP 4: Verifying Subscription" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

try {
    $sub = Invoke-RestMethod -Uri "http://localhost:3100/api/subscriptions/$billingCustomerId" -Method GET
    
    Write-Host "✓ Subscription verified!" -ForegroundColor Green
    Write-Host "  Status:           $($sub.subscription.status)" -ForegroundColor Gray
    Write-Host "  Plan:             $($sub.subscription.plan)" -ForegroundColor Gray
    Write-Host "  Stripe Sub ID:    $($sub.subscription.stripe_subscription_id)" -ForegroundColor Gray
    Write-Host ""
} catch {
    Write-Host "⚠️  Could not retrieve subscription: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host ""
}

# Step 5: Check Deployment Status
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "STEP 5: Checking Deployment Status" -ForegroundColor Yellow
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

try {
    $customer = Invoke-RestMethod -Uri "http://localhost:3100/api/customers/$billingCustomerId" -Method GET
    
    Write-Host "✓ Customer details:" -ForegroundColor Green
    Write-Host "  Deployment Status: $($customer.deployment_status || 'pending')" -ForegroundColor Gray
    Write-Host "  Instance URL:      $($customer.instance_url || 'N/A')" -ForegroundColor Gray
    Write-Host "  Namespace:         $($customer.instance_namespace || 'N/A')" -ForegroundColor Gray
    Write-Host ""
    
    if ($customer.deployment_status -eq 'provisioning' -or $customer.deployment_status -eq 'pending') {
        Write-Host "🚀 Deployment in progress!" -ForegroundColor Cyan
        Write-Host "   Monitor progress at: http://localhost:3100/admin/queues" -ForegroundColor Gray
    } elseif ($customer.deployment_status -eq 'ready') {
        Write-Host "✅ Deployment completed!" -ForegroundColor Green
        Write-Host "   Instance URL: $($customer.instance_url)" -ForegroundColor Cyan
    } elseif ($customer.deployment_status -eq 'failed') {
        Write-Host "❌ Deployment failed!" -ForegroundColor Red
        Write-Host "   Error: $($customer.deployment_error || 'Unknown error')" -ForegroundColor Red
    }
} catch {
    Write-Host "⚠️  Could not retrieve customer details: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "✨ TEST COMPLETE" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host ""

Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host "  Stripe Customer:  $stripeCustomerId" -ForegroundColor Gray
Write-Host "  Billing Customer: $billingCustomerId" -ForegroundColor Gray
Write-Host "  Email:            $Email" -ForegroundColor Gray
Write-Host "  Plan:             $Plan" -ForegroundColor Gray
Write-Host ""

Write-Host "🔗 Quick Links:" -ForegroundColor Cyan
Write-Host "  • Stripe Dashboard:  https://dashboard.stripe.com/test/customers/$stripeCustomerId" -ForegroundColor Gray
Write-Host "  • Bull Board:        http://localhost:3100/admin/queues" -ForegroundColor Gray
Write-Host "  • Customer API:      http://localhost:3100/api/customers/$billingCustomerId" -ForegroundColor Gray
Write-Host ""

Write-Host "🧹 Cleanup (optional):" -ForegroundColor Cyan
Write-Host "  stripe customers delete $stripeCustomerId" -ForegroundColor Gray
Write-Host ""
