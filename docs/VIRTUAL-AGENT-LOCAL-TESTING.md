# Virtual Agent Local Testing Guide

Complete guide for testing virtual agent deployment locally using Docker Desktop's built-in Kubernetes.

## Prerequisites

- Docker Desktop for Windows
- PowerShell terminal
- kubectl CLI (bundled with Docker Desktop)

## Phase 1: Enable Kubernetes in Docker Desktop

### 1.1 Enable K8s

1. Open **Docker Desktop**
2. Click **Settings** (gear icon)
3. Navigate to **Kubernetes** section
4. Check **☑ Enable Kubernetes**
5. Click **Apply & Restart**
6. Wait for Kubernetes status to show **green circle** (1-2 minutes)

### 1.2 Verify K8s is Running

```powershell
# Check cluster info
kubectl cluster-info

# Expected output:
# Kubernetes control plane is running at https://kubernetes.docker.internal:6443
# CoreDNS is running at https://kubernetes.docker.internal:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy

# Check nodes
kubectl get nodes

# Expected output:
# NAME             STATUS   ROLES           AGE   VERSION
# docker-desktop   Ready    control-plane   1h    v1.29.x
```

### 1.3 Create Virtual Agents Namespace

```powershell
# Create namespace
kubectl create namespace virtual-agents

# Verify
kubectl get namespaces
```

## Phase 2: Configure API Container

### 2.1 Verify Docker Compose Configuration

The `docker-compose.yml` has been updated with:

**Environment Variables (added):**
```yaml
- KUBECONFIG=/root/.kube/config
- VIRTUAL_AGENT_NAMESPACE=virtual-agents
- AGENT_IMAGE=iotistic/agent:latest
- CLOUD_API_URL=https://api1.iotistica.com:443
- MQTT_BROKER_URL_VIRTUAL=mqtts://mqtt1.iotistica.com:8883
```

**Volume Mount (added):**
```yaml
- ${USERPROFILE}/.kube:/root/.kube:ro
```

This mounts your Windows kubeconfig (`C:\Users\<YourName>\.kube\config`) into the container at `/root/.kube/config`.

### 2.2 Restart API Container

```powershell
cd C:\Users\Dan\zemfyre-sensor

# Rebuild and restart API
docker compose up -d api --build

# Check logs for K8s initialization
docker compose logs api | Select-String -Pattern "VirtualAgentDeployer"
```

**Expected Success Log:**
```
✅ VirtualAgentDeployer initialized with default kubeconfig
  currentContext: "docker-desktop"
  clusterServer: "https://kubernetes.docker.internal:6443"
  kubeconfigPath: "/root/.kube/config"
```

**If you see failure log:**
```
❌ Failed to initialize K8s config - Virtual agents will not work
```
→ Check troubleshooting section below.

## Phase 3: Test Virtual Agent Creation

### 3.1 Create Virtual Agent via API

```powershell
# Create virtual agent via REST API
$response = Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/virtual" `
  -Method POST `
  -ContentType "application/json" `
  -Body (@{
    name = "test-virtual-agent"
    fleetId = "default"
    tags = @("test", "local")
  } | ConvertTo-Json)

# Save device UUID
$deviceUuid = $response.deviceUuid
Write-Host "Created virtual agent: $deviceUuid"
Write-Host "Deployment status: $($response.deploymentStatus)"
```

**Expected Response:**
```json
{
  "deviceUuid": "abc123...",
  "deploymentStatus": "deploying",
  "message": "Virtual agent deployment initiated"
}
```

### 3.2 Check Deployment Status

```powershell
# Check via API
Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/$deviceUuid/deployment-status"

# Check K8s resources
kubectl get all -n virtual-agents

# Expected output:
# NAME                              READY   STATUS    RESTARTS   AGE
# pod/agent-abc123xx-xxxxx-xxxxx   1/1     Running   0          30s
#
# NAME                          READY   UP-TO-DATE   AVAILABLE   AGE
# deployment.apps/agent-abc123  1/1     1            1           30s
```

### 3.3 Check Pod Logs

```powershell
# Get pod name
$podName = (kubectl get pods -n virtual-agents -o name | Select-String "agent-") -replace 'pod/',''

# View logs
kubectl logs -n virtual-agents $podName -f

# Expected logs (agent provisioning):
# [INFO] Agent starting with UUID: abc123...
# [INFO] Provisioning key found in environment
# [INFO] Registering device with cloud API...
# [INFO] Device provisioned successfully
# [INFO] Connecting to MQTT broker...
```

### 3.4 Verify in Dashboard

1. Open dashboard: http://localhost:3000
2. Navigate to **Devices** page
3. Look for your virtual agent (Container icon)
4. Status should change: `pending` → `deploying` → `running` → `online`

## Phase 4: Cleanup

### 4.1 Delete Virtual Agent

```powershell
# Via API
Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/$deviceUuid/virtual" `
  -Method DELETE

# Verify K8s resources deleted
kubectl get all -n virtual-agents

# Expected: No resources (or only system resources)
```

### 4.2 Delete Namespace (Optional)

```powershell
kubectl delete namespace virtual-agents
```

## Troubleshooting

### Issue: "Failed to initialize Kubernetes configuration"

**Symptoms:**
```
❌ Failed to initialize K8s config - Virtual agents will not work
```

**Solutions:**

1. **Verify K8s is enabled in Docker Desktop:**
   - Docker Desktop → Settings → Kubernetes → Enable Kubernetes
   - Status should be green

2. **Check kubeconfig exists:**
   ```powershell
   Test-Path $env:USERPROFILE\.kube\config
   # Should return: True
   
   # View contents
   Get-Content $env:USERPROFILE\.kube\config
   ```

3. **Verify kubectl works from host:**
   ```powershell
   kubectl cluster-info
   # Should connect successfully
   ```

4. **Check volume mount in API container:**
   ```powershell
   docker compose exec api ls -la /root/.kube/
   # Should show: config file
   
   docker compose exec api cat /root/.kube/config
   # Should show kubeconfig contents
   ```

5. **Check API container environment:**
   ```powershell
   docker compose exec api printenv | Select-String KUBE
   # Should show: KUBECONFIG=/root/.kube/config
   ```

### Issue: Pod stuck in "Pending" state

**Check:**
```powershell
kubectl describe pod -n virtual-agents <pod-name>
```

**Common causes:**
- Image pull failure (check `AGENT_IMAGE` env var)
- Resource limits too high (Docker Desktop has limited resources)
- Namespace doesn't exist

**Solution:**
```powershell
# Check events
kubectl get events -n virtual-agents --sort-by='.lastTimestamp'

# Reduce resource limits in virtual-agent-deployer.ts (lines 290-300)
```

### Issue: Pod CrashLoopBackOff

**Check pod logs:**
```powershell
kubectl logs -n virtual-agents <pod-name>
```

**Common causes:**
- PROVISIONING_KEY secret not created
- Invalid CLOUD_API_URL or MQTT_BROKER_URL
- Agent can't reach cloud API (network issue)

**Verify secret:**
```powershell
kubectl get secrets -n virtual-agents
kubectl describe secret -n virtual-agents <secret-name>
```

### Issue: Agent doesn't appear online

**Check:**
1. Pod is running: `kubectl get pods -n virtual-agents`
2. Agent logs show successful provisioning: `kubectl logs -n virtual-agents <pod>`
3. Device record in DB: Query `devices` table for device UUID
4. MQTT connection: Check agent logs for MQTT connect success

## Configuration Reference

### Environment Variables (API Container)

| Variable | Default | Description |
|----------|---------|-------------|
| `KUBECONFIG` | `/root/.kube/config` | Path to kubeconfig file |
| `VIRTUAL_AGENT_NAMESPACE` | `virtual-agents` | K8s namespace for virtual agents |
| `AGENT_IMAGE` | `iotistic/agent:latest` | Docker image for agent pods |
| `CLOUD_API_URL` | `https://api1.iotistica.com:443` | Cloud API URL for agents |
| `MQTT_BROKER_URL_VIRTUAL` | `mqtts://mqtt1.iotistica.com:8883` | MQTT broker URL for agents |
| `VIRTUAL_AGENT_CPU_LIMIT` | `1000m` | Max CPU per agent (1 core) |
| `VIRTUAL_AGENT_MEMORY_LIMIT` | `2Gi` | Max memory per agent |
| `VIRTUAL_AGENT_CPU_REQUEST` | `200m` | Requested CPU per agent |
| `VIRTUAL_AGENT_MEMORY_REQUEST` | `512Mi` | Requested memory per agent |

### K8s Resources Created (Per Virtual Agent)

1. **Secret:** `agent-<uuid>-prov-key` (contains provisioning key)
2. **Deployment:** `agent-<uuid>` (single replica)
3. **Pod:** `agent-<uuid>-xxxxx-xxxxx` (managed by deployment)

### Docker Desktop Resource Limits

By default, Docker Desktop allocates:
- **CPU:** 2 cores
- **Memory:** 8 GB

Adjust in **Docker Desktop → Settings → Resources** if testing multiple virtual agents.

## Next Steps

### For Development:
- Mock K8s deployer for offline testing
- Add unit tests for VirtualAgentDeployer
- Implement deployment status webhook

### For Production:
- Set up cloud K8s cluster (EKS, GKE, AKS)
- Configure RBAC permissions
- Set up monitoring (Prometheus/Grafana)
- Implement auto-scaling policies

## Additional Resources

- [Docker Desktop K8s Docs](https://docs.docker.com/desktop/kubernetes/)
- [kubectl Cheat Sheet](https://kubernetes.io/docs/reference/kubectl/cheatsheet/)
- Virtual Agent Architecture: `api/src/services/virtual-agent-deployer.ts`
- Provisioning Flow: `api/src/services/provisioning.service.ts` (lines 121-245)

## Success Criteria

✅ K8s enabled in Docker Desktop (green status)  
✅ `kubectl cluster-info` shows cluster running  
✅ API logs show "✅ VirtualAgentDeployer initialized"  
✅ Virtual agent created via POST `/devices/virtual`  
✅ Pod running: `kubectl get pods -n virtual-agents`  
✅ Agent logs show successful provisioning  
✅ Device appears online in dashboard  

---

**Last Updated:** 2026-02-07  
**Tested On:** Docker Desktop 4.x, Windows 11, Kubernetes v1.29
