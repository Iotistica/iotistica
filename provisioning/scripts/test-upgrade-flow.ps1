# Test Upgrade Flow (Trial → Paid)
# Tests the complete upgrade flow from trial to paid subscription

Write-Host "`n🧪 Testing Upgrade Flow (Trial → Paid)`n" -ForegroundColor Cyan

$baseUrl = "http://localhost:3100"

# ========================================
# Step 1: Create trial customer
# ========================================
Write-Host "Step 1: Create trial customer" -ForegroundColor Yellow

$signupData = @{
    email = "upgrade-test-$(Get-Random)@example.com"
    password = "SecurePass123"
    company_name = "Upgrade Test Corp"
    full_name = "Upgrade Tester"
} | ConvertTo-Json

try {
    $signup = Invoke-RestMethod -Uri "$baseUrl/api/customers/signup" `
        -Method POST `
        -Body $signupData `
        -ContentType "application/json"
    
    Write-Host "✅ Trial customer created!" -ForegroundColor Green
    Write-Host "   Customer ID: $($signup.customer.customer_id)" -ForegroundColor Gray
    Write-Host "   Email: $($signup.customer.email)" -ForegroundColor Gray
    Write-Host "   Plan: $($signup.subscription.plan)" -ForegroundColor Gray
    Write-Host "   Status: $($signup.subscription.status)" -ForegroundColor Gray
    Write-Host "   Trial ends: $($signup.subscription.trial_ends_at)" -ForegroundColor Gray
    Write-Host "   Max devices: $($signup.license.features.maxDevices)" -ForegroundColor Gray
    Write-Host "   Can schedule jobs: $($signup.license.features.canScheduleJobs)" -ForegroundColor Gray
    Write-Host "   Stripe customer ID: $($signup.customer.stripe_customer_id)" -ForegroundColor Gray
    
    $script:customerId = $signup.customer.customer_id
    $script:customerEmail = $signup.customer.email
    $script:trialLicense = $signup.license.jwt
    
} catch {
    Write-Host "❌ Failed to create trial customer: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ========================================
# Step 2: Verify trial status in database
# ========================================
Write-Host "`nStep 2: Verify trial in database" -ForegroundColor Yellow

try {
    $dbResult = docker exec billing-postgres-1 psql -U billing -d billing -t -c `
        "SELECT customer_id, stripe_customer_id, deployment_status FROM customers WHERE customer_id = '$script:customerId';" 2>$null
    
    Write-Host "✅ Database record:" -ForegroundColor Green
    Write-Host "   $dbResult" -ForegroundColor Gray
    
    $subResult = docker exec billing-postgres-1 psql -U billing -d billing -t -c `
        "SELECT plan, status, stripe_subscription_id FROM subscriptions WHERE customer_id = '$script:customerId';" 2>$null
    
    Write-Host "   Subscription: $subResult" -ForegroundColor Gray
    
} catch {
    Write-Host "⚠️  Could not query database: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Step 3: Create checkout session (Upgrade to Professional)
# ========================================
Write-Host "`nStep 3: Create Stripe checkout session" -ForegroundColor Yellow

$checkoutData = @{
    customer_id = $script:customerId
    plan = "professional"
    success_url = "http://localhost:3000/success"
    cancel_url = "http://localhost:3000/cancel"
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
    $errorDetails = $_.ErrorDetails.Message | ConvertFrom-Json
    Write-Host "   Error: $($errorDetails.error)" -ForegroundColor Red
    exit 1
}

# ========================================
# Step 4: Check if stripe_customer_id was created
# ========================================
Write-Host "`nStep 4: Verify Stripe customer creation" -ForegroundColor Yellow

try {
    $customer = Invoke-RestMethod -Uri "$baseUrl/api/customers/$script:customerId" `
        -Method GET
    
    if ($customer.customer.stripe_customer_id) {
        Write-Host "✅ Stripe customer ID created!" -ForegroundColor Green
        Write-Host "   Stripe ID: $($customer.customer.stripe_customer_id)" -ForegroundColor Gray
    } else {
        Write-Host "⚠️  Stripe customer ID not yet created (will be created on checkout)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "⚠️  Could not verify customer: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Step 5: Simulate webhook (checkout completed)
# ========================================
Write-Host "`nStep 5: Simulating webhook (checkout.session.completed)" -ForegroundColor Yellow
Write-Host "   ℹ️  In production, Stripe sends this webhook automatically" -ForegroundColor DarkGray
Write-Host "   ℹ️  For testing, you can:" -ForegroundColor DarkGray
Write-Host "      1. Use Stripe CLI: stripe trigger checkout.session.completed" -ForegroundColor DarkGray
Write-Host "      2. Complete actual payment in Stripe checkout" -ForegroundColor DarkGray
Write-Host "      3. Use Stripe test mode with test card 4242 4242 4242 4242" -ForegroundColor DarkGray

Write-Host "`n   💳 To complete the upgrade:" -ForegroundColor Cyan
Write-Host "      Open: $script:checkoutUrl" -ForegroundColor White

# ========================================
# Step 6: Check current subscription status
# ========================================
Write-Host "`nStep 6: Check current subscription" -ForegroundColor Yellow

try {
    $subscription = Invoke-RestMethod -Uri "$baseUrl/api/subscriptions/$script:customerId" `
        -Method GET
    
    Write-Host "✅ Current subscription:" -ForegroundColor Green
    Write-Host "   Plan: $($subscription.subscription.plan)" -ForegroundColor Gray
    Write-Host "   Status: $($subscription.subscription.status)" -ForegroundColor Gray
    Write-Host "   Stripe Sub ID: $($subscription.subscription.stripe_subscription_id)" -ForegroundColor Gray
    
    if ($subscription.subscription.status -eq "active") {
        Write-Host "   ✅ Subscription is ACTIVE (payment completed)" -ForegroundColor Green
    } else {
        Write-Host "   ⏳ Subscription is TRIALING (payment pending)" -ForegroundColor Yellow
    }
    
} catch {
    Write-Host "⚠️  Could not fetch subscription: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Step 7: Verify customer count
# ========================================
Write-Host "`nStep 7: Verify single customer created" -ForegroundColor Yellow

try {
    $customerCount = docker exec billing-postgres-1 psql -U billing -d billing -t -c `
        "SELECT COUNT(*) FROM customers WHERE email LIKE '%upgrade-test%' OR email LIKE '%direct-upgrade%';" 2>$null
    
    Write-Host "✅ Total upgrade test customers: $($customerCount.Trim())" -ForegroundColor Green
    
} catch {
    Write-Host "⚠️  Could not query customer count: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Step 8: Check license history
# ========================================
Write-Host "`nStep 8: Check license audit history" -ForegroundColor Yellow

try {
    $history = Invoke-RestMethod -Uri "$baseUrl/api/licenses/$script:customerId/history" `
        -Method GET
    
    Write-Host "✅ License history:" -ForegroundColor Green
    Write-Host "   Total entries: $($history.entries.Count)" -ForegroundColor Gray
    
    foreach ($entry in $history.entries) {
        Write-Host "   - Action: $($entry.action) | Plan: $($entry.plan) | Date: $($entry.generated_at)" -ForegroundColor Gray
    }
    
    Write-Host "`n   Statistics:" -ForegroundColor Gray
    Write-Host "   Total generations: $($history.stats.totalGenerations)" -ForegroundColor Gray
    
} catch {
    Write-Host "⚠️  Could not fetch history: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Summary
# ========================================
Write-Host "`n" + ("="*70) -ForegroundColor Cyan
Write-Host "TEST SUMMARY - UPGRADE FLOW" -ForegroundColor Cyan
Write-Host ("="*70) -ForegroundColor Cyan

Write-Host "`n📋 Customer Details:" -ForegroundColor White
Write-Host "   Customer ID: $script:customerId" -ForegroundColor Gray
Write-Host "   Email: $script:customerEmail" -ForegroundColor Gray
Write-Host "   Checkout Session: $script:sessionId" -ForegroundColor Gray

Write-Host "`n💳 To Complete Payment:" -ForegroundColor Yellow
Write-Host "   1. Open checkout URL: $script:checkoutUrl" -ForegroundColor White
Write-Host "   2. Use test card: 4242 4242 4242 4242" -ForegroundColor White
Write-Host "   3. Any future expiry date, any CVC" -ForegroundColor White

Write-Host "`n🔍 Verify Upgrade Success:" -ForegroundColor Yellow
Write-Host "   # Check subscription status" -ForegroundColor Gray
Write-Host "   Invoke-RestMethod -Uri '$baseUrl/api/subscriptions/$script:customerId'" -ForegroundColor DarkGray
Write-Host "`n   # Check updated license" -ForegroundColor Gray
Write-Host "   Invoke-RestMethod -Uri '$baseUrl/api/customers/login' -Method POST -Body (@{email='$script:customerEmail'; password='SecurePass123'} | ConvertTo-Json) -ContentType 'application/json'" -ForegroundColor DarkGray
Write-Host "`n   # Check license history" -ForegroundColor Gray
Write-Host "   Invoke-RestMethod -Uri '$baseUrl/api/licenses/$script:customerId/history'" -ForegroundColor DarkGray

Write-Host "`n📊 Database Queries:" -ForegroundColor Yellow
Write-Host "   # Check Stripe customer ID" -ForegroundColor Gray
Write-Host "   docker exec billing-postgres-1 psql -U billing -d billing -c \`"SELECT customer_id, email, stripe_customer_id FROM customers WHERE customer_id = '$script:customerId';\`"" -ForegroundColor DarkGray
Write-Host "`n   # Check subscription" -ForegroundColor Gray
Write-Host "   docker exec billing-postgres-1 psql -U billing -d billing -c \`"SELECT customer_id, plan, status, stripe_subscription_id FROM subscriptions WHERE customer_id = '$script:customerId';\`"" -ForegroundColor DarkGray

Write-Host "`n🎯 Expected After Payment:" -ForegroundColor Yellow
Write-Host "   - subscription.status = 'active'" -ForegroundColor Gray
Write-Host "   - subscription.plan = 'professional'" -ForegroundColor Gray
Write-Host "   - license.features.maxDevices = 50" -ForegroundColor Gray
Write-Host "   - license.features.canScheduleJobs = true" -ForegroundColor Gray
Write-Host "   - license_history shows 'upgraded' action" -ForegroundColor Gray

Write-Host "`n"
