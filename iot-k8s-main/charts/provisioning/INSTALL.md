# Provisioning Service - Installation Guide

Quick guide for deploying the provisioning service to Kubernetes using Helm.

## Prerequisites Checklist

- [ ] Kubernetes cluster (v1.19+)
- [ ] Helm CLI (v3.2+)
- [ ] 1Password Operator installed in cluster
- [ ] Envoy Gateway installed
- [ ] All 1Password secrets created (see README.md)

## Installation Steps

### 1. Update chart dependencies

```bash
cd iot-k8s-main/charts/provisioning
helm dependency update
```

### 2. Create namespace

```bash
kubectl create namespace provisioning
```

### 3. Install chart

**Development (simulated services):**
```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --values ./charts/provisioning/values/development.yaml
```

**Production:**
```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --values ./charts/provisioning/values/production.yaml
```

### 4. Verify deployment

```bash
# Check pods are running
kubectl get pods -n provisioning

# Check services
kubectl get svc -n provisioning

# Check HTTPRoute
kubectl get httproute -n provisioning

# View API logs
kubectl logs -n provisioning -l app.kubernetes.io/component=api --tail=50

# View worker logs
kubectl logs -n provisioning -l app.kubernetes.io/component=worker --tail=50
```

### 5. Test API health

```bash
# Port forward to test locally
kubectl port-forward -n provisioning svc/provisioning-api 3100:3100

# Test health endpoint
curl http://localhost:3100/health
```

## Upgrade Chart

```bash
helm upgrade provisioning ./charts/provisioning \
  --namespace provisioning \
  --values ./charts/provisioning/values/production.yaml
```

## Rollback

```bash
# View history
helm history provisioning -n provisioning

# Rollback to previous version
helm rollback provisioning -n provisioning
```

## Uninstall

```bash
helm uninstall provisioning --namespace provisioning
```

## Troubleshooting

### Pods not starting

Check 1Password secrets are created:
```bash
kubectl get onepassworditems -n provisioning
```

Check pod events:
```bash
kubectl describe pod <pod-name> -n provisioning
```

### Database migration needed

Run migration job:
```bash
kubectl exec -it -n provisioning deployment/provisioning-api -- npm run migrate
```

### Worker not processing jobs

Check Redis connectivity:
```bash
kubectl exec -it -n provisioning deployment/provisioning-worker -- \
  redis-cli -h provisioning-redis-master -a $REDIS_PASSWORD ping
```

Check Bull queue status:
```bash
kubectl logs -n provisioning -l app.kubernetes.io/component=worker | grep "listening for jobs"
```

## Environment-Specific Configuration

### Development
- Single replica for API and worker
- Simulated external services (TigerData, 1Password, GitOps)
- No persistent volumes for Redis
- 7-day trial period

### Production
- 3 API replicas, 5 worker replicas
- Real external service integrations
- Premium storage classes (managed-csi-premium)
- 14-day trial period
- Higher resource limits

## Custom Configuration

Create your own values file:
```yaml
# custom-values.yaml
api:
  replicas: 2
  env:
    BASE_DOMAIN: mycompany.com
    DEFAULT_TRIAL_DAYS: "30"

worker:
  replicas: 3
  concurrency: 5

ingress:
  hostname: billing.mycompany.com
```

Deploy with custom values:
```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --values custom-values.yaml
```
