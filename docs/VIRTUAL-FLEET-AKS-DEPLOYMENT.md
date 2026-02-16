# Virtual Fleet Deployment to Azure AKS

## Overview

This guide explains how to deploy virtual fleet devices from Docker Desktop to Azure AKS cluster `dev-iotistica-aks-cluster`.

**Status**: ✅ Tested and working on `dev-iotistica-aks-cluster` with fleet `fleet-1medf11j`
- Virtual agents deploying successfully
- Cluster-internal service communication working
- Virtual device sidecars (OPC UA simulator) operational

## Architecture Comparison

### Current (Docker Desktop)
```
┌─────────────────────────────────────────┐
│ Docker Desktop K8s (Local)              │
├─────────────────────────────────────────┤
│ Namespace: virtual-agents               │
│   - Virtual Agent Pods (fleet devices)  │
│   - Resource Quotas per fleet           │
│                                         │
│ Namespace: fleet-{id}                   │
│   - Fleet-specific virtual agents       │
└─────────────────────────────────────────┘
```

### Target (Azure AKS)
```
┌──────────────────────────────────────────────────────────┐
│ Azure AKS: dev-iotistica-aks-cluster                     │
├──────────────────────────────────────────────────────────┤
│ Namespace: tsdb                                          │
│   - API (3002) - uses ServiceAccount virtual-fleet-mgr   │
│   - Dashboard (80)                                       │
│   - Mosquitto (1883)                                     │
│   - PostgreSQL                                           │
│                                                          │
│ Namespace: fleet-{id}                                    │
│   - Virtual Agent Deployments                            │
│   - Resource Quotas (per fleet)                          │
│   - Virtual Device Sidecars (OPC UA, Modbus, etc.)       │
└──────────────────────────────────────────────────────────┘
```

## Quick Setup (Working Configuration)

### 1. RBAC Setup

Create ServiceAccount and permissions for fleet management:

```bash
# Create ServiceAccount in customer namespace
kubectl create serviceaccount virtual-fleet-manager -n tsdb

# Create ClusterRole
kubectl create clusterrole fleet-namespace-manager \
  --verb=get,list,watch,create,update,patch,delete \
  --resource=namespaces,deployments,pods,secrets,resourcequotas

# Create ClusterRoleBinding
kubectl create clusterrolebinding fleet-manager-binding \
  --clusterrole=fleet-namespace-manager \
  --serviceaccount=tsdb:virtual-fleet-manager

# Patch API deployment to use ServiceAccount
kubectl patch deployment tsdb-release-iotistic-api -n tsdb \
  -p '{"spec":{"template":{"spec":{"serviceAccountName":"virtual-fleet-manager"}}}}'

# Verify permissions
kubectl auth can-i create namespaces --as=system:serviceaccount:tsdb:virtual-fleet-manager
# Should return "yes"
```

### 2. Configure Cluster-Internal Services

Set environment variables for cluster-internal communication:

```bash
# Set API URL (cluster-internal)
kubectl set env deployment/tsdb-release-iotistic-api -n tsdb \
  CLOUD_API_URL=http://tsdb-release-iotistic-api.tsdb.svc.cluster.local:3002

# Set MQTT URL (cluster-internal)
kubectl set env deployment/tsdb-release-iotistic-api -n tsdb \
  MQTT_BROKER_URL=mqtt://tsdb-release-iotistic-mosquitto.tsdb.svc.cluster.local:1883
```

### 3. Resource Management

If cluster is at capacity, scale down unused deployments:

```bash
# Free up resources
kubectl scale deployment client1-release-iotistic-api -n client1 --replicas=0

# Check node capacity
kubectl top nodes
```

## Network Policies (Optional)

For production, configure network policies to restrict traffic:

```yaml
# k8s/network-policies/virtual-agents-egress.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: virtual-agents-egress
  namespace: virtual-agents-tsdb01
spec:
  podSelector:
    matchLabels:
      iotistica.com/component: virtual-agent
  policyTypes:
  - Egress
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Allow access to customer API
  - to:
    - namespaceSelector:
        matchLabels:
          customer: tsdb
    - podSelector:
        matchLabels:
          app: iotistic-api
    ports:
    - protocol: TCP
      port: 3002
  # Allow access to customer MQTT
  - to:
    - namespaceSelector:
        matchLabels:
          customer: tsdb
    - podSelector:
        matchLabels:
          app: iotistic-mosquitto
    ports:
    - protocol: TCP
      port: 1883
  # Allow external HTTPS (for cloud API if needed)
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443
```

Apply:
```bash
kubectl apply -f k8s/network-policies/virtual-agents-egress.yaml
```

### 7. Update Fleet Creation Logic

Modify `api/src/routes/fleets.ts` to create namespace per customer (not per fleet):

```typescript
// When creating a virtual fleet
router.post('/fleets/virtual', jwtAuth, async (req, res) => {
  try {
    const { fleet_name, agent_count, devices_per_agent, customer_id } = req.body;
    
    // Namespace per customer (not per fleet)
    const namespace = `virtual-agents-${customer_id}`;
    
    // Check if namespace exists, create if not
    const deployer = new VirtualAgentDeployer({ customerId: customer_id });
    await deployer.ensureNamespaceExists(namespace);
    
    // Create resource quota for the fleet
    await deployer.createFleetResourceQuota({
      fleet_id: fleetId,
      namespace,
      agent_count,
      devices_per_agent
    });
    
    // ... rest of fleet creation logic
  }
});
```

### 8. Testing Strategy

#### Local Testing (Docker Desktop)
```bash
# Switch to local context
kubectl config use-context docker-desktop

# Start API locally
cd api && npm run dev

# Test fleet creation
curl -X POST http://localhost:3002/api/fleets/virtual \
  -H "Content-Type: application/json" \
  -d '{
    "fleet_name": "Test Fleet",
    "agent_count": 2,
    "devices_per_agent": 3,
    "customer_id": "local-test"
  }'

# Verify deployment
kubectl get pods -n virtual-agents-local-test
```

#### AKS Testing
```bash
# Switch to AKS context
kubectl config use-context dev-iotistica-aks-cluster

# Deploy API with updated config
helm upgrade client1-release ./charts \
  --namespace io-cluster-tsdb01 \
  --set api.env.VIRTUAL_AGENT_NAMESPACE=virtual-agents-tsdb01 \
  --set api.env.K8S_CONTEXT=in-cluster

# Port-forward to API
kubectl port-forward -n io-cluster-tsdb01 svc/client1-release-iotistic-api 3002:3002

# Test fleet creation
curl -X POST http://localhost:3002/api/fleets/virtual \
  -H "Content-Type: application/json" \
  -d '{
    "fleet_name": "AKS Test Fleet",
    "agent_count": 2,
    "devices_per_agent": 3,
    "customer_id": "tsdb"
  }'

# Verify deployment
kubectl get pods -n virtual-agents-tsdb01
kubectl get resourcequotas -n virtual-agents-tsdb01
```

## Resource Quota Management

Virtual fleet pods consume resources based on the fleet quota formula:

**Per Agent**:
- Memory Request: `256Mi`
- Memory Limit: `512Mi`
- CPU Request: `0.25` (250 millicores)
- CPU Limit: `0.5` (500 millicores)

**Per Virtual Device (Sidecar)**:
- Memory Request: `128Mi`
- Memory Limit: `256Mi`
- CPU Request: `0.1` (100 millicores)
- CPU Limit: `0.2` (200 millicores)

**Example**: Fleet with 10 agents, 5 devices each
- Total Memory Request: `10 × 256Mi + 50 × 128Mi = 8.96 GiB`
- Total CPU Request: `10 × 0.25 + 50 × 0.1 = 7.5 cores`

## Monitoring and Billing

### Prometheus Metrics

Virtual agents expose metrics at `:9090/metrics`:
- `agent_cpu_usage_percent`
- `agent_memory_usage_mb`
- `agent_uptime_seconds`
- `virtual_device_count`

### Cost Calculation

Use the existing `calculate_fleet_cost()` database function:

```sql
SELECT * FROM calculate_fleet_cost(10, 5);  -- 10 agents, 5 devices each
```

This returns:
- `hourly_cost_usd`
- `monthly_cost_usd`
- `yearly_cost_usd`

## Security Considerations

1. **ServiceAccount Isolation**: Each customer's API uses a dedicated ServiceAccount with permissions only to their virtual-agents namespace

2. **Network Policies**: Virtual agents can only communicate with:
   - Their customer's API/Mosquitto
   - kube-dns for DNS resolution
   - External endpoints (HTTPS only)

3. **Resource Quotas**: Prevent resource exhaustion with strict quotas per fleet

4. **Secrets Management**: Provisioning keys stored as K8s Secrets, not environment variables

## Troubleshooting

### Common Issues

**Issue**: `403 Forbidden` when creating virtual agents  
**Fix**: Verify ServiceAccount has correct RBAC permissions:
```bash
kubectl auth can-i create namespaces --as=system:serviceaccount:tsdb:virtual-fleet-manager
```

**Issue**: Virtual agents trying to reach external API (https://api1.iotistica.com:443)  
**Fix**: Set cluster-internal URLs on API deployment:
```bash
kubectl set env deployment/tsdb-release-iotistic-api -n tsdb \
  CLOUD_API_URL=http://tsdb-release-iotistic-api.tsdb.svc.cluster.local:3002 \
  MQTT_BROKER_URL=mqtt://tsdb-release-iotistic-mosquitto.tsdb.svc.cluster.local:1883
```

**Issue**: Pods stuck in `Pending` state (insufficient CPU)  
**Fix**: Check node capacity and scale down unused deployments:
```bash
kubectl top nodes
kubectl scale deployment client1-release-iotistic-api -n client1 --replicas=0
```

**Issue**: RBAC applied to wrong namespace  
**Fix**: Recreate ServiceAccount in correct namespace:
```bash
kubectl delete serviceaccount virtual-fleet-manager -n <wrong-namespace>
kubectl create serviceaccount virtual-fleet-manager -n tsdb
kubectl patch clusterrolebinding fleet-manager-binding \
  --type='json' -p='[{"op":"replace","path":"/subjects/0/namespace","value":"tsdb"}]'
```

## Migration Path

### Phase 1: Dual Mode (Current)
- Keep Docker Desktop deployment working
- Add AKS support as opt-in feature
- Test with single customer (TSDB)

### Phase 2: Gradual Migration
- Move development workloads to AKS
- Keep production on Docker Desktop temporarily
- Validate billing accuracy

### Phase 3: Full AKS
- Deprecate Docker Desktop deployment
- All customers on AKS
- Remove local K8s dependencies

## Verification Commands

```bash
# Check fleet namespace created
kubectl get namespace fleet-1medf11j

# Verify virtual agent pods running
kubectl get pods -n fleet-1medf11j

# Check agent logs
kubectl logs -n fleet-1medf11j <pod-name> -c agent --tail=50

# View virtual device sidecar
kubectl get pod <pod-name> -n fleet-1medf11j -o jsonpath='{.spec.containers[*].name}'

# Monitor resource usage
kubectl top pods -n fleet-1medf11j
```

## Next Steps

1. ✅ Switch kubectl context to AKS cluster
2. ✅ Configure RBAC for API service (ServiceAccount + ClusterRole)
3. ✅ Update API deployment with ServiceAccount
4. ✅ Set cluster-internal service URLs (CLOUD_API_URL, MQTT_BROKER_URL)
5. ✅ Test virtual fleet creation on AKS
6. ✅ Verify virtual devices (OPC UA simulator sidecars)
7. ⬜ Configure monitoring dashboards
8. ⬜ Update Helm charts with RBAC templates
9. ⬜ Document runbook for production deployment
