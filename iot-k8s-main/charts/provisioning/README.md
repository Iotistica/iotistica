# Provisioning Service Helm Chart

Helm chart for deploying the Iotistica Provisioning Service on Kubernetes. This service handles customer onboarding, tenant provisioning, and GitOps-based deployment orchestration.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2+
- 1Password Operator installed (for secret management)
- Envoy Gateway installed (for HTTPRoute ingress)

## Required 1Password Secrets

Create the following items in your 1Password vault (`IOT-CLIENTS`):

### 1. provisioning-db-credentials
- `user`: PostgreSQL username
- `password`: PostgreSQL password

### 2. redis-credentials-master (Existing)
- **Uses existing master secret**
- `host`: Redis hostname
- `port_ext`: Redis port
- `password`: Redis password

### 3. provisioning-stripe-credentials
- `secret-key`: Stripe API secret key
- `publishable-key`: Stripe publishable key
- `webhook-secret`: Stripe webhook signing secret
- `price-starter`: Price ID for Starter plan
- `price-professional`: Price ID for Professional plan
- `price-enterprise`: Price ID for Enterprise plan

### 4. provisioning-auth0-credentials
- `domain`: Auth0 domain (e.g., iotistica.auth0.com)
- `client-id`: Auth0 application client ID
- `client-secret`: Auth0 application client secret
- `audience`: Auth0 API audience

### 5. provisioning-jwt-secret
- `secret`: Secret for signing JWT tokens

### 6. api-license-public-key-master (Existing)
- **Uses existing master secret**
- `key`: RSA public key for license validation (PEM format)

### 7. provisioning-tigerdata-credentials
- `access-key`: Timescale Cloud access key
- `secret-key`: Timescale Cloud secret key
- `project-id`: Timescale Cloud project ID

### 8. provisioning-onepassword-credentials
- `token`: 1Password Connect token
- `vault-id`: 1Password vault ID

### 9. provisioning-gitops-credentials
- `pat`: GitHub personal access token with repo write access

### 10. provisioning-argocd-credentials
- `url`: Argo CD API URL
- `token`: Argo CD API token

## Installation

### Install with default values

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace
```

### Install with custom values

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace \
  --values ./values/production.yaml
```

## Configuration

Key configuration options in `values.yaml`:

```yaml
api:
  enabled: true
  replicas: 2
  port: 3100
  env:
    BASE_DOMAIN: iotistica.com
    DEFAULT_TRIAL_DAYS: "14"
    GITOPS_ENABLED: "true"

worker:
  enabled: true
  replicas: 3
  concurrency: 3
  retryAttempts: 3

ingress:
  enabled: true
  hostname: billing.iotistica.com
  gateway: eg
  gatewayNamespace: envoy-gateway-system
```

### Exposing PostgreSQL via a TCP Gateway (optional)

To expose the PostgreSQL service externally through an Envoy Gateway TCPRoute, enable
the `postgres.ingress` block:

```yaml
postgres:
  enabled: true
  ingress:
    enabled: true
    gateway: iotistica-gateway
    gatewayNamespace: envoy-gateway-system
```

When `postgres.ingress.enabled` is `false` (the default) no TCPRoute is created.

## Architecture

The chart deploys:

1. **API Service** - REST API handling customer signup, Stripe webhooks, Auth0 callbacks
2. **Worker Service** - Bull queue workers processing deployment jobs
3. **PostgreSQL** - Database for customer data, subscriptions, usage tracking
4. **Redis** - Bull queue backend and caching layer

## Endpoints

- `GET /health` - Health check endpoint
- `POST /api/customers/signup` - Customer signup
- `POST /api/webhooks/stripe` - Stripe webhook handler
- `GET /api/auth/callback-auth0` - Auth0 callback
- `POST /api/auth/signup-callback` - Auth0 signup callback

## Monitoring

The API service exposes health endpoints for liveness and readiness probes:

- Liveness probe: `GET /health` (initial delay 30s, period 10s)
- Readiness probe: `GET /health` (initial delay 10s, period 5s)

## Upgrade

```bash
helm upgrade provisioning ./charts/provisioning \
  --namespace provisioning \
  --values ./values/production.yaml
```

## Uninstall

```bash
helm uninstall provisioning --namespace provisioning
```

## Dependencies

This chart depends on:

- `postgresql` (Bitnami, version 15.x.x)
- `redis` (Bitnami, version 19.x.x)

Dependencies are automatically installed via Helm.
