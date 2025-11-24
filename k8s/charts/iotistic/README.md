# Iotistic Helm Chart

A Kubernetes Helm chart for deploying the complete Iotistic IoT platform stack for integration testing and development.

## Overview

This chart deploys a complete Iotistic stack including:
- **PostgreSQL** - Database for device data and MQTT ACLs
- **Redis** - Cache and real-time metrics
- **Mosquitto** - MQTT broker with PostgreSQL authentication
- **API** - Backend API service
- **Dashboard** - Frontend web UI

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- Storage provisioner for PersistentVolumes (optional, can use emptyDir)

## Installation

### Install from local chart

```bash
# Install with default values
helm install iotistic ./k8s/charts/iotistic

# Install with custom namespace
helm install iotistic ./k8s/charts/iotistic --namespace iotistic --create-namespace

# Install with custom values
helm install iotistic ./k8s/charts/iotistic -f custom-values.yaml
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
| `api.enabled` | Enable API service | `true` |
| `api.image.tag` | API image tag | `latest` |
| `api.nodePort` | NodePort for API | `30002` |
| `dashboard.enabled` | Enable Dashboard | `true` |
| `dashboard.nodePort` | NodePort for Dashboard | `30000` |
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
kubectl exec -n iotistic -it deployment/iotistic-postgres -- psql -U postgres -d iotistic
```

### MQTT Connection Issues

```bash
# Test MQTT connection from inside cluster
kubectl run mqtt-test --rm -it --image=eclipse-mosquitto:latest -- mosquitto_pub -h iotistic-mosquitto -p 1883 -t test -m "hello"
```

## Comparison with Docker Compose

This chart is equivalent to `docker-compose.k8s.yml` with these key differences:

| Feature | Docker Compose | Kubernetes/Helm |
|---------|----------------|-----------------|
| **Orchestration** | Docker Compose | Kubernetes |
| **Networking** | Bridge network | Services + DNS |
| **Storage** | Named volumes | PersistentVolumeClaims |
| **Scaling** | Manual | Declarative (replicas) |
| **Health Checks** | Basic | Liveness + Readiness probes |
| **Configuration** | .env files | ConfigMaps + Values |
| **Port Exposure** | Host ports | NodePort/LoadBalancer |

## License

Copyright © 2025 Iotistic Team
