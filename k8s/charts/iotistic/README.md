# Iotistic Helm Chart

A Kubernetes Helm chart for deploying the complete Iotistic IoT platform stack for integration testing and development.

## Overview

This chart deploys a complete Iotistic stack including:
- **PostgreSQL** - Database for device data and MQTT ACLs (StatefulSet)
- **Redis** - Cache, Bull queues, and real-time metrics (StatefulSet)
- **Mosquitto** - MQTT broker with **HTTP authentication via API service**
- **API** - Backend API service (handles MQTT auth, device management)
- **Dashboard** - Frontend web UI
- **MQTT Monitor** - Real-time MQTT topic monitoring with schema generation

### Key Architecture Patterns

**MQTT Authentication Flow:**
```
Device/Client → Mosquitto (go-auth plugin) → HTTP POST → API (/mosquitto-auth/*) → PostgreSQL
                                                            ↓
                                                       Redis Cache
```

- Mosquitto uses **HTTP backend authentication** (not direct PostgreSQL access)
- API provides endpoints: `/mosquitto-auth/user`, `/mosquitto-auth/superuser`, `/mosquitto-auth/acl`
- Redis caches auth results (5 min TTL) to reduce API load
- Supports MQTT wildcards in ACL rules (`+` for single-level, `#` for multi-level)

**Stateful Services:**
- **PostgreSQL**: StatefulSet with volumeClaimTemplates (stable storage, ordered scaling)
- **Redis**: StatefulSet with volumeClaimTemplates (stable pod identity, persistent queues)

### Deployment Options

| Option | Use Case | Values File | Guide |
|--------|----------|-------------|-------|
| **Local Development** | Docker Desktop K8s, Minikube | `values.yaml` | [INSTALLATION-GUIDE.md](./INSTALLATION-GUIDE.md) |
| **Azure AKS (All-in-K8s)** | Production, self-managed DB | `values-aks.yaml` | [AKS-DEPLOYMENT-GUIDE.md](./AKS-DEPLOYMENT-GUIDE.md) |
| **Azure AKS (Hybrid)** | Production, managed Azure PaaS | `values-aks-paas.yaml` | [AKS-DEPLOYMENT-GUIDE.md](./AKS-DEPLOYMENT-GUIDE.md#option-2-hybrid-azure-paas--k8s) |
| **General Production** | Any K8s cluster | `values-production.yaml` | [INSTALLATION-GUIDE.md](./INSTALLATION-GUIDE.md) |

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- Storage provisioner for PersistentVolumes (optional, can use emptyDir)

## Installation

### Local Development

```bash
# Install with default values
helm install iotistic ./k8s/charts/iotistic

# Install with custom namespace
helm install iotistic ./k8s/charts/iotistic --namespace iotistic --create-namespace

# Install with custom values
helm install iotistic ./k8s/charts/iotistic -f custom-values.yaml
```

### Azure AKS Production

For deploying to Azure Kubernetes Service (AKS), see the **[AKS Deployment Guide](./AKS-DEPLOYMENT-GUIDE.md)** which includes:
- Complete AKS cluster setup
- Azure PaaS integration (Azure Database for PostgreSQL, Azure Cache for Redis)
- SSL/TLS with cert-manager and Let's Encrypt
- Monitoring with Azure Monitor and Prometheus
- Security hardening and cost optimization

Quick start for AKS:
```bash
helm install iotistic ./k8s/charts/iotistic \
  --namespace iotistic \
  --create-namespace \
  -f values-aks.yaml
```

### Uninstall

```bash
helm uninstall iotistic --namespace iotistic
```

## Configuration

### Key Configuration Options

| Parameter | Description | Default |
|-----------|-------------|---------|
| `postgres.enabled` | Enable PostgreSQL | `true` |
| `postgres.password` | PostgreSQL password | `postgres` |
| `postgres.storage.size` | PostgreSQL storage size | `10Gi` |
| `redis.enabled` | Enable Redis | `true` |
| `redis.maxMemory` | Redis max memory | `256mb` |
| `mosquitto.enabled` | Enable Mosquitto MQTT broker | `true` |
| `mosquitto.serviceType` | Service type (NodePort/ClusterIP) | `NodePort` |
| `mosquitto.nodePorts.mqtt` | NodePort for MQTT | `30883` |
| `mosquitto.auth.allowAnonymous` | Allow anonymous connections | `false` |
| `mosquitto.auth.hasher` | Password hasher (bcrypt) | `bcrypt` |
| `mosquitto.auth.hasherCost` | Bcrypt cost factor | `10` |
| `mosquitto.auth.logLevel` | Auth logging level | `info` |
| `mosquitto.persistence.enabled` | Enable message persistence | `true` |
| `api.enabled` | Enable API service | `true` |
| `api.image.tag` | API image tag | `latest` |
| `api.nodePort` | NodePort for API | `30002` |
| `api.corsOrigins` | CORS allowed origins | `http://*:30000` |
| `dashboard.enabled` | Enable Dashboard | `true` |
| `dashboard.nodePort` | NodePort for Dashboard | `30000` |
| `mqttMonitor.enabled` | Enable MQTT Monitor | `true` |
| `mqttMonitor.port` | Internal service port | `3500` |
| `ingress.enabled` | Enable Ingress | `false` |

### Example: Custom Values

Create a `custom-values.yaml` file:

```yaml
# Use production images
api:
  image:
    tag: v1.2.3
    
dashboard:
  image:
    tag: v1.2.3

# Increase resources
postgres:
  storage:
    size: 20Gi
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

# Enable ingress
ingress:
  enabled: true
  host: iotistic.local
```

Then install:

```bash
helm install iotistic ./k8s/charts/iotistic -f custom-values.yaml
```

## Accessing Services

### NodePort (Default for local development)

When using NodePort (default), services are accessible at:

- **Dashboard**: http://localhost:30000
- **API**: http://localhost:30002
- **MQTT Broker**: mqtt://localhost:30883
- **MQTT WebSocket**: ws://localhost:30901

### Ingress (Optional)

When ingress is enabled:

- **Dashboard**: http://iotistic.local
- **API**: http://iotistic.local/api

Add this to your `/etc/hosts` (Linux/Mac) or `C:\Windows\System32\drivers\etc\hosts` (Windows):

```
127.0.0.1 iotistic.local
```

## Development Workflow

### 1. Build Images

```bash
# Build API image
cd api
docker build -t iotistic/api:latest .

# Build Dashboard image
cd dashboard
docker build -t iotistic/dashboard:latest .
```

### 2. Deploy to Kubernetes

```bash
# Install chart
helm install iotistic ./k8s/charts/iotistic --namespace iotistic --create-namespace

# Wait for pods to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=iotistic -n iotistic --timeout=300s
```

> **Note:** Database migrations are automatically applied when the API service starts up. No manual migration step required.

### 3. Access the Application

Open your browser:
- Dashboard: http://localhost:30000
- API Health: http://localhost:30002/health

### 4. View Logs

```bash
# API logs
kubectl logs -n iotistic -l app.kubernetes.io/component=api -f

# Dashboard logs
kubectl logs -n iotistic -l app.kubernetes.io/component=dashboard -f

# All logs
kubectl logs -n iotistic -l app.kubernetes.io/instance=iotistic -f --all-containers
```

### 5. Upgrade

```bash
# After making changes to values or templates
helm upgrade iotistic ./k8s/charts/iotistic --namespace iotistic
```

## Troubleshooting

### PostgreSQL StatefulSet

PostgreSQL is deployed as a **StatefulSet** (not Deployment) for production-grade stateful workloads. This provides:

- **Stable network identity**: Each pod gets a predictable hostname
- **Ordered deployment/scaling**: Pods are created and terminated in order
- **Persistent storage**: Each pod gets its own PersistentVolumeClaim
- **Stable storage**: PVC remains even if pod is rescheduled

**Important Notes:**
- Deleting the StatefulSet does NOT delete PVCs automatically (prevents data loss)
- To fully clean up: `kubectl delete statefulset,pvc -l app.kubernetes.io/component=postgres -n iotistic`
- For high availability, consider using PostgreSQL operators (e.g., Zalando Postgres Operator, CloudNativePG)

### Redis StatefulSet

Redis is deployed as a **StatefulSet** for stable pod identity and persistent storage:

- **Stable pod name**: `iotistic-redis-0` (never changes, even after restarts)
- **Automatic PVC**: Created per pod via volumeClaimTemplates
- **Persistent queues**: Bull job queues survive pod restarts
- **Metrics streams**: Redis Streams data persisted across restarts
- **Future-ready**: Foundation for Redis Sentinel or Cluster mode

**Important Notes:**
- Pod hostname: `iotistic-redis-0.iotistic-redis-headless.iotistic.svc.cluster.local`
- PVC name: `redis-data-iotistic-redis-0` (automatically managed)
- To clean up: `kubectl delete statefulset,pvc -l app.kubernetes.io/component=redis -n iotistic`
- Persistence controlled by `redis.persistence.enabled` (default: true)

### Check Pod Status

```bash
kubectl get pods -n iotistic
```

### Describe Pod Issues

```bash
kubectl describe pod -n iotistic -l app.kubernetes.io/instance=iotistic
```

### Check Service Endpoints

```bash
kubectl get svc -n iotistic
```

### PostgreSQL Connection Issues

```bash
# Test PostgreSQL connection
kubectl exec -n iotistic -it statefulset/iotistic-postgres -- psql -U postgres -d iotistic

# Check StatefulSet status
kubectl get statefulset -n iotistic

# Check PVC (Persistent Volume Claim)
kubectl get pvc -n iotistic
```

### Redis Connection Issues

```bash
# Test Redis connection
kubectl exec -n iotistic -it statefulset/iotistic-redis -- redis-cli ping

# Check Redis data persistence
kubectl exec -n iotistic -it statefulset/iotistic-redis -- redis-cli INFO persistence

# Check Bull queue jobs
kubectl exec -n iotistic -it statefulset/iotistic-redis -- redis-cli KEYS "bull:*"

# Check MQTT auth cache (DB 1)
kubectl exec -n iotistic -it statefulset/iotistic-redis -- redis-cli -n 1 KEYS "*"

# Check StatefulSet status
kubectl get statefulset/iotistic-redis -n iotistic

# Check PVC
kubectl get pvc -l app.kubernetes.io/component=redis -n iotistic
```

### MQTT Connection Issues

```bash
# Check Mosquitto logs
kubectl logs -n iotistic -l app.kubernetes.io/component=mosquitto -f

# Check API logs (auth endpoint)
kubectl logs -n iotistic -l app.kubernetes.io/component=api -f | grep MosquittoAuth

# Test MQTT connection from inside cluster
kubectl run mqtt-test --rm -it --image=eclipse-mosquitto:latest -- \
  mosquitto_pub -h iotistic-mosquitto -p 1883 \
  -u admin -P iotistic42! -t test -m "hello"

# Check Redis cache (auth caching)
kubectl exec -n iotistic deployment/iotistic-redis -- redis-cli -n 1 KEYS "*"
```

**Common Issues:**
- **Connection refused**: Check if API service is running (Mosquitto depends on API for auth)
- **Authentication failed**: Check API `/mosquitto-auth/*` endpoints and database `mqtt_users` table
- **Slow auth**: Check Redis cache connection (should cache auth for 5 min)

## Comparison with Docker Compose

This chart is equivalent to `docker-compose.k8s.yml` with these key differences:

| Feature | Docker Compose | Kubernetes/Helm |
|---------|----------------|-----------------|
| **Orchestration** | Docker Compose | Kubernetes |
| **Networking** | Bridge network | Services + DNS |
| **Storage** | Named volumes | PersistentVolumeClaims (StatefulSet) |
| **Scaling** | Manual | Declarative (replicas) |
| **Health Checks** | Basic | Liveness + Readiness probes |
| **Configuration** | .env files | ConfigMaps + Values |
| **Port Exposure** | Host ports | NodePort/LoadBalancer |
| **MQTT Auth** | HTTP via API (same) | HTTP via API (same) |
| **PostgreSQL** | Deployment | StatefulSet with volumeClaimTemplates |
| **Redis** | Deployment | StatefulSet with volumeClaimTemplates |

**Note:** Both environments use **HTTP authentication** via the API service for Mosquitto. The API provides `/mosquitto-auth/*` endpoints that query PostgreSQL and cache results in Redis.

## License

Copyright © 2025 Iotistic Team
