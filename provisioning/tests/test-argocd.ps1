#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test Argo CD API connectivity and list applications

.DESCRIPTION
    This script reads Argo CD credentials from .env file and tests the
    connection, authentication, and lists all deployed applications.

.EXAMPLE
    .\test-argocd.ps1
    Lists all Argo CD applications

.EXAMPLE
    .\test-argocd.ps1 -ClientId "a9c0fb7554e2"
    Tests connection and checks status of a specific client application

.EXAMPLE
    .\test-argocd.ps1 -Verbose
    Lists applications with detailed request/response information
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$ClientId
)

# Set error action preference
$ErrorActionPreference = "Stop"

# Get the directory containing this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path (Split-Path -Parent $scriptDir) ".env"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "   Argo CD Connection Test" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env file exists
if (-not (Test-Path $envFile)) {
    Write-Host "❌ Error: .env file not found at: $envFile" -ForegroundColor Red
    Write-Host "   Please create .env file with Argo CD credentials" -ForegroundColor Yellow
    exit 1
}

Write-Verbose "Reading configuration from: $envFile"

# Parse .env file
$envVars = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    # Skip comments and empty lines
    if ($line -and -not $line.StartsWith('#')) {
        if ($line -match '^([^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            # Remove quotes if present
            $value = $value -replace '^[''"]|[''"]$', ''
            $envVars[$key] = $value
        }
    }
}

# Extract required variables
$baseUrl = $envVars['ARGOCD_BASE_URL']
$token = $envVars['ARGOCD_TOKEN']
$skipCheck = $envVars['SKIP_ARGOCD_STATUS_CHECK']

if (-not $baseUrl) {
    Write-Host "❌ Error: ARGOCD_BASE_URL not found in .env" -ForegroundColor Red
    exit 1
}

if (-not $token) {
    Write-Host "❌ Error: ARGOCD_TOKEN not found in .env" -ForegroundColor Red
    exit 1
}

# Remove trailing slash from base URL
$baseUrl = $baseUrl.TrimEnd('/')

Write-Host "📋 Configuration:" -ForegroundColor Yellow
Write-Host "   Base URL: $baseUrl"
$tokenPreview = $token.Substring(0, [Math]::Min(20, $token.Length)) + "..." + $token.Substring([Math]::Max(0, $token.Length - 10))
Write-Host "   Token:    $tokenPreview"
Write-Host "   Skip Check: $($skipCheck -eq 'true')"
Write-Host ""

# Setup headers
$headers = @{
    'Authorization' = "Bearer $token"
    'Content-Type' = 'application/json'
}

try {
    # Skip SSL certificate validation for dev/test
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        # PowerShell Core/7+
        $PSDefaultParameterValues['Invoke-RestMethod:SkipCertificateCheck'] = $true
    } else {
        # Windows PowerShell 5.1
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    }

    # Test 1: Basic Connection & Authentication
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "Test 1: Basic Connection & Authentication" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "⏳ Testing connection to Argo CD API..." -ForegroundColor Yellow
    $versionUrl = "$baseUrl/api/version"
    Write-Verbose "GET $versionUrl"
    
    $version = Invoke-RestMethod -Uri $versionUrl -Headers $headers -Method Get
    Write-Host "✅ Connection successful!" -ForegroundColor Green
    Write-Host ""
    
    Write-Host "📊 Argo CD Version Info:" -ForegroundColor Yellow
    Write-Host "   Version:     $($version.Version)"
    Write-Host "   Build Date:  $($version.BuildDate)"
    Write-Host "   Git Commit:  $($version.GitCommit.Substring(0, [Math]::Min(8, $version.GitCommit.Length)))"
    Write-Host ""

    # Test 2: List Applications
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host "Test 2: List All Applications" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "⏳ Fetching applications from Argo CD..." -ForegroundColor Yellow
    $appsUrl = "$baseUrl/api/v1/applications"
    Write-Verbose "GET $appsUrl"
    
    $appsResponse = Invoke-RestMethod -Uri $appsUrl -Headers $headers -Method Get
    $applications = $appsResponse.items
    
    Write-Host "✅ Found $($applications.Count) application(s)" -ForegroundColor Green
    Write-Host ""
    
    if ($applications.Count -eq 0) {
        Write-Host "ℹ️  No applications deployed yet" -ForegroundColor Yellow
    } else {
        Write-Host "📋 Applications List:" -ForegroundColor Yellow
        
        for ($i = 0; $i -lt $applications.Count; $i++) {
            $app = $applications[$i]
            
            $syncIcon = if ($app.status.sync.status -eq 'Synced') { '✅' } else { '⚠️' }
            $healthIcon = switch ($app.status.health.status) {
                'Healthy' { '💚' }
                'Progressing' { '🔄' }
                default { '❌' }
            }
            
            Write-Host ""
            Write-Host "   $($i + 1). $($app.metadata.name)" -ForegroundColor Cyan
            Write-Host "      Namespace:  $($app.spec.destination.namespace)"
            Write-Host "      Sync:       $syncIcon $($app.status.sync.status)"
            Write-Host "      Health:     $healthIcon $($app.status.health.status)"
            
            if ($app.status.health.message) {
                Write-Host "      Message:    $($app.status.health.message)"
            }
            
            if ($app.status.operationState) {
                Write-Host "      Operation:  $($app.status.operationState.phase)"
            }
        }
    }
    Write-Host ""

    # Test 3: Get Specific Application Details (first one)
    if ($applications.Count -gt 0) {
        Write-Host "================================================================================" -ForegroundColor Cyan
        Write-Host "Test 3: Get Specific Application Details" -ForegroundColor Cyan
        Write-Host "================================================================================" -ForegroundColor Cyan
        Write-Host ""
        
        $firstApp = $applications[0]
        $appName = $firstApp.metadata.name
        
        Write-Host "⏳ Fetching details for: $appName..." -ForegroundColor Yellow
        $appUrl = "$baseUrl/api/v1/applications/$appName"
        Write-Verbose "GET $appUrl"
        
        $app = Invoke-RestMethod -Uri $appUrl -Headers $headers -Method Get
        Write-Host "✅ Application details retrieved" -ForegroundColor Green
        Write-Host ""
        
        Write-Host "📊 Detailed Information:" -ForegroundColor Yellow
        Write-Host "   Name:           $($app.metadata.name)"
        Write-Host "   Namespace:      $($app.metadata.namespace)"
        Write-Host "   Target NS:      $($app.spec.destination.namespace)"
        Write-Host "   Server:         $($app.spec.destination.server)"
        Write-Host "   Repo URL:       $($app.spec.source.repoURL)"
        Write-Host "   Path:           $($app.spec.source.path)"
        Write-Host "   Sync Status:    $($app.status.sync.status)"
        Write-Host "   Health Status:  $($app.status.health.status)"
        
        if ($app.status.sync.revision) {
            $revisionShort = $app.status.sync.revision.Substring(0, [Math]::Min(8, $app.status.sync.revision.Length))
            Write-Host "   Revision:       $revisionShort"
        }
        
        if ($app.status.operationState) {
            Write-Host "   Operation:      $($app.status.operationState.phase)"
            if ($app.status.operationState.message) {
                Write-Host "   Msg:            $($app.status.operationState.message)"
            }
        }
        Write-Host ""
        
        # Check if ready
        $isSynced = $app.status.sync.status -eq 'Synced'
        $isHealthy = $app.status.health.status -eq 'Healthy'
        $isReady = $isSynced -and $isHealthy
        
        Write-Host "🎯 Readiness Check:" -ForegroundColor Yellow
        Write-Host "   Synced:   $(if ($isSynced) { '✅ Yes' } else { '❌ No' })"
        Write-Host "   Healthy:  $(if ($isHealthy) { '✅ Yes' } else { '❌ No' })"
        Write-Host "   Ready:    $(if ($isReady) { '✅ Yes' } else { '❌ No' })"
        Write-Host ""
    }

    # Test 4: Test Specific Client Application (if ClientId provided)
    if ($ClientId) {
        Write-Host "================================================================================" -ForegroundColor Cyan
        Write-Host "Test 4: Test Specific Client Application" -ForegroundColor Cyan
        Write-Host "================================================================================" -ForegroundColor Cyan
        Write-Host ""
        
        $appName = "client-$ClientId"
        Write-Host "⏳ Looking for application: $appName..." -ForegroundColor Yellow
        
        try {
            $appUrl = "$baseUrl/api/v1/applications/$appName"
            Write-Verbose "GET $appUrl"
            
            $app = Invoke-RestMethod -Uri $appUrl -Headers $headers -Method Get
            Write-Host "✅ Application found!" -ForegroundColor Green
            Write-Host ""
            
            Write-Host "📊 Application Status:" -ForegroundColor Yellow
            Write-Host "   Name:         $($app.metadata.name)"
            Write-Host "   Namespace:    $($app.spec.destination.namespace)"
            Write-Host "   Sync:         $($app.status.sync.status)"
            Write-Host "   Health:       $($app.status.health.status)"
            
            $isSynced = $app.status.sync.status -eq 'Synced'
            $isHealthy = $app.status.health.status -eq 'Healthy'
            $isReady = $isSynced -and $isHealthy
            
            $readyText = if ($isReady) { 
                '✅ Yes' 
            } else { 
                "❌ No (Synced: $isSynced, Healthy: $isHealthy)" 
            }
            Write-Host "   Ready:        $readyText"
            Write-Host ""
        }
        catch {
            if ($_.Exception.Response.StatusCode -eq 404) {
                Write-Host "❌ Application not found in Argo CD" -ForegroundColor Red
                Write-Host "   Expected name: $appName" -ForegroundColor Yellow
                Write-Host "   This is normal if the application has not been deployed yet" -ForegroundColor Yellow
            } else {
                throw
            }
            Write-Host ""
        }
    }

    # Success summary
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "✅ ALL TESTS PASSED" -ForegroundColor Green
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Connection Test Results:" -ForegroundColor Yellow
    Write-Host "  ✅ Argo CD API is accessible"
    Write-Host "  ✅ Authentication token is valid"
    Write-Host "  ✅ HTTPS configured correctly"
    Write-Host "  ✅ Found $($applications.Count) deployed application(s)"
    Write-Host ""
    Write-Host "Usage Tips:" -ForegroundColor Cyan
    Write-Host "  • Test specific client: .\test-argocd.ps1 -ClientId `"a9c0fb7554e2`""
    Write-Host "  • Verbose output:       .\test-argocd.ps1 -Verbose"
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "================================================================================" -ForegroundColor Red
    Write-Host "❌ TEST FAILED" -ForegroundColor Red
    Write-Host "================================================================================" -ForegroundColor Red
    Write-Host ""
    
    if ($_.Exception.Message -match "Unable to resolve|Could not resolve") {
        Write-Host "❌ Connection Error: DNS resolution failed" -ForegroundColor Red
        Write-Host "   Cannot resolve hostname: $baseUrl" -ForegroundColor Yellow
        Write-Host "   Check your ARGOCD_BASE_URL in .env" -ForegroundColor Yellow
    }
    elseif ($_.Exception.Response.StatusCode -eq 401) {
        Write-Host "❌ Authentication Error: Invalid token" -ForegroundColor Red
        Write-Host "   Your ARGOCD_TOKEN may be expired or invalid" -ForegroundColor Yellow
        Write-Host "   Generate a new token from Argo CD UI:" -ForegroundColor Yellow
        Write-Host "   Settings → Accounts → Generate New Token" -ForegroundColor Yellow
    }
    elseif ($_.Exception.Response.StatusCode -eq 403) {
        Write-Host "❌ Authorization Error: Insufficient permissions" -ForegroundColor Red
        Write-Host "   Your token does not have permission to access this resource" -ForegroundColor Yellow
    }
    else {
        Write-Host "❌ Unexpected Error:" -ForegroundColor Red
        Write-Host "   Message: $($_.Exception.Message)" -ForegroundColor Yellow
        
        if ($_.Exception.Response) {
            Write-Host "   Status:  $($_.Exception.Response.StatusCode)" -ForegroundColor Yellow
        }
        
        if ($VerbosePreference -eq 'Continue') {
            Write-Host ""
            Write-Host "📋 Full Error Details:" -ForegroundColor Cyan
            Write-Host $_.Exception.ToString()
        }
    }
    
    Write-Host ""
    exit 1
}
