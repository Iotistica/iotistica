# ArgoCD GitOps - Multi-Customer Update Guide

Complete guide for managing all customer deployments with ArgoCD GitOps.

## 🎯 Key Concept

**One update → All customers get it automatically**

When you update `argocd/shared/image-versions.yaml`, ArgoCD syncs ALL customer instances within minutes.

## 📋 Table of Contents

1. [How It Works](#how-it-works)
2. [Update All Customers](#update-all-customers)
3. [Add New Customer](#add-new-customer)
4. [Update Single Customer](#update-single-customer)
5. [Rollback](#rollback)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Repository (zemfyre-sensor)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  argocd/                                                    │
│  ├── shared/                                                │
│  │   ├── image-versions.yaml  ← CI/CD updates this         │
│  │   └── common-values.yaml                                │
│  │                                                          │
│  ├── customers/                                             │
│  │   ├── customer-7f05d0d2.yaml  ← References shared       │
│  │   ├── customer-abc12345.yaml     image versions         │
│  │   └── customer-xyz67890.yaml                            │
│  │                                                          │
│  └── root-app.yaml  ← ArgoCD watches this                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
                    Git Push
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ ArgoCD (running in Kubernetes)                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  • Polls git every 3 minutes                                │
│  • Detects changes in image-versions.yaml                  │
│  • Automatically syncs ALL customer instances               │
│  • Each customer gets new images                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Kubernetes Cluster                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ├── customer-7f05d0d2/                                     │
│  │   ├── api (new image deployed)                          │
│  │   ├── dashboard (new image deployed)                    │
│  │   └── postgres, mosquitto, etc.                         │
│  │                                                          │
│  ├── customer-abc12345/                                     │
│  │   ├── api (new image deployed)                          │
│  │   ├── dashboard (new image deployed)                    │
│  │   └── ...                                                │
│  │                                                          │
│  └── customer-xyz67890/ (and so on...)                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Workflow

1. **Developer pushes code** to `master` branch
2. **GitHub Actions**:
   - Builds Docker images with version tags (e.g., `v1.0.42-a3f4d9c`)
   - Pushes images to GitHub Container Registry
   - Updates `argocd/shared/image-versions.yaml` with new tags
   - Commits and pushes changes back to git
3. **ArgoCD** (within 3 minutes):
   - Detects git changes
   - Syncs ALL customer Applications
   - Kubernetes pulls new images and rolls out updates

---

## Update All Customers

### Automatic (CI/CD) - RECOMMENDED

Just push code to master:

```bash
# Make changes to API or Dashboard
vim api/src/routes/devices.ts

# Commit and push
git add .
git commit -m "feat: add new API endpoint"
git push origin master

# GitHub Actions will:
# 1. Build new images
# 2. Update image-versions.yaml
# 3. All customers will be updated automatically within 3 minutes
```

### Manual

If you want to manually update image versions:

```bash
# Update image tags in shared file
cd argocd/shared
vim image-versions.yaml

# Change:
api:
  image:
    tag: v1.0.50-abc123

# Commit and push
git add image-versions.yaml
git commit -m "chore: update API to v1.0.50"
git push

# All customers updated within 3 minutes
```

### Force Immediate Update

Don't want to wait 3 minutes?

```bash
# Sync all customers immediately
argocd app sync -l app.kubernetes.io/instance=iotistic-customers

# Or sync specific customer
argocd app sync customer-7f05d0d2
```

---

## Add New Customer

### Using Script (Recommended)

**PowerShell (Windows):**
```powershell
cd argocd/scripts
.\add-customer.ps1 -CustomerId "new123" -CustomerName "New Corp" -Plan "professional"
git push
```

**Bash (Linux/Mac):**
```bash
cd argocd/scripts
chmod +x add-customer.sh
./add-customer.sh new123 "New Corp" professional
git push
```

### Manually

1. Copy existing customer file:
```bash
cp argocd/customers/customer-7f05d0d2.yaml argocd/customers/customer-new123.yaml
```

2. Edit customer details:
```yaml
metadata:
  name: customer-new123
  labels:
    customer-id: "new123"
    plan: "professional"

spec:
  source:
    helm:
      values: |
        customerId: "new123"
        customerName: "New Corp"
        namespace: customer-new123
        ingress:
          host: new123.iotistic.cloud
```

3. Commit and push:
```bash
git add argocd/customers/customer-new123.yaml
git commit -m "feat: add customer new123"
git push
```

4. ArgoCD will deploy automatically within 3 minutes.

---

## Update Single Customer

Sometimes you need customer-specific configuration (e.g., pinned version, extra resources):

```yaml
# argocd/customers/customer-special.yaml
spec:
  source:
    helm:
      valueFiles:
        - ../../argocd/shared/image-versions.yaml  # Still inherit shared
      values: |
        # Override specific values
        api:
          image:
            tag: v1.0.42-pinned  # Pin to specific version
        
        resources:
          api:
            limits:
              cpu: 4000m  # More CPU for this customer
```

**Use cases:**
- Testing new version with one customer first
- Customer needs more resources
- Customer has specific compliance requirements
- Gradual rollout (canary deployment)

---

## Rollback

### Rollback All Customers

```bash
# Option 1: Revert git commit
git revert HEAD
git push

# Option 2: Manually edit image-versions.yaml
cd argocd/shared
vim image-versions.yaml
# Change tag back to previous version
git add image-versions.yaml
git commit -m "rollback: revert to v1.0.45"
git push
```

### Rollback Single Customer

```bash
# ArgoCD rollback (goes back to previous synced state)
argocd app rollback customer-7f05d0d2

# Or manually override in customer file
vim argocd/customers/customer-7f05d0d2.yaml
# Add:
#   api:
#     image:
#       tag: v1.0.45-old-version
git add argocd/customers/customer-7f05d0d2.yaml
git commit -m "rollback: customer 7f05d0d2 to v1.0.45"
git push
```

---

## Monitoring

### Check All Customers

```bash
# List all customer applications
argocd app list

# Check sync status
argocd app list -l app.kubernetes.io/instance=iotistic-customers

# Get detailed status
argocd app get customer-7f05d0d2
```

### Watch Deployment Progress

```bash
# Watch all customers sync
watch -n 2 'argocd app list -l app.kubernetes.io/instance=iotistic-customers'

# Watch specific customer pods
watch kubectl get pods -n customer-7f05d0d2

# Follow logs
argocd app logs customer-7f05d0d2 --follow
kubectl logs -n customer-7f05d0d2 deployment/customer-7f05d0d2-customer-instance-api -f
```

### Health Checks

```bash
# Check application health
argocd app get customer-7f05d0d2 | grep Health

# Check sync status
argocd app get customer-7f05d0d2 | grep Sync

# Get events
kubectl get events -n customer-7f05d0d2 --sort-by='.lastTimestamp' | tail -20
```

---

## Troubleshooting

### Application Out of Sync

**Symptom:** ArgoCD shows "OutOfSync" status

**Solution:**
```bash
# View diff
argocd app diff customer-7f05d0d2

# Sync manually
argocd app sync customer-7f05d0d2

# Force sync (ignores sync waves)
argocd app sync customer-7f05d0d2 --force
```

### Image Pull Errors

**Symptom:** Pods stuck in `ImagePullBackOff`

**Solution:**
```bash
# Check pod events
kubectl describe pod -n customer-7f05d0d2 <pod-name>

# Verify image exists
docker pull ghcr.io/dsamborschi/api:v1.0.50-abc123

# Check image pull secrets
kubectl get secret -n customer-7f05d0d2
```

### Sync Taking Too Long

**Symptom:** Changes not reflected after 5+ minutes

**Solution:**
```bash
# Check ArgoCD logs
kubectl logs -n argocd deployment/argocd-application-controller

# Force refresh
argocd app get customer-7f05d0d2 --refresh

# Hard refresh (clears cache)
argocd app get customer-7f05d0d2 --hard-refresh
```

### Customer Namespace Not Created

**Symptom:** Namespace doesn't exist after app creation

**Solution:**
```bash
# Check Application manifest has CreateNamespace
argocd app get customer-7f05d0d2 -o yaml | grep CreateNamespace

# Manually create namespace
kubectl create namespace customer-7f05d0d2

# Sync again
argocd app sync customer-7f05d0d2
```

---

## Best Practices

### 1. **Always Test First**
```bash
# Deploy to staging customer first
vim argocd/customers/customer-staging.yaml
# Update to new version
git push
# Wait and verify
# Then update shared/image-versions.yaml for all customers
```

### 2. **Use Semantic Versioning**
```bash
# Good: v1.2.3-abc123
# Bad: latest, v1, master
```

### 3. **Monitor Deployments**
```bash
# Set up alerts for failed syncs
# Use ArgoCD Notifications
# Monitor pod restarts
```

### 4. **Keep Rollback Plan**
```bash
# Always know previous working version
git log --oneline argocd/shared/image-versions.yaml
```

### 5. **Gradual Rollouts**
```bash
# Update 1 customer → verify → update 10 customers → verify → update all
```

---

## Quick Reference

```bash
# Update all customers
git push  # (after CI/CD updates image-versions.yaml)

# Add customer
./argocd/scripts/add-customer.ps1 -CustomerId "new123" -CustomerName "New Corp" -Plan "pro"

# Force sync all
argocd app sync -l app.kubernetes.io/instance=iotistic-customers

# Check status
argocd app list

# Rollback all
git revert HEAD && git push

# View logs
argocd app logs customer-7f05d0d2 -f
```

---

## Next Steps

1. **Install ArgoCD** - See `argocd/README.md`
2. **Deploy Root App** - `kubectl apply -f argocd/root-app.yaml`
3. **Add Customers** - Use `add-customer.ps1` script
4. **Setup CI/CD** - GitHub Actions already configured
5. **Monitor** - Set up ArgoCD UI and notifications
