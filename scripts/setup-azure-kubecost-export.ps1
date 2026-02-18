#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Set up Azure Cost Management export for Kubecost integration

.DESCRIPTION
    This script creates an Azure Cost Export configuration that exports cost data
    to a storage account for Kubecost to consume.

.NOTES
    Prerequisites:
    - Azure CLI installed and logged in (az login)
    - Proper permissions on the subscription
    - Storage account already created
#>

# ============================================================================
# Configuration Variables - UPDATE THESE
# ============================================================================

$subscriptionId = "833accc2-1856-4e07-bcef-06cef4efdef2"
$storageAccountName = "iotisticacosts9057"  # TODO: Fill in your storage account name
$storageAccountResourceGroup = "dev-iotistica-aks-rg"  # TODO: Fill in your resource group
$containerName = "cost-exports"
$exportName = "kubecost-daily-export"

# ============================================================================
# Validation
# ============================================================================

if ([string]::IsNullOrWhiteSpace($storageAccountName)) {
    Write-Error "Please set the `$storageAccountName variable"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($storageAccountResourceGroup)) {
    Write-Error "Please set the `$storageAccountResourceGroup variable"
    exit 1
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "Azure Cost Export Setup for Kubecost" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Subscription ID: $subscriptionId" -ForegroundColor Yellow
Write-Host "Storage Account: $storageAccountName" -ForegroundColor Yellow
Write-Host "Resource Group:  $storageAccountResourceGroup" -ForegroundColor Yellow
Write-Host "Container:       $containerName" -ForegroundColor Yellow
Write-Host "Export Name:     $exportName" -ForegroundColor Yellow
Write-Host ""

# ============================================================================
# Step 1: Verify Azure CLI and Login
# ============================================================================

Write-Host "[1/7] Checking Azure CLI..." -ForegroundColor Green
$azCommand = Get-Command az -ErrorAction SilentlyContinue
if (-not $azCommand) {
    Write-Error "Azure CLI not installed. Please install from: https://aka.ms/installazurecliwindows"
    exit 1
}

$azVersionOutput = az version 2>&1 | Out-String
if ($azVersionOutput -match '"azure-cli":\s*"([^"]+)"') {
    $azVersion = $matches[1]
    Write-Host "  ✓ Azure CLI version: $azVersion" -ForegroundColor Gray
} else {
    Write-Host "  ✓ Azure CLI found" -ForegroundColor Gray
}

Write-Host "[2/7] Verifying Azure login..." -ForegroundColor Green
$accountOutput = az account show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged into Azure. Please run: az login"
    exit 1
}
$currentAccount = $accountOutput | ConvertFrom-Json
Write-Host "  ✓ Logged in as: $($currentAccount.user.name)" -ForegroundColor Gray
Write-Host "  ✓ Subscription: $($currentAccount.name)" -ForegroundColor Gray

# ============================================================================
# Step 2: Verify Storage Account Exists
# ============================================================================

Write-Host "[3/7] Verifying storage account exists..." -ForegroundColor Green
$storageAccountOutput = az storage account show `
    --name $storageAccountName `
    --resource-group $storageAccountResourceGroup `
    2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Error "Storage account '$storageAccountName' not found in resource group '$storageAccountResourceGroup'"
    Write-Host ""
    Write-Host "Available storage accounts:" -ForegroundColor Yellow
    az storage account list --query "[].{Name:name, ResourceGroup:resourceGroup, Location:location}" -o table
    exit 1
}
$storageAccount = $storageAccountOutput | ConvertFrom-Json
Write-Host "  ✓ Storage account found: $($storageAccount.name)" -ForegroundColor Gray
Write-Host "  ✓ Location: $($storageAccount.location)" -ForegroundColor Gray

# ============================================================================
# Step 3: Register Cost Management Exports Resource Provider
# ============================================================================
Write-Host "[4/8] Registering Microsoft.CostManagementExports provider..." -ForegroundColor Green

$providerStatus = az provider show --namespace Microsoft.CostManagementExports --query "registrationState" -o tsv 2>&1

if ($providerStatus -ne "Registered") {
    Write-Host "  Registering provider (this may take 1-2 minutes)..." -ForegroundColor Yellow
    az provider register --namespace Microsoft.CostManagementExports --output none
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to register Microsoft.CostManagementExports provider"
        exit 1
    }
    
    # Wait for registration to complete
    Write-Host "  Waiting for registration to complete..." -ForegroundColor Gray
    $maxWait = 120 # 2 minutes
    $waited = 0
    while ($waited -lt $maxWait) {
        $status = az provider show --namespace Microsoft.CostManagementExports --query "registrationState" -o tsv 2>&1
        if ($status -eq "Registered") {
            Write-Host "  ✓ Provider registered successfully" -ForegroundColor Gray
            break
        }
        Start-Sleep -Seconds 5
        $waited += 5
    }
    
    if ($status -ne "Registered") {
        Write-Warning "Provider registration taking longer than expected. Status: $status"
        Write-Host "  You may need to wait a few more minutes before the export creation succeeds." -ForegroundColor Yellow
    }
} else {
    Write-Host "  ✓ Provider already registered" -ForegroundColor Gray
}

# ============================================================================
# Step 4: Get Storage Account Key
# ============================================================================

Write-Host "[5/8] Getting storage account key..." -ForegroundColor Green
$storageAccountKey = az storage account keys list `
    --resource-group $storageAccountResourceGroup `
    --account-name $storageAccountName `
    --query "[0].value" -o tsv

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($storageAccountKey)) {
    Write-Error "Failed to retrieve storage account key"
    exit 1
}
Write-Host "  ✓ Storage key retrieved" -ForegroundColor Gray

# ============================================================================
# Step 5: Create Container
# ============================================================================

Write-Host "[6/8] Creating storage container '$containerName'..." -ForegroundColor Green
$containerExistsOutput = az storage container exists `
    --name $containerName `
    --account-name $storageAccountName `
    --account-key $storageAccountKey `
    2>&1

if ($LASTEXITCODE -eq 0) {
    $existingContainer = $containerExistsOutput | ConvertFrom-Json
    if ($existingContainer.exists) {
        Write-Host "  ✓ Container already exists" -ForegroundColor Gray
    } else {
        az storage container create `
            --name $containerName `
            --account-name $storageAccountName `
            --account-key $storageAccountKey `
            --output none

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to create container"
            exit 1
        }
        Write-Host "  ✓ Container created successfully" -ForegroundColor Gray
    }
} else {
    # If container check failed, try to create it anyway
    az storage container create `
        --name $containerName `
        --account-name $storageAccountName `
        --account-key $storageAccountKey `
        --output none 2>&1 | Out-Null
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ✓ Container created successfully" -ForegroundColor Gray
    } else {
        Write-Error "Failed to create container"
        exit 1
    }
}

# ============================================================================
# Step 6: Create Cost Export
# ============================================================================

Write-Host "[7/8] Creating cost export..." -ForegroundColor Green

# Check if export already exists
$existingExportOutput = az costmanagement export show `
    --name $exportName `
    --scope "/subscriptions/$subscriptionId" `
    2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ⚠ Export '$exportName' already exists. Deleting..." -ForegroundColor Yellow
    az costmanagement export delete `
        --name $exportName `
        --scope "/subscriptions/$subscriptionId" `
        --yes `
        --output none
}

# Create the export using REST API (more reliable than az costmanagement)
$startDate = (Get-Date).ToString("yyyy-MM-ddT00:00:00Z")
$endDate = (Get-Date).AddYears(1).ToString("yyyy-MM-ddT00:00:00Z")

$exportBody = @{
    properties = @{
        definition = @{
            type = "ActualCost"
            timeframe = "MonthToDate"
            dataSet = @{
                granularity = "Daily"
            }
        }
        deliveryInfo = @{
            destination = @{
                resourceId = "/subscriptions/$subscriptionId/resourceGroups/$storageAccountResourceGroup/providers/Microsoft.Storage/storageAccounts/$storageAccountName"
                container = $containerName
                rootFolderPath = $exportName
            }
        }
        schedule = @{
            status = "Active"
            recurrence = "Daily"
            recurrencePeriod = @{
                from = $startDate
                to = $endDate
            }
        }
        format = "Csv"
    }
} | ConvertTo-Json -Depth 10

Write-Host "  Creating export via REST API..." -ForegroundColor Gray

# Write body to temp file to avoid escaping issues
$tempBodyFile = [System.IO.Path]::GetTempFileName()
$exportBody | Out-File -FilePath $tempBodyFile -Encoding utf8 -NoNewline

$exportOutput = az rest `
    --method put `
    --url "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.CostManagement/exports/$($exportName)?api-version=2023-03-01" `
    --body "@$tempBodyFile" `
    2>&1

# Clean up temp file
Remove-Item $tempBodyFile -ErrorAction SilentlyContinue

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create cost export"
    Write-Host ""
    Write-Host "Error details:" -ForegroundColor Red
    Write-Host $exportOutput -ForegroundColor Red
    Write-Host ""
    Write-Host "Tip: You can also try creating the export manually in Azure Portal:" -ForegroundColor Yellow
    Write-Host "  1. Go to Cost Management → Exports" -ForegroundColor Yellow
    Write-Host "  2. Create a new export with these settings:" -ForegroundColor Yellow
    Write-Host "     - Type: Daily export of month-to-date costs" -ForegroundColor Yellow
    Write-Host "     - Storage: $storageAccountName / $containerName" -ForegroundColor Yellow
    exit 1
}
Write-Host "  ✓ Cost export created successfully" -ForegroundColor Gray

# ============================================================================
# Step 7: Manually Trigger Export
# ============================================================================

Write-Host "[8/8] Triggering export manually..." -ForegroundColor Green
Write-Host "  (This can take 5-10 minutes to complete)" -ForegroundColor Gray

az costmanagement export execute `
    --export-name $exportName `
    --scope "/subscriptions/$subscriptionId" `
    --output none

if ($LASTEXITCODE -ne 0) {
    Write-Warning "Failed to trigger export manually, but it will run on schedule"
} else {
    Write-Host "  ✓ Export triggered successfully" -ForegroundColor Gray
}

# ============================================================================
# Summary and Next Steps
# ============================================================================

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Export Configuration:" -ForegroundColor Yellow
Write-Host "  Export Name:      $exportName" -ForegroundColor White
Write-Host "  Schedule:         Daily" -ForegroundColor White
Write-Host "  Format:           CSV" -ForegroundColor White
Write-Host "  Type:             ActualCost" -ForegroundColor White
Write-Host ""
Write-Host "Storage Configuration:" -ForegroundColor Yellow
Write-Host "  Account:          $storageAccountName" -ForegroundColor White
Write-Host "  Container:        $containerName" -ForegroundColor White
Write-Host "  Directory:        $exportName/" -ForegroundColor White
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Wait 5-10 minutes for the export to complete" -ForegroundColor White
Write-Host "  2. Run this command to check for files:" -ForegroundColor White
Write-Host ""
Write-Host "     az storage blob list ``" -ForegroundColor Cyan
Write-Host "       --account-name $storageAccountName ``" -ForegroundColor Cyan
Write-Host "       --container-name $containerName ``" -ForegroundColor Cyan
Write-Host "       --account-key `$storageAccountKey ``" -ForegroundColor Cyan
Write-Host "       --output table" -ForegroundColor Cyan
Write-Host ""
Write-Host "  3. Configure Kubecost with these values:" -ForegroundColor White
Write-Host "     - Azure Storage Account: $storageAccountName" -ForegroundColor White
Write-Host "     - Container: $containerName" -ForegroundColor White
Write-Host "     - Storage Key: (use the retrieved key)" -ForegroundColor White
Write-Host "     - Subscription ID: $subscriptionId" -ForegroundColor White
Write-Host ""
Write-Host "To get the storage connection string for Kubecost:" -ForegroundColor Yellow
Write-Host "  az storage account show-connection-string ``" -ForegroundColor Cyan
Write-Host "    --name $storageAccountName ``" -ForegroundColor Cyan
Write-Host "    --resource-group $storageAccountResourceGroup" -ForegroundColor Cyan
Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
