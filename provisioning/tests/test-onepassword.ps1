#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test 1Password Connect API connectivity

.DESCRIPTION
    This script reads 1Password Connect credentials from .env file and tests
    the API by listing vaults and items to verify connectivity.

.EXAMPLE
    .\test-onepassword.ps1
    Lists all vaults and items in the configured vault

.EXAMPLE
    .\test-onepassword.ps1 -Verbose
    Shows detailed request/response information
#>

[CmdletBinding()]
param()

# Set error action preference
$ErrorActionPreference = "Stop"

# Get the directory containing this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path (Split-Path -Parent $scriptDir) ".env"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  1Password Connect API Test" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Check if .env file exists
if (-not (Test-Path $envFile)) {
    Write-Host "❌ Error: .env file not found at: $envFile" -ForegroundColor Red
    Write-Host "   Please create .env file with 1Password Connect credentials" -ForegroundColor Yellow
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

# Extract 1Password configuration
$connectUrl = $envVars['ONEPASSWORD_CONNECT_URL']
$connectToken = $envVars['ONEPASSWORD_CONNECT_TOKEN']
$vaultId = $envVars['ONEPASSWORD_VAULT_ID']

# Validate required variables
$missingVars = @()
if (-not $connectUrl) { $missingVars += 'ONEPASSWORD_CONNECT_URL' }
if (-not $connectToken) { $missingVars += 'ONEPASSWORD_CONNECT_TOKEN' }
if (-not $vaultId) { $missingVars += 'ONEPASSWORD_VAULT_ID' }

if ($missingVars.Count -gt 0) {
    Write-Host "❌ Error: Missing required environment variables:" -ForegroundColor Red
    $missingVars | ForEach-Object { Write-Host "   - $_" -ForegroundColor Yellow }
    exit 1
}

Write-Host "📋 Configuration:" -ForegroundColor White
Write-Host "   Connect URL: $connectUrl" -ForegroundColor Gray
Write-Host "   Vault ID:    $vaultId" -ForegroundColor Gray
Write-Host "   Token:       $($connectToken.Substring(0, [Math]::Min(20, $connectToken.Length)))..." -ForegroundColor Gray
Write-Host ""

# Create headers
$headers = @{
    "Authorization" = "Bearer $connectToken"
    "Content-Type" = "application/json"
}

Write-Verbose "Authorization header created (Bearer token)"

# Test 1: List all vaults
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Test 1: List All Vaults" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

$vaultsEndpoint = "$connectUrl/v1/vaults"
Write-Host "🔍 Testing endpoint:" -ForegroundColor White
Write-Host "   GET $vaultsEndpoint" -ForegroundColor Gray
Write-Host ""

try {
    Write-Host "⏳ Sending request..." -ForegroundColor Yellow
    
    $vaultsResponse = Invoke-RestMethod -Uri $vaultsEndpoint -Method Get -Headers $headers -ErrorAction Stop
    
    Write-Host "✅ Success! Connected to 1Password Connect API" -ForegroundColor Green
    Write-Host ""
    
    $vaults = if ($vaultsResponse -is [Array]) { $vaultsResponse } else { @($vaultsResponse) }
    
    Write-Host "📊 Found $($vaults.Count) vault(s):" -ForegroundColor Cyan
    Write-Host ""
    
    $configuredVaultFound = $false
    foreach ($vault in $vaults) {
        $isConfigured = $vault.id -eq $vaultId
        if ($isConfigured) { $configuredVaultFound = $true }
        
        $marker = if ($isConfigured) { "👉" } else { "  " }
        Write-Host "$marker Vault ID:   $($vault.id)" -ForegroundColor $(if ($isConfigured) { 'Green' } else { 'White' })
        Write-Host "   Name:       $($vault.name)" -ForegroundColor Gray
        Write-Host "   Type:       $($vault.type)" -ForegroundColor Gray
        if ($isConfigured) {
            Write-Host "   ✓ This is your configured vault (ONEPASSWORD_VAULT_ID)" -ForegroundColor Green
        }
        Write-Host ""
    }
    
    if (-not $configuredVaultFound) {
        Write-Host "⚠️  Warning: Configured vault ID '$vaultId' not found in available vaults!" -ForegroundColor Yellow
        Write-Host "   Please verify ONEPASSWORD_VAULT_ID in .env file" -ForegroundColor Yellow
        Write-Host ""
    }
    
} catch {
    Write-Host "❌ Error: Failed to list vaults" -ForegroundColor Red
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
    Write-Host "   1. Verify 1Password Connect server is running" -ForegroundColor Gray
    Write-Host "   2. Check that the Connect URL is correct: $connectUrl" -ForegroundColor Gray
    Write-Host "   3. Verify your Connect token is valid and has not expired" -ForegroundColor Gray
    Write-Host "   4. Ensure the token has permission to access vaults" -ForegroundColor Gray
    
    exit 1
}

# Test 2: List items in configured vault
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Test 2: List Items in Vault" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

$itemsEndpoint = "$connectUrl/v1/vaults/$vaultId/items"
Write-Host "🔍 Testing endpoint:" -ForegroundColor White
Write-Host "   GET $itemsEndpoint" -ForegroundColor Gray
Write-Host ""

try {
    Write-Host "⏳ Sending request..." -ForegroundColor Yellow
    
    $itemsResponse = Invoke-RestMethod -Uri $itemsEndpoint -Method Get -Headers $headers -ErrorAction Stop
    
    Write-Host "✅ Success! Can access vault items" -ForegroundColor Green
    Write-Host ""
    
    $items = if ($itemsResponse -is [Array]) { $itemsResponse } else { @($itemsResponse) }
    
    Write-Host "📊 Found $($items.Count) item(s) in vault:" -ForegroundColor Cyan
    Write-Host ""
    
    if ($items.Count -eq 0) {
        Write-Host "   No items found in this vault" -ForegroundColor Gray
        Write-Host "   This is normal if you haven't created any secrets yet" -ForegroundColor Gray
    } else {
        foreach ($item in $items) {
            Write-Host "   Item ID:   $($item.id)" -ForegroundColor White
            Write-Host "   Title:     $($item.title)" -ForegroundColor Gray
            Write-Host "   Category:  $($item.category)" -ForegroundColor Gray
            Write-Host "   Vault:     $($item.vault.id)" -ForegroundColor Gray
            
            # Check if this is a database credential item
            if ($item.title -match '^sql-credentials-') {
                Write-Host "   Type:      Database Credential ✓" -ForegroundColor Green
            }
            
            Write-Host ""
        }
    }
    
    # Display raw response in verbose mode
    if ($VerbosePreference -eq 'Continue') {
        Write-Host "📄 Raw API Response:" -ForegroundColor Cyan
        $itemsResponse | ConvertTo-Json -Depth 10 | Write-Host -ForegroundColor Gray
        Write-Host ""
    }
    
} catch {
    Write-Host "❌ Error: Failed to list vault items" -ForegroundColor Red
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
    Write-Host "💡 This might indicate:" -ForegroundColor Cyan
    Write-Host "   1. The vault ID '$vaultId' doesn't exist" -ForegroundColor Gray
    Write-Host "   2. The token doesn't have access to this vault" -ForegroundColor Gray
    Write-Host "   3. The vault name might be different from the ID" -ForegroundColor Gray
    
    exit 1
}

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "✅ All tests completed successfully" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "💡 Your 1Password Connect API is ready to use!" -ForegroundColor Cyan
Write-Host "   The provisioning service will create items with titles like:" -ForegroundColor Gray
Write-Host "   'sql-credentials-client-abc123'" -ForegroundColor Gray
