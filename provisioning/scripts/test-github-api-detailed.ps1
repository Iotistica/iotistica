#!/usr/bin/env pwsh
# Test GitHub API with detailed error messages

Write-Host "`n=== GitHub API Detailed Test ===" -ForegroundColor Cyan

# Test from container with full response
Write-Host "`n1. Testing with full response body..." -ForegroundColor Yellow
$response = docker exec provisioning-worker curl -s -i https://api.github.com/repos/Iotistica/iotistic/releases/latest 2>&1
Write-Host $response
Write-Host ""

# Check if repo is accessible without auth
Write-Host "`n2. Testing repository accessibility..." -ForegroundColor Yellow
$repoCheck = docker exec provisioning-worker curl -s https://api.github.com/repos/Iotistica/iotistic 2>&1
$repoJson = $repoCheck | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($repoJson.message -eq "Not Found") {
    Write-Host "   ✗ Repository not found or is private" -ForegroundColor Red
    Write-Host "   Message: $($repoJson.message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "   This suggests the repository is PRIVATE and needs authentication." -ForegroundColor Yellow
    Write-Host "   Add a GitHub token to .env: GITHUB_TOKEN=ghp_..." -ForegroundColor Yellow
} elseif ($repoJson.private -eq $true) {
    Write-Host "   ✓ Repository found but it's PRIVATE" -ForegroundColor Yellow
    Write-Host "   Name: $($repoJson.full_name)" -ForegroundColor Gray
    Write-Host "   You need authentication to access releases" -ForegroundColor Yellow
} else {
    Write-Host "   ✓ Repository is public and accessible" -ForegroundColor Green
    Write-Host "   Name: $($repoJson.full_name)" -ForegroundColor Gray
}

# Check if releases endpoint exists
Write-Host "`n3. Testing releases endpoint..." -ForegroundColor Yellow
$releasesCheck = docker exec provisioning-worker curl -s https://api.github.com/repos/Iotistica/iotistic/releases 2>&1
$releasesList = $releasesCheck | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($releasesList -is [array]) {
    if ($releasesList.Count -eq 0) {
        Write-Host "   ✗ No releases found in repository" -ForegroundColor Red
        Write-Host "   Create a release in GitHub first" -ForegroundColor Yellow
    } else {
        Write-Host "   ✓ Found $($releasesList.Count) releases" -ForegroundColor Green
        Write-Host "   Latest: $($releasesList[0].tag_name) (published: $($releasesList[0].published_at))" -ForegroundColor Green
        Write-Host "   Is prerelease: $($releasesList[0].prerelease)" -ForegroundColor Gray
        Write-Host "   Is draft: $($releasesList[0].draft)" -ForegroundColor Gray
    }
} elseif ($releasesList.message) {
    Write-Host "   ✗ Error: $($releasesList.message)" -ForegroundColor Red
}

Write-Host "`n=== Recommendation ===" -ForegroundColor Cyan
Write-Host "Based on the 404 error, you need to:"
Write-Host "1. Verify the repository exists: https://github.com/Iotistica/iotistic"
Write-Host "2. If private, add GitHub token to release-service.ts axios config"
Write-Host "3. If no releases exist, create one in GitHub"
Write-Host ""
