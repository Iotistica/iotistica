# Secrets Management - Best Practices

## Overview

This project uses **Option 4: Deploy-Time Injection** for Kubernetes secrets management.

**Key Principle:** Secrets are **never stored in Git**. They are injected at deployment time from the billing service environment.

---

## How It Works

### 1. Billing Service (.env)

```bash
# billing/.env (NOT committed to Git - use .env.example as template)
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
...actual key content...
-----END PUBLIC KEY-----"
```

### 2. K8s Deployment Service

```typescript
// billing/src/services/k8s-deployment-service.ts
constructor() {
  // Load from environment (not from values.yaml!)
  this.licensePublicKey = process.env.LICENSE_PUBLIC_KEY || '';
}

private async installHelmRelease() {
  const helmValues = [
    `--set license.publicKey="${escapedPublicKey}"`,  // Injected at deploy time
    // ... other values
  ];
}
```

### 3. Helm Chart (values.yaml)

```yaml
# charts/customer-instance/values.yaml
license:
  key: ""
  publicKey: ""  # Empty - injected at deploy time!
```

### 4. Customer Instance (K8s Secret)

```yaml
# Automatically created by Helm during deployment
apiVersion: v1
kind: Secret
metadata:
  name: customer-xxx-secrets
stringData:
  LICENSE_PUBLIC_KEY: "{{ .Values.license.publicKey }}"  # From deploy-time injection
```

---

## Setup Instructions

### Local Development

1. Copy `.env.example` to `.env`:
   ```bash
   cd billing
   cp .env.example .env
   ```

2. Add your LICENSE_PUBLIC_KEY to `.env`:
   ```bash
   LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
   MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqS6oN6f88fM0YkWE1rcu
   ...
   -----END PUBLIC KEY-----"
   ```

3. Ensure `.env` is in `.gitignore` ✅

### Production Deployment

**Option A: Environment Variables (Current)**
```bash
# Set in your deployment platform (Heroku, AWS, Azure, etc.)
export LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
```

**Option B: Kubernetes Secret (Recommended for production)**
```bash
# Create secret in billing service namespace
kubectl create secret generic billing-secrets \
  --from-file=LICENSE_PUBLIC_KEY=./keys/public-key.pem \
  -n default

# Reference in deployment
env:
  - name: LICENSE_PUBLIC_KEY
    valueFrom:
      secretKeyRef:
        name: billing-secrets
        key: LICENSE_PUBLIC_KEY
```

**Option C: External Secrets Operator (Enterprise)**
```yaml
# Use AWS Secrets Manager, Azure Key Vault, or HashiCorp Vault
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: billing-secrets
spec:
  secretStoreRef:
    name: aws-secrets-manager
  data:
  - secretKey: LICENSE_PUBLIC_KEY
    remoteRef:
      key: /iotistic/license/public-key
```

---

## Security Best Practices

### ✅ DO

- Store `LICENSE_PUBLIC_KEY` in billing service environment
- Load from environment variables at runtime
- Use External Secrets Operator for production
- Rotate keys regularly (update billing service env, redeploy customers)
- Use different keys for dev/staging/production

### ❌ DON'T

- Commit `.env` files to Git
- Store secrets in `values.yaml`
- Hardcode secrets in code
- Share secrets via Slack/email
- Use same key across all environments

---

## Key Rotation Process

When you need to rotate the LICENSE_PUBLIC_KEY:

1. **Generate new key pair** (in billing service):
   ```bash
   cd billing
   npm run generate-keys  # Creates new keys/public-key.pem and keys/private-key.pem
   ```

2. **Update billing service environment**:
   ```bash
   # Update .env or your deployment platform
   LICENSE_PUBLIC_KEY="<new public key>"
   ```

3. **Redeploy all customer instances**:
   ```typescript
   // Trigger via API or admin panel
   POST /api/customers/:customerId/redeploy
   ```

4. **Old licenses become invalid** - customers must re-provision

---

## Troubleshooting

### "LICENSE_PUBLIC_KEY is not configured or invalid"

**Cause:** The public key is missing or malformed.

**Fix:**
1. Check billing service logs: `docker logs billing-service`
2. Verify environment variable is set: `echo $LICENSE_PUBLIC_KEY`
3. Ensure key has proper format (-----BEGIN PUBLIC KEY-----)
4. Check for escaped newlines (`\n` vs actual newlines)

### Customer instances show "unlicensed mode"

**Cause:** Public key not passed during deployment.

**Fix:**
1. Check billing service has `LICENSE_PUBLIC_KEY` env var
2. Redeploy customer instance
3. Check customer secret: `kubectl get secret customer-xxx-secrets -o yaml`

---

## Future Improvements

1. **External Secrets Operator** - Sync from AWS/Azure/Vault
2. **Sealed Secrets** - Encrypt secrets for GitOps workflows
3. **Automatic key rotation** - Scheduled rotation with zero downtime
4. **Multi-tenant key management** - Different keys per customer tier

---

## References

- [Kubernetes Secrets Best Practices](https://kubernetes.io/docs/concepts/configuration/secret/#best-practices)
- [External Secrets Operator](https://external-secrets.io/)
- [Bitnami Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets)
- [Helm Secrets Plugin](https://github.com/jkroepke/helm-secrets)
