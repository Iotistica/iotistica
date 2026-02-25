# Argo CD RBAC Permission Fix

## Problem

API token authentication succeeds but gets `"permission denied"` when accessing applications:

```json
{
  "error": "permission denied",
  "code": 7,
  "message": "permission denied"
}
```

This is an **Argo CD RBAC policy issue**, not an authentication problem.

## Root Cause

The API token has **list** permissions but lacks **get** permissions:
- ✅ Can list all applications (`/api/v1/applications`) 
- ❌ Cannot get specific application details (`/api/v1/applications/client-xxx`)

This causes Argo CD to return **403 Permission Denied** instead of **404 Not Found** for non-existent apps.

Required RBAC permissions:
- `applications, get, */*, allow` - View specific application
- `applications, list, */*, allow` - List all applications (already works)
- `applications, sync, */*, allow` - Trigger syncs (optional)

## Solution

### Option 1: Grant Admin Permissions (Recommended for Dev/Test)

Edit the Argo CD ConfigMap to give the API token admin access:

```bash
kubectl edit configmap argocd-rbac-cm -n argocd
```

Add this policy:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    # Grant admin account full access
    p, role:admin, applications, *, */*, allow
    p, role:admin, clusters, get, *, allow
    p, role:admin, repositories, get, *, allow
    p, role:admin, repositories, create, *, allow
    p, role:admin, repositories, update, *, allow
    p, role:admin, repositories, delete, *, allow
    
    # Assign admin role to admin account
    g, admin, role:admin
  policy.default: role:readonly
```

### Option 2: Create Specific Service Account (Production)

If your token is for a service account like `provisioning-api`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    # Allow provisioning service to manage applications
    p, role:provisioning, applications, get, */*, allow
    p, role:provisioning, applications, list, */*, allow
    p, role:provisioning, applications, sync, */*, allow
    p, role:provisioning, applications, delete, */*, allow
    
    # Assign role to service account
    g, provisioning-api, role:provisioning
  policy.default: role:readonly
```

### Option 3: Use Admin User Token (Quick Fix)

Generate a new token from the **admin** user with full permissions:

```bash
# Login to Argo CD
argocd login cd.iotistica.com --username admin

# Generate new API token
argocd account generate-token --account admin

# Copy token to .env
# ARGOCD_TOKEN=<new-token>
```

## Apply Changes

After editing the ConfigMap:

```bash
# Restart Argo CD server to apply RBAC changes
kubectl rollout restart deployment argocd-server -n argocd

# Wait for restart
kubectl rollout status deployment argocd-server -n argocd
```

## Verify Fix

Test from the provisioning worker:

```bash
# Test authentication
docker exec provisioning-worker sh -c 'curl -s -k -H "Authorization: Bearer $ARGOCD_TOKEN" "$ARGOCD_BASE_URL/api/version"'

# Test application access (should NOT get permission denied)
docker exec provisioning-worker sh -c 'curl -s -k -H "Authorization: Bearer $ARGOCD_TOKEN" "$ARGOCD_BASE_URL/api/v1/applications"'
```

Expected: JSON with application data or 404 Not Found
Wrong: `{"error":"permission denied","code":7}`

**Note**: If application doesn't exist yet, you should get 404, not 403. The 403 error indicates RBAC is blocking access.

## References

- [Argo CD RBAC Docs](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/)
- [Argo CD API Keys](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_account_generate-token/)
