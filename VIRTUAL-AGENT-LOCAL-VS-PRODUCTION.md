# Virtual Agent Deployment: Local vs Production

## TL;DR

**YES, it will work in production** - but you need RBAC permissions. The code is already designed for both environments.

## How It Works

### Code Automatically Detects Environment

```typescript
// api/src/services/virtual-agent-deployer.ts (lines 52-68)
try {
  // Try in-cluster config first (PRODUCTION)
  this.k8sConfig.loadFromCluster();
  logger.info('✅ VirtualAgentDeployer initialized with in-cluster K8s config');
} catch (error) {
  // Fallback to kubeconfig (LOCAL DEV)
  try {
    this.k8sConfig.loadFromDefault();
    logger.info('✅ VirtualAgentDeployer initialized with default kubeconfig');
  } catch (fallbackError) {
    // Neither worked - fail
    throw new Error('Failed to initialize Kubernetes configuration');
  }
}
```

## Environment Comparison

| Aspect | Local Development | Production K8s |
|--------|------------------|----------------|
| **API Location** | Docker Desktop container | K8s pod |
| **K8s Config** | Mounted kubeconfig | In-cluster service account |
| **RBAC** | Not needed (kubeconfig has admin) | **Required** (service account needs permissions) |
| **Image Pull** | Local images work | Need registry (ECR, GCR, ACR, Docker Hub) |
| **Namespace** | Any (docker-desktop cluster) | Isolated namespaces |
| **Networking** | Host network works | Cluster network only |
| **Logs** | `docker logs` | `kubectl logs` |

## Production Prerequisites

### 1. RBAC Setup (CRITICAL)

```bash
# Deploy RBAC before API
kubectl apply -f k8s/virtual-agent-rbac.yaml

# Creates:
# - ServiceAccount: iotistic-api
# - ClusterRole: virtual-agent-manager
# - ClusterRoleBinding: iotistic-api-virtual-agent-manager
```

**Without RBAC, you'll see:**
```
❌ Failed to deploy virtual agent
Error: Forbidden: User "system:serviceaccount:default:default" cannot create resource "deployments"
```

### 2. Service Account in Deployment

```yaml
# k8s/api-deployment-production.yaml
spec:
  template:
    spec:
      serviceAccountName: iotistic-api  # ← MUST ADD THIS
```

**Without serviceAccountName, pod uses `default` service account (no permissions)**

### 3. Agent Image in Registry

```bash
# Build and push agent
docker build -t your-registry.com/iotistic/agent:v1.0.0 ./agent
docker push your-registry.com/iotistic/agent:v1.0.0

# Update API deployment env var
AGENT_IMAGE=your-registry.com/iotistic/agent:v1.0.0
```

### 4. Environment Variables

```yaml
env:
- name: AGENT_IMAGE
  value: "your-registry.com/iotistic/agent:v1.0.0"  # ← Your registry
- name: CLOUD_API_URL
  value: "https://api.yourdomain.com"  # ← Your production API
- name: MQTT_BROKER_URL_VIRTUAL
  value: "mqtts://mqtt.yourdomain.com:8883"  # ← Your production MQTT
```

## Deployment Flow Comparison

### Local Development

```
User creates virtual agent (dashboard)
   ↓
POST /api/v1/devices (API in Docker container)
   ↓
virtualAgentDeployer.deploy() loads kubeconfig from mounted volume
   ↓
Creates K8s resources in Docker Desktop K8s
   ↓
Pod starts in virtual-agents namespace
```

### Production

```
User creates virtual agent (dashboard)
   ↓
POST /api/v1/devices (API pod in K8s)
   ↓
virtualAgentDeployer.deploy() loads in-cluster config from service account
   ↓
Uses RBAC permissions to create K8s resources
   ↓
Pod starts in virtual-agents namespace (isolated)
```

## Testing Production Setup

### Before Deploying API

```bash
# 1. Deploy RBAC
kubectl apply -f k8s/virtual-agent-rbac.yaml

# 2. Verify service account
kubectl get serviceaccount iotistic-api -n default

# 3. Test permissions
kubectl auth can-i create deployments --namespace=virtual-agents \
  --as=system:serviceaccount:default:iotistic-api
# Expected: yes
```

### After Deploying API

```bash
# 1. Check API pod logs
kubectl logs -n default deployment/iotistic-api | grep VirtualAgentDeployer
# Expected: ✅ VirtualAgentDeployer initialized with in-cluster K8s config

# 2. Create test virtual agent
curl -X POST https://api.yourdomain.com/api/v1/devices \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceName":"test","deviceType":"virtual","fleetId":"default"}'

# 3. Verify deployment created
kubectl get deployments -n virtual-agents
# Expected: agent-xxxxxxxx deployment with 1/1 ready
```

## Common Issues

### Issue: "Failed to initialize Kubernetes configuration"

**Local Dev:**
- Ensure K8s enabled in Docker Desktop
- Check kubeconfig mounted: `docker exec <api-container> ls -la /root/.kube/`

**Production:**
- Ensure `serviceAccountName: iotistic-api` in deployment
- Check RBAC applied: `kubectl get serviceaccount iotistic-api`

### Issue: "Forbidden: cannot create resource"

**Cause:** Missing or incorrect RBAC permissions

**Fix:**
```bash
kubectl apply -f k8s/virtual-agent-rbac.yaml
kubectl rollout restart deployment/iotistic-api -n default
```

### Issue: Pod stuck in "ImagePullBackOff"

**Cause:** Image not in registry or wrong image name

**Fix:**
```bash
# Verify image exists
docker pull your-registry.com/iotistic/agent:v1.0.0

# Update AGENT_IMAGE env var in deployment
kubectl set env deployment/iotistic-api -n default \
  AGENT_IMAGE=your-registry.com/iotistic/agent:v1.0.0
```

## Migration From Local to Production

1. ✅ **No code changes needed** - the same code works in both environments
2. ✅ **Apply RBAC** - `kubectl apply -f k8s/virtual-agent-rbac.yaml`
3. ✅ **Update deployment** - Add `serviceAccountName: iotistic-api`
4. ✅ **Push agent image** - To production registry
5. ✅ **Update env vars** - AGENT_IMAGE, CLOUD_API_URL, MQTT_BROKER_URL_VIRTUAL
6. ✅ **Deploy** - `kubectl apply -f k8s/api-deployment-production.yaml`
7. ✅ **Test** - Create virtual agent, verify logs

## Key Files

| File | Purpose | When to Use |
|------|---------|-------------|
| `k8s/virtual-agent-rbac.yaml` | RBAC permissions | Deploy before API in production |
| `k8s/api-deployment-production.yaml` | API deployment with service account | Production deployment |
| `docker-compose.yml` | Local dev with kubeconfig mount | Local testing |
| `VIRTUAL-AGENT-LOCAL-TESTING.md` | Local testing guide | Development |
| `VIRTUAL-AGENT-PRODUCTION-DEPLOYMENT.md` | Production deployment guide | Production |

## Summary

✅ **Code is production-ready** - uses `loadFromCluster()` for in-cluster config  
✅ **RBAC required** - service account needs permissions to create K8s resources  
✅ **Same codebase** - automatically detects and adapts to environment  
✅ **Minimal changes** - just RBAC + deployment config + env vars  

**Bottom line:** The virtual agent system will work seamlessly in production once you apply RBAC and configure the API deployment with the service account.
