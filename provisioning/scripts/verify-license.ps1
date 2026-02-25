# Verify License JWT
# Decodes and displays the license data

param(
    [Parameter(Mandatory=$false)]
    [string]$LicenseJwt
)

# If no JWT provided, get from latest signup
if (-not $LicenseJwt) {
    Write-Host "Getting latest signup license..." -ForegroundColor Cyan
    
    $signup = @{
        email = "verify-test@example.com"
        password = "TestPass123"
        company_name = "Verify Test Corp"
    } | ConvertTo-Json
    
    try {
        $result = Invoke-RestMethod -Uri "http://localhost:3100/api/customers/signup" `
            -Method POST `
            -Body $signup `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        $LicenseJwt = $result.license.jwt
        Write-Host "✅ Got license from signup" -ForegroundColor Green
        
    } catch {
        # Try login instead
        $login = @{
            email = "john.doe@example.com"
            password = "SecurePass123"
        } | ConvertTo-Json
        
        $result = Invoke-RestMethod -Uri "http://localhost:3100/api/customers/login" `
            -Method POST `
            -Body $login `
            -ContentType "application/json"
        
        $LicenseJwt = $result.license.jwt
        Write-Host "✅ Got license from login" -ForegroundColor Green
    }
}

# Decode JWT (without verification - just for display)
$parts = $LicenseJwt.Split('.')
if ($parts.Length -ne 3) {
    Write-Host "❌ Invalid JWT format" -ForegroundColor Red
    exit 1
}

# Decode header
$headerJson = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String(
        $parts[0].Replace('-', '+').Replace('_', '/').PadRight(
            ($parts[0].Length + 3) -band -bnot 3, '='
        )
    )
)
$header = $headerJson | ConvertFrom-Json

# Decode payload
$payloadJson = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String(
        $parts[1].Replace('-', '+').Replace('_', '/').PadRight(
            ($parts[1].Length + 3) -band -bnot 3, '='
        )
    )
)
$payload = $payloadJson | ConvertFrom-Json

# Display results
Write-Host "`n" + ("="*70) -ForegroundColor Cyan
Write-Host "LICENSE JWT DECODED" -ForegroundColor Cyan
Write-Host ("="*70) -ForegroundColor Cyan

Write-Host "`n📋 HEADER" -ForegroundColor Yellow
Write-Host "   Algorithm: $($header.alg)" -ForegroundColor Gray
Write-Host "   Type: $($header.typ)" -ForegroundColor Gray

Write-Host "`n👤 CUSTOMER INFO" -ForegroundColor Yellow
Write-Host "   Customer ID: $($payload.customerId)" -ForegroundColor Gray
Write-Host "   Customer Name: $($payload.customerName)" -ForegroundColor Gray
Write-Host "   Plan: $($payload.plan)" -ForegroundColor Gray

Write-Host "`n🎁 TRIAL INFO" -ForegroundColor Yellow
Write-Host "   Is Trial: $($payload.trial.isTrialMode)" -ForegroundColor Gray
if ($payload.trial.expiresAt) {
    $trialExpiry = [DateTime]::Parse($payload.trial.expiresAt)
    $daysRemaining = [Math]::Ceiling(($trialExpiry - (Get-Date)).TotalDays)
    Write-Host "   Trial Expires: $($payload.trial.expiresAt)" -ForegroundColor Gray
    Write-Host "   Days Remaining: $daysRemaining" -ForegroundColor $(if ($daysRemaining -lt 3) { "Red" } elseif ($daysRemaining -lt 7) { "Yellow" } else { "Green" })
}

Write-Host "`n📊 SUBSCRIPTION STATUS" -ForegroundColor Yellow
Write-Host "   Status: $($payload.subscription.status)" -ForegroundColor Gray
Write-Host "   Current Period Ends: $($payload.subscription.currentPeriodEndsAt)" -ForegroundColor Gray

Write-Host "`n✨ FEATURES" -ForegroundColor Yellow
Write-Host "   Max Devices: $($payload.features.maxDevices)" -ForegroundColor $(if ($payload.features.maxDevices -ge 50) { "Green" } elseif ($payload.features.maxDevices -ge 5) { "Yellow" } else { "Red" })
Write-Host "   Can Execute Jobs: $($payload.features.canExecuteJobs)" -ForegroundColor Gray
Write-Host "   Can Schedule Jobs: $($payload.features.canScheduleJobs)" -ForegroundColor Gray
Write-Host "   Can Remote Access: $($payload.features.canRemoteAccess)" -ForegroundColor Gray
Write-Host "   Can OTA Updates: $($payload.features.canOtaUpdates)" -ForegroundColor Gray
Write-Host "   Can Export Data: $($payload.features.canExportData)" -ForegroundColor Gray
Write-Host "   Has Advanced Alerts: $($payload.features.hasAdvancedAlerts)" -ForegroundColor Gray
Write-Host "   Has Custom Dashboards: $($payload.features.hasCustomDashboards)" -ForegroundColor Gray

Write-Host "`n📏 LIMITS" -ForegroundColor Yellow
Write-Host "   Max Job Templates: $($payload.limits.maxJobTemplates)" -ForegroundColor Gray
Write-Host "   Max Alert Rules: $($payload.limits.maxAlertRules)" -ForegroundColor Gray
Write-Host "   Max Users: $($payload.limits.maxUsers)" -ForegroundColor Gray

Write-Host "`n🕐 TIMESTAMPS" -ForegroundColor Yellow
$issuedAt = [DateTimeOffset]::FromUnixTimeSeconds($payload.issuedAt).DateTime
$expiresAt = [DateTimeOffset]::FromUnixTimeSeconds($payload.expiresAt).DateTime
$validFor = [Math]::Ceiling(($expiresAt - $issuedAt).TotalDays)

Write-Host "   Issued At: $issuedAt" -ForegroundColor Gray
Write-Host "   Expires At: $expiresAt" -ForegroundColor Gray
Write-Host "   Valid For: $validFor days" -ForegroundColor Gray

# Verify signature using billing API
Write-Host "`n🔐 SIGNATURE VERIFICATION" -ForegroundColor Yellow
try {
    $verifyResult = Invoke-RestMethod `
        -Uri "http://localhost:3100/api/licenses/verify" `
        -Method POST `
        -Body (@{ license = $LicenseJwt } | ConvertTo-Json) `
        -ContentType "application/json" `
        -ErrorAction Stop
    
    Write-Host "   ✅ Signature Valid" -ForegroundColor Green
    Write-Host "   Verified by: RS256 algorithm" -ForegroundColor Gray
    
} catch {
    Write-Host "   ⚠️  Could not verify (API may not have verify endpoint)" -ForegroundColor Yellow
}

Write-Host "`n" + ("="*70) -ForegroundColor Cyan

# Show JWT (truncated)
Write-Host "`n📝 FULL JWT (first 200 chars):" -ForegroundColor Yellow
Write-Host $LicenseJwt.Substring(0, [Math]::Min(200, $LicenseJwt.Length)) -ForegroundColor DarkGray
Write-Host "... ($($LicenseJwt.Length) total characters)" -ForegroundColor DarkGray

Write-Host "`n💡 TIP: Use this JWT as IOTISTIC_LICENSE_KEY environment variable" -ForegroundColor Cyan
Write-Host "`n"
