# Kubecost Azure Integration Guide

Complete guide for integrating Kubecost with Azure Cost Management, including all commands and troubleshooting for issues encountered during setup.

## Overview

This guide documents the process of setting up Azure cost reconciliation with Kubecost, including:
- Azure Cost Management export configuration
- Kubernetes secret setup for authentication
- Helm deployment configuration
- Common issues and their resolutions

**Result**: Accurate Azure cost data imported into Kubecost for cost allocation by namespace/pod/service.

---

## Prerequisites

- Azure CLI installed and authenticated (`az login`)
- kubectl configured with access to Kubernetes cluster
- Helm 3.x installed
- PowerShell (for automation scripts)
- Kubecost deployed in Kubernetes cluster

**Azure Resources Required**:
- Azure Storage Account
- Azure Subscription with Cost Management access
- Resource provider: `Microsoft.CostManagementExports`

---

## Architecture

```
Azure Cost Management
    ↓ (Daily CSV export)
Azure Storage Account (Blob Container)
    ↓ (Storage account key authentication)
Kubernetes Secret (kubecost-cloud-integration)
    ↓ (Mounted as volume)
Kubecost cost-analyzer Pod
    ↓ (Reads CSV files)
Kubecost Cost Reconciliation
```

**Key Components**:
- **Storage Account**: `iotisticacosts9057` (example)
- **Container**: `cost-exports`
- **Export Name**: `kubecost-daily-export`
- **Path Structure**: `cost-exports/kubecost-daily-export/kubecost-daily-export/YYYYMMDD-YYYYMMDD/`
- **Secret**: `kubecost-cloud-integration` in `kubecost` namespace

---

## Step 1: Azure Cost Export Setup

### Automated Setup (Recommended)

Use the PowerShell script in `scripts/setup-azure-kubecost-export.ps1`:

```powershell
# Run from repository root
.\scripts\setup-azure-kubecost-export.ps1
```

This script will:
1. ✅ Verify Azure CLI installation and login
2. ✅ Register `Microsoft.CostManagementExports` resource provider
3. ✅ Validate storage account and container exist
4. ✅ Create daily cost export via REST API
5. ✅ Trigger initial export run

### Manual Setup

If you need to create the export manually:

```powershell
# Variables
$subscriptionId = "833accc2-1856-4e07-bcef-06cef4efdef2"
$storageAccountName = "iotisticacosts9057"
$storageAccountResourceGroup = "dev-iotistica-aks-rg"
$containerName = "cost-exports"
$exportName = "kubecost-daily-export"

# 1. Register resource provider
az provider register --namespace Microsoft.CostManagementExports

# Wait for registration (check every 5 seconds, max 2 minutes)
while ($true) {
    $status = az provider show --namespace Microsoft.CostManagementExports --query "registrationState" -o tsv
    if ($status -eq "Registered") { break }
    Start-Sleep -Seconds 5
}

# 2. Create export definition
$exportBody = @{
    properties = @{
        definition = @{
            type = "ActualCost"
            timeframe = "MonthToDate"
            dataSet = @{ granularity = "Daily" }
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
                from = (Get-Date).ToString("yyyy-MM-ddT00:00:00Z")
                to = (Get-Date).AddYears(1).ToString("yyyy-MM-ddT00:00:00Z")
            }
        }
        format = "Csv"
    }
} | ConvertTo-Json -Depth 10

# 3. Save to temp file (avoid escaping issues)
$tempBodyFile = [System.IO.Path]::GetTempFileName()
$exportBody | Out-File -FilePath $tempBodyFile -Encoding utf8 -NoNewline

# 4. Create export via REST API
az rest --method put `
    --url "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.CostManagement/exports/$exportName?api-version=2023-03-01" `
    --body "@$tempBodyFile"

Remove-Item $tempBodyFile -Force

# 5. Trigger immediate export run
az rest --method post `
    --url "https://management.azure.com/subscriptions/$subscriptionId/providers/Microsoft.CostManagement/exports/$exportName/run?api-version=2023-03-01"
```

### Verify Export

```powershell
# List exports
az costmanagement export list --scope "/subscriptions/$subscriptionId"

# Check storage container (after 5-10 minutes)
az storage blob list `
    --account-name $storageAccountName `
    --container-name $containerName `
    --prefix $exportName `
    --output table
```

**Expected Path Structure**:
```
cost-exports/
└── kubecost-daily-export/
    └── kubecost-daily-export/
        └── 20260201-20260228/
            ├── [timestamp]_[guid].csv
            └── manifest.json
```

---

## Step 2: Kubernetes Secret Configuration

### Automated Setup (Recommended)

Use the PowerShell script in `scripts/configure-kubecost-azure.ps1`:

```powershell
# Run from repository root
.\scripts\configure-kubecost-azure.ps1
```

### Manual Setup

```powershell
# Variables
$subscriptionId = "833accc2-1856-4e07-bcef-06cef4efdef2"
$storageAccountName = "iotisticacosts9057"
$storageAccountResourceGroup = "dev-iotistica-aks-rg"
$containerName = "cost-exports"
$containerPath = "kubecost-daily-export/kubecost-daily-export"  # Note: nested path!

# 1. Get storage account key
$storageKey = az storage account keys list `
    --resource-group $storageAccountResourceGroup `
    --account-name $storageAccountName `
    --query "[0].value" `
    -o tsv

# 2. Create cloud-integration.json
$cloudIntegration = @{
    azure = @(
        @{
            azureSubscriptionID = $subscriptionId
            azureStorageAccount = $storageAccountName
            azureStorageAccessKey = $storageKey
            azureStorageContainer = $containerName
            azureContainerPath = $containerPath
            azureCloud = "public"
        }
    )
} | ConvertTo-Json -Depth 10

# 3. Save to temp file
$tempFile = [System.IO.Path]::GetTempFileName()
$cloudIntegration | Out-File -FilePath $tempFile -Encoding utf8 -NoNewline

# 4. Create/update Kubernetes secret
kubectl delete secret kubecost-cloud-integration -n kubecost --ignore-not-found
kubectl create secret generic kubecost-cloud-integration `
    --from-file=cloud-integration.json=$tempFile `
    --namespace kubecost

# 5. Cleanup
Remove-Item $tempFile -Force
```

### Verify Secret

```powershell
# View secret content
kubectl get secret kubecost-cloud-integration -n kubecost -o jsonpath='{.data.cloud-integration\.json}' | ForEach-Object {
    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_))
}

# Verify mounted in pod (after deployment)
kubectl exec -n kubecost deployment/kubecost-cost-analyzer -c cost-model -- cat /var/configs/cloud-integration/cloud-integration.json
```

---

## Step 3: Helm Configuration

### Update values.yaml

Edit `k8s/kubecost-values.yaml`:

```yaml
global:
  prometheus:
    enabled: true
    fqdn: http://kubecost-prometheus-server.kubecost.svc
  clusterId: "dev-iotistica-aks-cluster"

kubecostProductConfigs:
  clusterName: "dev-iotistica-aks-cluster"
  cloudProvider: "azure"
  cloudIntegrationSecret: "kubecost-cloud-integration"
  
  # DO NOT add inline Azure config here!
  # Using cloudIntegrationSecret only to avoid duplicate integrations
```

**⚠️ CRITICAL**: Do NOT include inline Azure fields (`azureSubscriptionID`, `azureStorageAccount`, `azureStorageContainer`) in values.yaml. This causes duplicate integrations. Use `cloudIntegrationSecret` only.

### Deploy with Helm

```bash
# Upgrade Kubecost
helm upgrade kubecost kubecost/cost-analyzer \
    --namespace kubecost \
    -f k8s/kubecost-values.yaml \
    --version 1.108.1 \
    --wait

# Verify deployment
kubectl rollout status deployment/kubecost-cost-analyzer -n kubecost --timeout=2m

# Check pods
kubectl get pods -n kubecost -l app=cost-analyzer
```

---

## Common Issues & Solutions

### Issue 1: Resource Provider Not Registered

**Symptom**:
```
RP Not Registered. Register destination storage account subscription with Microsoft.CostManagementExports
```

**Solution**:
```powershell
# Register provider
az provider register --namespace Microsoft.CostManagementExports

# Wait for registration (up to 2 minutes)
$waited = 0
while ($waited -lt 120) {
    $status = az provider show --namespace Microsoft.CostManagementExports --query "registrationState" -o tsv
    if ($status -eq "Registered") {
        Write-Host "✅ Provider registered successfully"
        break
    }
    Start-Sleep -Seconds 5
    $waited += 5
}
```

### Issue 2: Container Name Typo

**Symptom**: Export created but files not appearing in expected container.

**Diagnosis**:
```powershell
# List containers
az storage container list --account-name $storageAccountName --output table

# Check if export wrote to wrong container
az storage blob list --account-name $storageAccountName --container-name cost-exportsw --output table
```

**Solution**: Delete and recreate export with correct container name.

### Issue 3: Nested Folder Path Mismatch

**Symptom**: Kubecost shows "Error(missing Data)" despite CSV files existing in storage.

**Diagnosis**: Azure creates nested folder structure:
```
cost-exports/                           # Container
  kubecost-daily-export/                # rootFolderPath from export
    kubecost-daily-export/              # Extra nested folder (Azure behavior)
      YYYYMMDD-YYYYMMDD/                # Date range
        [CSV files]
```

**Solution**: Update secret with nested path:
```powershell
# Update azureContainerPath in secret
azureContainerPath: "kubecost-daily-export/kubecost-daily-export"
#                    ^^^^^^^^^^^^^^^^^^^^^^^^ nested structure
```

Then recreate secret and restart Kubecost:
```powershell
# Recreate secret with updated path
kubectl delete secret kubecost-cloud-integration -n kubecost
kubectl create secret generic kubecost-cloud-integration --from-file=cloud-integration.json=$tempFile -n kubecost

# Restart deployment
kubectl rollout restart deployment/kubecost-cost-analyzer -n kubecost
```

### Issue 4: Duplicate Azure Integrations

**Symptom**: Two Azure integrations appear in Kubecost UI, both showing as "Connected".

**Root Cause**: Azure configuration defined in TWO places:
1. Inline fields in `kubecost-values.yaml` (azureSubscriptionID, azureStorageAccount, azureStorageContainer)
2. Complete configuration in `cloudIntegrationSecret`

Kubecost treats these as separate integrations, causing duplicate cost counting.

**Solution**:

1. Edit `k8s/kubecost-values.yaml` - remove inline Azure fields:
```yaml
kubecostProductConfigs:
  clusterName: "dev-iotistica-aks-cluster"
  cloudProvider: "azure"
  cloudIntegrationSecret: "kubecost-cloud-integration"
  # REMOVED: azureSubscriptionID, azureStorageAccount, azureStorageContainer
```

2. If duplicate persists, clear cached state:
```bash
# Scale down
kubectl scale deployment kubecost-cost-analyzer -n kubecost --replicas=0

# Wait for pod termination
kubectl wait --for=delete pod -l app=cost-analyzer -n kubecost --timeout=60s

# Delete PVC (clears cached integrations)
kubectl delete pvc kubecost-cost-analyzer -n kubecost

# Redeploy with Helm
helm upgrade kubecost kubecost/cost-analyzer --namespace kubecost -f k8s/kubecost-values.yaml --version 1.108.1 --wait
```

### Issue 5: Helm Upgrade Stuck in "pending-upgrade"

**Symptom**: Helm upgrade hangs, `helm list` shows no releases or stuck revision.

**Diagnosis**:
```bash
helm history kubecost -n kubecost
# Shows revision in "pending-upgrade" state
```

**Solution**:
```bash
# Rollback to last working revision
helm rollback kubecost 5 -n kubecost  # Replace 5 with last "deployed" revision

# Then retry upgrade
helm upgrade kubecost kubecost/cost-analyzer --namespace kubecost -f k8s/kubecost-values.yaml --version 1.108.1 --wait
```

### Issue 6: `cluster_id` Duplication Error

**Symptom**:
```
Kubecost 2.9.x is only used for preparing agents to upgrade to 3.0. 
In kubecost 2.9, cluster_id is set in two places
```

**Root Cause**: `cluster_id` in `kubecostProductConfigs` conflicts with `global.clusterId`.

**Solution**: Remove `cluster_id` from kubecostProductConfigs:
```yaml
# WRONG:
kubecostProductConfigs:
  cluster_id: "dev-iotistica-aks-cluster"  # ❌ Remove this

# CORRECT:
global:
  clusterId: "dev-iotistica-aks-cluster"  # ✅ Keep only this
```

### Issue 7: Storage Account Authentication Errors

**Symptom**: Kubecost logs show Azure authentication failures or "Multiple user assigned identities" errors.

**Solution**: These errors are normal for managed identity attempts. Kubecost falls back to storage account key authentication from the secret.

**Verify Authentication**:
```powershell
# Test storage access with key from secret
$storageKey = $(kubectl get secret kubecost-cloud-integration -n kubecost -o jsonpath='{.data.cloud-integration\.json}' | ForEach-Object {
    [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($_))
} | ConvertFrom-Json).azure[0].azureStorageAccessKey

az storage blob list `
    --account-name iotisticacosts9057 `
    --container-name cost-exports `
    --account-key $storageKey `
    --output table
```

---

## Verification Steps

### 1. Verify Azure Export

```powershell
# Check export exists and is active
az costmanagement export list --scope "/subscriptions/$subscriptionId" | ConvertFrom-Json | Select-Object -ExpandProperty properties

# Check CSV files in storage
az storage blob list `
    --account-name $storageAccountName `
    --container-name cost-exports `
    --prefix kubecost-daily-export `
    --output table
```

### 2. Verify Kubernetes Secret

```bash
# Secret exists
kubectl get secret kubecost-cloud-integration -n kubecost

# Secret content is valid JSON
kubectl get secret kubecost-cloud-integration -n kubecost -o jsonpath='{.data.cloud-integration\.json}' | base64 -d | jq .

# Secret mounted in pod
kubectl exec -n kubecost deployment/kubecost-cost-analyzer -c cost-model -- ls -la /var/configs/cloud-integration/
```

### 3. Verify Integration Status

```bash
# Check pod logs for integration activity
kubectl logs -n kubecost deployment/kubecost-cost-analyzer -c cost-model --tail=100 | grep -i "azure\|cloud\|integration"

# Check Kubecost UI
# Navigate to: Settings → Cloud Integrations
# Should show: ONE Azure integration with "Connected" status
```

### 4. Verify Cost Data

After 10-15 minutes:
1. Open Kubecost UI
2. Navigate to Cost Allocation
3. Check if Azure costs are appearing
4. Verify costs match Azure Portal billing (48-hour reconciliation delay is normal)

---

## Troubleshooting Commands

```powershell
# Check all Kubecost pods
kubectl get pods -n kubecost

# View cost-analyzer logs
kubectl logs -n kubecost deployment/kubecost-cost-analyzer -c cost-model --tail=200

# Check persistent volumes
kubectl get pvc -n kubecost

# Describe pod for events
kubectl describe pod -n kubecost -l app=cost-analyzer

# Check Helm status
helm list -n kubecost
helm history kubecost -n kubecost

# Restart Kubecost
kubectl rollout restart deployment/kubecost-cost-analyzer -n kubecost
kubectl rollout status deployment/kubecost-cost-analyzer -n kubecost --timeout=2m
```

---

## Cost Data Timeline

**Understanding cost data availability**:

| Time | Event | Data Available |
|------|-------|----------------|
| Day 0 | Export created | No data yet |
| Day 0 + 5-10 min | First CSV generated | CSV in storage |
| Day 0 + 15-20 min | Kubecost ingests CSV | Cost data appears in UI |
| Day 2 | Cloud billing reconciliation | Costs reconciled with Azure Portal |
| Daily | Automatic export runs | Previous day costs added |

**First-time setup**: Allow 15-20 minutes for initial data to appear in Kubecost UI.

**Cost reconciliation**: 48-hour delay for reconciliation with Azure cloud provider billing data is normal.

---

## Best Practices

### Security

1. **Never commit storage keys**: Secrets are stored in Kubernetes, not in values.yaml
2. **Rotate keys periodically**: Update secret when rotating storage account keys
3. **Use RBAC**: Restrict access to kubecost namespace

### Configuration

1. **Use secret-only approach**: Avoid inline Azure config in values.yaml to prevent duplicates
2. **Document paths**: Note the nested folder structure for future reference
3. **Version control**: Keep kubecost-values.yaml in git (without secrets)

### Monitoring

1. **Set up alerts**: Monitor for integration failures
2. **Check logs regularly**: Look for Azure authentication issues
3. **Verify data freshness**: Ensure daily exports are running

### Maintenance

```powershell
# Monthly: Verify export is still active
az costmanagement export list --scope "/subscriptions/$subscriptionId"

# Weekly: Check storage usage
az storage blob list --account-name $storageAccountName --container-name cost-exports --output table

# As needed: Clean up old CSV files (optional)
# Azure typically retains 13 months of data
```

---

## Reference: Full Configuration Example

### cloud-integration.json (in Kubernetes secret)

```json
{
  "azure": [
    {
      "azureSubscriptionID": "833accc2-1856-4e07-bcef-06cef4efdef2",
      "azureStorageAccount": "iotisticacosts9057",
      "azureStorageAccessKey": "[STORAGE_ACCOUNT_KEY]",
      "azureStorageContainer": "cost-exports",
      "azureContainerPath": "kubecost-daily-export/kubecost-daily-export",
      "azureCloud": "public"
    }
  ]
}
```

### kubecost-values.yaml (minimal Azure config)

```yaml
global:
  prometheus:
    enabled: true
    fqdn: http://kubecost-prometheus-server.kubecost.svc
  clusterId: "dev-iotistica-aks-cluster"

kubecostProductConfigs:
  clusterName: "dev-iotistica-aks-cluster"
  cloudProvider: "azure"
  cloudIntegrationSecret: "kubecost-cloud-integration"
  # No inline Azure configuration to avoid duplicates

persistentVolume:
  enabled: true
  size: 32Gi
  storageClass: managed-premium

service:
  type: ClusterIP

networkCosts:
  enabled: true
```

---

## Additional Resources

- [Kubecost Azure Integration Docs](https://docs.kubecost.com/install-and-configure/install/cloud-integration/azure-out-of-cluster)
- [Azure Cost Management REST API](https://learn.microsoft.com/en-us/rest/api/cost-management/)
- [Azure Storage Account Keys](https://learn.microsoft.com/en-us/azure/storage/common/storage-account-keys-manage)

---

## Summary

**Successful integration checklist**:

- ✅ Azure Cost Management export created (daily schedule)
- ✅ CSV files generating in blob storage
- ✅ Kubernetes secret with storage credentials
- ✅ Helm values.yaml configured (secret-only approach)
- ✅ Kubecost deployed and reading data
- ✅ Single Azure integration showing as "Connected"
- ✅ Cost data appearing in Kubecost UI

**Key learnings**:
1. Always use temp files for JSON in PowerShell (avoids escaping issues)
2. Resource provider registration required for first-time exports
3. Azure creates nested folder structures (account for in containerPath)
4. Use cloudIntegrationSecret exclusively (no inline config)
5. Clear PVC if duplicate integrations persist after config changes

---

*Document created: February 18, 2026*
*Last updated: February 18, 2026*
