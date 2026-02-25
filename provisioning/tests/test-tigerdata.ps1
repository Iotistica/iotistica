#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test TigerData API connectivity and list all services

.DESCRIPTION
    This script reads TigerData credentials from .env file and tests the
    "List All Services" endpoint to verify API connectivity.

.EXAMPLE
    .\test-tigerdata.ps1
    Lists all TimescaleDB services in your TigerData project

.EXAMPLE
    .\test-tigerdata.ps1 -Verbose
    Lists services with detailed request/response information
#>

[CmdletBinding()]
param()

# Set error action preference
$ErrorActionPreference = "Stop"

# Get the directory containing this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path (Split-Path -Parent $scriptDir) ".env"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "   TigerData API Connection Test" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env file exists
if (-not (Test-Path $envFile)) {
    Write-Host "❌ Error: .env file not found at: $envFile" -ForegroundColor Red
    Write-Host "   Please create .env file with TigerData credentials" -ForegroundColor Yellow
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
            $value = $value -replace '^["'']|["'']$', ''
            $envVars[$key] = $value
        }
    }
}

# Extract TigerData configuration
$apiUrl = $envVars['TIGERDATA_API_URL']
$accessKey = $envVars['TIGERDATA_ACCESS_KEY']
$secretKey = $envVars['TIGERDATA_SECRET_KEY']
$projectId = $envVars['TIGERDATA_PROJECT_ID']

# Validate required variables
$missingVars = @()
if (-not $apiUrl) { $missingVars += 'TIGERDATA_API_URL' }
if (-not $accessKey) { $missingVars += 'TIGERDATA_ACCESS_KEY' }
if (-not $secretKey) { $missingVars += 'TIGERDATA_SECRET_KEY' }
if (-not $projectId) { $missingVars += 'TIGERDATA_PROJECT_ID' }

if ($missingVars.Count -gt 0) {
    Write-Host "❌ Error: Missing required environment variables:" -ForegroundColor Red
    $missingVars | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
    exit 1
}

Write-Host "📋 Configuration:" -ForegroundColor White
Write-Host "   API URL:    $apiUrl" -ForegroundColor Gray
Write-Host "   Project ID: $projectId" -ForegroundColor Gray
Write-Host "   Access Key: $($accessKey.Substring(0, [Math]::Min(10, $accessKey.Length)))..." -ForegroundColor Gray
Write-Host ""

# Create Basic Auth header
$pair = "$($accessKey):$($secretKey)"
$encodedCredentials = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{
    "Authorization" = "Basic $encodedCredentials"
    "Content-Type" = "application/json"
}

Write-Verbose "Authorization header created (Basic Auth)"

# Build endpoint URL
$endpoint = "$apiUrl/projects/$projectId/services"

Write-Host "🔍 Testing endpoint:" -ForegroundColor White
Write-Host "   GET $endpoint" -ForegroundColor Gray
Write-Host ""

try {
    # Make API request
    Write-Host "⏳ Sending request..." -ForegroundColor Yellow
    
    $response = Invoke-RestMethod -Uri $endpoint -Method Get -Headers $headers -ErrorAction Stop
    
    Write-Host "✅ Success! Connected to TigerData API" -ForegroundColor Green
    Write-Host ""
    
    # Display results
    if ($response -is [Array]) {
        $services = $response
    } elseif ($response.services) {
        $services = $response.services
    } elseif ($response.data) {
        $services = $response.data
    } else {
        $services = @($response)
    }
    
    $serviceCount = if ($services) { $services.Count } else { 0 }
    
    Write-Host "📊 Found $serviceCount service(s):" -ForegroundColor Cyan
    Write-Host ""
    
    if ($serviceCount -eq 0) {
        Write-Host "   No services found in this project" -ForegroundColor Gray
        Write-Host "   This is normal if you haven't provisioned any databases yet" -ForegroundColor Gray
    } else {
        $services | ForEach-Object {
            Write-Host "   Service ID: $($_.id)" -ForegroundColor White
            Write-Host "   Name:       $($_.name)" -ForegroundColor Gray
            Write-Host "   Type:       $($_.type)" -ForegroundColor Gray
            Write-Host "   Status:     $($_.status)" -ForegroundColor $(if ($_.status -eq 'active') { 'Green' } elseif ($_.status -eq 'provisioning') { 'Yellow' } else { 'Red' })
            Write-Host "   Region:     $($_.region)" -ForegroundColor Gray
            Write-Host "   Host:       $($_.host)" -ForegroundColor Gray
            Write-Host "   Port:       $($_.port)" -ForegroundColor Gray
            Write-Host ""
        }
    }
    
    # Display raw response in verbose mode
    if ($VerbosePreference -eq 'Continue') {
        Write-Host "📄 Raw API Response:" -ForegroundColor Cyan
        $response | ConvertTo-Json -Depth 10 | Write-Host -ForegroundColor Gray
    }
    
    Write-Host "=====================================" -ForegroundColor Cyan
    Write-Host "✅ Test completed successfully" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Cyan
    
} catch {
    Write-Host "❌ Error: API request failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "   Status:  $($_.Exception.Response.StatusCode)" -ForegroundColor Yellow
    Write-Host "   Message: $($_.Exception.Message)" -ForegroundColor Yellow
    
    if ($_.ErrorDetails.Message) {
        Write-Host ""
        Write-Host "   Details:" -ForegroundColor Yellow
        try {
            $errorDetails = $_.ErrorDetails.Message | ConvertFrom-Json
            $errorDetails | ConvertTo-Json -Depth 5 | Write-Host -ForegroundColor Gray
        } catch {
            Write-Host "   $($_.ErrorDetails.Message)" -ForegroundColor Gray
        }
    }
    
    Write-Host ""
    Write-Host "💡 Troubleshooting tips:" -ForegroundColor Cyan
    Write-Host "   1. Verify your access key and secret key are correct" -ForegroundColor Gray
    Write-Host "   2. Check that the project ID exists: $projectId" -ForegroundColor Gray
    Write-Host "   3. Ensure your API keys have sufficient permissions" -ForegroundColor Gray
    Write-Host "   4. Verify the API URL is correct: $apiUrl" -ForegroundColor Gray
    
    exit 1
}
