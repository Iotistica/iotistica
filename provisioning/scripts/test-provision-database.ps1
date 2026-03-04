#!/usr/bin/env pwsh
<#
.SYNOPSIS
Test the database provisioning endpoint

.DESCRIPTION
Tests the POST /api/admin/test/provision-database endpoint which creates
a test database from the template using the robust provisioning logic.

.EXAMPLE
./test-provision-database.ps1
#>

param(
    [string]$BaseUrl = "http://localhost:3100",
    [string]$Namespace = "test-customer-$(Get-Random -Minimum 1000 -Maximum 9999)"
)

# Load environment variables from .env
$envFile = "..\\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*ADMIN_API_TOKEN=' } | ForEach-Object {
        if ($_ -match 'ADMIN_API_TOKEN=(.+)') {
            $adminToken = $matches[1].Trim('"')
        }
    }
}

if (-not $adminToken) {
    Write-Error "ADMIN_API_TOKEN not found in .env file"
    exit 1
}

Write-Host "╔════════════════════════════════════════════════════════════════╗"
Write-Host "║              DATABASE PROVISIONING TEST SUITE                  ║"
Write-Host "╚════════════════════════════════════════════════════════════════╝"
Write-Host ""

Write-Host "Configuration:"
Write-Host "  Base URL:     $BaseUrl"
Write-Host "  Namespace:    $Namespace"
Write-Host "  Token:        $(($adminToken -replace '.{20}.*', '...(hidden)...') -join '')"
Write-Host ""

# Test 1: Check template status before provisioning
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 1: Verify template database exists"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/admin/template/status" `
        -Method Get `
        -Headers @{ Authorization = "Bearer $adminToken" } `
        -ContentType "application/json"
    
    $statusData = $response.Content | ConvertFrom-Json
    
    if ($statusData.success) {
        Write-Host "✓ Template Status: SUCCESS" -ForegroundColor Green
        Write-Host "  Template Name:     $($statusData.template.name)"
        Write-Host "  Exists:            $($statusData.template.exists)"
        Write-Host "  Is Template:       $($statusData.template.is_template)"
        Write-Host "  Allow Connections: $($statusData.template.allow_connections)"
        Write-Host "  Table Count:       $($statusData.template.tableCount)"
        Write-Host ""
    } else {
        Write-Host "✗ Template Status: FAILED" -ForegroundColor Red
        Write-Host "  Message: $($statusData.message)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Template Status: ERROR" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Test 2: Provision a test database
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 2: Provision test database from template"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/admin/test/provision-database?namespace=$Namespace" `
        -Method Post `
        -Headers @{ Authorization = "Bearer $adminToken" } `
        -ContentType "application/json"
    
    $provisionData = $response.Content | ConvertFrom-Json
    
    if ($provisionData.success) {
        Write-Host "✓ Database Provisioning: SUCCESS" -ForegroundColor Green
        Write-Host "  Message:             $($provisionData.message)"
        Write-Host "  Database Name:       $($provisionData.database.databaseName)"
        Write-Host "  Owner Role:          $($provisionData.database.ownerRole)"
        Write-Host "  Created At:          $($provisionData.database.createdAt)"
        Write-Host "  Duration:            $($provisionData.metadata.duration)"
        Write-Host ""
        
        Write-Host "  Connection Details:"
        Write-Host "    Internal: $($provisionData.database.connectionString)"
        Write-Host "    External: $($provisionData.database.externalConnectionString)"
        Write-Host ""
        
        if ($provisionData.validationSteps) {
            Write-Host "  Validation Steps:"
            $provisionData.validationSteps | ForEach-Object {
                Write-Host "    $_"
            }
        }
        Write-Host ""
        
        if ($provisionData.nextSteps) {
            Write-Host "  Next Steps:"
            $provisionData.nextSteps | ForEach-Object {
                Write-Host "    • $_"
            }
        }
        Write-Host ""
        
        $dbName = $provisionData.database.databaseName
        $dbUser = $provisionData.database.ownerRole
        $dbPassword = $provisionData.database.password
        
    } else {
        Write-Host "✗ Database Provisioning: FAILED" -ForegroundColor Red
        Write-Host "  Message: $($provisionData.message)" -ForegroundColor Red
        if ($provisionData.details) {
            Write-Host "  Details: $($provisionData.details | ConvertTo-Json)" -ForegroundColor Red
        }
        if ($provisionData.troubleshooting) {
            Write-Host "  Troubleshooting:" -ForegroundColor Yellow
            $provisionData.troubleshooting | ForEach-Object {
                Write-Host "    • $_"
            }
        }
        exit 1
    }
} catch {
    Write-Host "✗ Database Provisioning: ERROR" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Response: $($_.Exception.Response.Content | ConvertFrom-Json -ErrorAction SilentlyContinue | ConvertTo-Json)" -ForegroundColor Red
    exit 1
}

# Test 3: Verify we can connect to the new database
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST 3: Verify new database is accessible"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Try to connect using psql (if available)
if (Get-Command psql -ErrorAction SilentlyContinue) {
    try {
        Write-Host "Attempting connection with psql..."
        
        # Set environment variable for password
        $env:PGPASSWORD = $dbPassword
        
        $result = & psql -h localhost -p 5433 -U $dbUser -d $dbName -c "SELECT version();" 2>&1
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ Database Connection: SUCCESS" -ForegroundColor Green
            Write-Host "  Result: $($result | Select-Object -First 1)"
        } else {
            Write-Host "✗ Database Connection: FAILED" -ForegroundColor Red
            Write-Host "  Error: $result"
        }
    } catch {
        Write-Host "✗ Database Connection: ERROR" -ForegroundColor Red
        Write-Host "  Error: $($_.Exception.Message)"
    }
} else {
    Write-Host "⊘ psql not found - skipping connection test" -ForegroundColor Yellow
    Write-Host "  Install PostgreSQL client to test connections"
    Write-Host "  You can still connect manually:"
    Write-Host "    psql -h localhost -p 5433 -U $dbUser -d $dbName"
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host "TEST SUITE COMPLETE" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
