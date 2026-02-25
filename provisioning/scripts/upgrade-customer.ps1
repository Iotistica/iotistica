# Upgrade Customer from Trial to Paid Plan
# Usage: .\upgrade-customer.ps1 -CustomerId "cust_xxx" -Plan "professional"

param(
    [Parameter(Mandatory=$true)]
    [string]$CustomerId,
    
    [Parameter(Mandatory=$true)]
    [ValidateSet("starter", "professional", "enterprise")]
    [string]$Plan
)

Write-Host "`n🔄 Upgrading Customer to $Plan Plan`n" -ForegroundColor Cyan

$baseUrl = "http://localhost:3100"

# ========================================
# Step 1: Verify customer exists
# ========================================
Write-Host "Step 1: Verify customer exists" -ForegroundColor Yellow

try {
    $customer = Invoke-RestMethod -Uri "$baseUrl/api/customers/$CustomerId" `
        -Method GET
    
    Write-Host "✅ Customer found!" -ForegroundColor Green
    Write-Host "   Customer ID: $($customer.customer.customer_id)" -ForegroundColor Gray
    Write-Host "   Email: $($customer.customer.email)" -ForegroundColor Gray
    Write-Host "   Company: $($customer.customer.company_name)" -ForegroundColor Gray
    Write-Host "   Deployment Status: $($customer.customer.deployment_status)" -ForegroundColor Gray
    
    $script:customerEmail = $customer.customer.email
    $script:stripeCustomerId = $customer.customer.stripe_customer_id
    
} catch {
    Write-Host "❌ Customer not found: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ========================================
# Step 2: Check current subscription
# ========================================
Write-Host "`nStep 2: Check current subscription" -ForegroundColor Yellow

try {
    $subscription = Invoke-RestMethod -Uri "$baseUrl/api/subscriptions/$CustomerId" `
        -Method GET
    
    Write-Host "✅ Current subscription:" -ForegroundColor Green
    Write-Host "   Plan: $($subscription.subscription.plan)" -ForegroundColor Gray
    Write-Host "   Status: $($subscription.subscription.status)" -ForegroundColor Gray
    Write-Host "   Stripe Sub ID: $($subscription.subscription.stripe_subscription_id)" -ForegroundColor Gray
    
    if ($subscription.subscription.status -eq "trialing") {
        Write-Host "   ℹ️  Customer is on trial - ready to upgrade" -ForegroundColor Cyan
    } elseif ($subscription.subscription.status -eq "active") {
        Write-Host "   ⚠️  Customer already has active subscription" -ForegroundColor Yellow
        Write-Host "   Current plan: $($subscription.subscription.plan)" -ForegroundColor Yellow
        
        if ($subscription.subscription.plan -eq $Plan) {
            Write-Host "   ℹ️  Customer already on $Plan plan" -ForegroundColor Cyan
            exit 0
        } else {
            Write-Host "   ℹ️  Will upgrade from $($subscription.subscription.plan) to $Plan" -ForegroundColor Cyan
        }
    }
    
    $script:currentPlan = $subscription.subscription.plan
    $script:currentStatus = $subscription.subscription.status
    
} catch {
    Write-Host "❌ Failed to fetch subscription: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ========================================
# Step 3: Create checkout session
# ========================================
Write-Host "`nStep 3: Create Stripe checkout session" -ForegroundColor Yellow

$checkoutData = @{
    customer_id = $CustomerId
    plan = $Plan
    success_url = "http://localhost:3000/success?customer_id=$CustomerId"
    cancel_url = "http://localhost:3000/cancel?customer_id=$CustomerId"
} | ConvertTo-Json

try {
    $checkout = Invoke-RestMethod -Uri "$baseUrl/api/subscriptions/checkout" `
        -Method POST `
        -Body $checkoutData `
        -ContentType "application/json"
    
    Write-Host "✅ Checkout session created!" -ForegroundColor Green
    Write-Host "   Session ID: $($checkout.session_id)" -ForegroundColor Gray
    Write-Host "   Checkout URL: $($checkout.checkout_url)" -ForegroundColor Gray
    
    $script:sessionId = $checkout.session_id
    $script:checkoutUrl = $checkout.checkout_url
    
} catch {
    Write-Host "❌ Failed to create checkout: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        $errorDetails = $_.ErrorDetails.Message | ConvertFrom-Json
        Write-Host "   Error: $($errorDetails.error)" -ForegroundColor Red
    }
    exit 1
}

# ========================================
# Step 4: Verify Stripe customer ID
# ========================================
Write-Host "`nStep 4: Verify Stripe customer ID" -ForegroundColor Yellow

try {
    # Re-fetch customer to get updated Stripe ID
    $customer = Invoke-RestMethod -Uri "$baseUrl/api/customers/$CustomerId" `
        -Method GET
    
    if ($customer.customer.stripe_customer_id) {
        Write-Host "✅ Stripe customer ID exists!" -ForegroundColor Green
        Write-Host "   Stripe ID: $($customer.customer.stripe_customer_id)" -ForegroundColor Gray
    } else {
        Write-Host "⚠️  Stripe customer ID not yet created (will be created on checkout)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "⚠️  Could not verify Stripe customer: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Summary
# ========================================
Write-Host "`n" + ("="*70) -ForegroundColor Cyan
Write-Host "UPGRADE READY" -ForegroundColor Cyan
Write-Host ("="*70) -ForegroundColor Cyan

Write-Host "`n📋 Customer Details:" -ForegroundColor White
Write-Host "   Customer ID: $CustomerId" -ForegroundColor Gray
Write-Host "   Email: $script:customerEmail" -ForegroundColor Gray
Write-Host "   Current Plan: $script:currentPlan" -ForegroundColor Gray
Write-Host "   Current Status: $script:currentStatus" -ForegroundColor Gray
Write-Host "   Target Plan: $Plan" -ForegroundColor Cyan

Write-Host "`n💳 Complete Payment:" -ForegroundColor Yellow
Write-Host "   Checkout URL: $script:checkoutUrl" -ForegroundColor White
Write-Host "`n   Test Card Details:" -ForegroundColor Gray
Write-Host "   Card Number: 4242 4242 4242 4242" -ForegroundColor White
Write-Host "   Expiry: Any future date (e.g., 12/28)" -ForegroundColor White
Write-Host "   CVC: Any 3 digits (e.g., 123)" -ForegroundColor White
Write-Host "   ZIP: Any 5 digits (e.g., 12345)" -ForegroundColor White

Write-Host "`n🚀 Next Steps:" -ForegroundColor Yellow
Write-Host "   1. Open the checkout URL above in your browser" -ForegroundColor Gray
Write-Host "   2. Complete the payment with test card" -ForegroundColor Gray
Write-Host "   3. You'll be redirected to success page" -ForegroundColor Gray
Write-Host "   4. Webhook will automatically update subscription" -ForegroundColor Gray

Write-Host "`n🔍 Verify Upgrade After Payment:" -ForegroundColor Yellow
Write-Host "   # Check subscription status" -ForegroundColor Gray
Write-Host "   Invoke-RestMethod -Uri '$baseUrl/api/subscriptions/$CustomerId'" -ForegroundColor DarkGray
Write-Host "`n   # Check license history" -ForegroundColor Gray
Write-Host "   Invoke-RestMethod -Uri '$baseUrl/api/licenses/$CustomerId/history'" -ForegroundColor DarkGray
Write-Host "`n   # Check in database" -ForegroundColor Gray
Write-Host "   docker exec billing-postgres-1 psql -U billing -d billing -c \`"SELECT plan, status, stripe_subscription_id FROM subscriptions WHERE customer_id = '$CustomerId';\`"" -ForegroundColor DarkGray

Write-Host "`n📊 Expected After Payment:" -ForegroundColor Yellow

$planFeatures = @{
    "starter" = @{
        maxDevices = 10
        dataRetentionDays = 30
        maxUsers = 5
        maxAlertRules = 25
    }
    "professional" = @{
        maxDevices = 50
        dataRetentionDays = 90
        maxUsers = 15
        maxAlertRules = 100
    }
    "enterprise" = @{
        maxDevices = -1
        dataRetentionDays = 365
        maxUsers = -1
        maxAlertRules = -1
    }
}

$features = $planFeatures[$Plan]
Write-Host "   - subscription.status = 'active'" -ForegroundColor Gray
Write-Host "   - subscription.plan = '$Plan'" -ForegroundColor Gray
Write-Host "   - license.features.maxDevices = $($features.maxDevices)" -ForegroundColor Gray
Write-Host "   - license.features.dataRetentionDays = $($features.dataRetentionDays)" -ForegroundColor Gray
Write-Host "   - license.features.maxUsers = $($features.maxUsers)" -ForegroundColor Gray
Write-Host "   - license_history shows 'upgraded' action" -ForegroundColor Gray

Write-Host "`n💡 Opening checkout in browser..." -ForegroundColor Cyan
Start-Process $script:checkoutUrl

Write-Host "`n"
