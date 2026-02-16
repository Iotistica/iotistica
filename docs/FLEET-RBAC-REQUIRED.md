# Virtual Fleet Deployment - RBAC Requirements

## Current Problem

Your code tries to create K8s resources but **fails** because:

1. ❌ API deployment has **NO ServiceAccount** configured
2. ❌ No RBAC permissions to create namespaces/deployments
3. ❌ In-cluster config loads but has no permissions

## What Your Code Does (virtual-agent-deployer.ts)

```typescript
// Line 1009: Creates namespace fleet-{id}
await this.coreApi.createNamespace({ ... });

// Line 1035: Creates ResourceQuota
await this.coreApi.createNamespacedResourceQuota(namespace, { ... });

// Line 516: Creates Deployment
await this.appsApi.createNamespacedDeployment(namespace, deployment);

// Line 334: Creates Secret (provisioning keys)
await this.coreApi.createNamespacedSecret(namespace, secret);
```

## Required Fix (2 Steps)

### Step 1: Apply RBAC

```bash
kubectl apply -f k8s/rbac/fleet-manager-minimal.yaml
```

This creates:
- **ServiceAccount**: `virtual-fleet-manager` (in client1 namespace)
- **ClusterRole**: `fleet-namespace-manager` (cluster-wide permissions)
- **ClusterRoleBinding**: Links ServiceAccount → ClusterRole

### Step 2: Update API Deployment

```bash
kubectl patch deployment client1-release-iotistic-api -n client1 -p '{
  "spec": {
    "template": {
      "spec": {
        "serviceAccountName": "virtual-fleet-manager"
      }
    }
  }
}'
```

This tells the API pod to use the ServiceAccount with K8s permissions.

## Quick Setup (Run Once)

```powershell
# From repository root
.\scripts\setup-fleet-rbac.ps1
```

This script does both steps above automatically.

## Verify It Works

```bash
# Check ServiceAccount exists
kubectl get serviceaccount virtual-fleet-manager -n client1

# Test permissions
kubectl auth can-i create namespaces \
  --as=system:serviceaccount:client1:virtual-fleet-manager
# Should return: yes

kubectl auth can-i create deployments \
  --as=system:serviceaccount:client1:virtual-fleet-manager
# Should return: yes
```

## What Changes Are Needed to Your Code?

**NONE** - Your code already tries to load in-cluster config (line 82-89). It just needs the ServiceAccount to exist.

The code will automatically:
1. ✅ Detect it's running in K8s
2. ✅ Load in-cluster config from `/var/run/secrets/kubernetes.io/serviceaccount/`
3. ✅ Use ServiceAccount token for authentication
4. ✅ Create namespaces/deployments with RBAC permissions

## Test Fleet Creation

```bash
# Port-forward to API
kubectl port-forward -n client1 svc/client1-release-iotistic-api 3002:3002

# Create test fleet
curl -X POST http://localhost:3002/api/fleets/virtual \
  -H "Content-Type: application/json" \
  -d '{
    "fleet_name": "Test Fleet",
    "agent_count": 2,
    "devices_per_agent": 3,
    "customer_id": "tsdb"
  }'

# Verify namespace created
kubectl get namespace | grep fleet-

# Verify ResourceQuota
kubectl get resourcequota -A | grep fleet-
```

## Summary

**Do you need code changes?** NO

**Do you need RBAC?** YES - Run `.\scripts\setup-fleet-rbac.ps1`

**Will current code work after RBAC?** YES - automatically
