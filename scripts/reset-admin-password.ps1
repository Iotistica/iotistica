# Reset Admin Password Script
# This script resets the admin user password to 'admin123'

$newPassword = "admin123"

Write-Host "🔐 Resetting admin password to: $newPassword" -ForegroundColor Cyan
Write-Host ""

# Generate bcrypt hash using the API container's Node.js
Write-Host "⏳ Generating password hash..." -ForegroundColor Yellow
$hashScript = @"
const bcrypt = require('bcrypt');
bcrypt.hash('$newPassword', 10).then(hash => console.log(hash));
"@

$passwordHash = docker exec iotistic-api node -e $hashScript

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error generating password hash" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Password hash generated" -ForegroundColor Green
Write-Host ""

# Update database
Write-Host "⏳ Updating database..." -ForegroundColor Yellow
$sqlCommand = "UPDATE users SET password_hash = '$passwordHash', updated_at = NOW() WHERE username = 'admin' RETURNING username, email, role;"

$result = docker exec iotistic-postgres psql -U postgres -d iotistic -c $sqlCommand

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error updating database" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Password reset successful!" -ForegroundColor Green
Write-Host ""
Write-Host "🎉 You can now login with:" -ForegroundColor Cyan
Write-Host "   Username: admin" -ForegroundColor White
Write-Host "   Password: $newPassword" -ForegroundColor White
Write-Host ""
