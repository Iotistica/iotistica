# Instructions for adding hosts entries
# You need to manually edit C:\Windows\System32\drivers\etc\hosts
# 
# OPTION 1: Run this script as Administrator
# Right-click PowerShell -> Run as Administrator
# Then run: .\add-hosts-entries.ps1
#
# OPTION 2: Manual edit
# 1. Open Notepad as Administrator
# 2. Open file: C:\Windows\System32\drivers\etc\hosts
# 3. Add these lines at the bottom:

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "Add these lines to your hosts file:" -ForegroundColor Yellow
Write-Host "============================================`n" -ForegroundColor Cyan

Write-Host "127.0.0.1    01d5b2ec.localhost    # Iotistic" -ForegroundColor Green
Write-Host "127.0.0.1    65160a0f.localhost    # Iotistic" -ForegroundColor Green

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "`nTo edit hosts file:" -ForegroundColor Yellow
Write-Host "1. Right-click Notepad -> Run as Administrator" -ForegroundColor White
Write-Host "2. Open: C:\Windows\System32\drivers\etc\hosts" -ForegroundColor White
Write-Host "3. Add the lines above at the bottom" -ForegroundColor White
Write-Host "4. Save and close" -ForegroundColor White
Write-Host "`nThen access your dashboards at:" -ForegroundColor Yellow
Write-Host "  http://01d5b2ec.localhost" -ForegroundColor Cyan
Write-Host "  http://65160a0f.localhost" -ForegroundColor Cyan
Write-Host ""
