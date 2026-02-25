# IoTistic Billing Service

Global billing system with Stripe integration, JWT license generation, and GitOps-based Kubernetes provisioning for multi-tenant SaaS deployments.

## Overview

The billing service manages:
- **Customer subscriptions** via Stripe webhooks
- **JWT license generation** (RS256) with plan-based features
- **GitOps provisioning** - Commits Argo CD manifests to deploy client instances
- **Usage tracking** for metered billing
- **Background job processing** via Bull queues

## Architecture

### GitOps Flow (Current - POC)

```
Stripe Webhook
    ↓
Billing Service (validates signature)
    ↓
Stripe Service (processes event)
    ↓
Deployment Queue (Bull + Redis)
    ↓
Deployment Worker
    ↓
GitOps Provisioning Service
    ↓
Git Commit (iot-k8s-main repo)
    │
    ├─ argocd/clients/client-<id>.yaml
    └─ charts/iotistica-app/values/client-<id>/values.yaml
    ↓
Git Push (GitHub)
    ↓
Argo CD (auto-sync)
    ↓
Kubernetes Deployment
    ↓
Argo Status Service (polls for Healthy/Synced)
    ↓
Customer Status → 'ready'
```

### Legacy Flow (Helm Direct)

When `GITOPS_ENABLED=false`, the service falls back to direct Helm operations:

```
Stripe Webhook → Deployment Queue → K8sDeploymentService → Helm Upgrade → kubectl
```

## Key Components

### Services

- **`stripe-service.ts`** - Handles Stripe webhooks, creates/updates/deletes subscriptions
- **`license-generator.ts`** - Generates RS256 JWT licenses with plan-specific features
- **`gitops-provisioning-service.ts`** - Manages Git commits for Argo CD
- **`argo-status-service.ts`** - Queries Argo CD API for deployment status
- **`k8s-deployment-service.ts`** - Legacy Helm-based provisioning (optional)
- **`deployment-queue.ts`** - Bull queue wrapper for async provisioning

### Workers

- **`deployment-worker.ts`** - Processes deployment/update/delete jobs from queue

### Database Models

- **`customer-model.ts`** - Customer records
- **`subscription-model.ts`** - Subscription plans and status
- **`usage-model.ts`** - Usage metrics for metered billing

## Environment Variables

### Required

```bash
# Server
PORT=3100
NODE_ENV=production

# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/iotistic_billing

# Stripe
STRIPE_SECRET_KEY=sk_live_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
STRIPE_PRICE_STARTER=price_xxxxx
STRIPE_PRICE_PROFESSIONAL=price_xxxxx
STRIPE_PRICE_ENTERPRISE=price_xxxxx

# License Keys (RS256)
LICENSE_PRIVATE_KEY_PATH=./keys/private-key.pem
LICENSE_PUBLIC_KEY_PATH=./keys/public-key.pem
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

### GitOps Configuration

```bash
# Enable GitOps mode (replaces Helm direct)
GITOPS_ENABLED=true

# Git Repository
GITOPS_REPO_URL=https://github.com/Iotistica/iot-k8s.git
GITOPS_REPO_DIR=/tmp/iot-k8s-main
GITOPS_MAIN_BRANCH=main
GITOPS_PAT=ghp_xxxxxxxxxxxxxxxxxxxxx

# Git Author (for commits)
GITOPS_COMMIT_AUTHOR_NAME="IoTistic Billing Bot"
GITOPS_COMMIT_AUTHOR_EMAIL=billing@iotistic.com

# Argo CD Status Polling
ARGOCD_BASE_URL=https://argocd.iotistica.com
ARGOCD_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ARGOCD_STATUS_MAX_RETRIES=10
ARGOCD_STATUS_RETRY_DELAY_MS=5000
```

### Legacy Helm (Optional)

```bash
# Only needed if GITOPS_ENABLED=false
HELM_CHART_PATH=../charts/customer-instance
BASE_DOMAIN=iotistica.com
SIMULATE_K8S_DEPLOYMENT=false
```

### Other

```bash
# Redis (for Bull queues)
REDIS_HOST=localhost
REDIS_PORT=6379

# Trial Period
DEFAULT_TRIAL_DAYS=14

# URLs
BASE_URL=https://billing.iotistica.com
CUSTOMER_PORTAL_URL=https://portal.iotistica.com

# Logging
LOG_LEVEL=info
```

## Setup

### 1. Install Dependencies

```bash
cd billing
npm install
```

### 2. Generate License Keys

```bash
npm run generate-keys
```

This creates:
- `keys/private-key.pem` - Used by billing service to sign JWTs
- `keys/public-key.pem` - Distributed to customer instances for verification

### 3. Configure Environment

```bash
cp .env.example .env
nano .env  # Edit with your values
```

**Critical**: Ensure `LICENSE_PUBLIC_KEY` in `.env` matches the generated public key (including newlines!).

### 4. Database Migration

```bash
npm run migrate
```

### 5. Start Services

**Development (local)**:
```bash
# Start PostgreSQL
docker-compose up -d postgres

# Start billing API
npm run dev

# In another terminal, start worker
npm run worker
```

**Production (Docker)**:
```bash
docker-compose up -d
```

## GitOps Setup

### Prerequisites

1. **GitHub Personal Access Token**
   - Create at: https://github.com/settings/tokens
   - Scopes: `repo` (full control)
   - Set as `GITOPS_PAT` environment variable

2. **Argo CD Installation**
   - Install Argo CD in your cluster: https://argo-cd.readthedocs.io/en/stable/getting_started/
   - Create API token: `argocd account generate-token`
   - Set as `ARGOCD_TOKEN` environment variable

3. **GitOps Repository Structure**
   - The billing service expects:
     ```
     iot-k8s-main/
     ├── argocd/clients/          # Application manifests (auto-generated)
     └── charts/iotistica-app/
         └── values/              # Per-client values (auto-generated)
     ```
   - See [iot-k8s-main/argocd/clients/README.md](../iot-k8s-main/argocd/clients/README.md)

### Testing GitOps Locally

```bash
# Set environment variables
export GITOPS_ENABLED=true
export GITOPS_REPO_DIR=/tmp/iot-k8s-main
export GITOPS_PAT=ghp_xxxxx
export ARGOCD_BASE_URL=https://argocd.iotistica.com
export ARGOCD_TOKEN=eyJhbGci...

# Start billing service
npm run dev

# Trigger test subscription (in another terminal)
node scripts/test-signup-flow.js

# Check Git repo for new files
ls /tmp/iot-k8s-main/argocd/clients/
ls /tmp/iot-k8s-main/charts/iotistica-app/values/
```

## Deployment Flow Details

### 1. Customer Signs Up

User completes Stripe checkout → `checkout.session.completed` webhook

### 2. Subscription Created

```typescript
// stripe-service.ts
handleSubscriptionCreated(subscription) {
  // 1. Create/update subscription in DB
  // 2. Generate license JWT
  // 3. Enqueue deployment job
  deploymentQueue.add('deploy-customer-stack', {
    customerId: 'cust_dc5fec42901a...',
    plan: 'professional',
    licenseKey: 'eyJhbGci...',
    // GitOps fields
    licensePublicKey: process.env.LICENSE_PUBLIC_KEY,
    domain: 'iotistic.com',
  });
}
```

### 3. Worker Processes Job

```typescript
// deployment-worker.ts
handleDeployment(job) {
  if (gitOpsProvisioningService.isEnabled()) {
    // GitOps flow
    const clientId = sanitizeClientId(job.data.customerId); // 'dc5fec42'
    
    // 1. Commit Application manifest
    gitOpsProvisioningService.deployClient({
      clientId,
      namespace: `client-${clientId}`,
      ...job.data,
    });
    
    // 2. Wait for Argo CD
    await argoStatusService.waitForApplicationReady(clientId);
    
    // 3. Mark customer as ready
    CustomerModel.updateDeploymentStatus(customerId, 'ready');
  } else {
    // Legacy Helm flow
    k8sDeploymentService.deployCustomerInstance(...);
  }
}
```

### 4. Argo CD Syncs

Argo CD detects new manifest in Git → applies to cluster → reports status

### 5. Status Confirmed

Billing service polls Argo CD → sees `Synced` + `Healthy` → updates customer status

## Client Naming Convention

| Stripe ID | Sanitized ID | Namespace | Manifest | Values Path |
|-----------|--------------|-----------|----------|-------------|
| `cust_dc5fec42901a7b3e` | `dc5fec42` | `client-dc5fec42` | `client-dc5fec42.yaml` | `values/client-dc5fec42/values.yaml` |

**Why 8 chars?**
- Kubernetes namespace limit: 63 characters
- Helm release names append suffixes (e.g., `-mosquitto`, `-api`)
- Short IDs prevent `metadata.name` length violations

## API Endpoints

### Customer Management

```bash
# Create customer
POST /api/customers
{
  "email": "user@example.com",
  "full_name": "John Doe",
  "company_name": "Acme Corp"
}

# Get customer
GET /api/customers/:customerId

# List customers
GET /api/customers

# Trigger deployment manually
POST /api/customers/:customerId/deploy
```

### Subscriptions

```bash
# Create checkout session
POST /api/subscriptions/checkout
{
  "customerId": "cust_xxxxx",
  "plan": "professional"
}

# Get subscription
GET /api/subscriptions/:customerId

# Cancel subscription
DELETE /api/subscriptions/:customerId
```

### License Management

```bash
# Verify license
POST /api/licenses/verify
{
  "licenseKey": "eyJhbGci..."
}

# Regenerate license (after plan change)
POST /api/licenses/:customerId/regenerate
```

### Queue Monitoring

```bash
# Bull Board UI
http://localhost:3100/admin/queues

# Queue stats (API)
GET /api/admin/jobs
GET /api/admin/jobs/:jobId
```

## Webhooks

### Stripe Webhook Events

Handled events:
- `checkout.session.completed` - New subscription created
- `customer.subscription.created` - Subscription created
- `customer.subscription.updated` - Plan changed
- `customer.subscription.deleted` - Subscription canceled
- `invoice.payment_succeeded` - Payment successful
- `invoice.payment_failed` - Payment failed

**Endpoint**: `POST /api/webhooks/stripe`

**Signature Verification**: Required (validates `STRIPE_WEBHOOK_SECRET`)

### Testing Webhooks Locally

```bash
# Install Stripe CLI
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3100/api/webhooks/stripe

# Copy webhook signing secret to .env
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

## Monitoring

### Queue Dashboard

Visit: http://localhost:3100/admin/queues

Monitor:
- Job counts (active, completed, failed)
- Job details and logs
- Retry attempts
- Queue health

### Logs

```bash
# Billing service logs
docker logs -f billing-api

# Worker logs
docker logs -f billing-worker

# Check specific customer deployment
grep "cust_dc5fec42" logs/billing.log
```

### Database

```sql
-- Check customer deployment status
SELECT customer_id, email, deployment_status, instance_namespace, instance_url
FROM customers
WHERE customer_id = 'cust_dc5fec42901a7b3e';

-- List active subscriptions
SELECT c.email, s.plan, s.status, s.current_period_ends_at
FROM customers c
JOIN subscriptions s ON c.customer_id = s.customer_id
WHERE s.status = 'active';
```

## Troubleshooting

### Deployment Stuck in 'provisioning'

**Symptom**: Customer status never reaches 'ready'

**Possible Causes**:
1. Git push failed (check `GITOPS_PAT`)
2. Argo CD not syncing (check Application status)
3. Argo API unreachable (check `ARGOCD_BASE_URL` and `ARGOCD_TOKEN`)
4. Kubernetes resources failing (check pod status in namespace)

**Debug**:
```bash
# Check job status
curl http://localhost:3100/api/admin/jobs | jq '.[] | select(.customerId == "cust_xxxxx")'

# Check Git repo
ls /tmp/iot-k8s-main/argocd/clients/

# Check Argo CD
argocd app get client-dc5fec42

# Check Kubernetes
kubectl get pods -n client-dc5fec42
```

### License Validation Fails

**Symptom**: Customer instances report "Invalid license" or "Unlicensed mode"

**Possible Causes**:
1. Public key mismatch between billing and customer instance
2. JWT expired (check expiration date)
3. Signature invalid (wrong algorithm)

**Debug**:
```bash
# Verify keys match
npm run verify-keys

# Decode license (without verification)
echo "eyJhbGci..." | cut -d'.' -f2 | base64 -d | jq

# Check customer instance logs
kubectl logs -n client-dc5fec42 deployment/api | grep license
```

### Git Push Fails

**Symptom**: Worker logs show "GitOps deployment failed: push rejected"

**Possible Causes**:
1. Invalid PAT (expired or wrong scopes)
2. Repository access denied
3. Branch protection rules preventing push

**Debug**:
```bash
# Test PAT manually
git clone https://${GITOPS_PAT}@github.com/Iotistica/iot-k8s.git

# Check PAT scopes
curl -H "Authorization: Bearer ${GITOPS_PAT}" https://api.github.com/user

# Check billing service logs
grep "GitOps" logs/billing.log
```

### Argo CD Status Check Timeout

**Symptom**: Deployment fails with "did not reach healthy state within timeout"

**Possible Causes**:
1. Pods not starting (image pull errors, resource limits)
2. Health checks failing (readiness probes)
3. Argo CD sync taking longer than expected

**Debug**:
```bash
# Check Application sync status
argocd app sync client-dc5fec42 --info

# Check sync history
argocd app history client-dc5fec42

# Force sync
argocd app sync client-dc5fec42 --force

# Check pod events
kubectl get events -n client-dc5fec42 --sort-by='.lastTimestamp'
```

## Development Scripts

```bash
# Generate license keys
npm run generate-keys

# Customer management CLI
npm run customer -- --help

# View usage metrics
npm run usage

# Database migrations
npm run migrate

# Type checking
npm run build
```

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
# Requires running PostgreSQL and Redis
docker-compose up -d postgres redis
npm run test:integration
```

### Manual Testing

```bash
# Test Stripe webhook locally
stripe trigger checkout.session.completed

# Test deployment flow
node scripts/test-signup-flow.js
```

## Security Notes (POC)

**⚠️ WARNING**: For this proof-of-concept, secrets are committed as plain YAML in the GitOps repository.

**Production Requirements**:
1. Use ExternalSecrets Operator or Sealed Secrets
2. Store sensitive data in Vault, AWS Secrets Manager, etc.
3. Reference secrets in values files, not inline
4. Rotate credentials regularly
5. Audit Git history for leaked secrets

See: [SECRETS-MANAGEMENT.md](docs/SECRETS-MANAGEMENT.md)

## Migration from Helm Direct

If you have existing customers deployed via Helm:

1. **Enable GitOps gradually**:
   ```bash
   GITOPS_ENABLED=true  # New customers use GitOps
   # Existing customers remain on Helm
   ```

2. **Migrate existing customers**:
   ```bash
   # For each customer, create Git manifests manually
   # Then delete Helm release and let Argo CD take over
   ```

3. **Retire Helm service**:
   ```bash
   # Once all customers migrated, remove k8s-deployment-service.ts
   ```

## References

- [Argo CD Documentation](https://argo-cd.readthedocs.io/)
- [GitOps Principles](https://opengitops.dev/)
- [Stripe Webhooks](https://stripe.com/docs/webhooks)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [Bull Queue Documentation](https://github.com/OptimalBits/bull)

## Contributing

See main repository CONTRIBUTING.md

## License

Proprietary - IoTistic Inc.
