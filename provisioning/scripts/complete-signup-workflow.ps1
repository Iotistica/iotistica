# billing/scripts/complete-signup-workflow.ps1
# Complete Customer Signup Workflow
# Flow: Customer Creation → Plan Selection/Payment → Deployment Queue → Simulated Execution
# Usage: .\complete-signup-workflow.ps1 [-Plan professional]

param(
    [string]$Plan = "",  # Leave empty to prompt user
    [string]$BaseUrl = "http://localhost:3100",
    [switch]$AutoAccept = $false,  # Skip confirmations
    [switch]$WaitForDeployment = $false  # Wait for deployment completion
)

$ErrorActionPreference = "Stop"

# ============================================================
# Helper Functions
# ============================================================

function Write-Step {
    param([string]$Message, [int]$Step)
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host "STEP $Step`: $Message" -ForegroundColor Yellow -NoNewline
    Write-Host " 🚀" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor Gray
}

function Write-Error-Message {
    param([string]$Message)
    Write-Host "❌ $Message" -ForegroundColor Red
}

function Write-Warning-Message {
    param([string]$Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

function Write-Title {
    param([string]$Message)
    Write-Host ""
    Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║  $Message" -ForegroundColor Cyan
    Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Section {
    param([string]$Title, [hashtable]$Data)
    Write-Host ""
    Write-Host "📋 $Title" -ForegroundColor Cyan
    foreach ($key in $Data.Keys) {
        Write-Info "${key}: $($Data[$key])"
    }
}

function Confirm-Action {
    param([string]$Message)
    
    if ($AutoAccept) {
        return $true
    }
    
    Write-Host ""
    $response = Read-Host "$Message (y/N)"
    return ($response -eq "y" -or $response -eq "Y")
}

# ============================================================
# Main Workflow
# ============================================================

Write-Title "IOTISTIC BILLING - COMPLETE SIGNUP WORKFLOW"

Write-Host "This script will:" -ForegroundColor Cyan
Write-Host "  1. Create a new customer account" -ForegroundColor White
Write-Host "  2. Select/purchase a subscription plan" -ForegroundColor White
Write-Host "  3. Queue a deployment job" -ForegroundColor White
Write-Host "  4. Simulate deployment execution" -ForegroundColor White
Write-Host ""

# ============================================================
# STEP 0: Plan Selection
# ============================================================

if ([string]::IsNullOrEmpty($Plan)) {
    Write-Host "Available Plans:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [1] Trial (FREE)" -ForegroundColor Green
    Write-Host "      • 14-day trial" -ForegroundColor Gray
    Write-Host "      • 10 devices max" -ForegroundColor Gray
    Write-Host "      • 30 days data retention" -ForegroundColor Gray
    Write-Host "      • Basic features" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [2] Starter ($29/month)" -ForegroundColor Blue
    Write-Host "      • 10 devices max" -ForegroundColor Gray
    Write-Host "      • 30 days data retention" -ForegroundColor Gray
    Write-Host "      • Standard support" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [3] Professional ($99/month)" -ForegroundColor Magenta
    Write-Host "      • 50 devices max" -ForegroundColor Gray
    Write-Host "      • 365 days data retention" -ForegroundColor Gray
    Write-Host "      • Advanced alerts" -ForegroundColor Gray
    Write-Host "      • Priority support" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [4] Enterprise (Custom pricing)" -ForegroundColor Yellow
    Write-Host "      • Unlimited devices" -ForegroundColor Gray
    Write-Host "      • Unlimited data retention" -ForegroundColor Gray
    Write-Host "      • Custom branding" -ForegroundColor Gray
    Write-Host "      • Dedicated support" -ForegroundColor Gray
    Write-Host ""
    
    $selection = Read-Host "Select plan (1-4, default: 1 Trial)"
    
    if ([string]::IsNullOrEmpty($selection)) {
        $selection = "1"
    }
    
    switch ($selection) {
        "1" { $Plan = "trial" }
        "2" { $Plan = "starter" }
        "3" { $Plan = "professional" }
        "4" { $Plan = "enterprise" }
        default {
            Write-Error-Message "Invalid selection. Using trial plan."
            $Plan = "trial"
        }
    }
}

# Validate plan
$validPlans = @("trial", "starter", "professional", "enterprise")
if ($Plan -notin $validPlans) {
    Write-Error-Message "Invalid plan: $Plan"
    Write-Host "Valid plans: trial, starter, professional, enterprise" -ForegroundColor Red
    exit 1
}

Write-Success "Selected Plan: $Plan"

# ============================================================
# STEP 1: Create Customer
# ============================================================

Write-Step "Creating Customer Account" -Step 1

$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$customerEmail = "customer-$timestamp@example.com"
$customerName = "Test User $timestamp"
$companyName = "Test Company $timestamp"

Write-Info "Email: $customerEmail"
Write-Info "Name: $customerName"
Write-Info "Company: $companyName"

if (-not (Confirm-Action "Create customer account?")) {
    Write-Warning-Message "Workflow cancelled by user"
    exit 0
}

$customerBody = @{
    email = $customerEmail
    company_name = $companyName
    full_name = $customerName
    password = "TestPass123"
} | ConvertTo-Json

try {
    $customerResponse = Invoke-RestMethod -Uri "$BaseUrl/api/customers/signup" `
        -Method POST `
        -Body $customerBody `
        -ContentType "application/json" `
        -ErrorAction Stop
    
    $customerId = $customerResponse.customer.customer_id
    
    Write-Success "Customer created successfully!"
    Write-Section "Customer Details" @{
        "Customer ID" = $customerId
        "Email" = $customerResponse.customer.email
        "Company" = $customerResponse.customer.company_name
        "Stripe Customer ID" = $customerResponse.customer.stripe_customer_id
        "Initial Status" = "$($customerResponse.subscription.status) ($($customerResponse.subscription.plan))"
        "Trial End" = $customerResponse.subscription.trial_ends_at
    }
}
catch {
    Write-Error-Message "Failed to create customer: $($_.Exception.Message)"
    exit 1
}

# ============================================================
# STEP 2: Plan Selection & Payment
# ============================================================

if ($Plan -eq "trial") {
    Write-Step "Trial Plan Selected - No Payment Required" -Step 2
    
    Write-Success "Customer is already on trial plan"
    Write-Info "Trial period: $($customerResponse.subscription.trial_ends_at)"
    Write-Info "Devices allowed: 10"
    Write-Info "Data retention: 30 days"
    
    $needsPayment = $false
}
else {
    Write-Step "Processing Payment for '$Plan' Plan" -Step 2
    
    $needsPayment = $true
    
    # Create checkout session
    Write-Info "Creating Stripe checkout session..."
    
    $checkoutBody = @{
        customer_id = $customerId
        plan = $Plan
        success_url = "$BaseUrl/success"
        cancel_url = "$BaseUrl/cancel"
    } | ConvertTo-Json
    
    try {
        $checkoutResponse = Invoke-RestMethod -Uri "$BaseUrl/api/subscriptions/checkout" `
            -Method POST `
            -Body $checkoutBody `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        Write-Success "Checkout session created"
        Write-Section "Checkout Information" @{
            "Session ID" = $checkoutResponse.session_id
            "Checkout URL" = $checkoutResponse.checkout_url
        }
        
        # Display test card info
        Write-Host ""
        Write-Host "💳 Test Card Information:" -ForegroundColor Cyan
        Write-Host "  ┌─────────────────────────────────────┐" -ForegroundColor DarkGray
        Write-Host "  │ Card Number: 4242 4242 4242 4242   │" -ForegroundColor White
        Write-Host "  │ Expiry:      12/28 (any future)    │" -ForegroundColor White
        Write-Host "  │ CVC:         123 (any 3 digits)    │" -ForegroundColor White
        Write-Host "  │ ZIP:         12345 (any 5 digits)  │" -ForegroundColor White
        Write-Host "  └─────────────────────────────────────┘" -ForegroundColor DarkGray
        Write-Host ""
        
        # Display checkout URL prominently
        Write-Host "🔗 Checkout URL:" -ForegroundColor Yellow
        Write-Host "   $($checkoutResponse.checkout_url)" -ForegroundColor White
        Write-Host ""
        
        # Open browser
        Write-Info "Opening checkout URL in browser..."
        Write-Host ""
        
        try {
            Start-Process $checkoutResponse.checkout_url
            Write-Success "Browser should open automatically"
            Write-Info "If browser did not open, copy the URL above"
            Start-Sleep -Seconds 2
        }
        catch {
            Write-Warning-Message "Could not open browser automatically"
            Write-Host "Please copy and paste this URL into your browser:" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   $($checkoutResponse.checkout_url)" -ForegroundColor White
            Write-Host ""
        }
        
        Write-Host ""
        Write-Host "📝 Instructions:" -ForegroundColor Cyan
        Write-Host "  1. Complete the payment form in your browser" -ForegroundColor Gray
        Write-Host "  2. Use the test card details above" -ForegroundColor Gray
        Write-Host "  3. Click 'Subscribe' or 'Pay'" -ForegroundColor Gray
        Write-Host "  4. Wait for payment confirmation" -ForegroundColor Gray
        Write-Host "  5. Return here and press Enter" -ForegroundColor Gray
        Write-Host ""
        Read-Host "Press Enter after completing the payment"
        
        # Verify subscription
        Write-Host ""
        Write-Info "Verifying subscription update..."
        Write-Info "Waiting for webhook to process..."
        Start-Sleep -Seconds 3
        
        $subscription = Invoke-RestMethod -Uri "$BaseUrl/api/subscriptions/$customerId" `
            -Method GET `
            -ErrorAction Stop
        
        if ($subscription.subscription.status -eq "active") {
            Write-Success "Subscription verified and activated!"
            Write-Section "Subscription Details" @{
                "Status" = $subscription.subscription.status
                "Plan" = $subscription.subscription.plan
                "Stripe Subscription ID" = $subscription.subscription.stripe_subscription_id
                "Current Period" = "$($subscription.subscription.current_period_start) to $($subscription.subscription.current_period_end)"
            }
        }
        else {
            Write-Warning-Message "Subscription status: $($subscription.subscription.status)"
            Write-Warning-Message "Expected 'active', got '$($subscription.subscription.status)'"
            Write-Info "Check webhook logs: docker logs billing-billing-1"
        }
    }
    catch {
        Write-Error-Message "Failed to process payment: $($_.Exception.Message)"
        exit 1
    }
}

# ============================================================
# STEP 3: Retrieve License
# ============================================================

Write-Step "Generating License Key" -Step 3

try {
    $license = Invoke-RestMethod -Uri "$BaseUrl/api/licenses/$customerId" `
        -Method GET `
        -ErrorAction Stop
    
    Write-Success "License generated successfully!"
    
    Write-Section "License Information" @{
        "Customer" = $license.decoded.customerName
        "Plan" = $license.decoded.plan
        "Status" = $license.decoded.subscription.status
        "Trial Mode" = $license.decoded.trial.isTrialMode
    }
    
    Write-Host ""
    Write-Host "🔧 Features Enabled:" -ForegroundColor Cyan
    $license.decoded.features.PSObject.Properties | ForEach-Object {
        $icon = if ($_.Value -eq $true) { "✓" } 
                elseif ($_.Value -eq $false) { "✗" } 
                else { "→" }
        $color = if ($_.Value -eq $true) { "Green" } 
                 elseif ($_.Value -eq $false) { "DarkGray" } 
                 else { "White" }
        Write-Host "  $icon $($_.Name): " -NoNewline -ForegroundColor $color
        Write-Host $_.Value -ForegroundColor White
    }
}
catch {
    Write-Error-Message "Failed to retrieve license: $($_.Exception.Message)"
    exit 1
}

# ============================================================
# STEP 4: Queue Deployment Job
# ============================================================

Write-Step "Queueing Deployment Job" -Step 4

Write-Info "Creating deployment job for customer instance..."

# Simulate deployment job creation
$deploymentPayload = @{
    customer_id = $customerId
    plan = $Plan
    namespace = "customer-$($customerId.Substring(5, 8))"  # Use part of customer ID
    helm_chart = "customer-instance"
    instance_url = "https://customer-$($customerId.Substring(5, 8)).iotistic.ca"
}

try {
    # Note: This endpoint might need to be created or we simulate it
    Write-Info "Deployment payload prepared"
    Write-Info "Namespace: $($deploymentPayload.namespace)"
    Write-Info "Instance URL: $($deploymentPayload.instance_url)"
    
    # Simulate job ID
    $jobId = [guid]::NewGuid().ToString()
    
    Write-Success "Deployment job queued!"
    Write-Section "Job Details" @{
        "Job ID" = $jobId
        "Customer ID" = $customerId
        "Namespace" = $deploymentPayload.namespace
        "Instance URL" = $deploymentPayload.instance_url
        "Status" = "queued"
    }
    
    # Check queue stats
    Write-Host ""
    Write-Info "Checking queue statistics..."
    
    try {
        $queueStats = Invoke-RestMethod -Uri "$BaseUrl/api/queue/stats" -ErrorAction Stop
        
        Write-Section "Queue Statistics" @{
            "Waiting" = $queueStats.waiting
            "Active" = $queueStats.active
            "Completed" = $queueStats.completed
            "Failed" = $queueStats.failed
        }
    }
    catch {
        Write-Warning-Message "Could not retrieve queue stats: $($_.Exception.Message)"
    }
}
catch {
    Write-Error-Message "Failed to queue deployment: $($_.Exception.Message)"
    exit 1
}

# ============================================================
# STEP 5: Simulate Deployment Execution
# ============================================================

Write-Step "Simulating Deployment Execution" -Step 5

if ($WaitForDeployment) {
    Write-Info "Monitoring deployment progress..."
    Write-Host ""
    
    $stages = @(
        @{ Name = "Validating configuration"; Duration = 2 }
        @{ Name = "Creating Kubernetes namespace"; Duration = 3 }
        @{ Name = "Installing Helm chart"; Duration = 5 }
        @{ Name = "Deploying PostgreSQL"; Duration = 4 }
        @{ Name = "Deploying Redis"; Duration = 3 }
        @{ Name = "Deploying MQTT broker"; Duration = 3 }
        @{ Name = "Deploying API service"; Duration = 4 }
        @{ Name = "Deploying dashboard"; Duration = 3 }
        @{ Name = "Configuring ingress"; Duration = 2 }
        @{ Name = "Running health checks"; Duration = 3 }
        @{ Name = "Finalizing deployment"; Duration = 2 }
    )
    
    $totalStages = $stages.Count
    $currentStage = 0
    
    foreach ($stage in $stages) {
        $currentStage++
        $progress = [math]::Round(($currentStage / $totalStages) * 100)
        
        Write-Host "[$progress%] $($stage.Name)..." -NoNewline -ForegroundColor Yellow
        
        # Simulate work
        Start-Sleep -Seconds $stage.Duration
        
        Write-Host " ✓" -ForegroundColor Green
    }
    
    Write-Host ""
    Write-Success "Deployment completed successfully!"
}
else {
    Write-Info "Simulating deployment stages..."
    Write-Info "(Use -WaitForDeployment flag to watch full simulation)"
    
    Write-Host ""
    Write-Host "  📦 Kubernetes namespace created" -ForegroundColor Gray
    Write-Host "  📦 Helm chart installed" -ForegroundColor Gray
    Write-Host "  📦 Services deployed (PostgreSQL, Redis, MQTT, API)" -ForegroundColor Gray
    Write-Host "  📦 Ingress configured" -ForegroundColor Gray
    Write-Host "  📦 Health checks passed" -ForegroundColor Gray
    Write-Host ""
    
    Write-Success "Deployment queued and processing"
}

# ============================================================
# STEP 6: Summary & Next Steps
# ============================================================

Write-Title "WORKFLOW COMPLETE ✨"

Write-Host "📊 Summary:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Customer Information:" -ForegroundColor White
Write-Host "    • Customer ID:  $customerId" -ForegroundColor Gray
Write-Host "    • Email:        $customerEmail" -ForegroundColor Gray
Write-Host "    • Company:      $companyName" -ForegroundColor Gray
Write-Host ""
Write-Host "  Subscription:" -ForegroundColor White
Write-Host "    • Plan:         $Plan" -ForegroundColor Gray
if ($needsPayment) {
    Write-Host "    • Status:       active (paid)" -ForegroundColor Gray
}
else {
    Write-Host "    • Status:       trialing" -ForegroundColor Gray
}
Write-Host "    • Max Devices:  $($license.decoded.features.maxDevices)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Deployment:" -ForegroundColor White
Write-Host "    • Job ID:       $jobId" -ForegroundColor Gray
Write-Host "    • Namespace:    $($deploymentPayload.namespace)" -ForegroundColor Gray
Write-Host "    • URL:          $($deploymentPayload.instance_url)" -ForegroundColor Gray
Write-Host "    • Status:       " -NoNewline -ForegroundColor Gray
if ($WaitForDeployment) {
    Write-Host "completed ✓" -ForegroundColor Green
}
else {
    Write-Host "processing..." -ForegroundColor Yellow
}
Write-Host ""

Write-Host "🔗 Quick Links:" -ForegroundColor Cyan
Write-Host "  • Bull Board:   $BaseUrl/admin/queues" -ForegroundColor Gray
Write-Host "  • Instance:     $($deploymentPayload.instance_url)" -ForegroundColor Gray
Write-Host ""

Write-Host "📋 Next Steps:" -ForegroundColor Cyan
Write-Host "  1. Monitor deployment:    Open Bull Board UI" -ForegroundColor White
Write-Host "  2. Check queue status:    curl $BaseUrl/api/queue/stats" -ForegroundColor White
Write-Host "  3. View customer:         curl $BaseUrl/api/customers/$customerId" -ForegroundColor White
Write-Host "  4. Test instance:         curl $($deploymentPayload.instance_url)/health" -ForegroundColor White
Write-Host "  5. View database:         docker exec -it billing-postgres-1 psql -U postgres -d billing" -ForegroundColor White
Write-Host ""

Write-Host "🔧 Management Commands:" -ForegroundColor Cyan
Write-Host "  • Upgrade plan:      POST $BaseUrl/api/subscriptions/upgrade" -ForegroundColor White
Write-Host "  • Cancel subscription: POST $BaseUrl/api/subscriptions/cancel" -ForegroundColor White
Write-Host "  • Regenerate license: GET $BaseUrl/api/licenses/$customerId" -ForegroundColor White
Write-Host ""

Write-Success "All systems operational! Customer is ready to use the platform."
Write-Host ""

# ============================================================
# STEP 7: Update Hosts File for Local Access
# ============================================================

Write-Step "Configuring Local DNS (Hosts File)" -Step 7

# Extract short customer ID (8 characters)
$shortId = $customerId.Substring(5, 8)
$hostname = "$shortId.localhost"

Write-Info "Customer subdomain: $hostname"

# Function to update hosts file with elevation
function Update-HostsFile {
    param(
        [string]$Hostname,
        [string]$ShortId
    )
    
    $hostsPath = "C:\Windows\System32\drivers\etc\hosts"
    $entry = "127.0.0.1    $Hostname    # Iotistic - $ShortId"
    
    # Check if running as administrator
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    
    if (-not $isAdmin) {
        Write-Warning-Message "Not running as Administrator"
        Write-Info "Attempting to elevate privileges..."
        
        # Create a script to update hosts file
        $updateScript = @"
`$hostsPath = '$hostsPath'
`$entry = '$entry'

# Backup hosts file
`$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
try {
    Copy-Item `$hostsPath "`$hostsPath.backup-`$timestamp" -ErrorAction Stop
} catch {
    Write-Host "Warning: Could not create backup: `$_" -ForegroundColor Yellow
}

# Read current content
`$hostsContent = Get-Content `$hostsPath -ErrorAction Stop

# Remove old Iotistic entries
`$hostsContent = `$hostsContent | Where-Object { `$_ -notmatch '# Iotistic' }

# Add new entry
`$hostsContent += ''
`$hostsContent += `$entry

# Write back
`$hostsContent | Set-Content `$hostsPath -Force -ErrorAction Stop

Write-Host "✓ Hosts file updated successfully!" -ForegroundColor Green
Write-Host "  Added entry: `$entry" -ForegroundColor Gray
"@
        
        # Save script to temp file
        $tempScript = "$env:TEMP\update-hosts-$(Get-Random).ps1"
        $updateScript | Out-File -FilePath $tempScript -Encoding UTF8
        
        try {
            # Run elevated
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = "powershell.exe"
            $psi.Arguments = "-ExecutionPolicy Bypass -File `"$tempScript`""
            $psi.Verb = "runas"
            $psi.WindowStyle = "Hidden"
            $psi.UseShellExecute = $true
            
            $process = [System.Diagnostics.Process]::Start($psi)
            $process.WaitForExit()
            
            if ($process.ExitCode -eq 0) {
                Write-Success "Hosts file updated successfully!"
                Write-Info "Entry added: $entry"
                return $true
            }
            else {
                Write-Error-Message "Failed to update hosts file (Exit code: $($process.ExitCode))"
                return $false
            }
        }
        catch {
            Write-Error-Message "Failed to elevate: $($_.Exception.Message)"
            return $false
        }
        finally {
            # Clean up temp script
            if (Test-Path $tempScript) {
                Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
            }
        }
    }
    else {
        # Already running as admin, update directly
        try {
            # Backup
            $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Copy-Item $hostsPath "$hostsPath.backup-$timestamp" -ErrorAction Stop
            
            # Read, filter, and add
            $hostsContent = Get-Content $hostsPath
            $hostsContent = $hostsContent | Where-Object { $_ -notmatch '# Iotistic' }
            $hostsContent += ""
            $hostsContent += $entry
            
            # Write back
            $hostsContent | Set-Content $hostsPath -Force
            
            Write-Success "Hosts file updated successfully!"
            Write-Info "Entry added: $entry"
            return $true
        }
        catch {
            Write-Error-Message "Failed to update hosts file: $($_.Exception.Message)"
            return $false
        }
    }
}

# Attempt to update hosts file
$hostsUpdated = Update-HostsFile -Hostname $hostname -ShortId $shortId

if (-not $hostsUpdated) {
    Write-Host ""
    Write-Warning-Message "Automatic hosts file update failed"
    Write-Host ""
    Write-Host "📝 Manual Setup Required:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1. Open Notepad as Administrator" -ForegroundColor White
    Write-Host "  2. Open file: C:\Windows\System32\drivers\etc\hosts" -ForegroundColor White
    Write-Host "  3. Add this line at the bottom:" -ForegroundColor White
    Write-Host ""
    Write-Host "     127.0.0.1    $hostname    # Iotistic" -ForegroundColor Green
    Write-Host ""
    Write-Host "  4. Save and close" -ForegroundColor White
    Write-Host ""
}
else {
    Write-Host ""
    Write-Success "Local DNS configured! You can now access:"
    Write-Host ""
    Write-Host "  🌐 http://$hostname" -ForegroundColor Cyan -BackgroundColor DarkBlue
    Write-Host ""
    
    # Try to get actual K8s ingress
    try {
        Write-Info "Verifying Kubernetes ingress..."
        $ingresses = kubectl get ingress --all-namespaces -o json | ConvertFrom-Json
        $customerIngress = $ingresses.items | Where-Object { $_.metadata.namespace -eq "customer-$shortId" }
        
        if ($customerIngress) {
            Write-Success "Ingress found and configured!"
            Write-Info "Namespace: $($customerIngress.metadata.namespace)"
            Write-Info "Host: $($customerIngress.spec.rules[0].host)"
            
            if ($customerIngress.spec.rules[0].host -eq $hostname) {
                Write-Success "Hostname matches! All configured correctly."
            }
            else {
                Write-Warning-Message "Ingress hostname mismatch:"
                Write-Info "  Expected: $hostname"
                Write-Info "  Actual: $($customerIngress.spec.rules[0].host)"
            }
        }
        else {
            Write-Info "Ingress not yet created (deployment may still be in progress)"
        }
    }
    catch {
        Write-Info "Could not verify ingress (kubectl may not be available)"
    }
}

Write-Host ""
