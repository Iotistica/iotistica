# Virtual Agent Resource Monitoring
# Prometheus queries and Grafana dashboard configuration

## Prometheus Queries

### Pod-Level Resource Usage

```promql
# CPU usage per virtual agent pod (rate over 5 minutes)
sum(rate(container_cpu_usage_seconds_total{
  namespace="virtual-agents",
  pod=~"va-.*",
  container!=""
}[5m])) by (pod)

# Memory usage per virtual agent pod (working set)
sum(container_memory_working_set_bytes{
  namespace="virtual-agents",
  pod=~"va-.*",
  container!=""
}) by (pod) / 1024 / 1024  # Convert to MiB

# Pod memory usage as percentage of limit
sum(container_memory_working_set_bytes{
  namespace="virtual-agents",
  pod=~"va-.*",
  container="agent"
}) by (pod) /
sum(container_spec_memory_limit_bytes{
  namespace="virtual-agents",
  container="agent"
}) by (pod) * 100
```

### Container-Level Resource Usage

```promql
# CPU usage per container (agent vs sidecars)
sum(rate(container_cpu_usage_seconds_total{
  namespace="virtual-agents",
  pod=~"va-.*",
  container!=""
}[5m])) by (pod, container)

# Memory usage per container
sum(container_memory_working_set_bytes{
  namespace="virtual-agents",
  pod=~"va-.*",
  container!=""
}) by (pod, container) / 1024 / 1024

# Sidecar count per pod
count(container_cpu_usage_seconds_total{
  namespace="virtual-agents",
  pod=~"va-.*",
  container=~"opcua-sim-.*"
}) by (pod)
```

### Namespace-Level Aggregation

```promql
# Total CPU requests in namespace
sum(kube_pod_container_resource_requests{
  namespace="virtual-agents",
  resource="cpu"
})

# Total memory requests in namespace (GiB)
sum(kube_pod_container_resource_requests{
  namespace="virtual-agents",
  resource="memory"
}) / 1024 / 1024 / 1024

# Total CPU limits in namespace
sum(kube_pod_container_resource_limits{
  namespace="virtual-agents",
  resource="cpu"
})

# Total memory limits in namespace (GiB)
sum(kube_pod_container_resource_limits{
  namespace="virtual-agents",
  resource="memory"
}) / 1024 / 1024 / 1024
```

### Resource Quota Utilization

```promql
# CPU quota usage percentage
(sum(kube_pod_container_resource_requests{
  namespace="virtual-agents",
  resource="cpu"
}) /
scalar(kube_resourcequota{
  namespace="virtual-agents",
  resource="requests.cpu",
  type="hard"
})) * 100

# Memory quota usage percentage
(sum(kube_pod_container_resource_requests{
  namespace="virtual-agents",
  resource="memory"
}) /
scalar(kube_resourcequota{
  namespace="virtual-agents",
  resource="requests.memory",
  type="hard"
})) * 100

# Pod count quota usage
(count(kube_pod_info{namespace="virtual-agents"}) /
scalar(kube_resourcequota{
  namespace="virtual-agents",
  resource="pods",
  type="hard"
})) * 100
```

### Pod Health & Evictions

```promql
# Pod restart count (high restarts = OOMKilled or crashes)
sum(kube_pod_container_status_restarts_total{
  namespace="virtual-agents"
}) by (pod, container)

# Evicted pods
kube_pod_status_reason{
  namespace="virtual-agents",
  reason="Evicted"
}

# Pods in pending state (insufficient resources)
count(kube_pod_status_phase{
  namespace="virtual-agents",
  phase="Pending"
})

# OOMKilled containers
sum(kube_pod_container_status_terminated_reason{
  namespace="virtual-agents",
  reason="OOMKilled"
}) by (pod, container)
```

### Node-Level Pressure

```promql
# Nodes with memory pressure
kube_node_status_condition{
  condition="MemoryPressure",
  status="true"
}

# Nodes with disk pressure
kube_node_status_condition{
  condition="DiskPressure",
  status="true"
}

# Node allocatable CPU
sum(kube_node_status_allocatable{resource="cpu"}) by (node)

# Node allocatable memory (GiB)
sum(kube_node_status_allocatable{resource="memory"}) by (node) / 1024 / 1024 / 1024
```

## Alerting Rules

Create `virtual-agent-alerts.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: virtual-agent-alerts
  namespace: monitoring
data:
  virtual-agents.rules: |
    groups:
    - name: virtual-agents
      interval: 30s
      rules:
      
      # High memory usage alert
      - alert: VirtualAgentHighMemory
        expr: |
          (container_memory_working_set_bytes{namespace="virtual-agents",container="agent"} /
           container_spec_memory_limit_bytes{namespace="virtual-agents",container="agent"}) > 0.85
        for: 5m
        labels:
          severity: warning
          component: virtual-agent
        annotations:
          summary: "Virtual agent {{ $labels.pod }} high memory usage"
          description: "Agent container using {{ $value | humanizePercentage }} of memory limit"
          
      # High CPU usage alert
      - alert: VirtualAgentHighCPU
        expr: |
          (rate(container_cpu_usage_seconds_total{namespace="virtual-agents",container="agent"}[5m]) /
           container_spec_cpu_limit{namespace="virtual-agents",container="agent"}) > 0.85
        for: 5m
        labels:
          severity: warning
          component: virtual-agent
        annotations:
          summary: "Virtual agent {{ $labels.pod }} high CPU usage"
          description: "Agent container using {{ $value | humanizePercentage }} of CPU limit"
          
      # Namespace quota approaching limit
      - alert: VirtualAgentQuotaNearLimit
        expr: |
          (sum(kube_pod_container_resource_requests{namespace="virtual-agents"}) by (resource) /
           kube_resourcequota{namespace="virtual-agents",type="hard"}) > 0.9
        for: 10m
        labels:
          severity: warning
          component: virtual-agent
        annotations:
          summary: "Virtual agents namespace quota at {{ $value | humanizePercentage }}"
          description: "Resource {{ $labels.resource }} quota nearly exhausted"
          
      # Pod eviction alert
      - alert: VirtualAgentEvicted
        expr: |
          kube_pod_status_reason{namespace="virtual-agents",reason="Evicted"} > 0
        labels:
          severity: critical
          component: virtual-agent
        annotations:
          summary: "Virtual agent pod evicted"
          description: "Pod {{ $labels.pod }} evicted due to resource pressure"
          
      # OOMKilled alert
      - alert: VirtualAgentOOMKilled
        expr: |
          sum(increase(kube_pod_container_status_terminated_reason{
            namespace="virtual-agents",
            reason="OOMKilled"
          }[5m])) by (pod, container) > 0
        labels:
          severity: critical
          component: virtual-agent
        annotations:
          summary: "Virtual agent container OOM killed"
          description: "Container {{ $labels.container }} in pod {{ $labels.pod }} killed due to out-of-memory"
          
      # Pending pods (insufficient resources)
      - alert: VirtualAgentPodPending
        expr: |
          count(kube_pod_status_phase{namespace="virtual-agents",phase="Pending"}) > 0
        for: 10m
        labels:
          severity: warning
          component: virtual-agent
        annotations:
          summary: "{{ $value }} virtual agent pods pending"
          description: "Pods stuck in Pending state - likely insufficient cluster resources"
          
      # Too many sidecars per agent
      - alert: VirtualAgentTooManySidecars
        expr: |
          count(container_cpu_usage_seconds_total{
            namespace="virtual-agents",
            pod=~"va-.*",
            container=~"opcua-sim-.*"
          }) by (pod) > 30
        labels:
          severity: warning
          component: virtual-agent
        annotations:
          summary: "Virtual agent {{ $labels.pod }} has excessive sidecars"
          description: "Agent has {{ $value }} sidecar containers - consider splitting devices"
```

## Grafana Dashboard JSON

Save as `grafana/virtual-agent-dashboard.json`:

```json
{
  "dashboard": {
    "title": "Virtual Agents - Resource Monitoring",
    "panels": [
      {
        "title": "Total CPU Usage by Agent",
        "targets": [{
          "expr": "sum(rate(container_cpu_usage_seconds_total{namespace=\"virtual-agents\",pod=~\"va-.*\",container!=\"\"}[5m])) by (pod)",
          "legendFormat": "{{ pod }}"
        }],
        "type": "graph"
      },
      {
        "title": "Total Memory Usage by Agent",
        "targets": [{
          "expr": "sum(container_memory_working_set_bytes{namespace=\"virtual-agents\",pod=~\"va-.*\",container!=\"\"}) by (pod) / 1024 / 1024",
          "legendFormat": "{{ pod }}"
        }],
        "type": "graph",
        "yaxes": [{"format": "mbytes"}]
      },
      {
        "title": "Sidecar Count Distribution",
        "targets": [{
          "expr": "count(container_cpu_usage_seconds_total{namespace=\"virtual-agents\",pod=~\"va-.*\",container=~\"opcua-sim-.*\"}) by (pod)",
          "legendFormat": "{{ pod }}"
        }],
        "type": "graph"
      },
      {
        "title": "Namespace Quota Utilization",
        "targets": [
          {
            "expr": "(sum(kube_pod_container_resource_requests{namespace=\"virtual-agents\",resource=\"cpu\"}) / scalar(kube_resourcequota{namespace=\"virtual-agents\",resource=\"requests.cpu\",type=\"hard\"})) * 100",
            "legendFormat": "CPU Requests"
          },
          {
            "expr": "(sum(kube_pod_container_resource_requests{namespace=\"virtual-agents\",resource=\"memory\"}) / scalar(kube_resourcequota{namespace=\"virtual-agents\",resource=\"requests.memory\",type=\"hard\"})) * 100",
            "legendFormat": "Memory Requests"
          }
        ],
        "type": "gauge",
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "max": 100,
            "thresholds": {
              "steps": [
                {"value": 0, "color": "green"},
                {"value": 80, "color": "yellow"},
                {"value": 90, "color": "red"}
              ]
            }
          }
        }
      }
    ]
  }
}
```

## kubectl Quick Checks

```bash
# Check resource quota status
kubectl describe resourcequota -n virtual-agents

# Check pod resources
kubectl top pods -n virtual-agents

# Check resource requests vs limits
kubectl get pods -n virtual-agents -o custom-columns=\
NAME:.metadata.name,\
CPU_REQ:.spec.containers[*].resources.requests.cpu,\
MEM_REQ:.spec.containers[*].resources.requests.memory,\
CPU_LIM:.spec.containers[*].resources.limits.cpu,\
MEM_LIM:.spec.containers[*].resources.limits.memory

# Check VPA recommendations
kubectl describe vpa virtual-agent-vpa -n virtual-agents

# Check pod events (evictions, OOMKilled)
kubectl get events -n virtual-agents --sort-by='.lastTimestamp' | grep -E 'Evicted|OOMKilled|FailedScheduling'

# Check sidecar count per pod
kubectl get pods -n virtual-agents -o json | \
jq '.items[] | {name: .metadata.name, containers: (.spec.containers | length)}'

# Check node resources
kubectl top nodes
kubectl describe nodes | grep -A 5 "Allocated resources"
```

## Log-Based Monitoring

```bash
# Agent out-of-memory logs
kubectl logs -n virtual-agents <pod-name> agent | grep -i "out of memory\|oom\|killed"

# Resource warnings in agent logs
kubectl logs -n virtual-agents <pod-name> agent | grep -i "memory\|cpu\|resource"

# Sidecar startup failures
kubectl logs -n virtual-agents <pod-name> opcua-sim-4840 | grep -i "error\|failed"
```

## Performance Baselines

Expected resource usage (per agent with 5 sidecars):

| State | Agent CPU | Agent Memory | Sidecar CPU (each) | Sidecar Memory (each) | Total |
|-------|-----------|--------------|--------------------|-----------------------|-------|
| **Idle** | 50-100m | 300-400Mi | 10-20m | 50-80Mi | 150m / 700Mi |
| **Normal** | 100-300m | 400-600Mi | 30-50m | 80-120Mi | 400m / 1.2Gi |
| **Peak** | 300-600m | 600-900Mi | 100-150m | 120-180Mi | 1.1Gi / 2Gi |

**Alert if**:
- CPU usage >85% of limit for >5 minutes
- Memory usage >85% of limit for >5 minutes
- Frequent restarts (>3 in 1 hour)
- Quota utilization >90%
