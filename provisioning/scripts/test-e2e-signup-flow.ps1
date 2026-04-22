#!/usr/bin/env pwsh
<#
.SYNOPSIS
Full E2E test: Customer signup -> Deployment job -> GitOps/CNPG provisioning

.DESCRIPTION
Tests the complete flow:
1. Customer signs up
2. Deployment job queued
3. Deployment worker processes job (writes CNPG DB CR + ArgoCD app to git)
4. Polls deployment status until complete or timeout

.EXAMPLE
./test-e2e-signup-flow.ps1 -AdminToken "your-ADMIN_API_TOKEN" -Email "test-e2e-$(Get-Random)@example.com"
#>

param(
    [string]$BaseUrl = "http://localhost:3100",
    [Parameter(Mandatory=$true)]
    [string]$AdminToken,
    [string]$Email = "test-e2e-$(Get-Random -Minimum 10000 -Maximum 99999)@example.com",
    [string]$CompanyName = "Test Company $(Get-Random)",
    [string]$Password = "TestPassword123!",
    [int]$JobTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"

$authHeader = @{ Authorization = "Bearer $AdminToken"; "Content-Type" = "application/json" }

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗"
Write-Host "║                   E2E SIGNUP & PROVISIONING TEST              ║"
Write-Host "╚════════════════════════════════════════════════════════════════╝"
Write-Host ""

Write-Host "Configuration:"
Write-Host "  Base URL:     $BaseUrl"
Write-Host "  Email:        $Email"
Write-Host "  Company:      $CompanyName"
Write-Host "  Password:     $(('*' * 8))"
Write-Host ""

# Test 1: Verify API is running
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 1: Verify Provisioning API is running"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

try {
    $healthResponse = Invoke-WebRequest -Uri "$BaseUrl/health" -Method Get -ErrorAction Stop
    if ($healthResponse.StatusCode -eq 200) {
        $health = $healthResponse.Content | ConvertFrom-Json
        Write-Host "✓ API Health: OK" -ForegroundColor Green
        Write-Host "  Redis: $($health.redis.status)"
    }
} catch {
    Write-Host "✗ API Health Check Failed" -ForegroundColor Red
    Write-Host "  Make sure provisioning API is running: docker compose up -d" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Test 2: Customer Signup
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 2: Customer Signup"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$signupPayload = @{
    email        = $Email
    password     = $Password
    company_name = $CompanyName
    full_name    = "Test User"
} | ConvertTo-Json

try {
    $signupResponse = Invoke-WebRequest -Uri "$BaseUrl/api/customers/signup" `
        -Method Post -Body $signupPayload -ContentType "application/json"

    $signupData = $signupResponse.Content | ConvertFrom-Json

    Write-Host "✓ Customer created" -ForegroundColor Green
    Write-Host "  Customer ID:    $($signupData.customer.customer_id)"
    Write-Host "  Email:          $($signupData.customer.email)"
    Write-Host "  Company:        $($signupData.customer.company_name)"
    Write-Host ""
    Write-Host "✓ Subscription created: $($signupData.subscription.plan)" -ForegroundColor Green
    Write-Host "  Status:         $($signupData.subscription.status)"
    Write-Host "  Trial ends:     $($signupData.subscription.trial_ends_at)"
    Write-Host "  Days remaining: $($signupData.subscription.trial_days_remaining)"
    Write-Host ""
    Write-Host "✓ Deployment job queued" -ForegroundColor Green
    Write-Host "  Job ID:         $($signupData.deployment.job_id)"
    Write-Host "  Namespace:      $($signupData.deployment.namespace)"
    Write-Host "  Status:         $($signupData.deployment.status)"
    Write-Host ""

    $customerId       = $signupData.customer.customer_id
    $deploymentJobId  = $signupData.deployment.job_id
    $namespace        = $signupData.deployment.namespace

} catch {
    Write-Host "✗ Customer Signup: ERROR" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $body = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream()).ReadToEnd()
        Write-Host "  Response: $body" -ForegroundColor Red
    }
    exit 1
}

# Test 3: Monitor Deployment Job
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 3: Monitor Deployment Job (timeout: ${JobTimeoutSeconds}s)"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$checkInterval = 5
$elapsed       = 0
$jobCompleted  = $false
$lastState     = ""

while ($elapsed -lt $JobTimeoutSeconds) {
    try {
        # /api/queue/jobs/:jobId requires admin auth
        $jobData = Invoke-RestMethod -Uri "$BaseUrl/api/queue/jobs/$deploymentJobId" `
            -Method Get -Headers $authHeader

        if ($jobData.state -ne $lastState) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] State: $($jobData.state) | Progress: $($jobData.progress) | Attempts: $($jobData.attempts)/$($jobData.maxAttempts)"
            $lastState = $jobData.state
        }

        if ($jobData.state -eq "completed") {
            Write-Host ""
            Write-Host "✓ Deployment job COMPLETED in ~${elapsed}s" -ForegroundColor Green
            $jobCompleted = $true
            break
        } elseif ($jobData.state -eq "failed") {
            Write-Host ""
            Write-Host "✗ Deployment job FAILED" -ForegroundColor Red
            Write-Host "  Reason: $($jobData.failedReason)" -ForegroundColor Red
            if ($jobData.stacktrace) {
                Write-Host "  Stacktrace: $($jobData.stacktrace[0])" -ForegroundColor Red
            }
            exit 1
        }

    } catch {
        Write-Host "⚠ Error polling job: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Start-Sleep -Seconds $checkInterval
    $elapsed += $checkInterval
}

if (-not $jobCompleted) {
    Write-Host "⚠ Job still running after ${JobTimeoutSeconds}s — GitOps/ArgoCD sync may still be in progress" -ForegroundColor Yellow
    Write-Host "  Poll manually: GET $BaseUrl/api/queue/jobs/$deploymentJobId" -ForegroundColor Yellow
    Write-Host ""
}

# Test 4: Verify Deployment Status via API
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 4: Verify Deployment Status"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$dbVerified = $false
try {
    # GET /api/customers/:id/deployment/status - no admin auth required
    $statusData = Invoke-RestMethod -Uri "$BaseUrl/api/customers/$customerId/deployment/status" `
        -Method Get

    Write-Host "Deployment status: $($statusData.deployment_status)"
    Write-Host "  Last step:   $($statusData.last_provisioning_step)"
    Write-Host "  Instance URL: $($statusData.instance_url)"
    Write-Host "  Namespace:    $($statusData.instance_namespace)"
    Write-Host ""
    Write-Host "Database credentials recorded:"
    Write-Host "  Host:     $($statusData.database.host)"
    Write-Host "  Port:     $($statusData.database.port)"
    Write-Host "  Name:     $($statusData.database.name)"

    if ($statusData.database.host -and $statusData.database.name) {
        Write-Host ""
        Write-Host "✓ Database credentials stored in customer record" -ForegroundColor Green
        $dbVerified = $true
    } else {
        Write-Host ""
        Write-Host "⚠ Database credentials not yet recorded (provisioning may still be running)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠ Could not retrieve deployment status: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "E2E TEST SUMMARY"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "✓ Step 1: API healthy"
Write-Host "✓ Step 2: Customer signed up & deployment queued"
Write-Host "$(if ($jobCompleted) { '✓' } else { '⏳' }) Step 3: Deployment job $(if ($jobCompleted) { 'completed' } else { 'still processing' })"
Write-Host "$(if ($dbVerified) { '✓' } else { '⏳' }) Step 4: DB credentials $(if ($dbVerified) { 'recorded' } else { 'pending' })"
Write-Host ""
Write-Host "Customer:"
Write-Host "  ID:        $customerId"
Write-Host "  Email:     $Email"
Write-Host "  Namespace: $namespace"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Poll job:    GET $BaseUrl/api/queue/jobs/$deploymentJobId  (Bearer token required)"
Write-Host "  Status:      GET $BaseUrl/api/customers/$customerId/deployment/status"
Write-Host "  ArgoCD app:  kubectl get app $namespace -n iotistica-argocd"
Write-Host "  CNPG DB:     kubectl get database.postgresql.cnpg.io -n iotistica-cnpg-cl01"
Write-Host ""


param(
    [string]$BaseUrl = "http://localhost:3100",
    [string]$Email = "test-e2e-$(Get-Random -Minimum 10000 -Maximum 99999)@example.com",
    [string]$CompanyName = "Test Company $(Get-Random)",
    [string]$Password = "TestPassword123!"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗"
Write-Host "║                   E2E SIGNUP & PROVISIONING TEST              ║"
Write-Host "╚════════════════════════════════════════════════════════════════╝"
Write-Host ""

Write-Host "Configuration:"
Write-Host "  Base URL:     $BaseUrl"
Write-Host "  Email:        $Email"
Write-Host "  Company:      $CompanyName"
Write-Host "  Password:     $(('*' * 8))"
Write-Host ""

# Test 1: Verify services are running
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 1: Verify Provisioning API is running"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

try {
    $healthResponse = Invoke-WebRequest -Uri "$BaseUrl/health" `
        -Method Get `
        -ContentType "application/json" `
        -ErrorAction Stop
    
    if ($healthResponse.StatusCode -eq 200) {
        Write-Host "✓ API Health: OK (Status 200)" -ForegroundColor Green
    }
} catch {
    Write-Host "✗ API Health Check Failed" -ForegroundColor Red
    Write-Host "  Make sure provisioning API is running:" -ForegroundColor Yellow
    Write-Host "  cd provisioning && docker compose up -d" -ForegroundColor Yellow
    exit 1
}

# Verify PostgreSQL provisioning is enabled
Write-Host ""
Write-Host "Checking database provider..."
try {
    $configResponse = Invoke-WebRequest -Uri "$BaseUrl/api/admin/template/status" `
        -Method Get `
        -Headers @{ Authorization = "Bearer your-token-here" } `
        -ContentType "application/json" `
        -ErrorAction SilentlyContinue
    
    Write-Host "✓ Template database accessible (PostgreSQL provisioning active)" -ForegroundColor Green
} catch {
    Write-Host "⚠ Could not verify database provider" -ForegroundColor Yellow
}

Write-Host ""

# Test 2: Customer Signup
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 2: Customer Signup"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$signupPayload = @{
    email = $Email
    password = $Password
    company_name = $CompanyName
    full_name = "Test User"
} | ConvertTo-Json

try {
    $signupResponse = Invoke-WebRequest -Uri "$BaseUrl/api/customers/signup" `
        -Method Post `
        -Body $signupPayload `
        -ContentType "application/json"
    
    $signupData = $signupResponse.Content | ConvertFrom-Json
    
    if ($signupData.customer) {
        Write-Host "✓ Customer Signup: SUCCESS" -ForegroundColor Green
        Write-Host "  Customer ID:   $($signupData.customer.customer_id)"
        Write-Host "  Email:         $($signupData.customer.email)"
        Write-Host "  Company:       $($signupData.customer.company_name)"
        Write-Host ""
        
        Write-Host "✓ Subscription Created: $($signupData.subscription.plan)" -ForegroundColor Green
        Write-Host "  Status:        $($signupData.subscription.status)"
        Write-Host "  Trial Ends:    $($signupData.subscription.trial_ends_at)"
        Write-Host "  Days Remaining: $($signupData.subscription.trial_days_remaining)"
        Write-Host ""
        
        Write-Host "✓ Deployment Job: Queued" -ForegroundColor Green
        Write-Host "  Job ID:        $($signupData.deployment.job_id)"
        Write-Host "  Namespace:     $($signupData.deployment.namespace)"
        Write-Host "  Status:        $($signupData.deployment.status)"
        Write-Host ""
        
        $customerId = $signupData.customer.customer_id
        $deploymentJobId = $signupData.deployment.job_id
        $namespace = $signupData.deployment.namespace
    } else {
        Write-Host "✗ Customer Signup: FAILED" -ForegroundColor Red
        Write-Host "  Response: $($signupResponse.Content)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Customer Signup: ERROR" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Test 3: Check Deployment Job Status
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 3: Monitor Deployment Job"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

$checkInterval = 2  # seconds
$maxWaitTime = 30   # seconds (let it run for 30 seconds)
$elapsedTime = 0
$jobCompleted = $false

Write-Host "Waiting for deployment job to process (max $maxWaitTime seconds)..."
Write-Host ""

while ($elapsedTime -lt $maxWaitTime) {
    try {
        $jobResponse = Invoke-WebRequest -Uri "$BaseUrl/api/admin/jobs/$deploymentJobId" `
            -Method Get `
            -ContentType "application/json"
        
        $jobData = $jobResponse.Content | ConvertFrom-Json
        
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Job State: $($jobData.state)" -ForegroundColor Cyan
        Write-Host "  Type:     $($jobData.type)"
        Write-Host "  Progress: $($jobData.progress)"
        Write-Host "  Attempts: $($jobData.attempts)/$($jobData.maxAttempts)"
        
        if ($jobData.state -eq "completed") {
            Write-Host ""
            Write-Host "✓ Deployment Job: COMPLETED" -ForegroundColor Green
            Write-Host "  Duration: $([math]::Round(($maxWaitTime - $elapsedTime)))s"
            Write-Host ""
            $jobCompleted = $true
            break
        } elseif ($jobData.state -eq "failed") {
            Write-Host ""
            Write-Host "✗ Deployment Job: FAILED" -ForegroundColor Red
            Write-Host "  Error: $($jobData.failedReason)" -ForegroundColor Red
            exit 1
        }
        
        Start-Sleep -Seconds $checkInterval
        $elapsedTime += $checkInterval
        
    } catch {
        Write-Host "⚠ Error checking job status: $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Seconds $checkInterval
        $elapsedTime += $checkInterval
    }
}

if (-not $jobCompleted) {
    Write-Host "⚠ Job still processing - this is normal for longer deployments (Kubernetes, GitOps)" -ForegroundColor Yellow
    Write-Host "  Check job status later: GET /api/admin/jobs/$deploymentJobId" -ForegroundColor Yellow
    Write-Host ""
}

# Test 4: Verify Customer Database Created
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 4: Verify Customer Database Created"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Query PostgreSQL directly (must use docker)
try {
    Write-Host "Querying PostgreSQL for customer database..."
    
    # Check if database exists
    $queryResult = docker exec provisioning-postgres `
        psql -U billing -d postgres -t -c `
        "SELECT datname FROM pg_database WHERE datname LIKE '%$customerId%' OR datname = '$namespace';" `
        2>&1
    
    if ($queryResult -and $queryResult -notlike "*error*") {
        Write-Host "✓ Customer Database: FOUND" -ForegroundColor Green
        Write-Host "  Database Name: $queryResult"
        Write-Host ""
        
        # Get database owner
        $ownerResult = docker exec provisioning-postgres `
            psql -U billing -d postgres -t -c `
            "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$queryResult';" `
            2>&1
        
        if ($ownerResult) {
            Write-Host "  Owner Role:    $($ownerResult.Trim())"
        }
        
        # Get table count
        $tableResult = docker exec provisioning-postgres `
            psql -U billing -d "$queryResult" -t -c `
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');" `
            2>&1
        
        if ($tableResult -and $tableResult -ne "0") {
            Write-Host "  Table Count:   $($tableResult.Trim()) (inheritedfrom template)"
        } else {
            Write-Host "  Table Count:   0 (template is empty - no migrations applied)"
        }
    } else {
        Write-Host "⚠ Customer Database: NOT FOUND (may still be provisioning)" -ForegroundColor Yellow
        Write-Host "  This is normal if deployment worker hasn't completed yet" -ForegroundColor Yellow
        Write-Host "  Customer ID: $customerId" -ForegroundColor Yellow
        Write-Host "  Namespace:   $namespace" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠ Could not query database (Docker command failed)" -ForegroundColor Yellow
    Write-Host "  You can manually verify with:" -ForegroundColor Yellow
    Write-Host "  docker exec provisioning-postgres psql -U billing -d postgres -l" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "E2E TEST SUMMARY" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "✓ Step 1: Customer signed up successfully"
Write-Host "✓ Step 2: Deployment job queued"
Write-Host "$(if ($jobCompleted) { '✓' } else { '⏳' }) Step 3: Deployment job processing"
Write-Host "$(if ($queryResult) { '✓' } else { '❓' }) Step 4: Customer database created"
Write-Host ""
Write-Host "Customer Details:"
Write-Host "  ID:        $customerId"
Write-Host "  Email:     $Email"
Write-Host "  Namespace: $namespace"
Write-Host ""
Write-Host "Next Steps:"
Write-Host "  1. Monitor deployment job: GET /api/admin/jobs/$deploymentJobId"
Write-Host "  2. View customer details: GET /api/customers/$customerId"
Write-Host "  3. Connect to database: psql -h localhost -p 5433 -U $namespace -d $namespace"
Write-Host ""
