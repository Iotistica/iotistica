# Agent Fleet Helm Chart

Deploy a fleet of IoT agents with integrated Modbus simulators for load testing and simulation.

## Architecture

This chart deploys a **StatefulSet** where each pod contains two containers:
- **Agent** - IoT device agent (port 48484)
- **Modbus Simulator** - Modbus TCP simulator (port 502)

Agents communicate with simulators via `localhost:502` using the sidecar pattern.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2.0+
- Pre-generated provisioning keys (from API)
- Persistent Volume provisioner (for agent SQLite storage)

## Installation

### 1. Generate Provisioning Keys

Generate provisioning keys from your API using the provided scripts:

```bash
# Generate 100 keys using bash script
./k8s/charts/agent-fleet/scripts/generate-provisioning-keys.sh \
  100 \
  https://api.iotistic.com \
  k8s-fleet-production \
  $AUTH_TOKEN > keys.env

# Or using PowerShell
.\k8s\charts\agent-fleet\scripts\generate-provisioning-keys.ps1 `
  -Count 100 `
  -ApiUrl "https://api.iotistic.com" `
  -FleetId "k8s-fleet-production" `
  -AuthToken $env:AUTH_TOKEN | Out-File -Encoding utf8 keys.env

# Create secret with generated keys
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys.env \
  -n agent-fleet
```

**Important**: The API endpoint is `/api/v1/provisioning-keys/generate` and requires:
- `fleetId` - Fleet identifier for grouping agents
- `newKey` - Set to `false` to reuse existing fleet keys
- `metadata` - Optional metadata (e.g., pod index)

### 2. Deploy Agent Fleet

```bash
# Basic deployment (10 agents)
helm install agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=k8s-fleet-production \
  --set provisioning.existingSecret=agent-provisioning-keys \
  -n agent-fleet --create-namespace

# Custom deployment (50 agents with monitoring)
helm install agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=50 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=load-test-fleet \
  --set provisioning.existingSecret=agent-provisioning-keys \
  --set monitoring.serviceMonitor.enabled=true \
  -n agent-fleet --create-namespace
```

### 3. Scale Fleet

```bash
# Scale to 100 agents
kubectl scale statefulset agent-fleet --replicas=100 -n agent-fleet

# Or via Helm upgrade
helm upgrade agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=100 \
  -n agent-fleet
```

## Configuration

### Core Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `fleet.name` | Fleet deployment name | `agent-fleet` |
| `fleet.replicaCount` | Number of agent pods | `10` |
| `fleet.cloudApiEndpoint` | Cloud API URL | `https://api.iotistic.com` |
| `fleet.fleetId` | Unique fleet identifier | `fleet-default` |

### Agent Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `agent.image.repository` | Agent image | `iotistica/agent` |
| `agent.image.tag` | Agent image tag | `latest` |
| `agent.resources.requests.memory` | Memory request | `256Mi` |
| `agent.resources.limits.memory` | Memory limit | `512Mi` |
| `agent.resources.requests.cpu` | CPU request | `200m` |
| `agent.resources.limits.cpu` | CPU limit | `200m` |

### Modbus Simulator Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `simulator.image.repository` | Simulator image | `iotistica/modbus-simulator` |
| `simulator.image.tag` | Simulator image tag | `latest` |
| `simulator.resources.requests.memory` | Memory request | `64Mi` |
| `simulator.resources.limits.memory` | Memory limit | `128Mi` |
| `simulator.port` | Modbus TCP port | `502` |
| `simulator.slaves` | Number of slaves | `5` |
| `simulator.vendor` | Vendor preset | `generic` |

### Provisioning

| Parameter | Description | Default |
|-----------|-------------|---------|
| `provisioning.existingSecret` | Existing secret with keys | `""` |
| `provisioning.secretName` | Secret name for keys | `agent-fleet-provisioning-keys` |

### Persistence

| Parameter | Description | Default |
|-----------|-------------|---------|
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.storageClass` | Storage class | `""` (default) |
| `persistence.size` | Storage size per agent | `1Gi` |

### Monitoring

| Parameter | Description | Default |
|-----------|-------------|---------|
| `monitoring.serviceMonitor.enabled` | Create ServiceMonitor | `false` |
| `monitoring.serviceMonitor.path` | Metrics endpoint | `/metrics` |
| `monitoring.serviceMonitor.interval` | Scrape interval | `30s` |

### High Availability

| Parameter | Description | Default |
|-----------|-------------|---------|
| `podDisruptionBudget.enabled` | Create PDB | `true` |
| `podDisruptionBudget.minAvailable` | Min available pods | `80%` |

## Monitoring & Operations

### View Agent Logs

```bash
# View agent logs (pod 0)
kubectl logs agent-fleet-0 -c agent -n agent-fleet --tail=100 -f

# View simulator logs (pod 0)
kubectl logs agent-fleet-0 -c modbus-simulator -n agent-fleet --tail=100 -f

# View all agent logs
kubectl logs -l app.kubernetes.io/name=agent-fleet -c agent -n agent-fleet --tail=20
```

### Check Agent Status

```bash
# List all pods
kubectl get pods -n agent-fleet

# Check provisioning status
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- \
  curl localhost:48484/v2/device

# Check Modbus connectivity
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- \
  curl localhost:48484/v2/modbus/status
```

### Resource Monitoring

```bash
# View resource usage
kubectl top pods -n agent-fleet

# View persistent volumes
kubectl get pvc -n agent-fleet
```

## Resource Requirements

### Small Fleet (10 agents)
- **CPU**: 2 cores (requests) + overhead = ~3 cores
- **Memory**: 3.8 GB (requests) + overhead = ~5 GB
- **Storage**: 10 GB (1Gi × 10 agents)

### Medium Fleet (50 agents)
- **CPU**: 10 cores (requests) + overhead = ~12 cores
- **Memory**: 19 GB (requests) + overhead = ~23 GB
- **Storage**: 50 GB (1Gi × 50 agents)

### Large Fleet (100 agents)
- **CPU**: 20 cores (requests) + overhead = ~24 cores
- **Memory**: 38.4 GB (requests) + overhead = ~46 GB
- **Storage**: 100 GB (1Gi × 100 agents)

**Recommended Node Configuration** (100 agents):
- 3-4 nodes × 8 vCPU / 16 GB RAM
- Use spot/preemptible instances for cost savings

## Troubleshooting

### Pods Stuck in Pending
```bash
# Check PVC status
kubectl get pvc -n agent-fleet

# Check events
kubectl get events -n agent-fleet --sort-by='.lastTimestamp'
```

### Provisioning Failures
```bash
# Check secret exists
kubectl get secret agent-provisioning-keys -n agent-fleet

# Verify key format
kubectl get secret agent-provisioning-keys -n agent-fleet -o yaml
```

### High Memory Usage
```bash
# Check memory metrics
kubectl top pods -n agent-fleet

# Adjust limits
helm upgrade agent-fleet ./k8s/charts/agent-fleet \
  --set agent.resources.limits.memory=1Gi \
  -n agent-fleet
```

## Uninstallation

```bash
# Delete Helm release
helm uninstall agent-fleet -n agent-fleet

# Delete PVCs (optional, data will be lost)
kubectl delete pvc -l app.kubernetes.io/name=agent-fleet -n agent-fleet

# Delete namespace
kubectl delete namespace agent-fleet
```

## Example: Load Testing Workflow

```bash
# 1. Generate 100 provisioning keys
./scripts/generate-provisioning-keys.sh 100 > keys.txt

# 2. Create secret
kubectl create secret generic agent-provisioning-keys \
  --from-file=keys.txt -n agent-fleet

# 3. Deploy 10 agents initially
helm install agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=10 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set provisioning.existingSecret=agent-provisioning-keys \
  -n agent-fleet --create-namespace

# 4. Monitor startup
kubectl get pods -n agent-fleet -w

# 5. Verify connectivity
for i in {0..9}; do
  kubectl exec agent-fleet-$i -c agent -n agent-fleet -- \
    curl -s localhost:48484/v2/device | jq '.uuid'
done

# 6. Scale to 50 agents
kubectl scale statefulset agent-fleet --replicas=50 -n agent-fleet

# 7. Monitor resource usage
watch kubectl top pods -n agent-fleet

# 8. Scale to 100 agents
kubectl scale statefulset agent-fleet --replicas=100 -n agent-fleet
```

## Advanced Configuration

### Custom Modbus Vendor Data

```yaml
simulator:
  vendor: "siemens"  # Options: generic, siemens, schneider, etc.
  vendorJsonPath: "/config/custom-vendor.json"
```

### Custom Agent Intervals

```yaml
agent:
  env:
    - name: DISCOVERY_INTERVAL_LIGHT_MS
      value: "60000"  # 1 minute
    - name: POLL_INTERVAL_MS
      value: "5000"   # 5 seconds
```

### Node Affinity (Dedicated Nodes)

```yaml
nodeSelector:
  workload-type: agent-fleet

tolerations:
  - key: "agent-fleet"
    operator: "Equal"
    value: "true"
    effect: "NoSchedule"
```

## Support

For issues or questions:
- GitHub Issues: https://github.com/iotistica/iotistic/issues
- Documentation: https://docs.iotistic.com
