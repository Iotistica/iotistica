#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test TigerData database creation API response format
#>

$ErrorActionPreference = "Stop"

# Get credentials from .env
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path (Split-Path -Parent $scriptDir) ".env"

$envVars = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
        if ($line -match '^([^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim() -replace '^["'']|["'']$', ''
            $envVars[$key] = $value
        }
    }
}

$apiUrl = $envVars['TIGERDATA_API_URL']
$accessKey = $envVars['TIGERDATA_ACCESS_KEY']
$secretKey = $envVars['TIGERDATA_SECRET_KEY']
$projectId = $envVars['TIGERDATA_PROJECT_ID']

# Create Basic Auth
$pair = "$($accessKey):$($secretKey)"
$encodedCredentials = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{
    "Authorization" = "Basic $encodedCredentials"
    "Content-Type" = "application/json"
}

$endpoint = "$apiUrl/projects/$projectId/services"

Write-Host "`n📋 Testing database creation API response format" -ForegroundColor Cyan
Write-Host "Endpoint: POST $endpoint`n" -ForegroundColor Gray

# Create test database
$testName = "test-response-format-$(Get-Random -Maximum 9999)"
$body = @{
    name = $testName
    type = "timescaledb"
    region = "us-east-1"
    plan = "dev"
} | ConvertTo-Json

Write-Host "🚀 Creating test database: $testName" -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body -ErrorAction Stop
    
    Write-Host "✅ Database creation request succeeded!`n" -ForegroundColor Green
    
    Write-Host "📄 RAW RESPONSE STRUCTURE:" -ForegroundColor Cyan
    Write-Host "Response Type: $($response.GetType().FullName)" -ForegroundColor Gray
    Write-Host "`nResponse Keys:" -ForegroundColor White
    if ($response -is [PSCustomObject]) {
        $response.PSObject.Properties | ForEach-Object {
            Write-Host "  - $($_.Name): $($_.Value)" -ForegroundColor Gray
        }
    }
    
    Write-Host "`n📋 Full JSON Response:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 10 | Write-Host -ForegroundColor Gray
    
    # Try to delete test database if we got an ID
    $serviceId = $response.id
    if ($serviceId) {
        Write-Host "`n🗑️  Cleaning up test database (ID: $serviceId)..." -ForegroundColor Yellow
        try {
            Invoke-RestMethod -Uri "$endpoint/$serviceId" -Method Delete -Headers $headers -ErrorAction Stop
            Write-Host "✅ Test database deleted`n" -ForegroundColor Green
        } catch {
            Write-Host "⚠️  Could not delete test database: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "   You may need to delete it manually: $testName`n" -ForegroundColor Gray
        }
    } else {
        Write-Host "`n⚠️  No 'id' field found in response - cannot clean up" -ForegroundColor Yellow
        Write-Host "   You may need to delete manually: $testName`n" -ForegroundColor Gray
    }
    
} catch {
    Write-Host "❌ API request failed`n" -ForegroundColor Red
    Write-Host "Status: $($_.Exception.Response.StatusCode)" -ForegroundColor Yellow
    Write-Host "Message: $($_.Exception.Message)`n" -ForegroundColor Yellow
    
    if ($_.ErrorDetails.Message) {
        Write-Host "Error Details:" -ForegroundColor Yellow
        $_.ErrorDetails.Message | Write-Host -ForegroundColor Gray
    }
    exit 1
}
