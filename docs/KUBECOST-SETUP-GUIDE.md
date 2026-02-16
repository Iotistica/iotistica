# Kubecost Setup Guide with Envoy Gateway Integration

**Last Updated**: February 16, 2026  
**Cluster**: dev-iotistica-aks-cluster (Azure AKS, canadacentral)  
**Version**: Kubecost 1.108.1

## Overview

This document covers the complete installation and configuration of Kubecost for namespace-level cost monitoring, including:
- Kubecost installation with Azure integration
- Migration from LoadBalancer to Envoy Gateway (cost savings ~$30-40/month)
- Azure Cost Management export configuration
- DNS setup for public access via HTTPS

## Prerequisites

- Azure AKS cluster with kubectl configured
- Azure CLI (`az`) installed and authenticated
- Helm 3.x installed
- Envoy Gateway already deployed in the cluster
- DNS management access for your domain

## Architecture

**Final Configuration**:
- **Kubecost**: ClusterIP service (no dedicated LoadBalancer)
- **Envoy Gateway**: Shared LoadBalancer at 20.220.137.172
- **Access**: https://kubecost.iotistica.com (HTTPS only, port 443)
- **Storage**: Azure Premium SSD (32Gi for Kubecost, 32Gi for Prometheus)
- **Azure Integration**: Daily cost exports to Blob Storage
- **Prometheus Retention**: 15 days

## Step 1: Add Kubecost Helm Repository

```bash
# Add Kubecost repo
helm repo add kubecost https://kubecost.github.io/cost-analyzer/

# Update repo cache
helm repo update

# Search for available versions
helm search repo kubecost/cost-analyzer --versions | head -20
```

**Output**: Version 1.108.1 selected (stable, production-ready)

## Step 2: Create Kubecost Values File

Create `k8s/kubecost-values.yaml`:

```yaml
# Production Kubecost Configuration for Azure AKS
# Cluster: dev-iotistica-aks-cluster

# Global settings
global:
  clusterId: "dev-iotistica-aks-cluster"  # REQUIRED for K8s 1.20+

# Product configuration
kubecostProductConfigs:
  clusterName: "dev-iotistica-aks-cluster"
  cloudProvider: "azure"
  cluster_id: "dev-iotistica-aks-cluster"  # REQUIRED for version 1.108.1
  
  # Azure Cost Integration
  cloudIntegrationSecret: "cloud-integration"
  azureSubscriptionID: "833accc2-1856-4e07-bcef-06cef4efdef2"
  azureStorageAccount: "iotisticacosts9057"
  azureStorageContainer: "cost-exports"

# Service configuration (ClusterIP for Envoy Gateway)
service:
  type: ClusterIP
  annotations:
    gateway.envoyproxy.io/exposed: "true"

# Persistent storage for Kubecost data
persistentVolume:
  enabled: true
  size: 32Gi
  storageClass: managed-premium  # Azure Premium SSD

# Prometheus configuration
prometheus:
  server:
    persistentVolume:
      enabled: true
      size: 32Gi
      storageClass: managed-premium
    retention: 15d
```

## Step 3: Install Kubecost

```bash
# Install Kubecost v1.108.1
helm install kubecost kubecost/cost-analyzer \
  --version 1.108.1 \
  --namespace kubecost \
  --create-namespace \
  -f k8s/kubecost-values.yaml \
  --wait

# Verify installation
kubectl get pods -n kubecost
kubectl get svc -n kubecost
```

**Expected Output**:
```
NAME                                            READY   STATUS    RESTARTS   AGE
kubecost-cost-analyzer-xxxx                     2/2     Running   0          2m
kubecost-grafana-xxxx                           2/2     Running   0          2m
kubecost-prometheus-server-xxxx                 2/2     Running   0          2m
```

## Step 4: Azure Cost Management Integration

### 4.1 Create Azure Storage Account

```bash
# Get AKS cluster details
az aks show --name dev-iotistica-aks-cluster \
  --resource-group dev-iotistica-aks-rg \
  --query "{name:name, location:location, nodeResourceGroup:nodeResourceGroup}"

# Create storage account for cost exports
az storage account create \
  --name iotisticacosts9057 \
  --resource-group dev-iotistica-aks-rg \
  --location canadacentral \
  --sku Standard_LRS

# Create container for exports
az storage container create \
  --name cost-exports \
  --account-name iotisticacosts9057
```

### 4.2 Retrieve Storage Access Key

```bash
# Get storage account key
az storage account keys list \
  --account-name iotisticacosts9057 \
  --resource-group dev-iotistica-aks-rg \
  --query "[0].value" -o tsv
```

**Save this key securely** - needed for next step.

### 4.3 Create Kubernetes Secret

Create local file `cloud-integration.json`:

```json
{
  "azure": {
    "storageAccount": "iotisticacosts9057",
    "storageAccessKey": "YOUR_STORAGE_ACCESS_KEY_HERE",
    "storageContainer": "cost-exports",
    "subscriptionID": "833accc2-1856-4e07-bcef-06cef4efdef2"
  }
}
```

Create Kubernetes secret:

```bash
# Create secret from JSON file
kubectl create secret generic cloud-integration \
  -n kubecost \
  --from-file=cloud-integration.json

# Verify secret created
kubectl get secret -n kubecost cloud-integration

# Delete local file (optional, for security)
rm cloud-integration.json
```

### 4.4 Create Azure Cost Export

```bash
# Get storage account resource ID
STORAGE_ACCOUNT_ID=$(az storage account show \
  --name iotisticacosts9057 \
  --resource-group dev-iotistica-aks-rg \
  --query id -o tsv)

# Create cost export (Daily, ActualCost)
az costmanagement export create \
  --name kubecost-export \
  --type ActualCost \
  --scope "/subscriptions/833accc2-1856-4e07-bcef-06cef4efdef2" \
  --storage-account-id "$STORAGE_ACCOUNT_ID" \
  --storage-container cost-exports \
  --timeframe MonthToDate \
  --recurrence Daily \
  --recurrence-period from='2025-02-16T00:00:00Z' to='2099-12-31T00:00:00Z'

# Verify export created
az costmanagement export list \
  --scope "/subscriptions/833accc2-1856-4e07-bcef-06cef4efdef2"
```

### 4.5 Upgrade Kubecost with Azure Integration

```bash
# Upgrade to apply Azure configuration
helm upgrade kubecost kubecost/cost-analyzer \
  --version 1.108.1 \
  --namespace kubecost \
  -f k8s/kubecost-values.yaml \
  --wait

# Verify pod restarted with new config
kubectl get pods -n kubecost -w
```

**Note**: Azure billing data appears in 24-48 hours after first export runs.

## Step 5: Migrate to Envoy Gateway (Cost Optimization)

### 5.1 Verify Envoy Gateway

```bash
# Check existing Envoy Gateway
kubectl get gateway -n envoy-gateway-system

# Get LoadBalancer IP
kubectl get svc -n envoy-gateway-system -o wide | Select-String "LoadBalancer"
```

**Expected Output**:
```
NAME                                               TYPE           EXTERNAL-IP      PORTS
envoy-envoy-gateway-system-iotistica-gateway-...   LoadBalancer   20.220.137.172   1883:31358/TCP,8883:32356/TCP,443:31887/TCP
```

### 5.2 Create HTTPRoute

Create `k8s/kubecost-httproute.yaml`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: kubecost-httproute
  namespace: kubecost
spec:
  hostnames:
    - kubecost.iotistica.com
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: iotistica-gateway
      namespace: envoy-gateway-system
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - kind: Service
          name: kubecost-cost-analyzer
          port: 9090
```

Apply HTTPRoute:

```bash
# Apply HTTPRoute
kubectl apply -f k8s/kubecost-httproute.yaml

# Verify HTTPRoute accepted by gateway
kubectl get httproute -n kubecost kubecost-httproute

# Check detailed status
kubectl get httproute -n kubecost kubecost-httproute -o yaml | Select-String -Pattern "status:" -Context 0,15
```

**Expected Output**:
```yaml
status:
  parents:
  - conditions:
    - status: "True"
      type: Accepted
    - status: "True"
      type: ResolvedRefs
```

### 5.3 Change Service to ClusterIP

Update `k8s/kubecost-values.yaml` service section:

```yaml
service:
  type: ClusterIP  # Changed from LoadBalancer
  annotations:
    gateway.envoyproxy.io/exposed: "true"
```

Apply change:

```bash
# Upgrade with ClusterIP service
helm upgrade kubecost kubecost/cost-analyzer \
  --version 1.108.1 \
  --namespace kubecost \
  -f k8s/kubecost-values.yaml \
  --wait

# Verify LoadBalancer deleted (automatic cleanup)
kubectl get svc -n kubecost

# Check all services are ClusterIP
kubectl get svc -n kubecost -o wide
```

**Expected Output**:
```
NAME                           TYPE        CLUSTER-IP       PORT(S)
kubecost-cost-analyzer         ClusterIP   172.16.111.157   9003/TCP,9090/TCP
kubecost-grafana               ClusterIP   ...              80/TCP
kubecost-prometheus-server     ClusterIP   ...              80/TCP
```

**Cost Savings**: ~$30-40/month by eliminating dedicated LoadBalancer.

## Step 6: DNS Configuration

### 6.1 Create DNS A Record

In your DNS provider (e.g., Cloudflare, Azure DNS, Route53):

- **Type**: A
- **Name**: kubecost
- **Value**: 20.220.137.172 (Envoy Gateway LoadBalancer IP)
- **TTL**: 300 (5 minutes)

### 6.2 Verify DNS Resolution

```bash
# Check DNS resolution
nslookup kubecost.iotistica.com

# Alternative (cross-platform)
Resolve-DnsName kubecost.iotistica.com
```

**Expected Output**:
```
Name:    kubecost.iotistica.com
Address: 20.220.137.172
```

## Step 7: Verification and Access

### 7.1 Verify Gateway Configuration

```bash
# Check gateway listeners (should include HTTPS on port 443)
kubectl get gateway -n envoy-gateway-system iotistica-gateway -o yaml | Select-String -Pattern "port:|protocol:" -Context 1
```

**Expected Output**:
```yaml
  - name: mqtt
    port: 1883
    protocol: TCP
  - name: mqtt-tls
    port: 8883
    protocol: TLS
  - name: https
    port: 443
    protocol: HTTPS
```

**Important**: Gateway configured for HTTPS only - no HTTP listener on port 80.

### 7.2 Access Dashboard

Open browser to: **https://kubecost.iotistica.com**

**Note**: Must use HTTPS (not HTTP) - gateway only listens on port 443.

### 7.3 Verify All Pods Running

```bash
# Check all pods
kubectl get pods -n kubecost

# Check pod details
kubectl describe pods -n kubecost

# Check logs (if needed)
kubectl logs -n kubecost deployment/kubecost-cost-analyzer -c cost-model
```

**Expected Status**:
```
NAME                                            READY   STATUS    RESTARTS   AGE
kubecost-cost-analyzer-xxxx                     2/2     Running   0          10m
kubecost-grafana-xxxx                           2/2     Running   0          10m
kubecost-prometheus-server-xxxx                 2/2     Running   0          10m
kubecost-network-costs-xxxx                     1/1     Running   0          10m (per node)
```

### 7.4 Check HTTPRoute Status

```bash
# Verify HTTPRoute routing traffic
kubectl get httproute -n kubecost

# Check backend connections
kubectl describe httproute -n kubecost kubecost-httproute
```

## Troubleshooting

### Issue: Pods Stuck in ContainerCreating

**Symptom**: cost-analyzer pod showing 0/2 ready

**Diagnosis**:
```bash
kubectl describe pod -n kubecost -l app=cost-analyzer
```

**Common Causes**:
1. **Missing secret mount**: Error "references non-existent secret key: cloud-integration.json"
   - Solution: Recreate secret with correct JSON format (Step 4.3)
   - Restart pod: `kubectl delete pod -n kubecost -l app=cost-analyzer`

2. **PVC pending**: Storage class not available
   - Check: `kubectl get pvc -n kubecost`
   - Solution: Verify `managed-premium` storage class exists

### Issue: HTTP Access Times Out

**Symptom**: `http://kubecost.iotistica.com` returns timeout

**Cause**: Gateway only configured with HTTPS listener (port 443), no HTTP (port 80)

**Solution**: Use HTTPS - `https://kubecost.iotistica.com`

**Verify**:
```bash
# Check gateway listeners
kubectl get gateway -n envoy-gateway-system iotistica-gateway -o jsonpath='{.spec.listeners[*].name}'
```

### Issue: "Update Available" Alert

**Symptom**: Dashboard shows "Update Available to v2.9.x"

**Expected Behavior**: This is informational only. Version 1.108.1 is stable and production-ready. Version 2.9.x requires special upgrade preparation (upgrade-only release).

**Action**: No action needed unless planning major version upgrade.

### Issue: Prometheus Recording Rules Warnings

**Symptom**: Alerts for missing Prometheus metrics

**Expected Behavior**: Recording rules take 5-10 minutes to initialize after deployment.

**Verification**:
```bash
# Check recording rules
kubectl get configmap -n kubecost kubecost-prometheus-server -o yaml | grep -A 10 "recording_rules"

# Wait 10 minutes, then check again
kubectl get pods -n kubecost -w
```

**Action**: Wait 10 minutes - alerts will auto-resolve.

### Issue: Azure Billing Data Not Showing

**Symptom**: Cloud Cost page shows "No data"

**Expected Behavior**: First export runs within 24 hours. Billing reconciliation takes 24-48 hours.

**Verification**:
```bash
# Check Azure cost export status
az costmanagement export list \
  --scope "/subscriptions/833accc2-1856-4e07-bcef-06cef4efdef2" \
  --query "[?name=='kubecost-export'].{name:name,status:status,lastRun:lastRunTime}"

# Check blob storage for exports
az storage blob list \
  --container-name cost-exports \
  --account-name iotisticacosts9057 \
  --output table
```

**Action**: Wait 48 hours for first complete billing cycle.

## Cost Analysis

### Before Migration
- Envoy Gateway LoadBalancer: ~$30-40/month
- Kubecost LoadBalancer: ~$30-40/month
- **Total**: ~$60-80/month

### After Migration
- Envoy Gateway LoadBalancer (shared): ~$30-40/month
- Kubecost: ClusterIP (no cost)
- **Total**: ~$30-40/month

**Savings**: ~$30-40/month (~50% reduction)

## Using Kubecost

Access dashboard: **https://kubecost.iotistica.com**

### Key Features

1. **Allocations**: Namespace-level cost breakdown
   - View costs by namespace (client1, tsdb, kubecost, virtual-agents)
   - Filter by time range, labels, pods
   - Export to CSV

2. **Assets**: Infrastructure costs
   - Node costs
   - Persistent volume costs
   - Network egress costs

3. **Cloud Cost**: Azure billing reconciliation
   - Actual Azure costs (available 24-48 hours after first export)
   - Cost by resource group, service, region
   - Trend analysis

4. **Savings**: Optimization recommendations
   - Right-sizing recommendations
   - Abandoned resources
   - Idle costs

5. **Alerts**: Budget notifications
   - Configure budget alerts
   - Anomaly detection
   - Slack/email notifications

6. **Reports**: Scheduled reports
   - Weekly/monthly cost reports
   - Email delivery
   - CSV exports

## Maintenance

### Upgrade Kubecost

```bash
# Check for updates
helm search repo kubecost/cost-analyzer --versions

# Upgrade to new version
helm upgrade kubecost kubecost/cost-analyzer \
  --version <NEW_VERSION> \
  --namespace kubecost \
  -f k8s/kubecost-values.yaml \
  --wait

# Verify upgrade
kubectl get pods -n kubecost
```

### Backup Configuration

```bash
# Backup Helm values
cp k8s/kubecost-values.yaml k8s/kubecost-values.yaml.backup

# Backup HTTPRoute
kubectl get httproute -n kubecost kubecost-httproute -o yaml > k8s/kubecost-httproute.backup.yaml

# Backup secret (encrypted)
kubectl get secret -n kubecost cloud-integration -o yaml > k8s/cloud-integration.backup.yaml
```

### Monitor Resource Usage

```bash
# Check pod resource usage
kubectl top pods -n kubecost

# Check PVC usage
kubectl get pvc -n kubecost

# Check Prometheus disk usage
kubectl exec -it -n kubecost deployment/kubecost-prometheus-server -- df -h /data
```

## References

- **Kubecost Documentation**: https://docs.kubecost.com/
- **Azure Cost Management**: https://docs.microsoft.com/azure/cost-management-billing/
- **Envoy Gateway**: https://gateway.envoyproxy.io/
- **Gateway API**: https://gateway-api.sigs.k8s.io/

## Summary

Successfully deployed Kubecost with:
- ✅ Production-ready configuration (v1.108.1)
- ✅ Azure cost integration (daily exports)
- ✅ Cost-optimized networking (shared Envoy Gateway)
- ✅ Secure HTTPS access (https://kubecost.iotistica.com)
- ✅ Persistent storage (15-day Prometheus retention)
- ✅ ~$30-40/month savings (eliminated dedicated LoadBalancer)

**Next Steps**:
1. Wait 24-48 hours for Azure billing data to populate
2. Configure cost alerts and budgets
3. Review namespace cost allocations
4. Implement cost optimization recommendations
5. Set up scheduled cost reports

---

**Document Version**: 1.0  
**Last Updated**: February 16, 2026  
**Cluster**: dev-iotistica-aks-cluster (canadacentral)
