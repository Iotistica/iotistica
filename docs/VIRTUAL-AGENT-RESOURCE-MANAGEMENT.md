# Virtual Agent Resource Management Guide

## Problem Statement

Virtual agents deploy with a variable number of sidecar containers (OPC UA simulators). As endpoint count grows, pod resources must scale proportionally to prevent:
- Pod eviction (OOMKilled)
- Cluster resource exhaustion
- Performance degradation
- Scheduler failures (insufficient resources)

## Current Architecture

### Per-Pod Resource Allocation

**Agent Container** (fixed):
```yaml
requests:
  cpu: 200m      # Guaranteed CPU
  memory: 512Mi  # Guaranteed RAM
limits:
  cpu: 1000m     # Maximum CPU burst
  memory: 2Gi    # Maximum RAM
```

**Each OPC UA Sidecar** (per endpoint):
```yaml
requests:
  cpu: 100m
  memory: 128Mi
limits:
  cpu: 500m
  memory: 512Mi
```

### Total Pod Resources Formula

```
Total Requests = Agent Requests + (Sidecar Count × Sidecar Requests)
Total Limits   = Agent Limits   + (Sidecar Count × Sidecar Limits)

Example (4 sidecars):
  Requests: 200m + (4 × 100m) = 600m CPU, 1024Mi RAM
  Limits:   1000m + (4 × 500m) = 3000m CPU, 4Gi RAM
```

## Recommended Solutions

### 1. Resource Tier System

Implement automatic resource tier selection based on endpoint count:

| Tier | Endpoints | Agent CPU | Agent Memory | Sidecar CPU | Sidecar Memory | Total (5 endpoints) |
|------|-----------|-----------|--------------|-------------|----------------|---------------------|
| **Small** | 1-5 | 200m / 1000m | 512Mi / 2Gi | 100m / 500m | 128Mi / 512Mi | 700m / 3.5Gi |
| **Medium** | 6-15 | 500m / 2000m | 1Gi / 4Gi | 100m / 400m | 128Mi / 384Mi | 1500m / 6.75Gi (15 endpoints) |
| **Large** | 16-30 | 1000m / 4000m | 2Gi / 8Gi | 50m / 200m | 96Mi / 256Mi | 2500m / 11.68Gi (30 endpoints) |
| **XLarge** | 31+ | 2000m / 8000m | 4Gi / 16Gi | 50m / 150m | 64Mi / 192Mi | 3550m / 10Gi (50 endpoints) |

**Rationale**:
- **Small**: Development/testing with few devices
- **Medium**: Production with moderate device count
- **Large**: High-density deployments (reduce per-sidecar overhead)
- **XLarge**: Enterprise scale (shared agent resources)

### 2. Namespace-Level Resource Quotas

Prevent runaway resource consumption with namespace quotas:

**Production Namespace** (`virtual-agents`):
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: virtual-agents-quota
  namespace: virtual-agents
spec:
  hard:
    # Limit total compute resources
    requests.cpu: "20"           # 20 CPU cores total
    requests.memory: 40Gi        # 40Gi RAM total
    limits.cpu: "100"            # 100 CPU cores burst
    limits.memory: 200Gi         # 200Gi RAM burst
    
    # Limit object count
    pods: "50"                   # Max 50 virtual agents
    persistentvolumeclaims: "50" # Max 50 PVCs
    
    # Limit storage
    requests.storage: 100Gi      # Total storage across all PVCs
```

**Development Namespace** (`virtual-agents-dev`):
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: virtual-agents-dev-quota
  namespace: virtual-agents-dev
spec:
  hard:
    requests.cpu: "5"
    requests.memory: 10Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "10"
    persistentvolumeclaims: "10"
    requests.storage: 20Gi
```

### 3. LimitRange for Default Resources

Prevent misconfiguration with default/max container limits:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: virtual-agent-limits
  namespace: virtual-agents
spec:
  limits:
  - max:
      cpu: "8"         # No container > 8 CPUs
      memory: 16Gi     # No container > 16Gi RAM
    min:
      cpu: 50m         # Minimum 50m CPU per container
      memory: 64Mi     # Minimum 64Mi RAM per container
    default:
      cpu: 500m        # Default if not specified
      memory: 512Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    type: Container
  - max:
      storage: 10Gi    # Max PVC size
    min:
      storage: 1Gi     # Min PVC size
    type: PersistentVolumeClaim
```

### 4. Quality of Service (QoS) Classes

**Current**: Burstable (requests < limits)
- Allows CPU/memory burst during high load
- Risk of eviction under cluster pressure

**Recommended Strategy**:

**Agent Container**: Guaranteed QoS
```yaml
resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 500m      # Same as requests
    memory: 1Gi    # Same as requests
```

**Sidecar Containers**: Burstable QoS
```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m      # Allow burst
    memory: 512Mi  # Allow burst
```

**Why?**
- Agent gets priority eviction protection (Guaranteed class)
- Sidecars can burst but are evicted first under pressure
- Balances stability with efficiency

### 5. Vertical Pod Autoscaler (VPA)

Let Kubernetes learn optimal resource allocation:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: virtual-agent-vpa
  namespace: virtual-agents
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: va-*  # Match all virtual agent deployments
  updatePolicy:
    updateMode: "Auto"  # Auto-adjust resources
  resourcePolicy:
    containerPolicies:
    - containerName: agent
      minAllowed:
        cpu: 200m
        memory: 512Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
    - containerName: opcua-sim-*
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: 500m
        memory: 512Mi
  ```

**Installation**:
```bash
kubectl apply -f https://github.com/kubernetes/autoscaler/releases/latest/download/vertical-pod-autoscaler.yaml
```

### 6. Monitoring & Alerting

**Prometheus Queries**:

```promql
# Pod CPU usage by virtual agent
sum(rate(container_cpu_usage_seconds_total{namespace="virtual-agents",pod=~"va-.*"}[5m])) by (pod)

# Pod memory usage by virtual agent
sum(container_memory_working_set_bytes{namespace="virtual-agents",pod=~"va-.*"}) by (pod) / 1024 / 1024

# Namespace-level resource consumption
sum(kube_pod_container_resource_requests{namespace="virtual-agents",resource="cpu"})
sum(kube_pod_container_resource_requests{namespace="virtual-agents",resource="memory"}) / 1024 / 1024 / 1024

# Sidecar count per pod (estimate from containers)
count(container_cpu_usage_seconds_total{namespace="virtual-agents",container=~"opcua-sim-.*"}) by (pod)
```

**Grafana Dashboard Panels**:
1. Total CPU/Memory usage per virtual agent
2. Sidecar count distribution histogram
3. Resource quota utilization (used vs. limit)
4. Pod eviction rate
5. Scheduler failures (insufficient resources)

**Alerting Rules**:

```yaml
groups:
- name: virtual-agents
  rules:
  - alert: VirtualAgentHighMemory
    expr: container_memory_working_set_bytes{namespace="virtual-agents",container="agent"} / container_spec_memory_limit_bytes > 0.8
    for: 5m
    annotations:
      summary: "Virtual agent {{ $labels.pod }} using >80% memory"
      
  - alert: NamespaceQuotaExceeded
    expr: kube_resourcequota{namespace="virtual-agents",type="used"} / kube_resourcequota{type="hard"} > 0.9
    annotations:
      summary: "Namespace quota at {{ $value | humanizePercentage }}"
      
  - alert: PodEvicted
    expr: kube_pod_status_reason{namespace="virtual-agents",reason="Evicted"} > 0
    annotations:
      summary: "Pod {{ $labels.pod }} evicted due to resource pressure"
```

## Implementation Plan

### Phase 1: Immediate (Week 1)

1. **Add resource tier calculation to deployer**:
   ```typescript
   private calculateResourceTier(endpointCount: number) {
     if (endpointCount <= 5) return 'small';
     if (endpointCount <= 15) return 'medium';
     if (endpointCount <= 30) return 'large';
     return 'xlarge';
   }
   ```

2. **Deploy namespace quotas**:
   ```bash
   kubectl apply -f k8s/virtual-agent-quota.yaml
   kubectl apply -f k8s/virtual-agent-limitrange.yaml
   ```

3. **Add sidecar count logging**:
   Log total pod resources when deploying to track growth.

### Phase 2: Short-term (Week 2-3)

1. **Implement Guaranteed QoS for agent container**
2. **Add pod resource annotations** for easier tracking:
   ```yaml
   metadata:
     annotations:
       iotistic.com/sidecar-count: "4"
       iotistic.com/resource-tier: "small"
       iotistic.com/total-cpu-requests: "600m"
   ```

3. **Set up basic monitoring** (Prometheus + Grafana)

### Phase 3: Medium-term (Month 2)

1. **Deploy VPA** for automatic resource tuning
2. **Implement resource alerts** in Prometheus
3. **Create Grafana dashboards** for virtual agents
4. **Add resource health checks** to deployment API

### Phase 4: Long-term (Month 3+)

1. **Multi-cluster support** with resource distribution
2. **Predictive scaling** based on historical usage
3. **Cost optimization** (spot instances for dev agents)
4. **Resource reservation** system for critical agents

## Environment Variables (Current)

Add these to API service (`.env`):

```bash
# Agent Container Resources
VIRTUAL_AGENT_CPU_REQUEST=200m
VIRTUAL_AGENT_MEMORY_REQUEST=512Mi
VIRTUAL_AGENT_CPU_LIMIT=1000m
VIRTUAL_AGENT_MEMORY_LIMIT=2Gi

# Sidecar Container Resources
OPCUA_SIMULATOR_CPU_REQUEST=100m
OPCUA_SIMULATOR_MEMORY_REQUEST=128Mi
OPCUA_SIMULATOR_CPU_LIMIT=500m
OPCUA_SIMULATOR_MEMORY_LIMIT=512Mi

# Storage
VIRTUAL_AGENT_STORAGE_SIZE=1Gi
VIRTUAL_AGENT_STORAGE_CLASS=fast-ssd  # Optional

# Namespace
VIRTUAL_AGENT_NAMESPACE=virtual-agents
```

## Recommended Environment Variables (Enhanced)

```bash
# Resource Tier Mode
VIRTUAL_AGENT_RESOURCE_MODE=auto  # auto | small | medium | large | xlarge

# Auto-scaling thresholds
VIRTUAL_AGENT_SMALL_MAX_ENDPOINTS=5
VIRTUAL_AGENT_MEDIUM_MAX_ENDPOINTS=15
VIRTUAL_AGENT_LARGE_MAX_ENDPOINTS=30

# Per-tier configurations (Small tier example)
VIRTUAL_AGENT_SMALL_CPU_REQUEST=200m
VIRTUAL_AGENT_SMALL_MEMORY_REQUEST=512Mi
VIRTUAL_AGENT_SMALL_CPU_LIMIT=1000m
VIRTUAL_AGENT_SMALL_MEMORY_LIMIT=2Gi
OPCUA_SMALL_CPU_REQUEST=100m
OPCUA_SMALL_MEMORY_REQUEST=128Mi
...
```

## Testing Recommendations

### 1. Load Testing

Create test agents with increasing sidecar counts:

```bash
# Test Small tier (5 endpoints)
curl -X POST http://api:4002/api/devices \
  -d '{"deviceType": "virtual", "endpoints": [/* 5 OPC UA endpoints */]}'

# Test Medium tier (15 endpoints)
curl -X POST http://api:4002/api/devices \
  -d '{"deviceType": "virtual", "endpoints": [/* 15 OPC UA endpoints */]}'

# Monitor resource usage
kubectl top pods -n virtual-agents
kubectl describe resourcequota -n virtual-agents
```

### 2. Stress Testing

Deploy maximum pods to test quota enforcement:

```bash
# Deploy 50 virtual agents (namespace limit)
for i in {1..50}; do
  curl -X POST http://api:4002/api/devices \
    -d "{\"deviceType\": \"virtual\", \"deviceName\": \"stress-test-$i\"}"
done

# Verify quota prevents 51st deployment
curl -X POST http://api:4002/api/devices \
  -d '{"deviceType": "virtual", "deviceName": "should-fail"}'
# Expected: 403 Forbidden (quota exceeded)
```

### 3. Eviction Testing

Force memory pressure to verify QoS classes:

```bash
# Deploy memory-hungry pod in same namespace
kubectl run stress --image=polinux/stress -n virtual-agents -- stress --vm 1 --vm-bytes 10G

# Monitor which pods get evicted first (should be Burstable sidecars)
kubectl get events -n virtual-agents --sort-by='.lastTimestamp' | grep Evicted
```

## Cost Optimization

### Resource Efficiency Metrics

| Configuration | 10 Agents (5 endpoints each) | Cost/Month (AWS EKS) |
|---------------|------------------------------|----------------------|
| **Current** (no tiers) | 7 CPU, 14Gi RAM | ~$250 |
| **With tiers** (auto) | 6 CPU, 10Gi RAM | ~$180 |
| **With VPA** (optimized) | 4.5 CPU, 8Gi RAM | ~$135 |

**Savings**: ~46% with tier system + VPA

### Cluster Sizing Recommendations

**Development** (10 virtual agents):
- 2 nodes × (4 vCPU, 16Gi RAM) = 8 vCPU, 32Gi
- Instance type: AWS t3.xlarge, GCP n2-standard-4
- Cost: ~$150-200/month

**Production** (50 virtual agents):
- 4 nodes × (8 vCPU, 32Gi RAM) = 32 vCPU, 128Gi
- Instance type: AWS c5.2xlarge, GCP c2-standard-8
- Cost: ~$800-1000/month

**Enterprise** (200 virtual agents):
- 10 nodes × (16 vCPU, 64Gi RAM) = 160 vCPU, 640Gi
- Instance type: AWS c5.4xlarge, GCP c2-standard-16
- Cost: ~$3500-4000/month

## Troubleshooting

### Pod Pending (Insufficient Resources)

```bash
# Check scheduler events
kubectl describe pod <pod-name> -n virtual-agents

# Common causes:
# 1. Node lacks CPU/memory
# 2. Namespace quota exceeded
# 3. Resource requests too high

# Solution:
kubectl describe resourcequota -n virtual-agents
kubectl top nodes  # Check node availability
```

### OOMKilled (Out of Memory)

```bash
# Check container memory usage
kubectl top pod <pod-name> -n virtual-agents --containers

# Increase memory limits or switch to higher tier
# Or: Reduce sidecar count per agent
```

### Eviction Loop

```bash
# Check eviction reasons
kubectl get events -n virtual-agents | grep Evicted

# Common causes:
# 1. Node pressure (DiskPressure, MemoryPressure)
# 2. Burstable QoS pods evicted first

# Solution:
# 1. Add nodes to cluster
# 2. Switch agent to Guaranteed QoS
# 3. Reduce resource limits
```

## References

- [Kubernetes Resource Management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Quality of Service Classes](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [LimitRange](https://kubernetes.io/docs/concepts/policy/limit-range/)

---

**Next Steps**: See `docs/VIRTUAL-AGENT-RESOURCE-TIERS.md` for implementation code examples.
