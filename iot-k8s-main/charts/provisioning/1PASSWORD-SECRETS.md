# 1Password Secrets for Provisioning Service

Create the following items in your 1Password vault (`IOT-CLIENTS`) for the provisioning service Helm chart.

**Note**: Items #2 (`redis-credentials-master`) and #7 (`api-license-public-key-master`) already exist - no action required for those. Item #6 (`api-license-private-key-master`) must be generated first using `npm run generate-keys`.

## 1. provisioning-db-credentials
PostgreSQL database credentials

```
user: billing
password: [your-secure-password]
```

## 2. redis-credentials-master (Existing)
External Redis cluster credentials - **uses existing master secret**

**Note**: This secret already exists in 1Password. No action required.

**Fields used**:
```
Item: redis-credentials-master
Field: host (Redis hostname)
Field: port_ext (Redis port, e.g., 6379)
Field: password (Redis password)
Value: [already configured]
```

## 3. provisioning-stripe-credentials
Stripe payment integration keys

```
secret-key: sk_live_xxxxx (or sk_test_xxxxx)
publishable-key: pk_live_xxxxx (or pk_test_xxxxx)
webhook-secret: whsec_xxxxx
price-starter: price_xxxxx
price-professional: price_xxxxx
price-enterprise: price_xxxxx
```

## 4. provisioning-auth0-credentials
Auth0 OAuth authentication

```
domain: your-tenant.auth0.com
client-id: [your-client-id]
client-secret: [your-client-secret]
audience: https://api.iotistica.com
```

## 5. provisioning-jwt-secret
JWT token signing secret

```
secret: [generate-strong-random-string, e.g., openssl rand -base64 32]
```

## 6. provisioning-license-private-key
RSA private key for signing license JWTs - **CREATE NEW ITEM**

**IMPORTANT**: Generate the RSA key pair first:
```bash
cd provisioning
npm run generate-keys
```

Then create the 1Password item with the **private key** content:
```
Item: provisioning-license-private-key
Field: key
Value: [Contents of keys/private-key.pem - full PEM including -----BEGIN PRIVATE KEY----- headers]
```

**Security**: Never commit this key to git. Store only in 1Password.

## 7. api-license-public-key-master (Existing)
License validation public key - **uses existing master secret**

**Note**: This secret already exists in 1Password. No action required.

```
Item: api-license-public-key-master
Field: key
Value: [RSA public key - already configured]
```

## 8. provisioning-tigerdata-credentials
TimescaleDB cloud provisioning API

```
access-key: [your-timescale-access-key]
secret-key: [your-timescale-secret-key]
project-id: [your-timescale-project-id]
```

## 9. provisioning-onepassword-credentials
1Password Operator integration

```
token: [1password-connect-api-token]
vault-id: [vault-id, e.g., jphmeuzr4ffmzlbq2ey5a75pvm]
```

## 10. provisioning-gitops-credentials
GitOps repository access

```
pat: ghp_xxxxx (GitHub Personal Access Token)
```

Required GitHub token scopes:
- `repo` (full control of repositories)

## 11. provisioning-argocd-credentials
Argo CD deployment automation

```
url: https://argocd.iotistica.com
token: [argo-cd-api-token]
```

## How to Create Items in 1Password

### Via 1Password CLI

```bash
# Example: Create provisioning-db-credentials
op item create \
  --vault "IOT-CLIENTS" \
  --title "provisioning-db-credentials" \
  --category "login" \
  user="billing" \
  pasword="your-password"
```

### Via Web UI

1. Open 1Password web vault
2. Navigate to "IOT-CLIENTS" vault
3. Click "+ New Item"
4. Select type: "Login" or "Secure Note"
5. Title: `provisioning-db-credentials`
6. Add fields for each key-value pair
7. Save

## Verification

After creating all secrets, verify that 1Password Operator can access them:

```bash
# Check if OnePasswordItem CRDs are created
kubectl get onepassworditems -n provisioning

# Check if secrets were synced
kubectl get secrets -n provisioning | grep provisioning-
```

## Notes

- All item names must match exactly as specified above
- Field names within items use kebab-case (e.g., `secret-key`, `client-id`) - must match exactly
- Special case: Database password field is `pasword` (not `password`) - matches existing 1Password convention
- Vault ID should be `IOT-CLIENTS` (or change in chart values)
- Keep all tokens and keys secure - never commit to git
- Rotate credentials regularly for production
