# Virtual Agent Resource Management - Quick Start

## Prerequisites

- Kubernetes cluster (1.19+)
- kubectl configured
- Prometheus + Grafana installed (optional, for monitoring)
- Metrics Server installed: `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`

## Step 1: Create Namespaces

```bash
# Production namespace
kubectl create namespace virtual-agents

# Development namespace
kubectl create namespace virtual-agents-dev
```

## Step 2: Deploy Resource Quotas & Limits

```bash
# Apply resource quotas and LimitRanges
kubectl apply -f k8s/virtual-agent-quotas.yaml

# Verify quotas
kubectl describe resourcequota -n virtual-agents
kubectl describe limitrange virtual-agent-limits -n virtual-agents
```

**Expected output**:
```
Resource Quotas
  Name:                   virtual-agents-quota
  Resource                Used  Hard
  --------                ----  ----
  limits.cpu              0     100
  limits.memory           0     200Gi
  pods                    0     50
  requests.cpu            0     20
  requests.memory         0     40Gi
```

## Step 3: Install Vertical Pod Autoscaler (Optional)

```bash
# Install VPA CRDs and controllers
kubectl apply -f https://github.com/kubernetes/autoscaler/releases/latest/download/vertical-pod-autoscaler.yaml

# Verify VPA components running
kubectl get pods -n kube-system | grep vpa

# Deploy VPA for virtual agents
kubectl apply -f k8s/virtual-agent-vpa.yaml

# Check VPA status
kubectl get vpa -n virtual-agents
```

## Step 4: Deploy First Virtual Agent

```bash
# Test deployment via API
curl -X POST http://localhost:4002/api/devices \
  -H "Content-Type: application/json" \
  -d '{
    "device_name": "test-agent-001",
    "device_type": "virtual",
    "fleet_id": "<your-fleet-id>",
    "endpoints": [
      {
        "protocol": "opcua",
        "connection": {
          "endpointUrl": "opc.tcp://localhost:4840",
          "profile": "testfactory2"
        }
      }
    ]
  }'

# Watch pod creation
kubectl get pods -n virtual-agents -w
```

## Step 5: Monitor Resources

```bash
# Check pod resource usage
kubectl top pods -n virtual-agents

# Check quota utilization
kubectl describe resourcequota -n virtual-agents

# View VPA recommendations (after ~5 minutes)
kubectl describe vpa virtual-agent-vpa -n virtual-agents
```

**Example VPA output**:
```
Recommendation:
  Container Recommendations:
    Container Name:  agent
    Lower Bound:     cpu: 250m, memory: 400Mi
    Target:          cpu: 350m, memory: 550Mi  ← VPA will update to these
    Upper Bound:     cpu: 800m, memory: 1.2Gi
```

## Step 6: Load Testing

```bash
# Deploy multiple agents to test quota enforcement
for i in {1..10}; do
  curl -X POST http://localhost:4002/api/devices \
    -H "Content-Type: application/json" \
    -d "{
      \"device_name\": \"load-test-$i\",
      \"device_type\": \"virtual\",
      \"fleet_id\": \"<fleet-id>\"
    }"
  sleep 2
done

# Monitor cluster resources
watch kubectl top nodes
watch kubectl top pods -n virtual-agents
```

## Step 7: Setup Monitoring (Optional)

### Install Prometheus + Grafana

```bash
# Using Helm
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace

# Verify
kubectl get pods -n monitoring
```

### Deploy Alert Rules

```bash
# Apply virtual agent alerts
kubectl apply -f docs/VIRTUAL-AGENT-MONITORING.md  # Extract alerting rules

# Verify alerts loaded
kubectl get prometheusrules -n monitoring
```

### Import Grafana Dashboard

```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80

# Open http://localhost:3000 (admin/prom-operator)
# Import dashboard from docs/VIRTUAL-AGENT-MONITORING.md
```

## Troubleshooting

### Pod Pending (Insufficient Resources)

```bash
# Check events
kubectl describe pod <pod-name> -n virtual-agents

# Common errors:
# "0/3 nodes are available: 3 Insufficient cpu."
# → Add nodes OR reduce resource requests

# Check node capacity
kubectl describe nodes | grep -A 5 "Allocatable"

# Check quota
kubectl describe resourcequota -n virtual-agents
# → Used CPU/Memory approaching Hard limit?
```

**Solutions**:
1. Add more nodes to cluster
2. Reduce resource requests in deployment
3. Increase namespace quota
4. Delete unused pods

### OOMKilled (Out of Memory)

```bash
# Check container memory usage
kubectl top pod <pod-name> -n virtual-agents --containers

# Check events
kubectl get events -n virtual-agents | grep <pod-name> | grep OOMKilled

# View logs before crash
kubectl logs <pod-name> -n virtual-agents agent --previous
```

**Solutions**:
1. Increase memory limits for agent
2. Reduce sidecar count per agent
3. Switch to higher resource tier
4. Enable VPA to auto-adjust

### Quota Exceeded

```bash
# Check current usage
kubectl describe resourcequota -n virtual-agents

# Output shows:
#   requests.cpu    Used: 19    Hard: 20  ← Only 1 CPU left!
#   pods            Used: 48    Hard: 50  ← Only 2 pods can be created
```

**Solutions**:
1. Delete unused virtual agents
2. Increase quota (edit `k8s/virtual-agent-quotas.yaml`)
3. Move dev agents to `virtual-agents-dev` namespace

### VPA Not Updating Resources

```bash
# Check VPA status
kubectl describe vpa virtual-agent-vpa -n virtual-agents

# Look for:
#   Update Mode: Auto  ← Should be "Auto", not "Off"
#   Last Update Time: <recent timestamp>

# Check VPA controller logs
kubectl logs -n kube-system deployment/vpa-updater
kubectl logs -n kube-system deployment/vpa-recommender
```

**Solutions**:
1. Ensure VPA controllers running: `kubectl get pods -n kube-system | grep vpa`
2. Wait 5-10 minutes for initial recommendations
3. Check `updateMode: Auto` in VPA spec
4. Verify metrics-server running: `kubectl top nodes`

## Environment Variables

Add to API service `.env`:

```bash
# Agent Resources
VIRTUAL_AGENT_CPU_REQUEST=200m
VIRTUAL_AGENT_MEMORY_REQUEST=512Mi
VIRTUAL_AGENT_CPU_LIMIT=1000m
VIRTUAL_AGENT_MEMORY_LIMIT=2Gi

# Sidecar Resources
OPCUA_SIMULATOR_CPU_REQUEST=100m
OPCUA_SIMULATOR_MEMORY_REQUEST=128Mi
OPCUA_SIMULATOR_CPU_LIMIT=500m
OPCUA_SIMULATOR_MEMORY_LIMIT=512Mi

# Storage
VIRTUAL_AGENT_STORAGE_SIZE=1Gi

# Namespace
VIRTUAL_AGENT_NAMESPACE=virtual-agents
```

## Monitoring Dashboard URLs

- Grafana: `http://localhost:3000` (via port-forward)
- Prometheus: `http://localhost:9090` (via port-forward)
- Kubernetes Dashboard: `http://localhost:8001/api/v1/namespaces/kubernetes-dashboard/services/https:kubernetes-dashboard:/proxy/`

## Useful kubectl Commands

```bash
# List all virtual agents
kubectl get pods -n virtual-agents -l app.kubernetes.io/name=virtual-agent

# Get resource requests/limits for all pods
kubectl get pods -n virtual-agents -o custom-columns=\
NAME:.metadata.name,\
CPU_REQ:.spec.containers[0].resources.requests.cpu,\
MEM_REQ:.spec.containers[0].resources.requests.memory,\
CPU_LIM:.spec.containers[0].resources.limits.cpu,\
MEM_LIM:.spec.containers[0].resources.limits.memory

# Count sidecars per pod
kubectl get pods -n virtual-agents -o json | \
jq '.items[] | {name: .metadata.name, containers: (.spec.containers | length)}'

# Get VPA recommendations for all agents
kubectl get vpa -n virtual-agents -o yaml | grep -A 10 "recommendation"

# Watch pod creation/deletion
kubectl get pods -n virtual-agents -w

# Show pod events in real-time
kubectl get events -n virtual-agents -w --sort-by='.lastTimestamp'

# Delete all virtual agents
kubectl delete deployment -n virtual-agents -l app.kubernetes.io/name=virtual-agent

# Check cluster-wide resource usage
kubectl top nodes
kubectl describe nodes | grep -A 10 "Allocated resources"
```

## Next Steps

1. **Review Logs**: Monitor first few agent deployments for resource issues
2. **Tune Resources**: Wait 24 hours, check VPA recommendations, adjust
3. **Set Alerts**: Configure Prometheus alerts for quota warnings
4. **Plan Scaling**: Based on current usage, plan cluster expansion
5. **Optimize**: Identify resource-heavy agents, optimize or split devices

## Reference Documentation

- [VIRTUAL-AGENT-RESOURCE-MANAGEMENT.md](VIRTUAL-AGENT-RESOURCE-MANAGEMENT.md) - Full guide
- [VIRTUAL-AGENT-MONITORING.md](VIRTUAL-AGENT-MONITORING.md) - Monitoring queries
- [k8s/virtual-agent-quotas.yaml](../k8s/virtual-agent-quotas.yaml) - Quota configuration
- [k8s/virtual-agent-vpa.yaml](../k8s/virtual-agent-vpa.yaml) - VPA configuration
