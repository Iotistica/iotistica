# GitOps Migration Guide

**From**: Direct Helm provisioning via `k8s-deployment-service.ts`  
**To**: Git-driven provisioning via Argo CD

## Overview

This guide walks through migrating the billing service from imperative Helm deployments to declarative GitOps using Argo CD.

## Why GitOps?

### Current Pain Points (Helm Direct)
- Billing service needs cluster credentials (security risk)
- Difficult to audit what was deployed and when
- No declarative state in version control
- Manual rollback procedures
- Complex drift detection

### GitOps Benefits
- **Single source of truth**: Git is the authoritative state
- **Auditability**: Full commit history of all changes
- **Security**: Billing service only needs Git write access
- **Automation**: Argo CD handles reconciliation
- **DevOps alignment**: CALMS principles (Automation, Measurement)

## Architecture Changes

### Before (Helm Direct)

```
Billing Service
    ↓ (kubectl + helm commands)
Kubernetes API Server
    ↓
Customer Namespaces
```

**Problems**:
- Billing needs `KUBECONFIG` with admin privileges
- No audit trail beyond logs
- State exists only in cluster

### After (GitOps)

```
Billing Service
    ↓ (git commit + push)
GitHub Repository
    ↓ (webhook notification)
Argo CD
    ↓ (kubectl apply)
Customer Namespaces
```

**Benefits**:
- Billing only needs GitHub PAT
- Full Git history = audit trail
- Declarative state in `iot-k8s-main` repo
- Argo CD enforces desired state

## Migration Steps

### Phase 1: Setup GitOps Infrastructure

#### 1.1 Install Argo CD

```bash
# Install Argo CD in cluster
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Wait for pods to be ready
kubectl wait --for=condition=available --timeout=300s \
  deployment/argocd-server -n argocd

# Get admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
```

#### 1.2 Install Argo CD CLI (optional)

```bash
# macOS
brew install argocd

# Linux
curl -sSL -o /usr/local/bin/argocd \
  https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
chmod +x /usr/local/bin/argocd
```

#### 1.3 Generate Argo CD API Token

```bash
# Login
argocd login argocd.iotistica.com --username admin

# Generate token (never expires)
argocd account generate-token --account admin

# Save token to .env
echo "ARGOCD_TOKEN=<token>" >> billing/.env
```

#### 1.4 Generate GitHub PAT

1. Go to https://github.com/settings/tokens/new
2. Select scopes:
   - `repo` (Full control of private repositories)
3. Generate token
4. Save to `.env`:
   ```bash
   echo "GITOPS_PAT=ghp_xxxxx" >> billing/.env
   ```

#### 1.5 Prepare GitOps Repository

```bash
# Clone iot-k8s-main
git clone https://github.com/Iotistica/iot-k8s.git
cd iot-k8s-main

# Create directory structure
mkdir -p argocd/clients
mkdir -p charts/iotistica-app/values

# Copy template files
cp argocd/clients/client-demo.yaml argocd/clients/README.md

# Commit structure
git add argocd/
git commit -m "Add GitOps directory structure for Argo CD"
git push origin main
```

### Phase 2: Update Billing Service

#### 2.1 Install Dependencies

```bash
cd billing
npm install simple-git
```

#### 2.2 Add Environment Variables

Update `billing/.env`:

```bash
# GitOps Configuration
GITOPS_ENABLED=false  # Keep false initially for gradual rollout
GITOPS_REPO_URL=https://github.com/Iotistica/iot-k8s.git
GITOPS_REPO_DIR=/tmp/iot-k8s-main
GITOPS_MAIN_BRANCH=main
GITOPS_PAT=ghp_xxxxxxxxxxxxxxxxxxxxx
GITOPS_COMMIT_AUTHOR_NAME="IoTistic Billing Bot"
GITOPS_COMMIT_AUTHOR_EMAIL=billing@iotistic.com

# Argo CD Status Polling
ARGOCD_BASE_URL=https://argocd.iotistica.com
ARGOCD_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ARGOCD_STATUS_MAX_RETRIES=10
ARGOCD_STATUS_RETRY_DELAY_MS=5000
```

#### 2.3 Deploy Updated Billing Service

```bash
# Build
npm run build

# Restart services
docker-compose restart billing-api billing-worker

# Or in K8s
kubectl rollout restart deployment/billing-api -n billing
```

### Phase 3: Test GitOps Flow

#### 3.1 Enable GitOps for Test Customer

```bash
# In billing/.env
GITOPS_ENABLED=true

# Restart services
docker-compose restart billing-api billing-worker
```

#### 3.2 Trigger Test Subscription

```bash
# Using Stripe CLI
stripe trigger checkout.session.completed

# Or via test script
node scripts/test-signup-flow.js
```

#### 3.3 Verify Git Commit

```bash
cd /tmp/iot-k8s-main
git pull

# Check for new files
ls argocd/clients/client-*.yaml
ls charts/iotistica-app/values/client-*/values.yaml

# View commit
git log --oneline -1
```

#### 3.4 Verify Argo CD Sync

```bash
# List Applications
argocd app list

# Check specific Application
argocd app get client-dc5fec42

# View sync status
argocd app sync client-dc5fec42 --dry-run
```

#### 3.5 Verify Kubernetes Deployment

```bash
# Check namespace
kubectl get namespaces | grep client-

# Check pods
kubectl get pods -n client-dc5fec42

# Check services
kubectl get svc -n client-dc5fec42

# Check ingress
kubectl get ingress -n client-dc5fec42
```

#### 3.6 Verify Billing Status

```bash
# Query customer status
curl http://localhost:3100/api/customers/<customerId>

# Check deployment status field
# Should be: "deployment_status": "ready"
```

### Phase 4: Gradual Rollout

#### 4.1 Run in Parallel Mode

Keep `GITOPS_ENABLED=false` for existing customers while testing:

```typescript
// deployment-worker.ts logic
if (isNewCustomer() && process.env.GITOPS_ENABLED === 'true') {
  // Use GitOps
  await gitOpsProvisioningService.deployClient(...);
} else {
  // Use legacy Helm
  await k8sDeploymentService.deployCustomerInstance(...);
}
```

**Benefits**:
- New customers use GitOps
- Existing customers remain on Helm
- Zero downtime migration

#### 4.2 Monitor Both Systems

```bash
# Watch GitOps deployments
watch argocd app list

# Watch Helm releases
watch helm list --all-namespaces

# Monitor billing queue
curl http://localhost:3100/admin/queues
```

#### 4.3 Migrate Existing Customers (Optional)

For each existing customer:

```bash
# 1. Export current Helm values
helm get values <release-name> -n <namespace> > /tmp/customer-values.yaml

# 2. Create GitOps manifest
cat > argocd/clients/client-<id>.yaml <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: client-<id>
  namespace: argocd
spec:
  # ... (see template)
EOF

# 3. Copy values file
mkdir -p charts/iotistica-app/values/client-<id>
cp /tmp/customer-values.yaml charts/iotistica-app/values/client-<id>/values.yaml

# 4. Commit to Git
git add argocd/clients/client-<id>.yaml \
        charts/iotistica-app/values/client-<id>/values.yaml
git commit -m "Migrate customer <id> to GitOps"
git push

# 5. Let Argo CD adopt resources
argocd app create client-<id> \
  --repo https://github.com/Iotistica/iot-k8s.git \
  --path charts/iotistica-app \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace client-<id> \
  --helm-set-file values=values/client-<id>/values.yaml

# 6. Delete Helm release (Argo CD now manages resources)
helm uninstall <release-name> -n <namespace> --keep-history
```

### Phase 5: Full Cutover

#### 5.1 Enable GitOps Globally

```bash
# In billing/.env
GITOPS_ENABLED=true

# Restart services
kubectl rollout restart deployment/billing-api -n billing
kubectl rollout restart deployment/billing-worker -n billing
```

#### 5.2 Remove Legacy Code (Optional)

**Warning**: Only after all customers migrated and verified!

```bash
# Backup k8s-deployment-service.ts
cp src/services/k8s-deployment-service.ts src/services/k8s-deployment-service.ts.backup

# Remove Helm service
rm src/services/k8s-deployment-service.ts

# Update imports in deployment-worker.ts
# Remove: import { k8sDeploymentService } from '../services/k8s-deployment-service';

# Rebuild
npm run build
```

#### 5.3 Clean Up Environment Variables

Remove unused Helm variables from `.env`:
```bash
# Can be removed after migration
# HELM_CHART_PATH
# SIMULATE_K8S_DEPLOYMENT
```

## Rollback Procedures

### Rollback to Helm (Emergency)

If GitOps has critical issues:

```bash
# 1. Disable GitOps immediately
kubectl set env deployment/billing-api -n billing GITOPS_ENABLED=false
kubectl set env deployment/billing-worker -n billing GITOPS_ENABLED=false

# 2. Verify Helm service is still available
kubectl exec -it deployment/billing-api -n billing -- \
  ls src/services/k8s-deployment-service.js

# 3. Test Helm deployment
node scripts/test-helm-deployment.js

# 4. Fix GitOps issues before re-enabling
```

### Rollback Single Customer

If a specific customer deployment fails via GitOps:

```bash
# 1. Remove GitOps manifests
git rm argocd/clients/client-<id>.yaml
git rm -r charts/iotistica-app/values/client-<id>
git commit -m "Rollback customer <id> to Helm"
git push

# 2. Delete Argo Application
argocd app delete client-<id>

# 3. Deploy via Helm manually
helm upgrade --install client-<id> charts/customer-instance \
  --namespace client-<id> \
  --create-namespace \
  --values /tmp/customer-<id>-values.yaml
```

## Troubleshooting

### Git Push Fails

**Error**: `remote: Permission to Iotistica/iotistic.git denied`

**Solution**:
```bash
# Verify PAT has correct scopes
curl -H "Authorization: Bearer ${GITOPS_PAT}" https://api.github.com/user

# Update PAT
export GITOPS_PAT=ghp_new_token
kubectl set env deployment/billing-worker -n billing GITOPS_PAT=$GITOPS_PAT
```

### Argo CD Not Syncing

**Error**: Application stuck in "OutOfSync"

**Solution**:
```bash
# Check Application details
argocd app get client-<id>

# View diff
argocd app diff client-<id>

# Force sync
argocd app sync client-<id> --force

# Check Argo CD logs
kubectl logs -n argocd deployment/argocd-application-controller
```

### Application Never Becomes Healthy

**Error**: Worker logs show "did not reach healthy state within timeout"

**Solution**:
```bash
# Check pod status
kubectl get pods -n client-<id>

# Check events
kubectl get events -n client-<id> --sort-by='.lastTimestamp'

# Check Application events
argocd app get client-<id> --refresh

# Increase timeout if pods are slow to start
export ARGOCD_STATUS_MAX_RETRIES=20
export ARGOCD_STATUS_RETRY_DELAY_MS=10000
```

### Customer Status Stuck in 'provisioning'

**Possible Causes**:
1. Git push succeeded but Argo CD webhook not triggered
2. Argo CD syncing but health checks failing
3. Argo status service timeout

**Debug**:
```bash
# Check if commit made it to Git
git log --oneline --grep="client-<id>"

# Check if Application exists
argocd app get client-<id>

# Force sync
argocd app sync client-<id>

# Manually update customer status (workaround)
psql $DATABASE_URL -c "UPDATE customers SET deployment_status='ready' WHERE customer_id='cust_xxxxx';"
```

## Validation Checklist

Before declaring migration complete:

- [ ] All new customers deploy via GitOps
- [ ] No Helm errors in billing logs
- [ ] Argo CD status checks working
- [ ] Git commits show author as "IoTistic Billing Bot"
- [ ] Customer deployment status accurately reflects Argo CD state
- [ ] Subscription cancellations delete Argo Applications
- [ ] Plan upgrades update values files correctly
- [ ] Bull queue processing GitOps jobs successfully
- [ ] Monitoring dashboards show GitOps metrics
- [ ] Documentation updated for operators
- [ ] Rollback procedure tested and documented

## Performance Comparison

### Metrics to Track

| Metric | Helm Direct | GitOps | Notes |
|--------|-------------|--------|-------|
| Deployment Time | 30-60s | 45-90s | +15-30s for Git/Argo |
| Failure Rate | 2-3% | <1% | Retry logic improved |
| Auditability | Logs only | Full Git history | Major improvement |
| Security Risk | High (cluster creds) | Low (Git PAT) | Reduced attack surface |
| Rollback Time | Manual | Automated | Git revert + Argo sync |

### Expected Impact (POC)

- **Deployment Time**: Slight increase (acceptable for POC)
- **Auditability**: 100% improvement (Git history)
- **Security**: Reduced credential scope
- **Operational Complexity**: Initial increase, long-term decrease

## Next Steps (Post-POC)

After POC validation, consider:

1. **Secrets Management**: Replace plain YAML with ExternalSecrets/Vault
2. **Multi-Branch Strategy**: Use PR flow instead of direct commits
3. **Argo CD Webhooks**: Replace polling with event-driven status updates
4. **Resource Management**: Add resource quotas per plan tier
5. **Cost Tracking**: Integrate usage metrics from billing exporter
6. **GitOps Analytics**: Monitor commit-to-deployment latency

## References

- [Argo CD Best Practices](https://argo-cd.readthedocs.io/en/stable/user-guide/best_practices/)
- [GitOps Principles](https://opengitops.dev/)
- [Argo CD vs Flux](https://www.weave.works/blog/argo-cd-flux-compared)

## Support

Questions? Contact DevOps team or see [billing/docs/README.md](README.md)
