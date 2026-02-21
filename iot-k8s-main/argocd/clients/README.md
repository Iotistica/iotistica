# Argo CD Client Manifests

This directory contains Argo CD `Application` manifests for individual clients (customers) deployed in the IoTistic platform.

## Overview

Each client gets:
- A dedicated namespace (`client-<id>`)
- An Argo CD `Application` manifest (`client-<id>.yaml`)
- A per-client values file (`../../charts/iotistica-app/values/client-<id>/values.yaml`)

The billing service automatically manages these manifests via Git commits when Stripe subscriptions are created/updated/deleted.

## Architecture

```
iot-k8s-main/
├── argocd/
│   └── clients/                      # Argo CD Application manifests (managed by billing)
│       ├── README.md                 # This file
│       ├── client-demo.yaml          # Example/demo client
│       └── client-dc5fec42.yaml      # Auto-generated per customer
│
└── charts/
    └── iotistica-app/
        ├── Chart.yaml
        ├── templates/                # Helm templates (shared)
        └── values/
            ├── demo/values.yaml      # Demo environment values
            └── client-dc5fec42/      # Per-client values (managed by billing)
                └── values.yaml
```

## GitOps Flow

```
Stripe Webhook
    ↓
Billing Service
    ↓
Git Commit (argocd/clients/client-<id>.yaml)
    ↓
Argo CD (auto-sync)
    ↓
Kubernetes Deployment
```

## Client Manifest Structure

Each `client-<id>.yaml` is an Argo CD `Application` that:
1. References the shared Helm chart (`charts/iotistica-app`)
2. Points to a client-specific values file
3. Deploys to a dedicated namespace
4. Enables auto-sync with self-healing

Example:
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: client-dc5fec42
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/Iotistica/iotistic.git
    targetRevision: main
    path: charts/iotistica-app
    helm:
      valueFiles:
        - values/client-dc5fec42/values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: client-dc5fec42
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

## Values File Structure

Each client's `values.yaml` contains:
- License key (JWT token) - **POC: plain text in Git**
- License public key (RSA public key for validation)
- MQTT broker configuration
- Database credentials
- Monitoring settings (plan-based)
- Ingress hosts (client subdomain)

**Security Note (POC)**: For this proof-of-concept, secrets are committed as plain YAML. Production deployments should use:
- ExternalSecrets Operator
- Sealed Secrets
- Vault integration
- Or similar secret management tooling

## Provisioning Process

### Creation (Stripe subscription created)
1. Billing service receives webhook from Stripe
2. Generates license JWT with plan-specific features
3. Sanitizes customer ID: `cust_dc5fec42901a...` → `dc5fec42`
4. Creates `argocd/clients/client-dc5fec42.yaml`
5. Creates `charts/iotistica-app/values/client-dc5fec42/values.yaml`
6. Commits and pushes to `main` branch
7. Argo CD detects change and deploys automatically

### Update (Subscription plan changed)
1. Billing service receives webhook
2. Regenerates license JWT with new features
3. Updates values file with new license
4. Commits and pushes
5. Argo CD syncs changes

### Deletion (Subscription canceled)
1. Billing service receives webhook
2. Removes `argocd/clients/client-<id>.yaml`
3. Removes `charts/iotistica-app/values/client-<id>/` directory
4. Commits and pushes
5. Argo CD deletes Application (prunes all resources)

## Client ID Format

Client IDs are derived from Stripe customer IDs:
- Stripe format: `cust_dc5fec42901a7b3e...` (28 chars)
- Sanitized format: `dc5fec42` (8 chars)
- Namespace: `client-dc5fec42`
- Manifest: `client-dc5fec42.yaml`

This ensures:
- Kubernetes namespace length limits (63 chars)
- DNS-compatible naming (lowercase alphanumeric + hyphens)
- Consistent naming across Git and K8s

## Monitoring Status

After committing manifests, the billing service queries Argo CD's API to confirm deployment:
- Check `Application.status.sync.status` = `Synced`
- Check `Application.status.health.status` = `Healthy`
- Update customer record in billing database to `deployment_status='active'`

The billing service will retry Argo status checks with exponential backoff but caps attempts to avoid continuous polling.

## Manual Operations

### View client deployments
```bash
# List all client Applications
kubectl get applications -n argocd -l managed-by=iotistic

# View specific client
argocd app get client-dc5fec42

# Check sync status
argocd app sync client-dc5fec42 --dry-run
```

### Manually create a client (testing)
```bash
# 1. Create values file
mkdir -p charts/iotistica-app/values/client-test123
cp charts/iotistica-app/values/demo/values.yaml \
   charts/iotistica-app/values/client-test123/values.yaml

# 2. Edit values (license, secrets, etc.)
nano charts/iotistica-app/values/client-test123/values.yaml

# 3. Create Application manifest
cat > argocd/clients/client-test123.yaml <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: client-test123
  namespace: argocd
  labels:
    managed-by: iotistic
spec:
  project: default
  source:
    repoURL: https://github.com/Iotistica/iotistic.git
    targetRevision: main
    path: charts/iotistica-app
    helm:
      valueFiles:
        - values/client-test123/values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: client-test123
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
EOF

# 4. Commit and push
git add argocd/clients/client-test123.yaml \
        charts/iotistica-app/values/client-test123/values.yaml
git commit -m "Add test client test123"
git push

# 5. Wait for Argo CD to sync (or force sync)
argocd app sync client-test123
```

### Delete a client
```bash
# Remove manifest files
rm argocd/clients/client-test123.yaml
rm -rf charts/iotistica-app/values/client-test123

# Commit and push
git add -A
git commit -m "Remove client test123"
git push

# Argo CD will automatically prune the namespace and all resources
```

## Troubleshooting

### Application stuck in "OutOfSync"
```bash
# Check what's different
argocd app diff client-dc5fec42

# Force sync
argocd app sync client-dc5fec42 --force
```

### Health check failing
```bash
# Check application health details
argocd app get client-dc5fec42 --show-operation

# Check pod status in namespace
kubectl get pods -n client-dc5fec42
kubectl describe pod <pod-name> -n client-dc5fec42
```

### License validation errors
Check the values file contains valid JWT:
```bash
# Extract license from values
grep "licenseKey:" charts/iotistica-app/values/client-dc5fec42/values.yaml

# Decode JWT (without verification)
echo "<jwt-token>" | cut -d'.' -f2 | base64 -d | jq
```

### Billing service can't push to repo
- Verify `GITOPS_PAT` environment variable is set
- Check GitHub PAT has `repo` scope
- Ensure billing service has write access to repository
- Check commit/push logs in billing service

## Environment Variables (Billing Service)

The billing service requires these variables to manage GitOps:

```bash
# GitOps Configuration
GITOPS_ENABLED=true                              # Enable GitOps mode
GITOPS_REPO_URL=https://github.com/Iotistica/iotistic.git
GITOPS_REPO_DIR=/tmp/iot-k8s-main               # Local clone path
GITOPS_MAIN_BRANCH=main                          # Target branch
GITOPS_PAT=ghp_xxxxxxxxxxxxxxxxxxxxx            # GitHub Personal Access Token
GITOPS_COMMIT_AUTHOR_NAME="IoTistic Billing Bot"
GITOPS_COMMIT_AUTHOR_EMAIL="billing@iotistic.com"

# Argo CD Status Polling
ARGOCD_BASE_URL=https://argocd.iotistic.com     # Argo CD API endpoint
ARGOCD_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI...     # Argo CD API token
ARGOCD_STATUS_MAX_RETRIES=10                     # Max status check attempts
ARGOCD_STATUS_RETRY_DELAY_MS=5000               # Delay between retries
```

## References

- [Argo CD Application Spec](https://argo-cd.readthedocs.io/en/stable/operator-manual/application.yaml)
- [Helm Value Files](https://helm.sh/docs/chart_template_guide/values_files/)
- [Kubernetes Namespace Naming](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/)
