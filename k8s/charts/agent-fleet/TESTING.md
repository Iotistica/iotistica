# Agent Fleet Testing Guide

Complete guide for testing the agent fleet deployment with load scenarios.

## Prerequisites

- Kubernetes cluster with sufficient resources
- `kubectl` configured with cluster access
- `helm` CLI installed
- API access for provisioning key generation
- Prometheus (optional, for monitoring)

## Test Environment Setup

### 1. Small Test (5 agents)

Quick validation test with minimal resources.

```bash
# Create namespace
kubectl create namespace agent-fleet-test

# Generate 5 provisioning keys
./scripts/generate-provisioning-keys.sh 5 https://api.iotistic.com $TOKEN > keys-test.env

# Create secret
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys-test.env \
  -n agent-fleet-test

# Deploy fleet
helm install agent-fleet-test ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=5 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=test-small \
  --set provisioning.existingSecret=agent-provisioning-keys \
  -n agent-fleet-test

# Wait for pods to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=agent-fleet \
  -n agent-fleet-test --timeout=300s

# Verify all agents are provisioned
for i in {0..4}; do
  echo "Agent $i:"
  kubectl exec agent-fleet-test-$i -c agent -n agent-fleet-test -- \
    curl -s localhost:48484/v2/device | jq -r '.uuid, .status'
done
```

**Expected Results:**
- All 5 pods running within 2-3 minutes
- Each agent has unique UUID
- Status: `provisioned` or `online`
- Modbus simulator responding on port 502

### 2. Medium Test (25 agents)

Production-like test with realistic load.

```bash
# Create namespace
kubectl create namespace agent-fleet-medium

# Generate 25 provisioning keys
./scripts/generate-provisioning-keys.sh 25 https://api.iotistic.com $TOKEN > keys-medium.env

# Create secret
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys-medium.env \
  -n agent-fleet-medium

# Deploy fleet with monitoring
helm install agent-fleet-medium ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=25 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=test-medium \
  --set provisioning.existingSecret=agent-provisioning-keys \
  --set monitoring.serviceMonitor.enabled=true \
  -n agent-fleet-medium

# Monitor rollout
kubectl rollout status statefulset agent-fleet-medium -n agent-fleet-medium

# Check resource usage
kubectl top pods -n agent-fleet-medium
```

**Expected Results:**
- All 25 pods running within 5-7 minutes
- Total CPU usage: ~5 cores
- Total memory usage: ~9.5 GB
- PVCs all bound and in use

### 3. Large Test (100 agents)

Full-scale load test simulating production environment.

```bash
# Create namespace
kubectl create namespace agent-fleet-large

# Generate 100 provisioning keys
./scripts/generate-provisioning-keys.sh 100 https://api.iotistic.com $TOKEN > keys-large.env

# Create secret
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys-large.env \
  -n agent-fleet-large

# Deploy fleet with full configuration
helm install agent-fleet-large ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=100 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=test-large \
  --set provisioning.existingSecret=agent-provisioning-keys \
  --set monitoring.serviceMonitor.enabled=true \
  --set podDisruptionBudget.enabled=true \
  --set podDisruptionBudget.minAvailable=80% \
  -n agent-fleet-large

# Monitor rollout (will take 10-15 minutes)
watch kubectl get pods -n agent-fleet-large
```

**Expected Results:**
- All 100 pods running within 10-15 minutes
- Total CPU usage: ~20 cores
- Total memory usage: ~38 GB
- Persistent volumes: 100 × 1Gi = 100 GB total

## Load Testing Scenarios

### Scenario 1: Discovery Load Test

Test Modbus discovery performance across all agents.

```bash
# Get all agent pod names
PODS=$(kubectl get pods -n agent-fleet-test -l app.kubernetes.io/name=agent-fleet -o name)

# Trigger discovery on all agents simultaneously
for pod in $PODS; do
  kubectl exec $pod -c agent -n agent-fleet-test -- \
    curl -s -X POST localhost:48484/v2/discovery/trigger &
done
wait

# Check discovery results
for pod in $PODS; do
  echo "Discovery results for $pod:"
  kubectl exec $pod -c agent -n agent-fleet-test -- \
    curl -s localhost:48484/v2/modbus/devices | jq length
done
```

**Metrics to Track:**
- Discovery completion time
- Number of devices discovered per agent
- CPU/memory spike during discovery
- API sync latency

### Scenario 2: Polling Load Test

Test continuous polling performance.

```bash
# Check polling status across fleet
kubectl exec -n agent-fleet-test agent-fleet-test-0 -c agent -- \
  curl -s localhost:48484/v2/modbus/status | jq

# Monitor resource usage during polling
watch kubectl top pods -n agent-fleet-test

# Check metrics reported to cloud
curl -s https://api.iotistic.com/metrics/fleet/test-small | jq
```

**Metrics to Track:**
- Polling cycle time (default 10s)
- Data points read per second (per agent)
- Total MQTT messages per second (fleet-wide)
- API resource usage

### Scenario 3: Connection Resilience Test

Test agent behavior during network disruptions.

```bash
# Simulate network partition (block egress to API)
kubectl exec -n agent-fleet-test agent-fleet-test-0 -c agent -- \
  iptables -A OUTPUT -d <API_IP> -j DROP

# Wait 2 minutes, check agent behavior
sleep 120
kubectl logs agent-fleet-test-0 -c agent -n agent-fleet-test --tail=50

# Restore connectivity
kubectl exec -n agent-fleet-test agent-fleet-test-0 -c agent -- \
  iptables -F OUTPUT

# Verify agent recovers
kubectl logs agent-fleet-test-0 -c agent -n agent-fleet-test --tail=50 | grep -i "cloud sync"
```

**Expected Behavior:**
- Agent continues local operation
- Logs show connection degraded/offline
- Local SQLite maintains state
- Agent reconnects and syncs when connectivity restored

### Scenario 4: Scale-Up/Scale-Down Test

Test fleet scaling behavior.

```bash
# Start with 10 agents
helm install agent-fleet-scale ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=10 \
  --set provisioning.existingSecret=agent-provisioning-keys \
  -n agent-fleet-test

# Wait for ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=agent-fleet \
  -n agent-fleet-test --timeout=300s

# Scale up to 50
kubectl scale statefulset agent-fleet-scale --replicas=50 -n agent-fleet-test

# Monitor scale-up
watch kubectl get pods -n agent-fleet-test

# Scale down to 25
kubectl scale statefulset agent-fleet-scale --replicas=25 -n agent-fleet-test

# Verify PVCs retained for scale-down
kubectl get pvc -n agent-fleet-test
```

**Metrics to Track:**
- Scale-up time (40 new pods)
- Provisioning success rate
- PVC retention after scale-down
- Resource cleanup

### Scenario 5: Chaos Testing

Test fault tolerance with random pod kills.

```bash
# Install chaos mesh (optional)
curl -sSL https://mirrors.chaos-mesh.org/v2.6.0/install.sh | bash

# Or use manual pod kills
for i in {1..10}; do
  # Kill random pod
  POD=$(kubectl get pods -n agent-fleet-test -l app.kubernetes.io/name=agent-fleet \
    -o name | shuf -n 1)
  kubectl delete $POD -n agent-fleet-test --force --grace-period=0
  
  # Wait 30 seconds
  sleep 30
done

# Verify all agents recover
kubectl get pods -n agent-fleet-test
```

**Expected Results:**
- Pods restart automatically
- PVCs reattach to new pods
- Agent state restored from SQLite
- No data loss

## Performance Benchmarks

### Expected Performance (per agent)

| Metric | Value |
|--------|-------|
| Memory (idle) | ~100 MB |
| Memory (polling) | ~150-200 MB |
| CPU (idle) | ~20m (2% core) |
| CPU (discovery) | ~100-150m (10-15% core) |
| Disk I/O | <1 MB/s |
| Network (API sync) | ~10 KB/s |
| MQTT messages/sec | ~1-5 (depends on poll interval) |

### Fleet-Wide Benchmarks (100 agents)

| Metric | Value |
|--------|-------|
| Total memory | ~15-20 GB |
| Total CPU | ~2-3 cores (idle), ~10-15 cores (discovery) |
| Total disk usage | ~100 GB (persistent) |
| Total network | ~1 MB/s to API |
| MQTT messages/sec | ~100-500 |
| Modbus reads/sec | ~500-1000 |

## Monitoring Setup

### Prometheus Queries

```promql
# Agent count
count(up{job="agent-fleet"})

# Average memory usage
avg(container_memory_working_set_bytes{pod=~"agent-fleet-.*", container="agent"}) by (pod)

# Discovery success rate
rate(agent_discovery_success_total[5m]) / rate(agent_discovery_total[5m])

# API sync latency
histogram_quantile(0.95, rate(agent_api_sync_duration_seconds_bucket[5m]))

# Modbus errors
rate(agent_modbus_errors_total[5m])
```

### Grafana Dashboard

Import dashboard JSON:

```json
{
  "dashboard": {
    "title": "Agent Fleet Monitoring",
    "panels": [
      {
        "title": "Fleet Size",
        "targets": [
          {
            "expr": "count(up{job=\"agent-fleet\"})"
          }
        ]
      },
      {
        "title": "Memory Usage",
        "targets": [
          {
            "expr": "sum(container_memory_working_set_bytes{pod=~\"agent-fleet-.*\", container=\"agent\"})"
          }
        ]
      },
      {
        "title": "Modbus Read Rate",
        "targets": [
          {
            "expr": "sum(rate(agent_modbus_reads_total[5m]))"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting

### Pods Stuck in Pending

```bash
# Check events
kubectl get events -n agent-fleet-test --sort-by='.lastTimestamp' | tail -20

# Check PVC status
kubectl get pvc -n agent-fleet-test

# Common causes:
# - Insufficient storage (no PV available)
# - Node resource constraints
# - StorageClass misconfiguration
```

### Provisioning Failures

```bash
# Check secret
kubectl get secret agent-provisioning-keys -n agent-fleet-test -o yaml

# Verify key format
kubectl get secret agent-provisioning-keys -n agent-fleet-test \
  -o jsonpath='{.data.PROVISIONING_KEY_0}' | base64 -d

# Check agent logs
kubectl logs agent-fleet-test-0 -c agent -n agent-fleet-test | grep -i provision
```

### High Memory Usage

```bash
# Check memory metrics
kubectl top pods -n agent-fleet-test

# Adjust limits
helm upgrade agent-fleet-test ./k8s/charts/agent-fleet \
  --set agent.resources.limits.memory=1Gi \
  -n agent-fleet-test --reuse-values
```

### Modbus Connectivity Issues

```bash
# Test simulator directly
kubectl exec agent-fleet-test-0 -c agent -n agent-fleet-test -- \
  curl -v telnet://localhost:502

# Check simulator logs
kubectl logs agent-fleet-test-0 -c modbus-simulator -n agent-fleet-test

# Verify simulator is running
kubectl exec agent-fleet-test-0 -c modbus-simulator -n agent-fleet-test -- \
  ps aux | grep python
```

## Cleanup

```bash
# Delete test deployments
helm uninstall agent-fleet-test -n agent-fleet-test
helm uninstall agent-fleet-medium -n agent-fleet-medium
helm uninstall agent-fleet-large -n agent-fleet-large

# Delete PVCs (optional, data will be lost)
kubectl delete pvc -l app.kubernetes.io/name=agent-fleet -n agent-fleet-test
kubectl delete pvc -l app.kubernetes.io/name=agent-fleet -n agent-fleet-medium
kubectl delete pvc -l app.kubernetes.io/name=agent-fleet -n agent-fleet-large

# Delete namespaces
kubectl delete namespace agent-fleet-test
kubectl delete namespace agent-fleet-medium
kubectl delete namespace agent-fleet-large
```

## Next Steps

1. **Production Deployment**: Use dedicated namespace and pre-generated keys
2. **Monitoring Setup**: Deploy Prometheus + Grafana stack
3. **Alerting**: Configure alerts for fleet health
4. **Automation**: Set up GitOps (ArgoCD/Flux) for fleet management
5. **Cost Optimization**: Use spot instances for non-critical environments

## Support

For issues:
- GitHub: https://github.com/iotistica/iotistic/issues
- Docs: https://docs.iotistic.com/agent-fleet
- Slack: https://iotistica.slack.com/channels/agent-fleet
