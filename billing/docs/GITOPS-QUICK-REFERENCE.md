# GitOps Quick Reference Card

**One-page operator guide for the billing service GitOps refactor**

---

## Architecture At a Glance

```
Stripe Webhook → Billing Service → Git Commit → Argo CD → Kubernetes
```

**Old Way**: Billing runs `helm upgrade` directly  
**New Way**: Billing writes YAML to Git, Argo CD applies it

---

## Key Commands

### Check Deployment Status

```bash
# Billing database
psql $DATABASE_URL -c "SELECT customer_id, email, deployment_status FROM customers WHERE customer_id='cust_xxxxx';"

# Argo CD
argocd app get client-dc5fec42

# Kubernetes
kubectl get pods -n client-dc5fec42
```

### Trigger Manual Deployment

```bash
# Via API
curl -X POST http://localhost:3100/api/customers/<customerId>/deploy

# Via Argo CD
argocd app sync client-dc5fec42
```

### View Deployment Logs

```bash
# Billing worker
docker logs -f billing-worker

# Argo CD controller
kubectl logs -n argocd deployment/argocd-application-controller -f

# Customer pod
kubectl logs -n client-dc5fec42 deployment/api
```

### Rollback Customer

```bash
# 1. Identify commit to revert
cd /tmp/iot-k8s-main
git log --oneline --grep="client-dc5fec42"

# 2. Revert commit
git revert <commit-hash>
git push

# 3. Argo CD will auto-sync the revert
argocd app sync client-dc5fec42
```

---

## Environment Variables

### Critical Settings

| Variable | Purpose | Example |
|----------|---------|---------|
| `GITOPS_ENABLED` | Enable GitOps mode | `true` |
| `GITOPS_PAT` | GitHub Personal Access Token | `ghp_xxxxx` |
| `ARGOCD_TOKEN` | Argo CD API token | `eyJhbGci...` |
| `LICENSE_PUBLIC_KEY` | RSA public key (PEM format) | `-----BEGIN PUBLIC KEY-----...` |

**Pro Tip**: Never commit `GITOPS_PAT` to Git. Store in environment or secrets manager.

---

## Directory Structure

```
iot-k8s-main/
├── argocd/
│   └── clients/
│       ├── client-dc5fec42.yaml      # Argo Application (auto-generated)
│       └── client-a1b2c3d4.yaml
│
└── charts/
    └── iotistica-app/
        └── values/
            ├── client-dc5fec42/      # Values file (auto-generated)
            │   └── values.yaml
            └── client-a1b2c3d4/
                └── values.yaml
```

**Where**: `/tmp/iot-k8s-main` (local clone) or GitHub (authoritative source)

---

## Common Issues

### Issue: Customer stuck in 'provisioning'

**Check**:
```bash
# Git commit made?
cd /tmp/iot-k8s-main && git log --oneline -1

# Argo CD syncing?
argocd app get client-<id>

# Pods running?
kubectl get pods -n client-<id>
```

**Fix**:
```bash
# Force Argo sync
argocd app sync client-<id> --force

# If still stuck, check pod events
kubectl describe pod <pod-name> -n client-<id>
```

---

### Issue: Git push fails

**Symptoms**: Worker logs show "push rejected" or "authentication failed"

**Fix**:
```bash
# Verify PAT is valid
curl -H "Authorization: Bearer ${GITOPS_PAT}" https://api.github.com/user

# Regenerate PAT if expired
# https://github.com/settings/tokens

# Update environment variable
export GITOPS_PAT=ghp_new_token
kubectl set env deployment/billing-worker -n billing GITOPS_PAT=$GITOPS_PAT
```

---

### Issue: Argo CD Application not found

**Symptoms**: Status service logs "Application not found (404)"

**Fix**:
```bash
# Check if manifest exists in Git
ls /tmp/iot-k8s-main/argocd/clients/client-<id>.yaml

# If missing, redeploy
curl -X POST http://localhost:3100/api/customers/<customerId>/deploy

# If exists but Argo doesn't see it, force refresh
argocd app list --refresh
```

---

## Namespace Naming Convention

| Input | Output | Notes |
|-------|--------|-------|
| Stripe ID: `cust_dc5fec42901a7b3e` | Client ID: `dc5fec42` | First 8 chars after `cust_` |
| | Namespace: `client-dc5fec42` | Kubernetes format |
| | Manifest: `client-dc5fec42.yaml` | Argo CD Application |

**Why 8 chars?** Kubernetes namespace limit (63 chars) + Helm release suffixes.

---

## Monitoring URLs

| Service | URL | Purpose |
|---------|-----|---------|
| Billing API | http://localhost:3100 | Customer/subscription endpoints |
| Bull Dashboard | http://localhost:3100/admin/queues | Job queue monitoring |
| Argo CD UI | https://argocd.iotistica.com | Application status |
| Argo CD API | https://argocd.iotistica.com/api/v1 | Programmatic access |

---

## Troubleshooting Flow

```
1. Check customer status in DB
   ↓ (if 'provisioning' >5min)
2. Check deployment job status (Bull dashboard)
   ↓ (if job failed)
3. Check worker logs
   ↓ (if Git error)
4. Verify GITOPS_PAT and repo access
   ↓ (if Argo error)
5. Check Argo CD Application status
   ↓ (if OutOfSync)
6. Force sync or check diff
   ↓ (if pods failing)
7. Check Kubernetes events and pod logs
```

---

## Emergency Rollback

**Disable GitOps globally** (reverts to Helm):

```bash
kubectl set env deployment/billing-api -n billing GITOPS_ENABLED=false
kubectl set env deployment/billing-worker -n billing GITOPS_ENABLED=false
```

**Rollback single customer**:

```bash
# Remove from Git
cd /tmp/iot-k8s-main
git rm argocd/clients/client-<id>.yaml
git rm -r charts/iotistica-app/values/client-<id>
git commit -m "Emergency rollback client-<id>"
git push

# Delete Argo Application
argocd app delete client-<id>

# Redeploy via Helm (if needed)
helm upgrade --install client-<id> charts/customer-instance \
  --namespace client-<id> \
  --values /tmp/client-<id>-values.yaml
```

---

## Testing Checklist

Before deploying to production:

- [ ] `GITOPS_PAT` has `repo` scope
- [ ] `ARGOCD_TOKEN` not expired
- [ ] `/tmp/iot-k8s-main` directory exists and writable
- [ ] Argo CD installed in cluster
- [ ] ServiceMonitor CRD installed (if using Prometheus)
- [ ] Billing worker restarted after config changes
- [ ] Test customer deployed successfully
- [ ] Git commit appears with correct author
- [ ] Argo CD synced automatically
- [ ] Customer status reached 'ready'

---

## Support Contacts

- **Documentation**: [billing/docs/](../docs/)
- **Migration Guide**: [GITOPS-MIGRATION-GUIDE.md](GITOPS-MIGRATION-GUIDE.md)
- **Implementation Summary**: [GITOPS-IMPLEMENTATION-SUMMARY.md](GITOPS-IMPLEMENTATION-SUMMARY.md)
- **DevOps Team**: #devops-support (Slack)

---

**Last Updated**: February 21, 2026  
**Version**: 1.0.0-poc
