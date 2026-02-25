# GitOps Deployment Verification Checklist

Use this checklist to verify the GitOps refactor is working correctly before production rollout.

---

## Pre-Deployment Setup

### Infrastructure Prerequisites

- [ ] **Argo CD installed** in target cluster
  ```bash
  kubectl get pods -n argocd
  # Should see: argocd-server, argocd-repo-server, argocd-application-controller
  ```

- [ ] **ServiceMonitor CRD installed** (required for monitoring)
  ```bash
  kubectl get crd servicemonitors.monitoring.coreos.com
  # If missing: kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
  ```

- [ ] **GitHub PAT generated** with `repo` scope
  - Created at: https://github.com/settings/tokens
  - Scope: `repo` (Full control of private repositories)
  - Expiration: Set to 90 days with reminder

- [ ] **Argo CD API token generated**
  ```bash
  argocd login argocd.iotistica.com
  argocd account generate-token
  ```

- [ ] **GitOps repository cloned** and writable
  ```bash
  git clone https://github.com/Iotistica/iot-k8s.git /tmp/iot-k8s-main
  cd /tmp/iot-k8s-main
  ls argocd/clients  # Should see README.md and client-demo.yaml
  ```

### Billing Service Configuration

- [ ] **Environment variables set** in `billing/.env`:
  ```bash
  grep -E "GITOPS_|ARGOCD_" billing/.env
  # Should show all GitOps and Argo CD variables
  ```

- [ ] **Dependencies installed**
  ```bash
  cd billing
  grep simple-git package.json
  npm install
  ```

- [ ] **Database migrated** (no schema changes for this refactor)
  ```bash
  npm run migrate
  ```

- [ ] **License keys present** and matching
  ```bash
  ls keys/private-key.pem keys/public-key.pem
  npm run verify-keys  # Should show "Keys match"
  ```

---

## Deployment Verification

### 1. Service Startup

- [ ] **Billing API starts** without errors
  ```bash
  npm run dev
  # Check logs for: "✅ Billing server listening on port 3100"
  ```

- [ ] **Worker starts** and connects to queue
  ```bash
  npm run worker
  # Check logs for: "✅ Deployment worker started"
  ```

- [ ] **GitOps service initializes** repository
  ```bash
  # Check logs for: "Repository cloned successfully" or "Repository updated successfully"
  ls /tmp/iot-k8s-main/.git  # Should exist
  ```

- [ ] **Health check passes**
  ```bash
  curl http://localhost:3100/health
  # Should return: {"status":"healthy","service":"billing"}
  ```

### 2. Test Deployment Flow

- [ ] **Trigger test subscription**
  ```bash
  stripe trigger checkout.session.completed
  # Or use test script:
  node scripts/test-signup-flow.js
  ```

- [ ] **Job enqueued** successfully
  ```bash
  curl http://localhost:3100/admin/queues
  # Check for "deploy-customer-stack" job
  ```

- [ ] **Git commit created**
  ```bash
  cd /tmp/iot-k8s-main
  git pull
  git log --oneline -1
  # Should see commit from "IoTistic Billing Bot"
  ```

- [ ] **Application manifest exists**
  ```bash
  ls argocd/clients/client-*.yaml
  cat argocd/clients/client-<id>.yaml
  # Verify structure matches template
  ```

- [ ] **Values file created**
  ```bash
  ls charts/iotistica-app/values/client-*/values.yaml
  cat charts/iotistica-app/values/client-<id>/values.yaml
  # Verify license key, namespace, customer info
  ```

- [ ] **Git push succeeded**
  ```bash
  # Check worker logs for: "Changes pushed to remote"
  # Verify on GitHub: https://github.com/Iotistica/iot-k8s/commits/main
  ```

### 3. Argo CD Sync

- [ ] **Application created** in Argo CD
  ```bash
  argocd app list | grep client-<id>
  # Should see new Application
  ```

- [ ] **Sync status** is "Synced"
  ```bash
  argocd app get client-<id>
  # Sync Status: Synced
  ```

- [ ] **Health status** is "Healthy"
  ```bash
  argocd app get client-<id>
  # Health Status: Healthy
  ```

- [ ] **Resources deployed** to Kubernetes
  ```bash
  kubectl get all -n client-<id>
  # Should see pods, services, deployments, etc.
  ```

### 4. Customer Status

- [ ] **Deployment status** updated to "ready"
  ```bash
  psql $DATABASE_URL -c "SELECT deployment_status FROM customers WHERE customer_id='cust_xxxxx';"
  # Should return: ready
  ```

- [ ] **Instance namespace** recorded
  ```bash
  psql $DATABASE_URL -c "SELECT instance_namespace FROM customers WHERE customer_id='cust_xxxxx';"
  # Should return: client-<id>
  ```

- [ ] **Instance URL** recorded
  ```bash
  psql $DATABASE_URL -c "SELECT instance_url FROM customers WHERE customer_id='cust_xxxxx';"
  # Should return: https://<id>.iotistic.com
  ```

### 5. Application Health

- [ ] **Pods running** in customer namespace
  ```bash
  kubectl get pods -n client-<id>
  # All pods should be Running
  ```

- [ ] **Services created**
  ```bash
  kubectl get svc -n client-<id>
  # API, Dashboard, PostgreSQL, Mosquitto, Redis services
  ```

- [ ] **Ingress configured**
  ```bash
  kubectl get ingress -n client-<id>
  # Should show customer subdomain
  ```

- [ ] **License validation** working
  ```bash
  kubectl logs -n client-<id> deployment/api | grep -i license
  # Should show "License validated successfully"
  ```

---

## Update Flow Verification

### Test Plan Change

- [ ] **Update subscription** in Stripe dashboard
  - Change plan from Starter → Professional

- [ ] **Update job enqueued**
  ```bash
  curl http://localhost:3100/admin/queues | grep update-customer-stack
  ```

- [ ] **Git commit shows update**
  ```bash
  cd /tmp/iot-k8s-main
  git pull
  git log --oneline -1
  # Should see: "Update client <id>"
  ```

- [ ] **Values file updated**
  ```bash
  cat charts/iotistica-app/values/client-<id>/values.yaml | grep plan
  # Should show: plan: "professional"
  ```

- [ ] **Argo CD resyncs**
  ```bash
  argocd app get client-<id> --refresh
  # Should show OutOfSync → Syncing → Synced
  ```

- [ ] **Pods restarted** (if needed)
  ```bash
  kubectl get pods -n client-<id> -o wide
  # Check AGE column for recent restarts
  ```

---

## Deletion Flow Verification

### Test Subscription Cancellation

- [ ] **Cancel subscription** in Stripe dashboard

- [ ] **Deletion job enqueued**
  ```bash
  curl http://localhost:3100/admin/queues | grep delete-customer-stack
  ```

- [ ] **Git commit removes files**
  ```bash
  cd /tmp/iot-k8s-main
  git pull
  git log --oneline -1
  # Should see: "Delete client <id>"
  ```

- [ ] **Application manifest removed**
  ```bash
  ls argocd/clients/client-<id>.yaml
  # Should not exist (ls: cannot access...)
  ```

- [ ] **Values directory removed**
  ```bash
  ls charts/iotistica-app/values/client-<id>
  # Should not exist
  ```

- [ ] **Argo CD deletes Application**
  ```bash
  argocd app list | grep client-<id>
  # Should not appear in list
  ```

- [ ] **Namespace deleted** from Kubernetes
  ```bash
  kubectl get namespace client-<id>
  # Should show: Error from server (NotFound)
  ```

- [ ] **Customer marked inactive** in database
  ```bash
  psql $DATABASE_URL -c "SELECT is_active, deleted_at FROM customers WHERE customer_id='cust_xxxxx';"
  # is_active: false, deleted_at: <timestamp>
  ```

---

## Error Handling Verification

### Test Failure Scenarios

- [ ] **Invalid PAT** - Set `GITOPS_PAT=invalid`
  - Worker logs show: "GitOps deployment failed: push rejected"
  - Customer status: "failed"
  - Job retries according to Bull config

- [ ] **Argo CD unreachable** - Set `ARGOCD_BASE_URL=http://invalid`
  - Worker logs show: "Failed to get Application status"
  - Customer status: "failed"
  - Job retries according to Bull config

- [ ] **Manifest syntax error** - Manually commit invalid YAML
  - Argo CD shows: "ComparisonError: invalid YAML"
  - Application status: "OutOfSync"
  - Manual fix required

- [ ] **Pod fails to start** - Set invalid image tag
  - Argo CD shows: "Progressing" then "Degraded"
  - Status service returns false after max retries
  - Customer status: "failed"

---

## Performance Verification

### Measure Deployment Times

- [ ] **Baseline timing** (5 deployments)
  ```bash
  # Record time from webhook to customer status = "ready"
  # Target: 45-90 seconds
  ```

- [ ] **Success rate** (20 deployments)
  ```bash
  # Count: successful / total
  # Target: >95%
  ```

- [ ] **Queue depth** under load
  ```bash
  # Simulate 10 concurrent signups
  # Check Bull dashboard for backlog
  # Target: Queue processes at 1-2 jobs/min
  ```

### Resource Usage

- [ ] **Billing API memory** (+50MB expected)
  ```bash
  docker stats billing-api --no-stream
  # Before GitOps: ~150MB
  # After GitOps: ~200MB
  ```

- [ ] **Worker memory** (+20MB expected)
  ```bash
  docker stats billing-worker --no-stream
  # Before GitOps: ~100MB
  # After GitOps: ~120MB
  ```

- [ ] **Disk space** (Git repo clone)
  ```bash
  du -sh /tmp/iot-k8s-main
  # Typical: 50-100MB
  ```

---

## Security Verification

### Credentials Audit

- [ ] **PAT scope minimized** (only `repo`)
  ```bash
  curl -H "Authorization: Bearer ${GITOPS_PAT}" \
       https://api.github.com/user/installations
  # Verify scope: ["repo"]
  ```

- [ ] **Argo token stored securely** (not in Git)
  ```bash
  grep -r ARGOCD_TOKEN . --exclude-dir=.git
  # Should only appear in .env (ignored by Git)
  ```

- [ ] **Secrets not committed** to Git
  ```bash
  cd /tmp/iot-k8s-main
  git log -p | grep -i "password\|secret\|token" | head -20
  # Review: Ensure no real secrets in plain text
  # POC: Plain secrets are expected, document for future resolution
  ```

- [ ] **License public key** matches private key
  ```bash
  npm run verify-keys
  # Output: "✅ Keys match"
  ```

### Access Control

- [ ] **Billing service** cannot run `kubectl` commands
  ```bash
  kubectl auth can-i create deployments --as=system:serviceaccount:billing:billing-api
  # Should return: no
  ```

- [ ] **Argo CD** has cluster admin (required)
  ```bash
  kubectl auth can-i create namespaces --as=system:serviceaccount:argocd:argocd-application-controller
  # Should return: yes
  ```

---

## Rollback Verification

### Test Emergency Rollback

- [ ] **Disable GitOps** via environment variable
  ```bash
  kubectl set env deployment/billing-api -n billing GITOPS_ENABLED=false
  kubectl set env deployment/billing-worker -n billing GITOPS_ENABLED=false
  ```

- [ ] **New customers deploy** via Helm
  ```bash
  stripe trigger checkout.session.completed
  # Check worker logs for: "Using legacy Helm deployment"
  ```

- [ ] **Helm release created**
  ```bash
  helm list -n customer-<id>
  # Should show release
  ```

- [ ] **Re-enable GitOps** and confirm switch
  ```bash
  kubectl set env deployment/billing-worker -n billing GITOPS_ENABLED=true
  # Trigger another signup
  # Check logs for: "Using GitOps provisioning"
  ```

---

## Documentation Verification

### Files Exist and Are Complete

- [ ] **Billing README** (`billing/README.md`)
  - Architecture diagrams present
  - Environment variables documented
  - Troubleshooting section complete

- [ ] **Migration Guide** (`billing/docs/GITOPS-MIGRATION-GUIDE.md`)
  - Step-by-step procedures
  - Prerequisites listed
  - Rollback procedures documented

- [ ] **Implementation Summary** (`billing/docs/GITOPS-IMPLEMENTATION-SUMMARY.md`)
  - File manifest accurate
  - Known limitations documented
  - Next steps defined

- [ ] **Quick Reference** (`billing/docs/GITOPS-QUICK-REFERENCE.md`)
  - Commands tested and working
  - URLs accessible
  - Troubleshooting flow accurate

- [ ] **GitOps Clients README** (`iot-k8s-main/argocd/clients/README.md`)
  - Structure explanation clear
  - Example manifest valid
  - Operator procedures documented

---

## Acceptance Criteria (POC)

### Must Have

- [x] Stripe webhook triggers Git commit
- [x] Argo CD syncs Application automatically
- [x] Customer status reaches 'ready' after sync
- [x] Subscription cancellation deletes Application
- [x] Plan upgrade updates values file
- [x] Dual-mode support (GitOps + Helm)
- [x] Documentation complete

### Should Have (POC)

- [ ] Basic unit tests for GitOps service
- [ ] Integration test for full flow
- [ ] Performance benchmarks recorded
- [ ] Error handling tested

### Nice to Have (Post-POC)

- [ ] Secrets externalized
- [ ] PR workflow implemented
- [ ] Event-driven status (not polling)
- [ ] Automated rollback

---

## Sign-Off

### Test Environment

- **Cluster**: _________________________
- **Argo CD Version**: _________________________
- **Billing Service Version**: _________________________
- **Test Date**: _________________________

### Results

- **Total Deployments Tested**: _________
- **Success Rate**: _________%
- **Average Deployment Time**: _________ seconds
- **Critical Failures**: _________

### Approvals

- [ ] **DevOps Lead**: _________________________ (Date: _________)
- [ ] **Engineering Manager**: _________________________ (Date: _________)
- [ ] **Product Owner**: _________________________ (Date: _________)

---

**Production Deployment Approved**: [ ] Yes [ ] No

**Outstanding Issues**: _____________________________________________

**Next Steps**: _____________________________________________
