#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Generate Argo CD API token using kubectl backend access

.DESCRIPTION
    This script uses kubectl to interact with Argo CD's backend directly,
    bypassing the CLI limitation where admin account may not have apiKey capability.

.EXAMPLE
    .\argocd-generate-token.ps1
    Generates token for existing automation account or creates one if needed

.EXAMPLE
    .\argocd-generate-token.ps1 -AccountName "provisioning-bot"
    Creates/uses specific account name
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$AccountName = "provisioning-automation",
    
    [Parameter(Mandatory=$false)]
    [string]$Namespace = "argocd"
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "  Argo CD API Token Generator (kubectl backend)" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if kubectl is available
try {
    kubectl version --client --output=json | Out-Null
    Write-Host "✅ kubectl is available" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: kubectl not found or not configured" -ForegroundColor Red
    Write-Host "   Install kubectl: https://kubernetes.io/docs/tasks/tools/" -ForegroundColor Yellow
    exit 1
}

# Check if we can access the Argo CD namespace
Write-Host "⏳ Checking access to namespace: $Namespace..." -ForegroundColor Yellow
try {
    kubectl get namespace $Namespace -o json | Out-Null
    Write-Host "✅ Namespace accessible" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: Cannot access namespace '$Namespace'" -ForegroundColor Red
    Write-Host "   Make sure you're connected to the correct cluster" -ForegroundColor Yellow
    Write-Host "   Run: kubectl config current-context" -ForegroundColor Yellow
    exit 1
}
Write-Host ""

# Step 1: Check current argocd-cm ConfigMap
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Step 1: Check Argo CD Accounts Configuration" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "⏳ Reading argocd-cm ConfigMap..." -ForegroundColor Yellow
$cmData = kubectl get configmap argocd-cm -n $Namespace -o json | ConvertFrom-Json

$accountsConfig = $cmData.data.'accounts.provisioning-automation'
$adminLogin = $cmData.data.'accounts.admin'

Write-Host "📋 Current Configuration:" -ForegroundColor Yellow
if ($accountsConfig) {
    Write-Host "   ✅ Account '$AccountName' exists: $accountsConfig" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  Account '$AccountName' does not exist" -ForegroundColor Yellow
}

if ($adminLogin) {
    Write-Host "   ℹ️  Admin account config: $adminLogin" -ForegroundColor Cyan
}
Write-Host ""

# Step 2: Create/Update Account with apiKey capability
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Step 2: Create/Update Service Account" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $accountsConfig) {
    Write-Host "⏳ Creating account '$AccountName' with apiKey capability..." -ForegroundColor Yellow
    
    # Patch the ConfigMap to add the account
    $patch = @{
        data = @{
            "accounts.$AccountName" = "apiKey, login"
        }
    } | ConvertTo-Json -Depth 10
    
    kubectl patch configmap argocd-cm -n $Namespace --type merge -p $patch
    
    Write-Host "✅ Account created" -ForegroundColor Green
    Write-Host ""
    
    # Wait for changes to propagate
    Write-Host "⏳ Waiting 5 seconds for changes to propagate..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
} else {
    Write-Host "✅ Account '$AccountName' already exists" -ForegroundColor Green
    Write-Host ""
}

# Step 3: Grant RBAC permissions
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Step 3: Configure RBAC Permissions" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "⏳ Checking argocd-rbac-cm ConfigMap..." -ForegroundColor Yellow
$rbacCm = kubectl get configmap argocd-rbac-cm -n $Namespace -o json | ConvertFrom-Json

$currentPolicy = $rbacCm.data.'policy.csv'
if (-not $currentPolicy) {
    $currentPolicy = ""
}

# Define permissions needed for provisioning
$permissionsNeeded = @(
    "p, role:provisioning, applications, get, */*, allow"
    "p, role:provisioning, applications, list, *, allow"
    "g, $AccountName, role:provisioning"
)

$needsUpdate = $false
foreach ($perm in $permissionsNeeded) {
    if ($currentPolicy -notmatch [regex]::Escape($perm)) {
        $needsUpdate = $true
        break
    }
}

if ($needsUpdate) {
    Write-Host "⏳ Adding RBAC permissions..." -ForegroundColor Yellow
    
    $newPolicy = $currentPolicy
    foreach ($perm in $permissionsNeeded) {
        if ($newPolicy -notmatch [regex]::Escape($perm)) {
            $newPolicy += "`n$perm"
        }
    }
    
    $rbacPatch = @{
        data = @{
            "policy.csv" = $newPolicy.Trim()
        }
    } | ConvertTo-Json -Depth 10
    
    kubectl patch configmap argocd-rbac-cm -n $Namespace --type merge -p $rbacPatch
    
    Write-Host "✅ RBAC permissions updated" -ForegroundColor Green
    Write-Host ""
    
    # Wait for changes to propagate
    Write-Host "⏳ Waiting 5 seconds for RBAC changes to propagate..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
} else {
    Write-Host "✅ RBAC permissions already configured" -ForegroundColor Green
    Write-Host ""
}

# Step 4: Generate Token via kubectl exec
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Step 4: Generate API Token" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "⏳ Finding Argo CD server pod..." -ForegroundColor Yellow
$serverPod = kubectl get pods -n $Namespace -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].metadata.name}'

if (-not $serverPod) {
    Write-Host "❌ Error: Argo CD server pod not found" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Found pod: $serverPod" -ForegroundColor Green
Write-Host ""

Write-Host "⏳ Generating token via argocd CLI inside pod..." -ForegroundColor Yellow
try {
    # Execute token generation inside the server pod
    $token = kubectl exec -n $Namespace $serverPod -- argocd account generate-token --account $AccountName 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Error generating token:" -ForegroundColor Red
        Write-Host $token -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Troubleshooting:" -ForegroundColor Cyan
        Write-Host "  1. Restart Argo CD server: kubectl rollout restart deployment argocd-server -n $Namespace" -ForegroundColor Yellow
        Write-Host "  2. Wait 30 seconds and try again" -ForegroundColor Yellow
        exit 1
    }
    
    # Clean up token (remove any extra output)
    $token = $token.Trim()
    
    Write-Host "✅ Token generated successfully!" -ForegroundColor Green
    Write-Host ""
    
    # Display token
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "🎉 SUCCESS - Your Argo CD API Token" -ForegroundColor Green
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Account: $AccountName" -ForegroundColor Cyan
    Write-Host "Token:   $token" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Update your .env file:" -ForegroundColor Cyan
    Write-Host "ARGOCD_TOKEN=$token" -ForegroundColor White
    Write-Host ""
    
    # Test the token
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "Testing Token" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host ""
    
    $baseUrl = kubectl get configmap argocd-cm -n $Namespace -o jsonpath='{.data.url}'
    if (-not $baseUrl) {
        # Try to get from ingress/service
        $baseUrl = kubectl get ingress -n $Namespace -o jsonpath='{.items[0].spec.rules[0].host}' 2>$null
        if ($baseUrl) {
            $baseUrl = "https://$baseUrl"
        }
    }
    
    if ($baseUrl) {
        Write-Host "⏳ Testing token against: $baseUrl..." -ForegroundColor Yellow
        
        # Skip SSL verification for test
        if ($PSVersionTable.PSVersion.Major -ge 6) {
            $PSDefaultParameterValues['Invoke-RestMethod:SkipCertificateCheck'] = $true
        } else {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}
        }
        
        try {
            $headers = @{
                'Authorization' = "Bearer $token"
            }
            $version = Invoke-RestMethod -Uri "$baseUrl/api/version" -Headers $headers -Method Get
            Write-Host "✅ Token works! Argo CD version: $($version.Version)" -ForegroundColor Green
        } catch {
            Write-Host "⚠️  Could not test token automatically" -ForegroundColor Yellow
            Write-Host "   Test manually: npx ts-node tests/test-argocd-connection.ts" -ForegroundColor Cyan
        }
    } else {
        Write-Host "ℹ️  Auto-test skipped (base URL not found)" -ForegroundColor Cyan
        Write-Host "   Test manually: npx ts-node tests/test-argocd-connection.ts" -ForegroundColor Cyan
    }
    Write-Host ""
    
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "================================================================================" -ForegroundColor Green
Write-Host "✅ COMPLETE" -ForegroundColor Green
Write-Host "================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "  1. Copy the token above to your .env file" -ForegroundColor Yellow
Write-Host "  2. Run test: npx ts-node tests/test-argocd-connection.ts" -ForegroundColor Yellow
Write-Host "  3. Restart provisioning services: docker-compose restart" -ForegroundColor Yellow
Write-Host ""
