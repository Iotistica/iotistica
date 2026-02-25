# Testing Stripe → Billing → Git Flow (Without Argo CD)

Quick guide to test the complete flow from Stripe webhook to Git commits **without needing Argo CD running**.

## Prerequisites

- Stripe account (test mode)
- GitHub account
- Git repository: `iot-k8s` (or fork it)

## Setup (5 Minutes)

### 1. Generate License Keys
```bash
cd billing
npm install
npm run generate-keys
```

### 2. Create GitHub Personal Access Token
1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scope: **`repo`** (Full control of private repositories)
4. Generate and copy the token (starts with `ghp_`)

### 3. Configure Environment
```bash
# Copy example
cp .env.example .env

# Edit .env and set these values:
```

```bash
# Stripe (required)
STRIPE_SECRET_KEY=sk_test_51...
STRIPE_PUBLISHABLE_KEY=pk_test_51...
STRIPE_WEBHOOK_SECRET=whsec_...  # Get this after starting stripe-cli
STRIPE_PRICE_STARTER=price_...   # Create in Stripe dashboard
STRIPE_PRICE_PROFESSIONAL=price_...
STRIPE_PRICE_ENTERPRISE=price_...

# License (auto-generated from keys/)
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
... paste from keys/public-key.pem ...
-----END PUBLIC KEY-----"

# GitOps (required)
GITOPS_ENABLED=true
GITOPS_REPO_URL=https://github.com/Iotistica/iot-k8s.git
GITOPS_PAT=ghp_your_github_token_here

# Testing mode - Git commits work, Argo CD check skipped
SKIP_ARGOCD_STATUS_CHECK=true
SIMULATE_K8S_DEPLOYMENT=false
```

## Start Services

```bash
# Start everything
docker-compose up -d

# Watch logs (separate terminals)
docker-compose logs -f billing
docker-compose logs -f worker

# Get Stripe webhook secret
docker logs billing-stripe-cli | grep whsec_
# Copy the whsec_... value and add to .env

# Restart to pick up webhook secret
docker-compose restart billing worker
```

## Test the Flow

### Step 1: Trigger Signup
```bash
stripe trigger checkout.session.completed
```

### Step 2: Watch the Flow
```bash
# Worker logs should show:
docker-compose logs -f worker

# Expected output:
# ✅ Processing deployment { customerId: 'cust_...', gitOpsEnabled: true }
# ✅ Using GitOps provisioning
# ✅ Repository cloned successfully
# ✅ GitOps deployment committed and pushed
# ⏭️ Skipping Argo CD status check (SKIP_ARGOCD_STATUS_CHECK=true)
# ✅ GitOps deployment completed
```

### Step 3: Verify Git Commits
```bash
# Check if files were created in Git repository
cd /path/to/iot-k8s
git pull

# Check Application manifest
ls argocd/clients/
# Should see: client-*.yaml

cat argocd/clients/client-<8-char-id>.yaml
# Should show Argo Application spec

# Check values file
ls charts/iotistica-app/values/
# Should see: client-<8-char-id>/

cat charts/iotistica-app/values/client-<8-char-id>/values.yaml
# Should show license, plan, namespace, etc.

# Check commit history
git log --oneline -5
# Should see commits from "IoTistic Billing Bot"
```

### Step 4: Check Queue Dashboard
```bash
# Open in browser
open http://localhost:3100/admin/queues

# Should show:
# - Completed jobs ✅
# - No failed jobs
```

## What Gets Created

For each customer signup:

1. **Database Record** (PostgreSQL)
   ```sql
   SELECT * FROM customers WHERE email='test@example.com';
   -- deployment_status: 'ready'
   -- instance_namespace: 'client-dc5fec42'
   ```

2. **Git Files** (iot-k8s repository)
   ```
   argocd/clients/client-dc5fec42.yaml        # Argo Application
   charts/iotistica-app/values/
     client-dc5fec42/
       values.yaml                             # Customer config
   ```

3. **Git Commit**
   ```
   Author: IoTistic Billing Bot <billing@iotistic.com>
   Message: Deploy client dc5fec42 (Starter plan)
   ```

## Troubleshooting

### "Git authentication failed"
```bash
# Check PAT is set
docker-compose exec worker printenv GITOPS_PAT

# Test Git access manually
docker-compose exec worker git ls-remote https://${GITOPS_PAT}@github.com/Iotistica/iot-k8s.git
```

### "Stripe webhook signature invalid"
```bash
# Get current webhook secret
docker logs billing-stripe-cli | grep "webhook signing secret"

# Update .env
STRIPE_WEBHOOK_SECRET=whsec_new_value

# Restart
docker-compose restart billing
```

### "Worker not processing jobs"
```bash
# Check worker is running
docker-compose ps worker
# State should be "Up"

# Check Redis connection
docker-compose exec worker redis-cli -h redis ping
# Should return: PONG

# Restart worker
docker-compose restart worker
```

### "Repository not found"
```bash
# Make sure iot-k8s repository exists and you have access
# Clone manually to test:
git clone https://${GITOPS_PAT}@github.com/Iotistica/iot-k8s.git

# Check repository structure:
ls -la iot-k8s/
# Should have: argocd/, charts/ directories
```

## Testing Different Plans

### Starter Plan
```bash
stripe trigger checkout.session.completed \
  --add checkout_session:metadata.plan=starter
```

### Professional Plan
```bash
stripe trigger checkout.session.completed \
  --add checkout_session:metadata.plan=professional
```

### Enterprise Plan
```bash
stripe trigger checkout.session.completed \
  --add checkout_session:metadata.plan=enterprise
```

Each creates different resource configurations in values.yaml:
- **Starter**: Shared Prometheus, 1 replica, 4Gi storage
- **Professional**: Shared Prometheus, 2 replicas, 10Gi storage  
- **Enterprise**: Dedicated Prometheus, 3 replicas, 30Gi storage

## Next Steps

Once this works:

1. ✅ Stripe webhooks → Billing API → Queue → Git commits
2. ⏭️ Install Argo CD on cluster
3. ⏭️ Set `SKIP_ARGOCD_STATUS_CHECK=false`
4. ⏭️ Test full flow with Argo CD deployment

## Success Criteria

You've successfully tested the flow when:

- ✅ Stripe webhook received without errors
- ✅ Job appears in Bull queue dashboard
- ✅ Worker processes job to completion
- ✅ Git repository has new commits
- ✅ Application manifest exists in `argocd/clients/`
- ✅ Values file exists in `charts/.../values/`
- ✅ Customer status = 'ready' in database

All this **without Argo CD running**! 🎉
