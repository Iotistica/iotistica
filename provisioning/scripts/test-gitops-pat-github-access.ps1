#!/usr/bin/env pwsh

Write-Host "`n=== Testing GitHub API with GITOPS_PAT ===" -ForegroundColor Cyan

# Read GITOPS_PAT from .env
$envFile = Join-Path $PSScriptRoot ".." ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "✗ .env file not found at: $envFile" -ForegroundColor Red
    exit 1
}

$gitopsPat = (Get-Content $envFile | Where-Object { $_ -match "^GITOPS_PAT=" }) -replace "^GITOPS_PAT=", ""
if (-not $gitopsPat) {
    Write-Host "✗ GITOPS_PAT not found in .env" -ForegroundColor Red
    exit 1
}

Write-Host "✓ Found GITOPS_PAT in .env" -ForegroundColor Green
Write-Host "  Token: $($gitopsPat.Substring(0, 10))..." -ForegroundColor Gray

# Test GitHub API with token
Write-Host "`n1. Testing authentication..." -ForegroundColor Yellow
try {
    $headers = @{
        "Accept" = "application/vnd.github.v3+json"
        "User-Agent" = "Iotistic-Provisioning-Service"
        "Authorization" = "Bearer $gitopsPat"
    }
    
    $response = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers
    Write-Host "✓ Authentication successful" -ForegroundColor Green
    Write-Host "  Authenticated as: $($response.login)" -ForegroundColor Gray
} catch {
    Write-Host "✗ Authentication failed" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Test releases endpoint
Write-Host "`n2. Testing releases endpoint..." -ForegroundColor Yellow
try {
    $releaseUrl = "https://api.github.com/repos/Iotistica/iotistic/releases/latest"
    $releaseResponse = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
    
    Write-Host "✓ Successfully fetched latest release" -ForegroundColor Green
    Write-Host "  Tag: $($releaseResponse.tag_name)" -ForegroundColor Cyan
    Write-Host "  Name: $($releaseResponse.name)" -ForegroundColor Gray
    Write-Host "  Published: $($releaseResponse.published_at)" -ForegroundColor Gray
    Write-Host "  Author: $($releaseResponse.author.login)" -ForegroundColor Gray
    
    if ($releaseResponse.assets.Count -gt 0) {
        Write-Host "  Assets: $($releaseResponse.assets.Count) files" -ForegroundColor Gray
    }
} catch {
    Write-Host "✗ Failed to fetch releases" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response.StatusCode -eq 404) {
        Write-Host "`n  Possible reasons:" -ForegroundColor Yellow
        Write-Host "    - No releases have been published yet" -ForegroundColor Gray
        Write-Host "    - Repository path is incorrect" -ForegroundColor Gray
        Write-Host "    - Token doesn't have access to releases" -ForegroundColor Gray
    }
    exit 1
}

# Check rate limit
Write-Host "`n3. Checking API rate limit..." -ForegroundColor Yellow
try {
    $rateLimitResponse = Invoke-RestMethod -Uri "https://api.github.com/rate_limit" -Headers $headers
    $core = $rateLimitResponse.rate
    
    Write-Host "✓ Rate limit status" -ForegroundColor Green
    Write-Host "  Limit: $($core.limit) requests/hour" -ForegroundColor Gray
    Write-Host "  Used: $($core.used)" -ForegroundColor Gray
    Write-Host "  Remaining: $($core.remaining)" -ForegroundColor Cyan
    Write-Host "  Resets at: $(Get-Date -UnixTimeSeconds $core.reset -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
} catch {
    Write-Host "⚠ Could not check rate limit" -ForegroundColor Yellow
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host "✓ GITOPS_PAT is valid and can access GitHub API" -ForegroundColor Green
Write-Host "✓ Release endpoint is accessible" -ForegroundColor Green
Write-Host "`nYou can now rebuild the containers:" -ForegroundColor White
Write-Host "  docker-compose up -d --build" -ForegroundColor Gray
Write-Host ""
