#!/usr/bin/env pwsh
<#
.SYNOPSIS
Test the template rebuild endpoint

.DESCRIPTION
This script demonstrates how to use the new template rebuild endpoints:
- POST /api/admin/template/rebuild   - Rebuild template from GitHub migrations
- GET  /api/admin/template/status    - Check template status

.EXAMPLE
.\test-template-rebuild.ps1
#>

param(
    [string]$BaseUrl = 'http://localhost:3100',
    [string]$AdminToken = ''
)

# Load admin token from .env if not provided
if ([string]::IsNullOrEmpty($AdminToken)) {
    $envPath = Join-Path $PSScriptRoot '..\provisioning\.env'
    if (Test-Path $envPath) {
        $envContent = Get-Content $envPath -Raw
        $adminTokenLine = $envContent -split "`n" | Where-Object { $_ -match '^ADMIN_API_TOKEN=' }
        if ($adminTokenLine) {
            $AdminToken = $adminTokenLine -replace '^ADMIN_API_TOKEN=', ''
        }
    }
}

# Fallback to hardcoded token if still empty (for CI/CD scenarios)
if ([string]::IsNullOrEmpty($AdminToken)) {
    $AdminToken = '51f00fe8797d390f15b8c6bcb9167af2f4fa8679288e607564f62b4d3c799b09'
}

$headers = @{
    'Authorization' = "Bearer $AdminToken"
    'Content-Type' = 'application/json'
}

Write-Host "Template Rebuild Endpoint Tests" -ForegroundColor Cyan
Write-Host "================================`n"
Write-Host "Using Admin Token: $($AdminToken.Substring(0, 16))..." -ForegroundColor Gray
Write-Host ""

# Test 1: Check current template status
Write-Host "TEST 1: Check Template Status" -ForegroundColor Green
Write-Host "GET $BaseUrl/api/admin/template/status`n"

try {
    $statusResponse = Invoke-WebRequest `
        -Uri "$BaseUrl/api/admin/template/status" `
        -Method Get `
        -Headers $headers
    
    $status = $statusResponse.Content | ConvertFrom-Json
    Write-Host "Response:" -ForegroundColor Yellow
    Write-Host ($status | ConvertTo-Json -Depth 5)
    Write-Host ""
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
}

# Test 2: Rebuild template from GitHub
Write-Host "`nTEST 2: Rebuild Template from GitHub" -ForegroundColor Green
Write-Host "POST $BaseUrl/api/admin/template/rebuild`n"

try {
    $rebuildResponse = Invoke-WebRequest `
        -Uri "$BaseUrl/api/admin/template/rebuild" `
        -Method Post `
        -Headers $headers
    
    $rebuild = $rebuildResponse.Content | ConvertFrom-Json
    
    if ($rebuild.success) {
        Write-Host "SUCCESS!" -ForegroundColor Green
        Write-Host "Template rebuilt in $($rebuild.metadata.totalDurationMs)ms" -ForegroundColor Green
        Write-Host "SQL applied: $($rebuild.metadata.sqlBytes) bytes" -ForegroundColor Green
        Write-Host ""
        Write-Host "Full Response:" -ForegroundColor Yellow
        Write-Host ($rebuild | ConvertTo-Json -Depth 5)
    }
    else {
        Write-Host "ERROR: $($rebuild.error)" -ForegroundColor Red
    }
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
}

# Test 3: Check status again
Write-Host "`nTEST 3: Verify Template Updated" -ForegroundColor Green
Write-Host "GET $BaseUrl/api/admin/template/status`n"

try {
    $statusAfter = Invoke-WebRequest `
        -Uri "$BaseUrl/api/admin/template/status" `
        -Method Get `
        -Headers $headers
    
    $status2 = $statusAfter.Content | ConvertFrom-Json
    Write-Host "Response:" -ForegroundColor Yellow
    Write-Host ($status2 | ConvertTo-Json -Depth 5)
    
    if ($status2.template.tableCount -gt 0) {
        Write-Host "`nSUCCESS! Template has $($status2.template.tableCount) tables" -ForegroundColor Green
    }
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
}

Write-Host "`nDone!" -ForegroundColor Cyan
