# Cluster-Wide Manifests

This directory contains Kubernetes manifests that should be applied **once per cluster** (not per customer).

## Prerequisites

Before deploying any customer instances, apply these base resources:

### 1. Create System Namespace

```bash
kubectl create namespace iotistic-system
```

### 2. Deploy License Public Key ConfigMap

```bash
kubectl apply -f license-public-key-configmap.yaml
```

**Verify:**
```bash
kubectl get configmap -n iotistic-system iotistic-license-public-key
kubectl describe configmap -n iotistic-system iotistic-license-public-key
```

## Architecture

### License Validation Flow

```
┌─────────────────────────────────────────────────────────┐
│ Cluster-Wide (iotistic-system namespace)               │
│                                                         │
│  ConfigMap: iotistic-license-public-key                │
│    └─ public-key.pem (RSA-2048)                        │
│       (Same for ALL customers)                          │
└─────────────────────────────────────────────────────────┘
                           │
                           │ Referenced by all customer API pods
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Per-Customer Namespace (client-xxxxxx)                  │
│                                                         │
│  1Password Secret: api-license-client-xxxxxx           │
│    └─ key: JWT token (unique per customer)            │
│                                                         │
│  API Pod Environment Variables:                         │
│    ├─ LICENSE_PUBLIC_KEY (from ConfigMap)              │
│    └─ IOTISTIC_LICENSE_KEY (from 1Password secret)     │
└─────────────────────────────────────────────────────────┘
```

### Why This Design?

**Public Key (Cluster-Wide ConfigMap):**
- ✅ Same for all customers (no duplication)
- ✅ Single source of truth
- ✅ Easy rotation (update once)
- ✅ Smaller per-customer deployments

**JWT Token (Per-Customer 1Password Secret):**
- ✅ Unique per customer (contains customer ID, plan, features)
- ✅ Secure storage in 1Password
- ✅ Plan-specific feature flags

## Key Rotation

When you regenerate the license key pair:

1. **Generate new keys:**
   ```bash
   cd provisioning
   npm run generate-keys
   ```

2. **Update ConfigMap:**
   - Copy new public key from `provisioning/keys/public-key.pem`
   - Update `license-public-key-configmap.yaml`
   - Apply changes:
     ```bash
     kubectl apply -f license-public-key-configmap.yaml
     ```

3. **Restart customer API pods** (they'll pick up the new key):
   ```bash
   # Restart all customer API pods
   kubectl rollout restart deployment -l app=iotistic-api --all-namespaces
   
   # Or restart specific customer:
   kubectl rollout restart deployment -n client-xxxxxx client-xxxxxx-iotistic-api
   ```

4. **Generate new licenses** for all customers:
   - The billing service will automatically generate new JWTs signed with the new private key
   - On next license refresh, customers get JWTs signed with new key
   - Pods validate with new public key

## Troubleshooting

### License validation fails

**Check ConfigMap exists:**
```bash
kubectl get configmap -n iotistic-system iotistic-license-public-key
```

**Check API pod can access ConfigMap:**
```bash
kubectl exec -n client-xxxxxx deployment/client-xxxxxx-iotistic-api -- \
  cat /etc/iotistic/license/public-key.pem
```

**Expected output:** RSA public key starting with `-----BEGIN PUBLIC KEY-----`

### Logs show "No license key found"

The customer's 1Password secret might be missing. Check:
```bash
# Via 1Password CLI
op item get "api-license-client-xxxxxx"

# Or check Kubernetes secret reference
kubectl get secret -n client-xxxxxx
```

## Security Notes

- **Never commit private keys to Git** (only public key in this ConfigMap)
- **Private key stays in:** `provisioning/keys/private-key.pem` (not in version control)
- **ConfigMap is immutable:** Prevents accidental edits. Create new version for updates.
- **Namespace isolation:** ConfigMap in `iotistic-system`, customer pods reference it cross-namespace
