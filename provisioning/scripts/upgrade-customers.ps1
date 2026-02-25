<#
.SYNOPSIS
    Upgrade customer instances to new component versions
.DESCRIPTION
    This script demonstrates the upgrade workflow for deploying new versions
    of components (api, dashboard, exporter, mosquitto) to all customer instances.
.EXAMPLE
    .\upgrade-customers.ps1 -Component api -Version v1.2.0 -Strategy canary
.EXAMPLE
    .\upgrade-customers.ps1 -Component dashboard -Version v2.0.0 -Strategy all
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('api', 'dashboard', 'exporter', 'mosquitto')]
    [string]$Component,

    [Parameter(Mandatory=$true)]
    [string]$Version,

    [Parameter(Mandatory=$false)]
    [ValidateSet('all', 'canary', 'batch')]
    [string]$Strategy = 'batch',

    [Parameter(Mandatory=$false)]
    [int]$CanaryPercent = 10,

    [Parameter(Mandatory=$false)]
    [int]$BatchSize = 10,

    [Parameter(Mandatory=$false)]
    [string]$BillingUrl = "http://localhost:3100"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  IOTISTIC - SYSTEM UPGRADE WORKFLOW" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

Write-Host "📦 Component:  " -NoNewline -ForegroundColor Yellow
Write-Host $Component -ForegroundColor White
Write-Host "🏷️  Version:    " -NoNewline -ForegroundColor Yellow
Write-Host $Version -ForegroundColor White
Write-Host "📊 Strategy:   " -NoNewline -ForegroundColor Yellow
Write-Host $Strategy -ForegroundColor White

if ($Strategy -eq 'canary') {
    Write-Host "🎯 Canary:     " -NoNewline -ForegroundColor Yellow
    Write-Host "$CanaryPercent%" -ForegroundColor White
}
if ($Strategy -eq 'batch') {
    Write-Host "📦 Batch Size: " -NoNewline -ForegroundColor Yellow
    Write-Host $BatchSize -ForegroundColor White
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
Write-Host ""

# Confirm upgrade
$confirm = Read-Host "Start upgrade? (y/N)"
if ($confirm -ne 'y') {
    Write-Host "❌ Upgrade cancelled" -ForegroundColor Red
    exit 0
}

Write-Host ""
Write-Host "🚀 Starting upgrade..." -ForegroundColor Green

# Start the upgrade
try {
    $body = @{
        component = $Component
        version = $Version
        strategy = $Strategy
        canaryPercent = $CanaryPercent
        batchSize = $BatchSize
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$BillingUrl/api/upgrades/deploy" `
        -Method Post `
        -Body $body `
        -ContentType "application/json"

    $upgradeId = $response.upgradeId
    $jobId = $response.jobId

    Write-Host "✅ Upgrade initiated" -ForegroundColor Green
    Write-Host ""
    Write-Host "   Upgrade ID: $upgradeId" -ForegroundColor Cyan
    Write-Host "   Job ID:     $jobId" -ForegroundColor Cyan
    Write-Host ""

    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
    Write-Host "MONITORING PROGRESS" -ForegroundColor Yellow
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
    Write-Host ""

    # Monitor progress
    $completed = $false
    $lastTotal = 0
    $lastCompleted = 0
    $lastFailed = 0

    while (-not $completed) {
        Start-Sleep -Seconds 5

        $progress = Invoke-RestMethod -Uri "$BillingUrl/api/upgrades/$upgradeId/status"

        # Only update if changed
        if ($progress.completed -ne $lastCompleted -or $progress.failed -ne $lastFailed) {
            $percent = [math]::Round(($progress.completed / $progress.total) * 100, 1)
            
            Write-Host "`r" -NoNewline
            Write-Host "   Total:      " -NoNewline -ForegroundColor Gray
            Write-Host "$($progress.total)" -NoNewline -ForegroundColor White
            Write-Host " | " -NoNewline -ForegroundColor Gray
            Write-Host "Completed:  " -NoNewline -ForegroundColor Green
            Write-Host "$($progress.completed)" -NoNewline -ForegroundColor White
            Write-Host " | " -NoNewline -ForegroundColor Gray
            Write-Host "Failed:     " -NoNewline -ForegroundColor Red
            Write-Host "$($progress.failed)" -NoNewline -ForegroundColor White
            Write-Host " | " -NoNewline -ForegroundColor Gray
            Write-Host "Progress:   " -NoNewline -ForegroundColor Yellow
            Write-Host "$percent%" -ForegroundColor White

            $lastCompleted = $progress.completed
            $lastFailed = $progress.failed
        }

        if ($progress.status -in @('completed', 'completed_with_errors', 'failed')) {
            $completed = $true
        }
    }

    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
    Write-Host ""

    # Final status
    $finalProgress = Invoke-RestMethod -Uri "$BillingUrl/api/upgrades/$upgradeId/status"

    if ($finalProgress.status -eq 'completed') {
        Write-Host "✅ UPGRADE COMPLETED SUCCESSFULLY" -ForegroundColor Green
    } elseif ($finalProgress.status -eq 'completed_with_errors') {
        Write-Host "⚠️  UPGRADE COMPLETED WITH ERRORS" -ForegroundColor Yellow
    } else {
        Write-Host "❌ UPGRADE FAILED" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "📊 Final Statistics:" -ForegroundColor Cyan
    Write-Host "   • Total customers:     $($finalProgress.total)" -ForegroundColor White
    Write-Host "   • Successfully upgraded: $($finalProgress.completed)" -ForegroundColor Green
    Write-Host "   • Failed:              $($finalProgress.failed)" -ForegroundColor Red
    Write-Host ""

    # If canary and successful, offer to continue
    if ($Strategy -eq 'canary' -and $finalProgress.failed -eq 0) {
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
        Write-Host "CANARY DEPLOYMENT SUCCESSFUL" -ForegroundColor Green
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Gray
        Write-Host ""
        
        $continueUpgrade = Read-Host "Continue upgrade to all remaining customers? (y/N)"
        
        if ($continueUpgrade -eq 'y') {
            Write-Host ""
            Write-Host "🚀 Continuing upgrade to all customers..." -ForegroundColor Green
            
            $continueResponse = Invoke-RestMethod -Uri "$BillingUrl/api/upgrades/$upgradeId/continue" `
                -Method Post `
                -ContentType "application/json"
            
            Write-Host "✅ Full upgrade queued" -ForegroundColor Green
            Write-Host "   Job ID: $($continueResponse.jobId)" -ForegroundColor Cyan
        }
    }

    Write-Host ""
    Write-Host "🔗 Quick Links:" -ForegroundColor Cyan
    Write-Host "   • Bull Board:  $BillingUrl/admin/queues" -ForegroundColor White
    Write-Host "   • View Logs:   curl $BillingUrl/api/upgrades/$upgradeId/logs" -ForegroundColor White
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "❌ Upgrade failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    exit 1
}
