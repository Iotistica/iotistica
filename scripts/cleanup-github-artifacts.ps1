<#
.SYNOPSIS
    Clean up old GitHub Actions artifacts to free storage space.

.DESCRIPTION
    Deletes old GitHub Actions artifacts while keeping the most recent builds.
    Helps prevent hitting GitHub's artifact storage quota.

.PARAMETER Repository
    GitHub repository in format "owner/repo". Defaults to "Iotistica/iotistic"

.PARAMETER KeepLatest
    Number of latest artifacts to keep per artifact name. Default: 2

.PARAMETER DryRun
    Show what would be deleted without actually deleting. Default: false

.PARAMETER OlderThanDays
    Delete artifacts older than N days. Optional (if not set, uses KeepLatest)

.EXAMPLE
    .\cleanup-github-artifacts.ps1
    Delete old artifacts, keeping latest 2 of each type

.EXAMPLE
    .\cleanup-github-artifacts.ps1 -KeepLatest 5
    Keep latest 5 artifacts of each type

.EXAMPLE
    .\cleanup-github-artifacts.ps1 -DryRun
    Show what would be deleted without actually deleting

.EXAMPLE
    .\cleanup-github-artifacts.ps1 -OlderThanDays 7
    Delete all artifacts older than 7 days
#>

param(
    [string]$Repository = "Iotistica/iotistic",
    [int]$KeepLatest = 2,
    [switch]$DryRun,
    [int]$OlderThanDays = 0
)

# Check if GitHub CLI is installed
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub CLI (gh) not found. Install it with: winget install GitHub.cli"
    exit 1
}

# Check authentication
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not authenticated with GitHub CLI. Run: gh auth login"
    exit 1
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "GitHub Artifacts Cleanup Tool" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Repository: $Repository"
Write-Host "Strategy: $(if ($OlderThanDays -gt 0) { "Delete older than $OlderThanDays days" } else { "Keep latest $KeepLatest per artifact type" })"
Write-Host "Dry Run: $($DryRun.IsPresent)"
Write-Host ""

# Fetch all artifacts
Write-Host "Fetching artifacts..." -ForegroundColor Yellow
try {
    $artifactsJson = gh api "repos/$Repository/actions/artifacts" --paginate
    $artifacts = ($artifactsJson | ConvertFrom-Json -AsHashtable).artifacts
} catch {
    Write-Error "Failed to fetch artifacts: $_"
    exit 1
}

if ($artifacts.Count -eq 0) {
    Write-Host "No artifacts found." -ForegroundColor Green
    exit 0
}

# Calculate current storage
$totalSize = ($artifacts | Measure-Object -Property size_in_bytes -Sum).Sum
Write-Host "Current Status:" -ForegroundColor Cyan
Write-Host "  Total artifacts: $($artifacts.Count)"
Write-Host "  Total size: $([math]::Round($totalSize/1GB, 2)) GB ($([math]::Round($totalSize/1MB, 2)) MB)"
Write-Host ""

# Group by artifact name
$groupedArtifacts = $artifacts | Group-Object name
Write-Host "Breakdown by type:" -ForegroundColor Cyan
foreach ($group in $groupedArtifacts) {
    $size = ($group.Group | Measure-Object -Property size_in_bytes -Sum).Sum
    Write-Host "  $($group.Name): $($group.Count) files, $([math]::Round($size/1MB, 2)) MB"
}
Write-Host ""

# Determine artifacts to delete
$toDelete = @()

if ($OlderThanDays -gt 0) {
    # Delete by age
    $cutoffDate = (Get-Date).AddDays(-$OlderThanDays)
    $toDelete = $artifacts | Where-Object { [DateTime]$_.created_at -lt $cutoffDate }
    Write-Host "Deleting artifacts older than $cutoffDate" -ForegroundColor Yellow
} else {
    # Keep latest N per artifact type
    foreach ($group in $groupedArtifacts) {
        $sorted = $group.Group | Sort-Object created_at -Descending
        $toDeleteFromGroup = $sorted | Select-Object -Skip $KeepLatest
        $toDelete += $toDeleteFromGroup
    }
    Write-Host "Keeping latest $KeepLatest of each artifact type" -ForegroundColor Yellow
}

if ($toDelete.Count -eq 0) {
    Write-Host "`n✓ No artifacts to delete!" -ForegroundColor Green
    exit 0
}

# Calculate space to be freed
$sizeToDelete = ($toDelete | Measure-Object -Property size_in_bytes -Sum).Sum
Write-Host "`nArtifacts to delete: $($toDelete.Count)" -ForegroundColor Yellow
Write-Host "Space to free: $([math]::Round($sizeToDelete/1GB, 2)) GB ($([math]::Round($sizeToDelete/1MB, 2)) MB)" -ForegroundColor Yellow
Write-Host ""

# Show artifacts to be deleted
Write-Host "Artifacts marked for deletion:" -ForegroundColor Yellow
$toDelete | Sort-Object created_at -Descending | ForEach-Object {
    $age = ((Get-Date) - [DateTime]$_.created_at).Days
    Write-Host "  - $($_.name) - $([math]::Round($_.size_in_bytes/1MB, 2)) MB - $(([DateTime]$_.created_at).ToString('yyyy-MM-dd HH:mm')) ($age days old)" -ForegroundColor Gray
}
Write-Host ""

if ($DryRun) {
    Write-Host "DRY RUN: No artifacts were deleted." -ForegroundColor Cyan
    Write-Host "Run without -DryRun to actually delete these artifacts." -ForegroundColor Cyan
    exit 0
}

# Confirm deletion
Write-Host "Proceed with deletion? [Y/N]: " -ForegroundColor Yellow -NoNewline
$confirmation = Read-Host
if ($confirmation -ne 'Y' -and $confirmation -ne 'y') {
    Write-Host "Cancelled." -ForegroundColor Red
    exit 0
}

# Delete artifacts
Write-Host "`nDeleting artifacts..." -ForegroundColor Yellow
$deleted = 0
$failed = 0

foreach ($artifact in $toDelete) {
    try {
        gh api --method DELETE "repos/$Repository/actions/artifacts/$($artifact.id)" | Out-Null
        $deleted++
        Write-Host "  ✓ Deleted $($artifact.name) (ID: $($artifact.id))" -ForegroundColor Green
    } catch {
        $failed++
        Write-Host "  ✗ Failed to delete $($artifact.name) (ID: $($artifact.id)): $_" -ForegroundColor Red
    }
}

# Summary
Write-Host "`n================================================" -ForegroundColor Cyan
Write-Host "Cleanup Summary" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Successfully deleted: $deleted artifacts" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "Failed to delete: $failed artifacts" -ForegroundColor Red
}
Write-Host "Space freed: ~$([math]::Round($sizeToDelete/1GB, 2)) GB" -ForegroundColor Green

# Show new totals
Write-Host "`nFetching updated stats..." -ForegroundColor Yellow
$newArtifactsJson = gh api "repos/$Repository/actions/artifacts" --paginate
$newArtifacts = ($newArtifactsJson | ConvertFrom-Json -AsHashtable).artifacts
$newTotalSize = ($newArtifacts | Measure-Object -Property size_in_bytes -Sum).Sum

Write-Host "New Status:" -ForegroundColor Cyan
Write-Host "  Total artifacts: $($newArtifacts.Count)"
Write-Host "  Total size: $([math]::Round($newTotalSize/1GB, 2)) GB ($([math]::Round($newTotalSize/1MB, 2)) MB)"
Write-Host "`n✓ Cleanup complete!" -ForegroundColor Green
