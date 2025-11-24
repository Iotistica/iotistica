# Iotistic Helm Chart - Quick Reference

## 🚀 Installation

```powershell
# Quick install (recommended)
cd k8s/charts/iotistic
.\install.ps1 -WaitReady -RunMigrations

# Or with Helm directly
helm install iotistic . --namespace iotistic --create-namespace
```

## 🌐 Access URLs (Default NodePort)

| Service | URL | Port |
|---------|-----|------|
| Dashboard | http://localhost:30000 | 30000 |
| API | http://localhost:30002 | 30002 |
| MQTT | mqtt://localhost:30883 | 30883 |
| WebSocket | ws://localhost:30901 | 30901 |

## 🔧 Common Commands

```powershell
# Check status
kubectl get pods -n iotistic

# View logs
kubectl logs -n iotistic -l app.kubernetes.io/instance=iotistic -f

# Run migrations
$POD = kubectl get pods -n iotistic -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}'
kubectl exec -n iotistic $POD -- npm run migrate

# Upgrade
helm upgrade iotistic . --namespace iotistic

# Uninstall
.\install.ps1 -Uninstall
# OR: helm uninstall iotistic --namespace iotistic
```

## 📝 Key Files

| File | Purpose |
|------|---------|
| `values.yaml` | Default configuration (dev) |
| `values-production.yaml` | Production overrides |
| `install.ps1` | Quick install script |
| `README.md` | Full documentation |
| `INSTALLATION-GUIDE.md` | Detailed guide |

## 🔐 Default Credentials

```yaml
PostgreSQL:
  username: postgres
  password: postgres
  database: iotistic

MQTT:
  username: admin
  password: iotistic42!
```

⚠️ **Change these in production!**

## 🎨 Customization

```yaml
# Create custom-values.yaml
api:
  image:
    tag: v1.2.3
  replicas: 2

postgres:
  storage:
    size: 50Gi
```

```powershell
helm upgrade iotistic . -f custom-values.yaml
```

## 🐛 Troubleshooting

```powershell
# Pod not starting
kubectl describe pod <pod-name> -n iotistic

# Service issues
kubectl get svc -n iotistic
kubectl get endpoints -n iotistic

# Database connection
kubectl exec -it -n iotistic deployment/iotistic-postgres -- psql -U postgres -d iotistic

# Validate chart
helm lint .
helm template iotistic . --debug
```

## 📊 Production Checklist

- [ ] Change default passwords
- [ ] Use specific image tags (not `latest`)
- [ ] Enable TLS/SSL (cert-manager)
- [ ] Configure resource limits
- [ ] Enable network policies
- [ ] Set up monitoring
- [ ] Configure backups
- [ ] Use ClusterIP + Ingress

## 📚 More Info

- Full README: `k8s/charts/iotistic/README.md`
- Installation Guide: `k8s/charts/iotistic/INSTALLATION-GUIDE.md`
- Values Reference: `k8s/charts/iotistic/values.yaml`
