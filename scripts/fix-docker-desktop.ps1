# Docker Desktop Troubleshooting Script for Windows
# This script attempts to fix common Docker Desktop startup issues

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Docker Desktop Troubleshooting Script" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "WARNING: Not running as Administrator!" -ForegroundColor Red
    Write-Host "Some fixes require administrator privileges." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell and select 'Run as Administrator' for best results.`n" -ForegroundColor Yellow
}

# Step 1: Kill all Docker processes
Write-Host "[Step 1/5] Stopping all Docker processes..." -ForegroundColor Yellow
$dockerProcesses = Get-Process | Where-Object { $_.Name -like "*docker*" -or $_.Name -like "*com.docker*" }
if ($dockerProcesses) {
    $dockerProcesses | ForEach-Object {
        Write-Host "  Stopping: $($_.Name) (PID: $($_.Id))" -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    Write-Host "  Done. All Docker processes stopped.`n" -ForegroundColor Green
} else {
    Write-Host "  No Docker processes running.`n" -ForegroundColor Green
}

# Step 2: Check WSL2
Write-Host "[Step 2/5] Checking WSL2 status..." -ForegroundColor Yellow
try {
    $wslVersion = wsl --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  WSL2 is installed." -ForegroundColor Green
        
        # List distributions
        $wslList = wsl --list --verbose 2>&1
        if ($wslList) {
            Write-Host "  WSL Distributions:" -ForegroundColor Gray
            Write-Host $wslList -ForegroundColor Gray
        }
    } else {
        Write-Host "  WSL2 may not be installed or configured properly." -ForegroundColor Red
        Write-Host "  Install WSL2: wsl --install" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  WSL2 not found. Docker Desktop requires WSL2." -ForegroundColor Red
    Write-Host "  Run: wsl --install" -ForegroundColor Yellow
}
Write-Host ""

# Step 3: Check Docker Desktop installation
Write-Host "[Step 3/5] Checking Docker Desktop installation..." -ForegroundColor Yellow
$dockerExePath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerExePath) {
    Write-Host "  Docker Desktop is installed at: $dockerExePath" -ForegroundColor Green
    
    # Get version
    $versionInfo = Get-Item $dockerExePath | Select-Object -ExpandProperty VersionInfo
    Write-Host "  Version: $($versionInfo.ProductVersion)" -ForegroundColor Gray
} else {
    Write-Host "  Docker Desktop executable NOT found!" -ForegroundColor Red
    Write-Host "  Please reinstall Docker Desktop from: https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
}
Write-Host ""

# Step 4: Check and restart Docker service
Write-Host "[Step 4/5] Checking Docker Desktop Service..." -ForegroundColor Yellow
try {
    $dockerService = Get-Service -Name "com.docker.service" -ErrorAction Stop
    Write-Host "  Service Status: $($dockerService.Status)" -ForegroundColor Gray
    
    if ($dockerService.Status -ne "Running") {
        if ($isAdmin) {
            Write-Host "  Attempting to start service..." -ForegroundColor Yellow
            try {
                Start-Service -Name "com.docker.service" -ErrorAction Stop
                Start-Sleep -Seconds 5
                $dockerService = Get-Service -Name "com.docker.service"
                if ($dockerService.Status -eq "Running") {
                    Write-Host "  Service started successfully!" -ForegroundColor Green
                } else {
                    Write-Host "  Service failed to start. Status: $($dockerService.Status)" -ForegroundColor Red
                }
            } catch {
                Write-Host "  Failed to start service: $($_.Exception.Message)" -ForegroundColor Red
            }
        } else {
            Write-Host "  Cannot start service - need Administrator privileges." -ForegroundColor Red
        }
    } else {
        Write-Host "  Service is running." -ForegroundColor Green
    }
} catch {
    Write-Host "  Docker Desktop Service not found or not accessible." -ForegroundColor Red
}
Write-Host ""

# Step 5: Clean up Docker data (if needed)
Write-Host "[Step 5/5] Docker data cleanup options..." -ForegroundColor Yellow
$dockerDataPath = "$env:APPDATA\Docker"
if (Test-Path $dockerDataPath) {
    $size = (Get-ChildItem $dockerDataPath -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host "  Docker data found at: $dockerDataPath ($([math]::Round($size, 2)) MB)" -ForegroundColor Gray
    
    Write-Host "`n  Would you like to reset Docker Desktop to factory defaults?" -ForegroundColor Yellow
    Write-Host "  WARNING: This will delete all containers, images, and volumes!" -ForegroundColor Red
    $response = Read-Host "  Type 'YES' to reset, or press Enter to skip"
    
    if ($response -eq "YES") {
        Write-Host "  Backing up and resetting Docker data..." -ForegroundColor Yellow
        
        # Stop Docker first
        Get-Process | Where-Object { $_.Name -like "*docker*" } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        
        # Rename old data
        $backupPath = "$env:APPDATA\Docker.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        if ($isAdmin) {
            try {
                Rename-Item -Path $dockerDataPath -NewName (Split-Path $backupPath -Leaf) -ErrorAction Stop
                Write-Host "  Old data backed up to: $backupPath" -ForegroundColor Green
                Write-Host "  Docker Desktop will recreate fresh data on next start." -ForegroundColor Green
            } catch {
                Write-Host "  Failed to reset: $($_.Exception.Message)" -ForegroundColor Red
            }
        } else {
            Write-Host "  Cannot reset - need Administrator privileges." -ForegroundColor Red
        }
    } else {
        Write-Host "  Skipping reset." -ForegroundColor Gray
    }
} else {
    Write-Host "  Docker data directory not found." -ForegroundColor Gray
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Recommended Actions:" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "1. Try starting Docker Desktop manually from Start Menu" -ForegroundColor White
Write-Host "2. If it still fails, try these in order:" -ForegroundColor White
Write-Host "   a) Restart Windows" -ForegroundColor Gray
Write-Host "   b) Update Docker Desktop to latest version" -ForegroundColor Gray
Write-Host "   c) Reinstall Docker Desktop" -ForegroundColor Gray
Write-Host "3. Check Windows Event Viewer > Application logs for errors" -ForegroundColor White
Write-Host "4. Ensure WSL2 is installed: wsl --install" -ForegroundColor White
Write-Host "`nPress any key to exit..." -ForegroundColor Cyan
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
