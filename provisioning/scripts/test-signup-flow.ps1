# Test Customer Signup Flow
# Tests the complete signup endpoint with trial creation

Write-Host "`n🧪 Testing Customer Signup Flow`n" -ForegroundColor Cyan

$baseUrl = "http://localhost:3100"

# ========================================
# Test 1: Signup with valid data
# ========================================
Write-Host "Test 1: Valid signup" -ForegroundColor Yellow

$signupData = @{
    email = "john.doe@example.com"
    password = "SecurePass123"
    company_name = "Acme Corporation"
    full_name = "John Doe"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/signup" `
        -Method POST `
        -Body $signupData `
        -ContentType "application/json"
    
    Write-Host "✅ Signup successful!" -ForegroundColor Green
    Write-Host "   Customer ID: $($response.customer.customer_id)" -ForegroundColor Gray
    Write-Host "   Email: $($response.customer.email)" -ForegroundColor Gray
    Write-Host "   Company: $($response.customer.company_name)" -ForegroundColor Gray
    Write-Host "   Plan: $($response.subscription.plan)" -ForegroundColor Gray
    Write-Host "   Status: $($response.subscription.status)" -ForegroundColor Gray
    Write-Host "   Trial ends: $($response.subscription.trial_ends_at)" -ForegroundColor Gray
    Write-Host "   Trial days left: $($response.subscription.trial_days_remaining)" -ForegroundColor Gray
    Write-Host "   Max devices: $($response.license.features.maxDevices)" -ForegroundColor Gray
    Write-Host "   Deployment: $($response.deployment.status)" -ForegroundColor Gray
    
    # Save customer ID and license for later tests
    $script:customerId = $response.customer.customer_id
    $script:customerEmail = $response.customer.email
    $script:licenseJwt = $response.license.jwt
    
    Write-Host "`n   License JWT (first 100 chars):" -ForegroundColor Gray
    Write-Host "   $($script:licenseJwt.Substring(0, [Math]::Min(100, $script:licenseJwt.Length)))..." -ForegroundColor DarkGray
    
} catch {
    Write-Host "❌ Test failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.Exception.Response.StatusCode -ForegroundColor Red
}

# ========================================
# Test 2: Duplicate email (should fail)
# ========================================
Write-Host "`nTest 2: Duplicate email (expect 409)" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/signup" `
        -Method POST `
        -Body $signupData `
        -ContentType "application/json"
    
    Write-Host "❌ Test failed: Should have returned 409 Conflict" -ForegroundColor Red
    
} catch {
    if ($_.Exception.Response.StatusCode -eq 409) {
        Write-Host "✅ Correctly rejected duplicate email" -ForegroundColor Green
    } else {
        Write-Host "❌ Wrong error: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    }
}

# ========================================
# Test 3: Invalid email format
# ========================================
Write-Host "`nTest 3: Invalid email format (expect 400)" -ForegroundColor Yellow

$invalidEmail = @{
    email = "not-an-email"
    password = "SecurePass123"
    company_name = "Test Corp"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/signup" `
        -Method POST `
        -Body $invalidEmail `
        -ContentType "application/json"
    
    Write-Host "❌ Test failed: Should have returned 400 Bad Request" -ForegroundColor Red
    
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "✅ Correctly rejected invalid email" -ForegroundColor Green
    } else {
        Write-Host "❌ Wrong error: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    }
}

# ========================================
# Test 4: Weak password
# ========================================
Write-Host "`nTest 4: Weak password (expect 400)" -ForegroundColor Yellow

$weakPassword = @{
    email = "jane@example.com"
    password = "weak"
    company_name = "Test Corp"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/signup" `
        -Method POST `
        -Body $weakPassword `
        -ContentType "application/json"
    
    Write-Host "❌ Test failed: Should have returned 400 Bad Request" -ForegroundColor Red
    
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "✅ Correctly rejected weak password" -ForegroundColor Green
    } else {
        Write-Host "❌ Wrong error: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    }
}

# ========================================
# Test 5: Login with created account
# ========================================
Write-Host "`nTest 5: Login with new account" -ForegroundColor Yellow

$loginData = @{
    email = $script:customerEmail
    password = "SecurePass123"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/login" `
        -Method POST `
        -Body $loginData `
        -ContentType "application/json"
    
    Write-Host "✅ Login successful!" -ForegroundColor Green
    Write-Host "   Customer ID: $($response.customer.customer_id)" -ForegroundColor Gray
    Write-Host "   Email: $($response.customer.email)" -ForegroundColor Gray
    Write-Host "   Plan: $($response.subscription.plan)" -ForegroundColor Gray
    Write-Host "   Status: $($response.subscription.status)" -ForegroundColor Gray
    Write-Host "   Deployment: $($response.deployment.status)" -ForegroundColor Gray
    
} catch {
    Write-Host "❌ Login failed: $($_.Exception.Message)" -ForegroundColor Red
}

# ========================================
# Test 6: Login with wrong password
# ========================================
Write-Host "`nTest 6: Login with wrong password (expect 401)" -ForegroundColor Yellow

$wrongPassword = @{
    email = $script:customerEmail
    password = "WrongPassword123"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/customers/login" `
        -Method POST `
        -Body $wrongPassword `
        -ContentType "application/json"
    
    Write-Host "❌ Test failed: Should have returned 401 Unauthorized" -ForegroundColor Red
    
} catch {
    if ($_.Exception.Response.StatusCode -eq 401) {
        Write-Host "✅ Correctly rejected wrong password" -ForegroundColor Green
    } else {
        Write-Host "❌ Wrong error: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
    }
}

# ========================================
# Test 7: Verify license history was logged
# ========================================
Write-Host "`nTest 7: Verify license audit log" -ForegroundColor Yellow

try {
    $history = Invoke-RestMethod -Uri "$baseUrl/api/licenses/$script:customerId/history" `
        -Method GET
    
    Write-Host "✅ License history retrieved!" -ForegroundColor Green
    Write-Host "   Total entries: $($history.entries.Count)" -ForegroundColor Gray
    
    if ($history.entries.Count -gt 0) {
        $entry = $history.entries[0]
        Write-Host "   Latest action: $($entry.action)" -ForegroundColor Gray
        Write-Host "   Plan: $($entry.plan)" -ForegroundColor Gray
        Write-Host "   Max devices: $($entry.max_devices)" -ForegroundColor Gray
        Write-Host "   Generated by: $($entry.generated_by)" -ForegroundColor Gray
    }
    
} catch {
    Write-Host "⚠️  Could not retrieve history: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Test 8: Check database
# ========================================
Write-Host "`nTest 8: Verify database records" -ForegroundColor Yellow

try {
    $dbResult = docker exec -it billing-postgres-1 psql -U billing -d billing -t -c "SELECT customer_id, email, company_name, deployment_status FROM customers WHERE email = '$($script:customerEmail)';"
    
    if ($dbResult) {
        Write-Host "✅ Customer record found in database!" -ForegroundColor Green
        Write-Host "   $dbResult" -ForegroundColor Gray
    } else {
        Write-Host "❌ Customer not found in database" -ForegroundColor Red
    }
    
} catch {
    Write-Host "⚠️  Could not query database: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ========================================
# Summary
# ========================================
Write-Host "`n" + ("="*60) -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host ("="*60) -ForegroundColor Cyan
Write-Host "Customer ID: $script:customerId" -ForegroundColor White
Write-Host "Email: $script:customerEmail" -ForegroundColor White
Write-Host "`nLicense JWT saved to:`n" -ForegroundColor White
Write-Host $script:licenseJwt -ForegroundColor DarkGray
Write-Host "`n" -ForegroundColor Cyan

Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Use this license key to deploy a Iotistic instance" -ForegroundColor Gray
Write-Host "2. Test login endpoint with email/password" -ForegroundColor Gray
Write-Host "3. Verify trial expiration (14 days from now)" -ForegroundColor Gray
Write-Host "4. Test subscription upgrade flow" -ForegroundColor Gray
Write-Host "`n"
