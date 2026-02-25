# Provisioning Service Helm Chart

Deploy the Iotistic provisioning service (API + Worker) to manage customer deployments.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.8+
- 1Password Operator installed
- Argo CD installed (if using GitOps)
- **Azure Database for PostgreSQL** (managed service)
- **Azure Cache for Redis** (managed service)

## 1Password Secrets Required

Create these items in 1Password vault `IOT-CLIENTS`:

### 1. `provisioning-postgres`
```yaml
### 1. `postgres-credentials-client-provisioning`
```yaml
username: iotistic
password: <generated-password>
```

### 2. `redis-credentials-client-client-provisioning`
```yaml
host: <redis-hostname>
port: <redis-port>
password: <redis-password>
port_ext: <redis-port>  # Same as port for Azure Redis
```

**For Azure Cache for Redis**:
- `host`: `your-cache.redis.cache.windows.net`
- `port`: `6380` (TLS port)
- `password`: Primary Access Key from Azure Portal
- `port_ext`: `6380`

### 3. `stripe-credentials-client-provisioning`
```yaml
secret_key: sk_live_...
webhook_secret: whsec_...
```

### 4. `git-credentials-client-provisioning`
```yaml
username: <github-username>
token: <github-pat>
```

### 5. `license-keys-client-provisioning`
```yaml
private_key: |
  -----BEGIN PRIVATE KEY-----
  <RSA private key for JWT signing>
  -----END PRIVATE KEY-----
public_key: |
  -----BEGIN PUBLIC KEY-----
  <RSA public key for JWT verification>
  -----END PUBLIC KEY-----
```

### 6. `onepassword-credentials-client-provisioning`
```yaml
service_account_token: <1password-service-account-token>
```

### 7. `tigerdata-credentials-client-provisioning`
```yaml
api_key: <tigerdata-api-key>
```

### 8. `provisioning-argocd`
```yaml
token: <argocd-api-token>
```

## Installation

### 1. Configure DNS and Ingress

Set up your domain for Stripe webhooks:

```yaml
# values/production/values.yaml
api:
  tlsCommonName: "provisioning.iotistica.com"
  corsOrigins: "https://dashboard.iotistica.com,https://app.iotistica.com"
```

**DNS Setup**:
1. Create A or CNAME record: `provisioning.iotistica.com` → Your Envoy Gateway LoadBalancer IP/hostname
2. Wait for DNS propagation (check with `nslookup provisioning.iotistica.com`)

**TLS Certificate**:
- The HTTPRoute will be created automatically referencing `iotistica-gateway`
- Ensure your Envoy Gateway has TLS configured (cert-manager or manual certificate)

**Webhook URL**: `https://provisioning.iotistica.com/api/webhooks/stripe`

### 2. Install the chart

```bash
# From iot-k8s-main repository root
helm install provisioning ./charts/provisioning \
  --namespace iotistica-provisioning \
  --create-namespace \
  --values ./charts/provisioning/values/default/values.yaml
```

### 3. Configure Stripe Webhook

After deployment, configure the webhook in Stripe Dashboard:

1. **Go to**: Stripe Dashboard → Developers → Webhooks
2. **Add endpoint**: `https://provisioning.iotistic.cloud/api/webhooks/stripe`
3. **Select events**:
   - `customer.created`
   - `customer.updated`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
4. **Copy webhook signing secret** → Store in 1Password `provisioning-stripe` item as `webhook_secret`
5. **Test webhook**: Use Stripe CLI or send test event from dashboard

**Verify connectivity**:
```bash
# Test webhook endpoint
curl https://provisioning.iotistic.cloud/health

# Check ingress
kubectl get ingress -n iotistica-provisioning
kubectl describe ingress provisioning-api -n iotistica-provisioning
```

### 4. Configure Stripe Webhook

```bash
# Check pods
kubectl get pods -n iotistica-provisioning

# Expected output:
# provisioning-api-xxxx       1/1     Running
# provisioning-worker-xxxx    1/1     Running
# provisioning-redis-0        1/1     Running

kubectl get svc -n iotistica-provisioning

# Check logs
kubectl logs -n iotistica-provisioning -l app.kubernetes.io/component=api
kubectl logs -n iotistica-provisioning -l app.kubernetes.io/component=worker
```

### 5. Access the API

**Production** (via Ingress):
```bash
# Health check
curl https://provisioning.iotistic.cloud/health

# API endpoints
curl https://provisioning.iotistic.cloud/api/customers
```

**Local testing** (port-forward):
```bash
# Port-forward for local access
kubectl port-forward -n iotistica-provisioning svc/provisioning-api 3100:3100

# Test health endpoint
curl http://localhost:3100/health
```

## Configuration

### External Access (Envoy Gateway)

The provisioning API needs to be accessible from the internet for:
- **Stripe Webhooks**: Payment events, subscription changes
- **Customer Portal**: Signup, billing management
- **Admin Dashboard**: Customer management UI

```yaml
# values/production/values.yaml
api:
  tlsCommonName: "provisioning.iotistica.com"  # Your domain
  corsOrigins: "https://dashboard.iotistica.com,https://app.iotistica.com"
```

**DNS Configuration**:
- Point `provisioning.iotistica.com` to your Envoy Gateway LoadBalancer IP
- Configure TLS certificate via cert-manager or Envoy Gateway

**HTTPRoute** is automatically created to route traffic from Envoy Gateway to the API service.

**Stripe Webhook URL**: `https://provisioning.iotistica.com/api/stripe/webhook`

### Managed Database

If using AWS RDS, Cloud SQL, or Azure Database for PostgreSQL:

```yaml
# values/production/values.yaml
postgres:
  host: "your-rds-endpoint.region.rds.amazonaws.com"
  port: "5432"
  database: "iotistic_provisioning"
```

### Azure Cache for Redis (Required)

Configure Redis cluster and TLS settings in values file:

```yaml
# values/production/values.yaml
redis:
  cluster: true  # Set to true if using Redis Cluster
  tls: true  # Set to true if Redis requires TLS

api:
  redis:
    SecretName: "redis-credentials-provisioning"

worker:
  redis:
    SecretName: "redis-credentials-provisioning"
```

**1Password Secret** `redis-credentials-provisioning` must contain:
- `host` - Redis hostname (e.g., `your-cache.redis.cache.windows.net`)
- `port` - Redis port (e.g., `6380` for TLS)
- `password` - Primary Access Key from Azure Portal
- `port_ext` - External port (same as `port` for Azure)

**Azure Redis Configuration**:
- **Tier**: Premium (for persistence, HA, and network isolation)
- **TLS**: Enabled on port 6380
- **maxmemory-policy**: `allkeys-lru`
- **Network**: Private endpoint recommended for production

### GitOps Settings

```yaml
gitops:
  repoUrl: "https://github.com/YourOrg/iot-k8s-main.git"
└────────────────┼───────────────────────────────┘
                 │
                 │ (External connections)
                 ▼
    ┌────────────────────────┐
    │ Azure Managed Services │
    │                        │
    │  ┌──────────────────┐ │
    │  │ PostgreSQL DB    │ │
    │  └──────────────────┘ │
    │                        │
    │  ┌──────────────────┐ │
    │  │ Redis Cache      │ │
    │  │ (Bull queues)    │ │
    │  └──────────────────┘
## Upgrading

```bash
# Update version in Chart.yaml, then:
helm upgrade provisioning ./charts/provisioning \
  --namespace iotistica-provisioning \
  --values ./charts/provisioning/values/default/values.yaml
```

## Uninstalling

```bash
helm uninstall provisioning --namespace iotistica-provisioning
kubectl delete namespace iotistica-provisioning
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Provisioning Namespace                          │
│                                                 │
│  ┌────────────┐         ┌─────────────┐       │
│  │ API        │         │ Worker      │       │
│  │ (port 3100)│         │ (Bull queue)│       │
│  └────┬───────┘         └──────┬──────┘       │
│       │                        │               │
│       └────────┬───────────────┘               │
│                │                               │
│         ┌──────▼──────┐                        │
│         │ Redis       │                        │
│         │ (Bull queue)│                        │
│         └─────────────┘                        │
│                                                 │
└─────────────────────────────────────────────────┘
                 │
                 │ (SQL connection)
                 ▼
    ┌────────────────────────┐
    │ Managed PostgreSQL     │
    │ (AWS RDS/Cloud SQL)    │
    └────────────────────────┘
```

## Troubleshooting

### Pods not starting

```bash
# Check events
kubectl get events -n iotistica-provisioning --sort-by='.lastTimestamp'

# Check pod details
kubectl describe pod -n iotistica-provisioning <pod-name>
```

### 1Password secrets not syncing

```bash
# Verify 1Password operator
kubectl get pods -n onepassword-operator-system

# Check OnePasswordItem status
kubectl get onepassworditems -n iotistica-provisioning
kubectl describe onepassworditem postgres-credentials-client-provisioning -n iotistica-provisioning
```

### Worker jobs failing

```bash
# Check worker logs
kubectl logs -n iotistica-provisioning -l app.kubernetes.io/component=worker -f

# Check Redis queue
kubectl exec -it -n iotistica-provisioning provisioning-redis-0 -- \
  reRedis connection issues

```bash
# Test connectivity from pod to Azure Redis
kubectl exec -it -n iotistica-provisioning deployment/provisioning-api -- \
  nc -zv <redis-host>.redis.cache.windows.net 6380

# Check if TLS is working
kubectl exec -it -n iotistica-provisioning deployment/provisioning-api -- \
  openssl s_client -connect <redis-host>.redis.cache.windows.net:6380

# Test Redis auth
kubectl exec -it -n iotistica-provisioning deployment/provisioning-api -- sh -c \
  'redis-cli -h <host> -p 6380 --tls --cacert /etc/ssl/certs/ca-certificates.crt -a <password> PING'
# Test connectivity from pod
kubectl exec -it -n iotistica-provisioning deployment/provisioning-api -- \
  nc -zv <db-host> 5432
```
