# Virtual Agent Production Deployment Checklist

Complete checklist for deploying virtual agent functionality to production Kubernetes cluster.

## Prerequisites

- [ ] Production Kubernetes cluster (EKS, GKE, AKS, or self-managed)
- [ ] `kubectl` access to cluster
- [ ] Helm 3.x installed (if using Helm charts)
- [ ] Container registry access (Docker Hub, ECR, GCR, ACR, etc.)

## Phase 1: Container Registry Setup

### 1.1 Build and Push Agent Image

```bash
# Build agent image
cd agent
docker build -t your-registry.com/iotistic/agent:latest .

# Push to registry
docker push your-registry.com/iotistic/agent:latest

# Tag specific version
docker tag your-registry.com/iotistic/agent:latest your-registry.com/iotistic/agent:v1.0.0
docker push your-registry.com/iotistic/agent:v1.0.0
```

### 1.2 Configure Image Pull Secrets (if private registry)

```bash
# Create image pull secret
kubectl create secret docker-registry regcred \
  --docker-server=your-registry.com \
  --docker-username=your-username \
  --docker-password=your-password \
  --docker-email=your-email@example.com \
  -n default

# Also create in virtual-agents namespace
kubectl create namespace virtual-agents
kubectl create secret docker-registry regcred \
  --docker-server=your-registry.com \
  --docker-username=your-username \
  --docker-password=your-password \
  --docker-email=your-email@example.com \
  -n virtual-agents
```

## Phase 2: RBAC Configuration

### 2.1 Create Service Account and RBAC

```bash
# Deploy RBAC resources
kubectl apply -f k8s/virtual-agent-rbac.yaml

# Verify service account created
kubectl get serviceaccount iotistic-api -n default

# Verify cluster role created
kubectl get clusterrole virtual-agent-manager

# Verify binding
kubectl get clusterrolebinding iotistic-api-virtual-agent-manager
```

### 2.2 Verify Permissions

```bash
# Test if service account can create namespaces
kubectl auth can-i create namespaces --as=system:serviceaccount:default:iotistic-api
# Expected: yes

# Test if service account can create deployments in virtual-agents namespace
kubectl auth can-i create deployments --namespace=virtual-agents --as=system:serviceaccount:default:iotistic-api
# Expected: yes

# Test if service account can create secrets
kubectl auth can-i create secrets --namespace=virtual-agents --as=system:serviceaccount:default:iotistic-api
# Expected: yes
```

## Phase 3: API Deployment Configuration

### 3.1 Update API Deployment Manifest

Add service account and environment variables to your API deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iotistic-api
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: iotistic-api
  template:
    metadata:
      labels:
        app: iotistic-api
    spec:
      serviceAccountName: iotistic-api  # ← CRITICAL: Use service account
      containers:
      - name: api
        image: your-registry.com/iotistic/api:latest
        ports:
        - containerPort: 3002
        env:
        # Virtual Agent Configuration
        - name: VIRTUAL_AGENT_NAMESPACE
          value: "virtual-agents"
        - name: AGENT_IMAGE
          value: "your-registry.com/iotistic/agent:latest"  # ← Update to your registry
        - name: AGENT_IMAGE_PULL_POLICY
          value: "Always"  # or "IfNotPresent" for tagged versions
        - name: CLOUD_API_URL
          value: "https://api.yourdomain.com"  # ← Your production API URL
        - name: MQTT_BROKER_URL_VIRTUAL
          value: "mqtts://mqtt.yourdomain.com:8883"  # ← Your production MQTT URL
        
        # Resource limits for virtual agents
        - name: VIRTUAL_AGENT_CPU_REQUEST
          value: "200m"
        - name: VIRTUAL_AGENT_CPU_LIMIT
          value: "1000m"
        - name: VIRTUAL_AGENT_MEMORY_REQUEST
          value: "512Mi"
        - name: VIRTUAL_AGENT_MEMORY_LIMIT
          value: "2Gi"
        
        # Database, Redis, etc.
        - name: DB_HOST
          value: "postgres-service"
        # ... other env vars
```

### 3.2 Create Virtual Agents Namespace

```bash
# Create namespace
kubectl create namespace virtual-agents

# Label it for easy identification
kubectl label namespace virtual-agents \
  app.kubernetes.io/managed-by=iotistic-api \
  iotistic.com/namespace-type=virtual-agents

# Verify
kubectl get namespace virtual-agents --show-labels
```

### 3.3 Deploy API

```bash
# Apply API deployment
kubectl apply -f k8s/api-deployment.yaml

# Wait for rollout
kubectl rollout status deployment/iotistic-api -n default

# Check logs for successful K8s initialization
kubectl logs -n default deployment/iotistic-api | grep VirtualAgentDeployer
# Expected: ✅ VirtualAgentDeployer initialized with in-cluster K8s config
```

## Phase 4: Network Configuration

### 4.1 Verify API Can Reach K8s API Server

```bash
# Get API pod name
API_POD=$(kubectl get pods -n default -l app=iotistic-api -o jsonpath='{.items[0].metadata.name}')

# Test K8s API access from pod
kubectl exec -n default $API_POD -- curl -k https://kubernetes.default.svc/api/
# Expected: Should return API version info (401 is ok, means connectivity works)
```

### 4.2 Configure Ingress/LoadBalancer

```yaml
# Example ingress for API
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: iotistic-api
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.yourdomain.com
    secretName: api-tls
  rules:
  - host: api.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: iotistic-api
            port:
              number: 3002
```

## Phase 5: Testing

### 5.1 Create Test Virtual Agent

```bash
# Get auth token
TOKEN=$(curl -X POST https://api.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com", "password":"password"}' \
  | jq -r '.accessToken')

# Create virtual agent
curl -X POST https://api.yourdomain.com/api/v1/devices \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceName": "test-virtual-agent-prod",
    "deviceType": "virtual",
    "fleetId": "default",
    "tags": [{"key": "env", "value": "production"}]
  }'

# Expected response:
# {
#   "success": true,
#   "deviceUuid": "abc123...",
#   "deviceType": "virtual",
#   "deploymentStatus": "deploying",
#   "namespace": "virtual-agents"
# }
```

### 5.2 Verify Deployment

```bash
# Get device UUID from previous response
DEVICE_UUID="abc123..."

# Check deployment created
kubectl get deployments -n virtual-agents
# Expected: agent-abc123xx deployment with 1/1 ready

# Check pod
kubectl get pods -n virtual-agents
# Expected: agent-abc123xx-xxxxx-xxxxx pod in Running state

# Check secret
kubectl get secrets -n virtual-agents
# Expected: agent-abc123xx-prov-key secret

# Check pod logs
kubectl logs -n virtual-agents $(kubectl get pods -n virtual-agents -o name | head -1)
# Expected: Agent provisioning logs
```

### 5.3 Check API Logs

```bash
# Check API logs for deployment flow
kubectl logs -n default deployment/iotistic-api | grep -A20 "Starting virtual agent deployment"

# Expected logs:
# Starting virtual agent deployment
# Creating namespace (or Namespace already exists)
# Provisioning key Secret created
# Deployment created
# Virtual agent deployment initiated successfully
```

## Phase 6: Monitoring

### 6.1 Set Up Alerts

```yaml
# Prometheus alert for failed deployments
groups:
- name: virtual-agents
  rules:
  - alert: VirtualAgentDeploymentFailed
    expr: kube_deployment_status_replicas_available{namespace="virtual-agents"} == 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Virtual agent deployment failed"
      description: "Deployment {{ $labels.deployment }} has no available replicas"
```

### 6.2 Dashboard Metrics

```bash
# Count running virtual agents
kubectl get deployments -n virtual-agents --no-headers | wc -l

# Check resource usage
kubectl top pods -n virtual-agents

# Check namespace resource quotas (if configured)
kubectl get resourcequota -n virtual-agents
```

## Phase 7: Security Hardening

### 7.1 Network Policies

```yaml
# Restrict virtual agent network access
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: virtual-agent-network-policy
  namespace: virtual-agents
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: virtual-agent
  policyTypes:
  - Egress
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Allow cloud API access
  - to:
    - podSelector: {}
    ports:
    - protocol: TCP
      port: 443
  # Allow MQTT access
  - to:
    - podSelector: {}
    ports:
    - protocol: TCP
      port: 8883
```

### 7.2 Pod Security Standards

```yaml
# Enforce restricted pod security
apiVersion: v1
kind: Namespace
metadata:
  name: virtual-agents
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

## Troubleshooting

### Issue: "Failed to initialize Kubernetes configuration"

**Cause**: API pod not using service account or RBAC not configured

**Solution**:
```bash
# Check service account in deployment
kubectl get deployment iotistic-api -n default -o yaml | grep serviceAccountName

# Verify service account exists
kubectl get serviceaccount iotistic-api -n default

# Check RBAC bindings
kubectl get clusterrolebinding iotistic-api-virtual-agent-manager -o yaml
```

### Issue: "Forbidden: User cannot create resource"

**Cause**: Service account lacks permissions

**Solution**:
```bash
# Re-apply RBAC
kubectl apply -f k8s/virtual-agent-rbac.yaml

# Test permissions
kubectl auth can-i create deployments --namespace=virtual-agents \
  --as=system:serviceaccount:default:iotistic-api
```

### Issue: Pod stuck in "ImagePullBackOff"

**Cause**: Image not accessible or wrong image name

**Solution**:
```bash
# Check image name
kubectl describe pod -n virtual-agents <pod-name> | grep Image

# Verify image exists in registry
docker pull your-registry.com/iotistic/agent:latest

# Check image pull secret (if private)
kubectl get secret regcred -n virtual-agents
```

### Issue: Pod in "CrashLoopBackOff"

**Cause**: Agent can't connect to cloud API or missing provisioning key

**Solution**:
```bash
# Check pod logs
kubectl logs -n virtual-agents <pod-name>

# Check secret exists
kubectl get secret -n virtual-agents | grep prov-key

# Verify secret contents
kubectl get secret <secret-name> -n virtual-agents -o jsonpath='{.data.provisioningKey}' | base64 -d
```

## Production Checklist

- [ ] Agent image built and pushed to production registry
- [ ] Image pull secrets created (if private registry)
- [ ] RBAC service account created
- [ ] ClusterRole and ClusterRoleBinding applied
- [ ] API deployment updated with serviceAccountName
- [ ] Environment variables configured (AGENT_IMAGE, CLOUD_API_URL, etc.)
- [ ] virtual-agents namespace created
- [ ] API deployed and healthy
- [ ] K8s initialization logs show success
- [ ] Test virtual agent created successfully
- [ ] Test pod running and provisioned
- [ ] Monitoring and alerts configured
- [ ] Network policies applied (optional)
- [ ] Resource quotas configured (optional)

## Next Steps

1. **Multi-tenancy**: Consider namespace-per-customer for better isolation
2. **Auto-scaling**: Configure HPA for virtual agents if needed
3. **Backup**: Ensure virtual agent configs backed up
4. **Disaster Recovery**: Document recreation process
5. **Cost Optimization**: Monitor resource usage and adjust limits

---

**Last Updated**: 2026-02-07  
**Tested On**: Kubernetes v1.28+, EKS, GKE, AKS
