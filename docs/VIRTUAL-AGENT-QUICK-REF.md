# Virtual Agent Testing - Quick Reference

## 🚀 Quick Start (5 minutes)

### 1. Enable K8s in Docker Desktop
```
Docker Desktop → Settings → Kubernetes → Enable Kubernetes → Apply & Restart
```

### 2. Create Namespace
```powershell
kubectl create namespace virtual-agents
```

### 3. Restart API
```powershell
docker compose up -d api --build
```

### 4. Create Virtual Agent
```powershell
$response = Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/virtual" `
  -Method POST -ContentType "application/json" `
  -Body '{"name":"test-agent","fleetId":"default"}' 

$deviceUuid = $response.deviceUuid
```

### 5. Check Status
```powershell
# API status
Invoke-RestMethod "http://localhost:4002/api/v1/devices/$deviceUuid/deployment-status"

# K8s status
kubectl get pods -n virtual-agents
```

## 📋 Essential Commands

### K8s Health Check
```powershell
kubectl cluster-info                  # Cluster info
kubectl get nodes                     # Node status (should show docker-desktop)
kubectl get namespaces                # List namespaces
```

### Virtual Agent Management
```powershell
# List pods
kubectl get pods -n virtual-agents

# View logs
kubectl logs -n virtual-agents <pod-name> -f

# Describe pod (troubleshooting)
kubectl describe pod -n virtual-agents <pod-name>

# List all resources
kubectl get all -n virtual-agents

# View secrets
kubectl get secrets -n virtual-agents
```

### API Debugging
```powershell
# Check API logs for K8s init
docker compose logs api | Select-String "VirtualAgentDeployer"

# Check kubeconfig mount
docker compose exec api ls -la /root/.kube/

# Verify K8s access from container
docker compose exec api kubectl cluster-info
```

### Cleanup
```powershell
# Delete virtual agent
Invoke-RestMethod -Uri "http://localhost:4002/api/v1/devices/$deviceUuid/virtual" -Method DELETE

# Delete namespace
kubectl delete namespace virtual-agents
```

## 🔍 Troubleshooting

### API can't connect to K8s
```powershell
# 1. Verify K8s enabled (green in Docker Desktop)
# 2. Check kubeconfig exists
Test-Path $env:USERPROFILE\.kube\config

# 3. Verify volume mount
docker compose exec api cat /root/.kube/config

# 4. Restart API
docker compose restart api
```

### Pod stuck in Pending
```powershell
# Check events
kubectl get events -n virtual-agents --sort-by='.lastTimestamp'

# Check pod details
kubectl describe pod -n virtual-agents <pod-name>

# Common: Image pull issues - check AGENT_IMAGE env var
```

### Pod CrashLoopBackOff
```powershell
# View logs
kubectl logs -n virtual-agents <pod-name>

# Check secret exists
kubectl get secrets -n virtual-agents

# Verify CLOUD_API_URL and MQTT_BROKER_URL in deployment
kubectl describe deployment -n virtual-agents
```

## ✅ Success Indicators

| Step | Command | Expected Result |
|------|---------|-----------------|
| K8s Running | `kubectl get nodes` | `docker-desktop   Ready` |
| API Init | `docker compose logs api \| Select-String K8s` | `✅ VirtualAgentDeployer initialized` |
| Namespace | `kubectl get ns virtual-agents` | `virtual-agents   Active` |
| Pod Running | `kubectl get pods -n virtual-agents` | `agent-xxx   1/1   Running` |
| Agent Online | Dashboard or API | `status: "online"` |

## 📖 Full Documentation

See [VIRTUAL-AGENT-LOCAL-TESTING.md](./VIRTUAL-AGENT-LOCAL-TESTING.md) for complete guide.
