# Iotistic Kubernetes Helm Chart

## 📦 What Was Created

A complete Kubernetes Helm chart for the Iotistic IoT platform, based on `docker-compose.k8s.yml`.

### Chart Structure

```
k8s/charts/iotistic/
├── Chart.yaml                      # Chart metadata
├── values.yaml                     # Default configuration
├── values-production.yaml          # Production overrides
├── .helmignore                     # Files to exclude from packaging
├── README.md                       # Comprehensive documentation
├── install.ps1                     # Quick install script (PowerShell)
└── templates/
    ├── _helpers.tpl                # Template helpers and functions
    ├── NOTES.txt                   # Post-install instructions
    ├── postgres.yaml               # PostgreSQL database
    ├── redis.yaml                  # Redis cache
    ├── mosquitto.yaml              # MQTT broker with config
    ├── api.yaml                    # API service
    ├── dashboard.yaml              # Dashboard UI
    └── ingress.yaml                # Ingress (optional)
```

## 🚀 Quick Start

### Install with Default Settings

```powershell
# Using the install script (recommended)
cd C:\Users\dsamborschi\iotistic\k8s\charts\iotistic
.\install.ps1 -WaitReady -RunMigrations

# Or manually with Helm
helm install iotistic . --namespace iotistic --create-namespace
```

### Install for Production

```powershell
helm install iotistic . \
  --namespace iotistic-prod \
  --create-namespace \
  -f values-production.yaml
```

### Uninstall

```powershell
.\install.ps1 -Uninstall

# Or manually
helm uninstall iotistic --namespace iotistic
```

## 🔧 Key Features

### 1. **Complete Stack Deployment**
- PostgreSQL 16 with optimized configuration
- Redis 7 with persistence
- Mosquitto MQTT broker with PostgreSQL authentication
- API backend service
- Dashboard frontend

### 2. **Development-Friendly Defaults**
- **NodePort** services for easy local access
- Exposed ports:
  - Dashboard: `30000` → http://localhost:30000
  - API: `30002` → http://localhost:30002
  - MQTT: `30883` → mqtt://localhost:30883
  - WebSocket: `30901` → ws://localhost:30901

### 3. **Production-Ready Options**
- ClusterIP + Ingress for production
- TLS/SSL support with cert-manager
- Resource limits and requests
- Health checks (liveness + readiness probes)
- Persistent storage with PVCs
- Network policies (optional)
- Resource quotas (optional)

### 4. **Flexible Configuration**
- Easy customization via `values.yaml`
- Production overrides in `values-production.yaml`
- Environment-specific settings
- Conditional resource deployment

## 📋 Configuration Examples

### Example 1: Change Image Versions

```yaml
# custom-values.yaml
api:
  image:
    tag: v1.2.3

dashboard:
  image:
    tag: v1.2.3
```

```powershell
helm upgrade iotistic . -f custom-values.yaml
```

### Example 2: Increase Resources

```yaml
postgres:
  storage:
    size: 50Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi
```

### Example 3: Enable Ingress

```yaml
ingress:
  enabled: true
  host: iotistic.example.com
  tls:
    enabled: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

### Example 4: Disable Components

```yaml
redis:
  enabled: false

vpn:
  enabled: false
```

## 🔑 Key Differences from Docker Compose

| Feature | Docker Compose | Kubernetes/Helm |
|---------|----------------|-----------------|
| **Service Discovery** | Container names | Kubernetes DNS (service names) |
| **Port Mapping** | `5432:5432` | NodePort/ClusterIP + Ingress |
| **Storage** | Named volumes | PersistentVolumeClaims (PVCs) |
| **Configuration** | `.env` files | `values.yaml` + ConfigMaps |
| **Scaling** | Manual | Declarative (`replicas: 2`) |
| **Health Checks** | Basic | Liveness + Readiness probes |
| **Networking** | Bridge network | Services + Network Policies |

## 🧪 Testing & Validation

### 1. Validate Chart Syntax

```powershell
helm lint .
```

### 2. Dry Run Installation

```powershell
helm install iotistic . --dry-run --debug
```

### 3. Template Rendering

```powershell
helm template iotistic . > rendered.yaml
```

### Check Deployed Resources

```powershell
kubectl get all -n iotistic
kubectl get pvc -n iotistic
kubectl get configmaps -n iotistic
```

## 📊 Monitoring & Debugging

### View Pod Status

```powershell
kubectl get pods -n iotistic
kubectl describe pod <pod-name> -n iotistic
```

### View Logs

```powershell
# API logs
kubectl logs -n iotistic -l app.kubernetes.io/component=api -f

# All services
kubectl logs -n iotistic -l app.kubernetes.io/instance=iotistic -f --all-containers
```

### Port Forward (if not using NodePort)

```powershell
kubectl port-forward -n iotistic svc/iotistic-dashboard 3000:80
kubectl port-forward -n iotistic svc/iotistic-api 3002:3002
```

### Execute Commands in Pods

```powershell
# Access PostgreSQL
kubectl exec -it -n iotistic deployment/iotistic-postgres -- psql -U postgres -d iotistic

# Access API pod shell (if needed)
$API_POD = kubectl get pods -n iotistic -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}'
kubectl exec -it -n iotistic $API_POD -- sh
```

> **Note:** Database migrations are automatically applied when the API service starts. No manual migration step is required.

## 🔐 Security Considerations

### Development (Current Defaults)
- ⚠️ Default passwords (change in production!)
- ⚠️ No TLS/SSL (use for dev only)
- ⚠️ Network policies disabled
- ⚠️ NodePort exposure (convenient but less secure)

### Production (values-production.yaml)
- ✅ Strong passwords required
- ✅ TLS/SSL via Ingress + cert-manager
- ✅ Network policies enabled
- ✅ Resource quotas enforced
- ✅ ClusterIP services (not exposed directly)

## 🛠️ Advanced Usage

### Using install.ps1 Script

```powershell
# Full installation
.\install.ps1 -WaitReady

# Custom namespace
.\install.ps1 -Namespace iotistic-dev

# Production deployment
.\install.ps1 -ValuesFile values-production.yaml -Namespace iotistic-prod

# Uninstall
.\install.ps1 -Uninstall
```

### Helm Upgrade

```powershell
# Upgrade with new values
helm upgrade iotistic . --namespace iotistic -f custom-values.yaml

# Force recreation of pods
helm upgrade iotistic . --namespace iotistic --force
```

### Helm Rollback

```powershell
# List revisions
helm history iotistic --namespace iotistic

# Rollback to previous version
helm rollback iotistic --namespace iotistic

# Rollback to specific revision
helm rollback iotistic 1 --namespace iotistic
```

## 📚 Template Helpers

The chart includes custom template helpers in `_helpers.tpl`:

- `iotistic.name` - Chart name
- `iotistic.fullname` - Full resource name
- `iotistic.labels` - Common labels
- `iotistic.selectorLabels` - Pod selector labels
- `iotistic.postgres.connectionString` - PostgreSQL connection URL
- `iotistic.redis.host` - Redis service name
- `iotistic.mosquitto.url` - MQTT broker URL
- `iotistic.mosquitto.host` - MQTT service name

## 🔄 Mapping from docker-compose.k8s.yml

| Docker Compose Service | Kubernetes Resources | Notes |
|------------------------|---------------------|-------|
| `postgres` | Deployment + Service + PVC + ConfigMap | PostgreSQL with custom config |
| `redis` | Deployment + Service + PVC | Redis with persistence |
| `mosquitto` | Deployment + Service + ConfigMap | MQTT with PostgreSQL auth |
| `api` | Deployment + Service | Backend API with all env vars |
| `dashboard` | Deployment + Service | Frontend UI |
| (optional) | Ingress | For production domain access |

## 🎯 Next Steps

1. **Test the chart locally:**
   ```powershell
   .\install.ps1 -WaitReady -RunMigrations
   ```

2. **Access the application:**
   - Dashboard: http://localhost:30000
   - API: http://localhost:30002/health

3. **Customize for your needs:**
   - Edit `values.yaml` or create custom values file
   - Run `helm upgrade iotistic . -f custom-values.yaml`

4. **Deploy to production:**
   ```powershell
   helm install iotistic . \
     -f values-production.yaml \
     --namespace iotistic-prod \
     --create-namespace
   ```

5. **Set up monitoring:**
   - Add Prometheus ServiceMonitor
   - Configure Grafana dashboards
   - Enable alerting

## 📞 Support

For issues or questions:
- Check logs: `kubectl logs -n iotistic -l app.kubernetes.io/instance=iotistic`
- Describe resources: `kubectl describe pod -n iotistic`
- Review chart README: `k8s/charts/iotistic/README.md`

---

**Created:** November 24, 2025  
**Chart Version:** 1.0.0  
**App Version:** 1.0.0
