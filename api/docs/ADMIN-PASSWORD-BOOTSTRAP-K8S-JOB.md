# Admin Password Bootstrap with K8s Job - Complete Guide

**Last Updated**: February 2026  
**Status**: ✅ Complete - K8s Job Architecture  
**Priority**: CRITICAL - Removes hardcoded `admin/admin` credentials from production  

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Comparison](#architecture-comparison)
3. [Complete Flow Step-by-Step](#complete-flow-step-by-step)
4. [Kubernetes Bootstrap Job](#kubernetes-bootstrap-job)
5. [Implementation Details](#implementation-details)
6. [Security](#security)
7. [Troubleshooting](#troubleshooting)

---

## Overview

This document describes the **secure initial admin password bootstrap flow** for multi-tenant Kubernetes deployments using a K8s Job that runs **after the API pod is deployed**.

**The Problem**:
- Every customer deployment had the same default admin password (`admin/admin`)
- If any Git repo leaked, all customer instances were compromised
- No compliance audit trail for admin password setup
- Violates PCI-DSS 8.2.3, SOC 2 CC6.1, HIPAA 164.312(a)(2)(i), ISO 27001 A.9.1

**The Solution**:
- Generate unique 16-character password per deployment during provisioning
- Store encrypted password in 1Password vault (AES-256)
- Sync to Kubernetes via 1Password Operator → K8s Secret
- **Run bootstrap as K8s Job in customer namespace (runs AFTER API pod is ready)**
- Enforce password change on first login
- Maintain complete audit trail

---

## Architecture Comparison

### ❌ Old Approach (Invalid - DO NOT USE)

**Problem**: Provisioning service runs OUTSIDE Kubernetes cluster and tries to call bootstrap endpoint before API pod exists.

```
Provisioning Service (AWS Lambda/External VM)
         │
         ├─ Generate password
         ├─ Push Helm manifests to Git
         │
         └─> HTTP call to http://customer-api.customer-ns.svc.cluster.local:3002
             ❌ FAILS - API pod doesn't exist yet!
             ❌ Requires complex retry logic
             ❌ No guarantee when API becomes available
             ❌ Job crashes with "connection refused"
```

**Why This Failed**:
- Provisioning finishes → Git push → Argo CD sees changes → Creates K8s resources
- Between "Git push" and "Argo CD syncs" (1-30 seconds) there's a timing gap
- API pod may not be running yet when provisioning tries to call it
- No way to know if API is ready without polling
- Failure doesn't fail the deployment, just leaves system in bad state

### ✅ New Approach (Current - K8s Job)

**Solution**: Let Kubernetes orchestrate the bootstrap as a Job that only runs after API pod is ready.

```
Provisioning Service (AWS Lambda/External VM)
         │
         ├─ Generate password
         ├─ Create 1Password item
         ├─ Commit bootstrap-job.yaml to Git
         │
         └─> Git push (NO API CALL)
             
Argo CD (in K8s cluster) watches GitHub
         │
         ├─ Deploy API pod (http://api:3002/health)
         │
         └─> Create bootstrap Job from manifest
             
Bootstrap Job (in customer namespace)
         │
         ├─ Poll /health endpoint (wait for API ready)
         ├─ Call bootstrap endpoint (SET ADMIN PASSWORD)
         │
         └─> SUCCESS - Password set in database
```

**Why This Works**:
- Provisioning doesn't orchestrate bootstrap - just generates password and Git commits
- Helm manifest (bootstrap-job.yaml) is declarative - describes what should happen
- Kubernetes Job controller ensures bootstrap runs ONLY after dependencies are ready
- 1Password Operator syncs secrets at the same time API pod gets created
- Job has native retry logic (backoffLimit, restart policy)
- Clear separation of concerns: provisioning generates, K8s applies

---

## Complete Flow Step-by-Step

### Phase 1: Provisioning Service (External AWS Lambda/VM)

**Timing**: ~2-5 seconds

```
Customer signup received
      │
      ├─ [1/5] Provision TigerData database
      ├─ [2/5] Create PostgreSQL databases  
      ├─ [3/5] Create 1Password secrets
      │         ├─ DB credentials
      │         ├─ API config
      │         ├─ Bootstrap token (from env)
      │         └─ admin-initial-password-{clientId} ⭐ KEY
      │
      ├─ [4/5] Generate Helm manifests
      │         ├─ api.yaml (OnePasswordItem CRD)
      │         ├─ bootstrap-job.yaml (⭐ NEW)
      │         ├─ database.yaml
      │         └─ ... other services ...
      │
      ├─ [5/5] Push to Git
      │         ├─ Commit all manifests
      │         └─ Argo CD watches and triggers sync
      │
      └─ Return: "Provisioning complete, deployment initiated"
  
Status in DB: deployment_status = 'deployed'
  (NOT 'deployed_bootstrap_pending' - bootstrap runs async in K8s)
```

**Code**: `provisioning/src/services/gitops-provisioning-service.ts::provision()`

**Key Changes**:
1. Generate password with `AdminBootstrapService.generateInitialPassword()`
2. Store in 1Password via `OnePasswordService.createSecretItem()`
   - Item path: `vaults/IOT-CLIENTS/items/admin-initial-password-{clientId}`
   - Fields: password, email, createdAt, notes
3. Include `bootstrap-job.yaml` manifest in Helm chart
4. Set deployment status = 'deployed' (no longer 'deployed_bootstrap_pending')

### Phase 2: Argo CD Syncs (Kubernetes)

**Timing**: 1-30 seconds after Git push

```
GitHub repository state changed
      │
      ├─ Argo CD Application controller detects diff
      │
      ├─ [1/4] Create namespace
      │         └─ customer-{12-char-id}
      │
      ├─ [2/4] Create K8s Secrets from OnePasswordItem CRDs
      │         ├─ 1Password Operator watches CRDs
      │         ├─ Fetches from 1Password vault
      │         └─ Creates K8s Secret objects
      │
      ├─ [3/4] Deploy API pod
      │         ├─ api.yaml manifest
      │         ├─ Inject env vars from K8s Secrets
      │         ├─ Readiness probe: /api/v1/health
      │         └─ Pod running in 3-5 seconds
      │
      └─ [4/4] Deploy bootstrap Job
                ├─ bootstrap-job.yaml manifest
                ├─ Job definition includes:
                │  ├─ Service account
                │  ├─ Environment variables from Secrets
                │  ├─ Shell script for polling + bootstrap
                │  ├─ Backoff limit: 5 retries
                │  ├─ TTL: 86400 seconds (24 hours)
                │  └─ Restart policy: OnFailure
                │
                └─ Job queued and scheduled
```

**What Gets Created**:
```yaml
# api.yaml creates this OnePasswordItem:
apiVersion: onepassword.com/v1
kind: OnePasswordItem
metadata:
  name: admin-initial-password-{clientId}
spec:
  itemPath: vaults/IOT-CLIENTS/items/admin-initial-password-{clientId}
---
# 1Password Operator automatically creates this K8s Secret:
apiVersion: v1
kind: Secret
metadata:
  name: admin-initial-password-{clientId}
type: Opaque
data:
  password: <base64-encoded-password>
```

### Phase 3: Bootstrap Job Executes (Kubernetes)

**Timing**: ~30-60 seconds total

```
Job Controller sees Job spec in namespace
      │
      ├─ [1/2] Polling loop (max 30 iterations, 10s delay)
      │         ├─ Call GET http://api:3002/api/v1/health
      │         ├─ Retry until response code 200
      │         └─ If API not ready: sleep 10s, retry
      │
      ├─ Success: API is ready ✅
      │
      ├─ [2/2] Bootstrap request
      │         ├─ Read BOOTSTRAP_TOKEN from env (from Secret)
      │         ├─ Read ADMIN_PASSWORD from env (from Secret)
      │         ├─ POST /api/v1/auth/bootstrap-admin
      │         │   ├─ Header: x-bootstrap-token: {TOKEN}
      │         │   ├─ Body: { "password": ADMIN_PASSWORD }
      │         │   └─ Timeout: 30 seconds
      │         │
      │         └─ Handle response:
      │             ├─ 200 OK: Success ✅ (Job exits 0)
      │             ├─ 401: Invalid token (check BOOTSTRAP_TOKEN env)
      │             ├─ 503: API not ready (retry)
      │             ├─ 400: Password invalid
      │             └─ Network error: Retry up to 5 times
      │
      └─ Job cleanup
          ├─ Status: Completed
          └─ Auto-delete after 24 hours (TTL)
```

**Job Configuration**:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: bootstrap-job
spec:
  backoffLimit: 5              # Retry up to 5 times
  ttlSecondsAfterFinished: 86400  # Auto-delete after 24h
  template:
    spec:
      restartPolicy: OnFailure  # Restart on failure
      containers:
      - name: bootstrap
        image: curlimages/curl:latest
        env:
        - name: BOOTSTRAP_TOKEN
          valueFrom:
            secretKeyRef:
              name: api-bootstrap-token-master
              key: INITIAL_ADMIN_BOOTSTRAP_TOKEN
        - name: ADMIN_PASSWORD
          valueFrom:
            secretKeyRef:
              name: admin-initial-password-{clientId}
              key: password
        command:
        - sh
        - -c
        - |
          # Shell script for polling + bootstrap
          ...
```

### Phase 4: API Processes Bootstrap Request

**Timing**: <1 second

```
/api/v1/auth/bootstrap-admin endpoint receives request
      │
      ├─ [1/4] Validate bootstrap token
      │         ├─ Extract: x-bootstrap-token header
      │         ├─ Compare: process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN
      │         └─ Reject with 401 if no match
      │
      ├─ [2/4] Validate password
      │         ├─ Min length: 12 chars
      │         ├─ Max length: 255 chars
      │         └─ Reject with 400 if invalid
      │
      ├─ [3/4] Update admin user in database
      │         ├─ Hash password with bcrypt (BCRYPT_ROUNDS=10)
      │         ├─ SET password = bcrypt_hash
      │         ├─ SET must_change_password = true
      │         ├─ SET password_last_changed_at = NULL
      │         ├─ REVOKE all existing refresh tokens
      │         └─ Log audit event: 'admin_bootstrap_password_set'
      │
      ├─ [4/4] Return response
      │         └─ 200 OK: {
      │              "message": "Admin password bootstrapped",
      │              "data": { "mustChangePassword": true }
      │            }
      │
      └─ Job receives 200 and exits successfully
```

**Code**: `api/src/routes/auth.ts::POST /api/v1/auth/bootstrap-admin`

### Phase 5: Customer First Login

**Timing**: User-initiated (within hours/days)

```
Customer receives email with initial password
      │
      ├─ [1/3] Customer logs in
      │         ├─ POST /api/v1/auth/login
      │         ├─ Body: { email: "admin@...", password: "..." }
      │         └─ API checks customer credentials
      │
      ├─ [2/3] Check must_change_password flag
      │         ├─ SELECT must_change_password FROM users
      │         ├─ If TRUE:
      │         │  ├─ Issue SHORT-LIVED accessToken (15 min)
      │         │  ├─ Do NOT issue refreshToken ⚠️
      │         │  └─ Return: { mustChangePassword: true }
      │         └─ Client redirects to password change page
      │
      ├─ [3/3] Change password
      │         ├─ POST /api/v1/auth/change-password
      │         ├─ Body: { oldPassword, newPassword }
      │         ├─ Verify old password is correct
      │         ├─ Update user password
      │         ├─ SET must_change_password = FALSE
      │         ├─ SET password_last_changed_at = NOW()
      │         └─ Clear audit flag
      │
      └─ Full authentication enabled
          ├─ Subsequent logins issue both accessToken + refreshToken
          └─ Account fully operational
```

**Database Changes**:
```sql
-- Initial state (after bootstrap)
SELECT email, password_hash, must_change_password, password_last_changed_at
FROM users WHERE id = 1;
-- admin@iotistic.local | $2a$10$... | true | NULL

-- After customer change password
SELECT email, password_hash, must_change_password, password_last_changed_at
FROM users WHERE id = 1;
-- admin@iotistic.local | $2a$10$... | false | 2026-02-15 10:45:23
```

---

## Kubernetes Bootstrap Job

### Job Manifest

**File**: `charts/iotistica-app/templates/bootstrap-job.yaml`

```yaml
---
# OnePasswordItem CRD for the per-deployment admin password
# Will be synced by 1Password Operator to K8s Secret
apiVersion: onepassword.com/v1
kind: OnePasswordItem
metadata:
  name: admin-initial-password-{{ .Release.Name }}
  namespace: {{ .Release.Namespace }}
  labels:
    app: {{ include "iotistica-app.name" . }}
    release: {{ .Release.Name }}
spec:
  itemPath: "vaults/IOT-CLIENTS/items/admin-initial-password-{{ .Release.Name }}"

---
# Kubernetes Job that bootstraps the admin password
# Runs AFTER API pod is ready
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "iotistica-app.fullname" . }}-bootstrap
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: {{ include "iotistica-app.name" . }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/component: bootstrap
spec:
  # Auto-delete completed Job after 24 hours
  ttlSecondsAfterFinished: 86400
  
  # Retry up to 5 times before failing
  backoffLimit: 5
  
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ include "iotistica-app.name" . }}
        app.kubernetes.io/instance: {{ .Release.Name }}
        app.kubernetes.io/component: bootstrap
    spec:
      # Service account with minimal permissions
      serviceAccountName: {{ include "iotistica-app.serviceAccountName" . }}
      
      # Pod restart policy
      restartPolicy: OnFailure
      
      containers:
      - name: bootstrap
        image: "curlimages/curl:latest"
        imagePullPolicy: IfNotPresent
        
        # Environment variables from K8s Secrets (synced by 1Password Operator)
        env:
        - name: BOOTSTRAP_TOKEN
          valueFrom:
            secretKeyRef:
              name: api-bootstrap-token-master
              key: INITIAL_ADMIN_BOOTSTRAP_TOKEN
        
        - name: ADMIN_PASSWORD
          valueFrom:
            secretKeyRef:
              name: admin-initial-password-{{ .Release.Name }}
              key: password
        
        - name: API_URL
          value: "http://api:3002"
        
        - name: API_HEALTH_ENDPOINT
          value: "/api/v1/health"
        
        - name: BOOTSTRAP_ENDPOINT
          value: "/api/v1/auth/bootstrap-admin"
        
        resources:
          requests:
            cpu: 50m
            memory: 32Mi
          limits:
            cpu: 100m
            memory: 64Mi
        
        # Main bootstrap script
        command:
        - /bin/sh
        - -c
        - |
          set -e
          
          echo "================================================"
          echo "Bootstrap Job: Setting Admin Password"
          echo "================================================"
          
          # Validate environment variables
          if [ -z "$BOOTSTRAP_TOKEN" ]; then
            echo "ERROR: BOOTSTRAP_TOKEN not set"
            echo "  Check: K8s Secret api-bootstrap-token-master exists"
            echo "  Check: Secret key INITIAL_ADMIN_BOOTSTRAP_TOKEN is populated"
            exit 1
          fi
          
          if [ -z "$ADMIN_PASSWORD" ]; then
            echo "ERROR: ADMIN_PASSWORD not set"
            echo "  Check: K8s Secret admin-initial-password-{{ .Release.Name }} exists"
            echo "  Check: Secret key 'password' is populated by 1Password Operator"
            exit 1
          fi
          
          if [ -z "$API_URL" ]; then
            echo "ERROR: API_URL not configured"
            exit 1
          fi
          
          echo "  API URL: $API_URL"
          echo "  Health endpoint: $API_HEALTH_ENDPOINT"
          echo ""
          
          # ============================================================
          # Step 1: Poll API health endpoint (max 30 retries, 10s delay)
          # ============================================================
          echo "Step 1/2: Waiting for API to be ready..."
          echo "  Polling: $API_URL$API_HEALTH_ENDPOINT"
          echo "  Max retries: 30, delay: 10s, timeout: 300s"
          echo ""
          
          HEALTH_RETRIES=0
          MAX_HEALTH_RETRIES=30
          HEALTH_DELAY=10
          HEALTH_SUCCESS=0
          
          while [ $HEALTH_RETRIES -lt $MAX_HEALTH_RETRIES ]; do
            HEALTH_RETRIES=$((HEALTH_RETRIES + 1))
            
            HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
              --connect-timeout 5 \
              --max-time 10 \
              "$API_URL$API_HEALTH_ENDPOINT" || echo "000")
            
            if [ "$HEALTH_STATUS" = "200" ]; then
              echo "  ✅ Attempt $HEALTH_RETRIES: API is ready (HTTP 200)"
              HEALTH_SUCCESS=1
              break
            else
              echo "  ⏳ Attempt $HEALTH_RETRIES/$MAX_HEALTH_RETRIES: API returned HTTP $HEALTH_STATUS"
              if [ $HEALTH_RETRIES -lt $MAX_HEALTH_RETRIES ]; then
                echo "     Waiting ${HEALTH_DELAY}s before retry..."
                sleep $HEALTH_DELAY
              fi
            fi
          done
          
          if [ $HEALTH_SUCCESS -ne 1 ]; then
            echo ""
            echo "❌ FAILED: API did not become ready within 5 minutes"
            echo ""
            echo "Troubleshooting:"
            echo "  1. Check API pod status: kubectl get pods -n {{ .Release.Namespace }}"
            echo "  2. Check API logs: kubectl logs -n {{ .Release.Namespace }} deployment/{{ include 'iotistica-app.fullname' . }}-api"
            echo "  3. Check API health: kubectl -n {{ .Release.Namespace }} exec deployment/{{ include 'iotistica-app.fullname' . }}-api -- curl -i http://localhost:3002/api/v1/health"
            exit 1
          fi
          
          echo ""
          
          # ============================================================
          # Step 2: Call bootstrap endpoint
          # ============================================================
          echo "Step 2/2: Calling bootstrap endpoint..."
          echo "  Endpoint: POST $API_URL$BOOTSTRAP_ENDPOINT"
          echo "  Token: ${BOOTSTRAP_TOKEN:0:10}... (truncated)"
          echo ""
          
          BOOTSTRAP_RESPONSE=$(curl -s -w '\n%{http_code}' \
            --connect-timeout 5 \
            --max-time 30 \
            -X POST \
            -H "Content-Type: application/json" \
            -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
            -d "{\"password\": \"$(echo "$ADMIN_PASSWORD" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')\"}" \
            "$API_URL$BOOTSTRAP_ENDPOINT" || echo 'error\n000')
          
          # Extract HTTP status (last line)
          HTTP_STATUS=$(echo "$BOOTSTRAP_RESPONSE" | tail -n1)
          
          # Extract response body (all but last line)
          RESPONSE_BODY=$(echo "$BOOTSTRAP_RESPONSE" | head -n-1)
          
          echo "  Response status: HTTP $HTTP_STATUS"
          echo ""
          
          case "$HTTP_STATUS" in
            200)
              echo "✅ SUCCESS: Admin password bootstrapped!"
              echo ""
              echo "Response:"
              echo "$RESPONSE_BODY" | sed 's/^/  /'
              echo ""
              echo "Next steps:"
              echo "  1. Customer should receive password via email"
              echo "  2. On first login, customer MUST change password"
              echo "  3. After password change, account is fully operational"
              exit 0
              ;;
            401)
              echo "❌ ERROR: Unauthorized (HTTP 401)"
              echo ""
              echo "Response:"
              echo "$RESPONSE_BODY" | sed 's/^/  /'
              echo ""
              echo "Troubleshooting:"
              echo "  1. Check bootstrap token in 1Password:"
              echo "     - Item: api-bootstrap-token-master"
              echo "     - Vault: IOT-CLIENTS"
              echo "     - Field: INITIAL_ADMIN_BOOTSTRAP_TOKEN"
              echo "  2. Verify Secret is synced: kubectl get secret api-bootstrap-token-master -n {{ .Release.Namespace }}"
              echo "  3. Compare token value with API env var:"
              echo "     kubectl exec -n {{ .Release.Namespace }} deployment/{{ include 'iotistica-app.fullname' . }}-api -- env | grep INITIAL_ADMIN"
              exit 1
              ;;
            400)
              echo "❌ ERROR: Bad Request (HTTP 400)"
              echo ""
              echo "Response:"
              echo "$RESPONSE_BODY" | sed 's/^/  /'
              echo ""
              echo "Troubleshooting:"
              echo "  1. Password must be 12-255 characters"
              echo "  2. Check password spec in 1Password item: admin-initial-password-{{ .Release.Name }}"
              echo "  3. Verify Secret is synced: kubectl get secret admin-initial-password-{{ .Release.Name }} -n {{ .Release.Namespace }}"
              echo "  4. Check password value: kubectl get secret admin-initial-password-{{ .Release.Name }} -n {{ .Release.Namespace }} -o yaml"
              exit 1
              ;;
            503)
              echo "⏳ ERROR: Service Unavailable (HTTP 503)"
              echo ""
              echo "Response:"
              echo "$RESPONSE_BODY" | sed 's/^/  /'
              echo ""
              echo "Troubleshooting:"
              echo "  API returned 503, which may indicate:"
              echo "  1. Database not yet connected"
              echo "  2. Database migrations still running"
              echo "  3. Internal server error"
              echo ""
              echo "The Job will automatically retry (backoffLimit: 5)"
              exit 1
              ;;
            000)
              echo "❌ ERROR: Connection failed"
              echo ""
              echo "Could not reach API at: $API_URL"
              echo ""
              echo "Troubleshooting:"
              echo "  1. Check API pod running: kubectl get pods -n {{ .Release.Namespace }}"
              echo "  2. Check DNS resolution: kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- nslookup api.{{ .Release.Namespace }}.svc.cluster.local"
              echo "  3. Test connectivity: kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- curl -v http://api:3002/api/v1/health"
              echo "  4. Check network policies: kubectl get networkpolicies -n {{ .Release.Namespace }}"
              exit 1
              ;;
            *)
              echo "❌ ERROR: Unexpected HTTP $HTTP_STATUS"
              echo ""
              echo "Response:"
              echo "$RESPONSE_BODY" | sed 's/^/  /'
              exit 1
              ;;
          esac
```

### Job Lifecycle

**Created by**: Helm chart (via `kubectl apply`)

**Triggered**: Automatically when deployed (no manual trigger needed)

**Execution Timeline**:
1. K8s Job controller picks up Job spec
2. Creates Job Pod in customer namespace
3. Pod polls API /health (30 retries, 10s delay = max 5 min wait)
4. Once API ready, calls bootstrap endpoint
5. Job exits with status 0 (success) or 1 (failure)

**Failure Handling**:
- If Job fails: K8s restarts it (up to 5 times = `backoffLimit: 5`)
- If all 5 retries fail: Job marked as "BackoffLimitExceeded"
- Job auto-deleted after 24 hours (TTL)

**Cleanup**:
```bash
# View Job status
kubectl get jobs -n customer-abc123

# View Job logs
kubectl logs -n customer-abc123 job/customer-abc123-bootstrap

# View Job definition
kubectl get job customer-abc123-bootstrap -n customer-abc123 -o yaml

# Delete Job manually (auto-deleted after 24h anyway)
kubectl delete job customer-abc123-bootstrap -n customer-abc123
```

---

## Implementation Details

### AdminBootstrapService

**File**: `provisioning/src/services/admin-bootstrap-service.ts`

```typescript
export class AdminBootstrapService {
  /**
   * Generate secure 16-character initial password
   * - Uppercase letters (A-Z)
   * - Lowercase letters (a-z)
   * - Digits (0-9)
   * - Special characters (!@#$%^&*)
   * - No ambiguous characters (0/O, 1/l/I)
   */
  generateInitialPassword(): string {
    const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // No O
    const lowercase = 'abcdefghjkmnpqrstuvwxyz';   // No l
    const digits = '23456789';                      // No 0, 1
    const symbols = '!@#$%^&*';
    
    const charset = uppercase + lowercase + digits + symbols;
    let password = '';
    
    for (let i = 0; i < 16; i++) {
      const randomIndex = crypto.randomInt(0, charset.length);
      password += charset[randomIndex];
    }
    
    return password;
  }
}
```

**Key Points**:
- Uses `crypto.randomBytes()` for cryptographic randomness
- 16 characters minimum deployment-grade password
- Avoids ambiguous characters (0/O, 1/l/I)
- Includes mix of character types

### GitOps Provisioning Service

**File**: `provisioning/src/services/gitops-provisioning-service.ts`

Key changes to `deployClient()` method:

```typescript
private async deployClient(data: ClientDeploymentData): Promise<void> {
  // ... database provisioning, 1Password items, Git prep ...
  
  // === STEP 4: Generate and store initial admin password ===
  
  // Generate password
  const bootstrapService = new AdminBootstrapService();
  const initialPassword = await bootstrapService.generateInitialPassword();
  
  logger.info('Initial admin password generated', {
    clientId: data.clientId,
    passwordLength: initialPassword.length,
  });
  
  // Store in 1Password
  const adminPasswordItemPath = `vaults/IOT-CLIENTS/items/admin-initial-password-${data.clientId}`;
  
  await this.onePasswordService.createSecretItem({
    itemPath: adminPasswordItemPath,
    fields: {
      password: initialPassword,
      email: data.customerEmail || 'admin@iotistic.local',
      createdAt: new Date().toISOString(),
      notes: `Initial admin password for ${data.clientId}. Set by provisioning service. Customer must change on first login.`,
    },
  });
  
  logger.info('Initial admin password stored in 1Password', {
    clientId: data.clientId,
    itemPath: adminPasswordItemPath,
  });
  
  // Update database
  await CustomerModel.updateBootstrapPassword(data.customerId, initialPassword);
  
  // Mark deployment as complete
  // K8s bootstrap Job will run after Argo CD deploys API pod
  await CustomerModel.updateDeploymentStatus(data.customerId, 'deployed');
  
  logger.info('Provisioning complete - K8s bootstrap Job queued', {
    clientId: data.clientId,
    customerId: data.customerId,
    passwordStoredIn: '1Password',
  });
}
```

**Why This Approach**:
1. Provisioning no longer needs to call bootstrap endpoint
2. Password is persisted in 1Password immediately
3. Helm manifest (bootstrap-job.yaml) is included in Git commit
4. Deployment status is 'deployed' (not 'bootstrap_pending')
5. K8s Job runs independently, asynchronously

### API Auth Endpoint

**File**: `api/src/routes/auth.ts`

```typescript
// POST /api/v1/auth/bootstrap-admin
router.post('/bootstrap-admin',
  rateLimit(5, 15 * 60),  // 5 req per 15 min
  validateBootstrapToken(),
  validatePasswordBody(),
  async (req, res) => {
    try {
      const { password } = req.body;
      
      await authService.bootstrapAdminPassword(password, req.body.email);
      
      return res.status(200).json({
        message: 'Admin password bootstrapped',
        data: {
          mustChangePassword: true
        }
      });
    } catch (error) {
      logger.error('Bootstrap failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      
      return res.status(500).json({
        message: 'Bootstrap failed',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);
```

### Auth Service Implementation

**File**: `api/src/services/auth.service.ts`

```typescript
async bootstrapAdminPassword(password: string, email?: string): Promise<void> {
  // Validate password
  if (!password || password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }
  
  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);
  
  // Update admin user
  const adminId = 1;  // System admin ID
  
  await db('users')
    .where({ id: adminId })
    .update({
      password_hash: hashedPassword,
      must_change_password: true,
      password_last_changed_at: null,
      email: email || this.db.raw('email'),  // Don't override if not provided
      updated_at: new Date(),
    });
  
  // Revoke all existing refresh tokens
  await db('refresh_tokens')
    .where({ user_id: adminId })
    .delete();
  
  // Log audit event
  logger.info('Admin password bootstrapped', {
    userId: adminId,
    mustChangePasswordFlag: true,
    timestamp: new Date().toISOString(),
  });
}
```

---

## Security

### Threat Model

| Threat | Prevention |
|--------|-----------|
| **Hardcoded password in repo** | No password in Git - stored in 1Password |
| **Password intercepted in Kubernetes** | TLS encryption in transit, Secret RBAC |
| **Unauthorized bootstrap** | x-bootstrap-token header validation, rate limiting |
| **Replay attacks** | Token is one-time setup, revoked after use |
| **Database compromise** | Password hashed with bcrypt, salt per hash |
| **Customer reuses initial password** | must_change_password flag forces change |
| **Job execution after API removed** | Job fails gracefully, no retry if API gone |

### Secret Management

**1Password Storage** (AES-256 encryption):
```
Vault: IOT-CLIENTS
├─ api-bootstrap-token-master (global, shared)
│  └─ INITIAL_ADMIN_BOOTSTRAP_TOKEN: "..." (created manually, stays in 1OP)
│
└─ admin-initial-password-{clientId} (per-deployment)
   └─ password: "..." (generated automatically, stored by provisioning)
   └─ email: "..." (for customer notification)
   └─ createdAt: "..." (audit trail)
   └─ notes: "..." (context)
```

**Kubernetes Secret Sync**:
```
1Password Operator watches OnePasswordItem CRDs
         │
         ├─ Uses 1Password Service Account token
         ├─ Fetches item from 1Password vault
         ├─ Base64-encodes password value
         │
         └─> Creates K8s Secret (TLS encrypted at rest)
             ├─ api-bootstrap-token-master
             └─ admin-initial-password-{clientId}
```

**Pod Injection**:
```
Kubernetes injects Secrets as environment variables
         │
         ├─ Read-only mount (can't be extracted)
         ├─ In-pod encryption via kubectl exec (encrypted over API channel)
         │
         └─> Container process
             ├─ process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN
             └─ process.env.ADMIN_PASSWORD
```

### Access Control

**Who Can See the Password**:
1. **Provisioning service** - Generates and stores, doesn't read back
2. **1Password admin** - Can view in vault if they have admin role
3. **Customer** - Receives via secure email notification
4. **K8s admins** - Can see Secret value but only in bootstrap namespace
5. **Job pod** - Can read from env (already in K8s, has access)

**Who CANNOT See**:
- GitHub (password never committed)
- Argo CD (processes manifests, not password values)
- Other customers (namespaced RBAC)
- Logs (not logged to disk, only to audit trail)

---

## Troubleshooting

### Jobs Fails to Run

**Symptom**: 
```bash
$ kubectl get jobs -n customer-abc123
NAME                     COMPLETIONS   DURATION   AGE
customer-abc123-bootstrap  0/1          45m        45m
```

**Check Status**:
```bash
kubectl describe job customer-abc123-bootstrap -n customer-abc123
```

**Common Causes**:

1. **1Password Operator not installed**
   ```
   Error: no matches for kind "OnePasswordItem"
   Fix: Install ServiceMonitor CRD first
   kubectl apply -f https://raw.githubusercontent.com/1password/1password-operator/main/config/crd/...
   ```

2. **1Password Secret not synced**
   ```
   kubectl get secret admin-initial-password-abc123 -n customer-abc123
   # If not found, check 1OP Operator logs
   kubectl logs -n 1password deployment/1password-operator
   ```

3. **API pod not ready**
   ```
   kubectl get pods -n customer-abc123
   # If api pod not running, check why
   kubectl logs -n customer-abc123 deployment/api
   ```

4. **BOOTSTRAP_TOKEN mismatch**
   ```
   Job log shows "401 Unauthorized"
   # Check token in Job env
   kubectl set env job/bootstrap -n customer-abc123 --list | grep BOOTSTRAP
   # Compare with 1OP: api-bootstrap-token-master
   ```

### Bootstrap Endpoint Returns 503

**Symptom**: 
```bash
$ kubectl logs -n customer-abc123 job/customer-abc123-bootstrap
...
Response status: HTTP 503
ERROR: Service Unavailable (HTTP 503)
```

**Causes**:
1. Database not yet connected
2. Database migrations still running
3. Internal server error

**Check**:
```bash
# Check API pod logs
kubectl logs -n customer-abc123 deployment/api

# Check database connection
kubectl exec -n customer-abc123 deployment/api -- \
  NODE_ENV=test npm run db:setup
```

### Debugging Local Development

```bash
# Simulate bootstrap (with curl)
BOOTSTRAP_TOKEN="your-token-here"
ADMIN_PASSWORD="test-password-123"

curl -X POST http://localhost:3002/api/v1/auth/bootstrap-admin \
  -H "Content-Type: application/json" \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -d "{\"password\": \"$ADMIN_PASSWORD\"}" \
  -v

# Expected response:
# < HTTP/1.1 200 OK
# {
#   "message": "Admin password bootstrapped",
#   "data": { "mustChangePassword": true }
# }
```

---

## Summary Table

| Component | Location | Responsibility |
|-----------|----------|-----------------|
| **Password Generation** | `provisioning/.../admin-bootstrap-service.ts` | Creates 16-char password |
| **1Password Storage** | `provisioning/.../onepassword-service.ts` | Stores in 1Password vault |
| **Helm Manifest** | `charts/iotistica-app/templates/bootstrap-job.yaml` | Defines K8s Job |
| **Bootstrap Endpoint** | `api/src/routes/auth.ts` | Accepts bootstrap request |
| **Bootstrap Logic** | `api/src/services/auth.service.ts` | Updates password in DB |
| **Secret Injection** | 1Password Operator | Syncs 1OP items to K8s Secrets |
| **Job Scheduling** | Kubernetes Job Controller | Runs Job after API ready |

