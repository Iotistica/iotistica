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
username: iotistic
password: <generated-password>
```

### 2. `redis-credentials-provisioning`
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

### 3. `provisioning-stripe`
```yaml
secret_key: sk_live_...
webhook_secret: whsec_...
```

### 4. `provisioning-git`
```yaml
username: <github-username>
token: <github-pat>
```

### 5. `provisioning-license-keys`
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

### 6. `provisioning-1password`
```yaml
service_account_token: <1password-service-account-token>
```

### 7. `provisioning-tigerdata`
```yaml
api_key: <tigerdata-api-key>
```

### 8. `provisioning-argocd`
```yaml
token: <argocd-api-token>
```

## Installation

### 1. Install the chart

```bash
# From iot-k8s-main repository root
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace \
  --values ./charts/provisioning/values/default/values.yaml
```

### 2. Verify deployment

```bash
# Check pods
kubectl get pods -n provisioning

# Expected output:
# provisioning-api-xxxx       1/1     Running
# provisioning-worker-xxxx    1/1     Running
# provisioning-redis-0        1/1     Running

kubectl get svc -n provisioning

# Check logs
kubectl logs -n provisioning -l app.kubernetes.io/component=api
kubectl logs -n provisioning -l app.kubernetes.io/component=worker
```

### 3. Access the API

```bash
# Port-forward for local access
kubectl port-forward -n provisioning svc/provisioning-api 3100:3100

# Test health endpoint
curl http://localhost:3100/health
```

## Configuration

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
  --namespace provisioning \
  --values ./charts/provisioning/values/default/values.yaml
```

## Uninstalling

```bash
helm uninstall provisioning --namespace provisioning
kubectl delete namespace provisioning
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
kubectl get events -n provisioning --sort-by='.lastTimestamp'

# Check pod details
kubectl describe pod -n provisioning <pod-name>
```

### 1Password secrets not syncing

```bash
# Verify 1Password operator
kubectl get pods -n onepassword-operator-system

# Check OnePasswordItem status
kubectl get onepassworditems -n provisioning
kubectl describe onepassworditem provisioning-postgres -n provisioning
```

### Worker jobs failing

```bash
# Check worker logs
kubectl logs -n provisioning -l app.kubernetes.io/component=worker -f

# Check Redis queue
kubectl exec -it -n provisioning provisioning-redis-0 -- \
  reRedis connection issues

```bash
# Test connectivity from pod to Azure Redis
kubectl exec -it -n provisioning deployment/provisioning-api -- \
  nc -zv <redis-host>.redis.cache.windows.net 6380

# Check if TLS is working
kubectl exec -it -n provisioning deployment/provisioning-api -- \
  openssl s_client -connect <redis-host>.redis.cache.windows.net:6380

# Test Redis auth
kubectl exec -it -n provisioning deployment/provisioning-api -- sh -c \
  'redis-cli -h <host> -p 6380 --tls --cacert /etc/ssl/certs/ca-certificates.crt -a <password> PING'
# Test connectivity from pod
kubectl exec -it -n provisioning deployment/provisioning-api -- \
  nc -zv <db-host> 5432
```
