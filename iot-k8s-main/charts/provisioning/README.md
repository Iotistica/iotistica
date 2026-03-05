# Provisioning Service Helm Chart

Multi-tenant database provisioning service for the Iotistica platform. This chart deploys the provisioning API, worker, and supporting services that create isolated PostgreSQL databases and roles for each customer tenant.

## Architecture

```
┌──────────────────────────────────┐
│  Provisioning Service            │
│  ├─ API (REST endpoints)         │
│  │  └─ Port 3100                 │
│  ├─ Worker (background jobs)     │
│  └─ Redis (job queue)            │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  Shared PostgreSQL Server        │
│  ├─ Provider: postgres           │
│  ├─ Admin user: provisioner      │
│  └─ Template database            │
│     template_iotistica           │
└──────────────────────────────────┘
```

## Prerequisites

### PostgreSQL Admin User (CRITICAL)

The provisioning service requires a dedicated PostgreSQL user with specific privileges. **This is the most common source of provisioning failures.**

#### ⚠️ Security Requirements

The admin user MUST have:
- ✓ `CREATEDB` privilege (ability to create new databases)
- ✓ `CREATEROLE` privilege (ability to create and manage roles)
- ✗ **NOT** superuser privileges (principle of least privilege)

#### Why NOT Superuser?

Superuser privileges violate the principle of least privilege:
- Creates unnecessary security risk if credentials are compromised
- Allows dangerous operations (DROP DATABASE, ALTER SYSTEM, DROP ROLE)
- Unnecessary for provisioning operations (CREATEDB + CREATEROLE are sufficient)

#### Setup Instructions

1. **Connect to PostgreSQL as superuser:**
   ```bash
   psql -h your-postgres-host -U postgres -d postgres
   ```

2. **Create the provisioner role:**
   ```sql
   CREATE ROLE provisioner WITH LOGIN PASSWORD 'your-secure-password';
   ALTER ROLE provisioner CREATEDB CREATEROLE;
   -- Do NOT grant superuser privilege
   ```

3. **Verify the provisioning user has correct privileges:**
   ```sql
   SELECT usecreatedb, usecreaterole, usesuper FROM pg_user WHERE usename='provisioner';
   ```
   
   Expected output:
   ```
    usecreatedb | usecreaterole | usesuper
   ─────────────┼───────────────┼──────────
    t           | t             | f
   ```
   (true, true, false)

4. **Create the admin database credentials secret:**
   ```bash
   kubectl create secret generic provisioning-pg-admin-credentials \
     --from-literal=username=provisioner \
     --from-literal=password='your-secure-password' \
     -n provisioning
   ```

### 1Password Integration (if enabled)

For production deployments using 1Password integration, ensure the following items exist:

- **provisioning-jwt-secret**: JWT signing keys for customer licenses
  - Required fields: `jwt_private_key`, `jwt_public_key`
  
- **provisioning-pg-admin-credentials**: Database admin credentials
  - Required fields: `username`, `password`

## Installation

### Basic Installation

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace
```

### Custom PostgreSQL Host

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace \
  --set postgresProvisioning.host=my-postgres-server.company.com
```

### With HTTPS/SSL to PostgreSQL

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace \
  --set postgresProvisioning.ssl=true \
  --set postgresProvisioning.sslRejectUnauthorized=false  # if using self-signed cert
```

## Verification After Deployment

### 1. Check Pod Status

```bash
kubectl get pods -n provisioning
```

All pods should be `Running`:
- `provisioning-api-*`
- `provisioning-worker-*`
- `provisioning-postgres-*` (if enabled)

### 2. Verify Provisioning User Setup

The Provisioning Service will log security warnings during startup if the admin user lacks required privileges.

Check the API logs:
```bash
kubectl logs -n provisioning deployment/provisioning-api | grep -i "provisioning user\|privilege"
```

Expected output (informational, not an error):
```
Provisioning user must have CREATEDB + CREATEROLE (not superuser)
```

### 3. Test Template Database Creation

The provisioning API creates the template database on first startup:

```bash
# Get into a pod and test
kubectl exec -it -n provisioning deployment/provisioning-api -- psql \
  -h provisioning-postgres.provisioning.svc.cluster.local \
  -U provisioner \
  -d postgres \
  -c "\l"  # List databases
```

You should see the template database created:
```
                                    List of databases
        Name        |  Owner   | Encoding |   Collate   |    Ctype    | ...
─────────────────────┼──────────┼──────────┼─────────────┼─────────────┼─...
 postgres            | postgres | UTF8     | en_US.UTF-8 | en_US.UTF-8 |
 template_iotistica  | provisioner | UTF8   | en_US.UTF-8 | en_US.UTF-8 |
 template0           | postgres | UTF8     | en_US.UTF-8 | en_US.UTF-8 |
 template1           | postgres | UTF8     | en_US.UTF-8 | en_US.UTF-8 |
```

### 4. Check Health Endpoint

```bash
curl https://api.iotistica.com/health
```

Should return HTTP 200 with health status.

## Troubleshooting

### Provisioning Service Won't Start

**Symptom**: Pods are in `CrashLoopBackOff` with permission errors

**Check logs:**
```bash
kubectl logs -n provisioning deployment/provisioning-api --tail=100
```

**Most Common Issues:**

1. **"permission denied for schema public"**
   - Admin user lacks `CREATEDB` or `CREATEROLE` privilege
   - Verify: `SELECT usecreatedb, usecreaterole FROM pg_user WHERE usename='provisioner';`
   - Fix: `ALTER ROLE provisioner CREATEDB CREATEROLE;`

2. **"must be superuser to create extension"**
   - Template database doesn't have extensions pre-created
   - This chart's postgres-init job should handle this
   - Check PostgreSQL init logs: `kubectl logs -n provisioning job/provisioning-postgres-init`

3. **"FATAL: role 'provisioner' does not exist"**
   - Provisioning user not created in PostgreSQL
   - Create it: `CREATE ROLE provisioner WITH LOGIN PASSWORD '...';`

4. **"no password supplied"**
   - `provisioning-pg-admin-credentials` secret not found or missing `password` field
   - Verify secret: `kubectl get secret provisioning-pg-admin-credentials -n provisioning -o yaml`

### Database Provisioning Fails

**Symptom**: "provisioning" status stays in "provisioning" state, never completes

**Check worker logs:**
```bash
kubectl logs -n provisioning deployment/provisioning-worker -f
```

**Common issues:**
- Admin user lacks privileges (same as above)
- Redis unreachable (worker can't get job queue)
- Kubernetes API unreachable (can't create per-customer namespaces)

### Template Database Already Exists

**Symptom**: "template_iotistica already exists" error during init

This is normal if upgrading the chart. The postgres-init job is idempotent and skips existing templates.

## Configuration

All configurable values are in `values.yaml`. Key sections:

### API Service
- `api.replicas`: Number of API pods (default: 1)
- `api.resources`: CPU/memory limits
- `api.env`: Environment variables (NODE_ENV, BASE_DOMAIN, etc.)

### Worker Service
- `worker.replicas`: Number of worker pods
- `worker.concurrency`: Max concurrent provisioning jobs
- `worker.retryAttempts`: Failed job retry attempts
- `worker.retryDelay`: Delay between retries (ms)

### PostgreSQL Provisioning
- `postgresProvisioning.provider`: "postgres" or "tigerdata" (Timescale Cloud)
- `postgresProvisioning.host`: Hostname of shared PostgreSQL server
- `postgresProvisioning.port`: PostgreSQL port (default: 5432)
- `postgresProvisioning.ssl`: Enable TLS to PostgreSQL (default: false for internal K8s)
- `postgresProvisioning.templateDatabase`: Template database name (default: template_iotistica)

## Security Best Practices

1. **Database User Privilege**
   - Always use a separate, non-superuser account for provisioning
   - Regularly audit provisioning user permissions
   - Use strong passwords and rotate periodically

2. **Network Security**
   - For external PostgreSQL: Use TLS/SSL
   - Set `postgresProvisioning.ssl=true` and provide TLS certificates
   - Use network policies to restrict PostgreSQL access

3. **Credential Management**
   - Use 1Password or similar secret management for credentials
   - Don't commit secrets to Git
   - Rotate credentials regularly

4. **Audit & Monitoring**
   - Enable PostgreSQL query logging for admin operations
   - Monitor provisioning job success/failure rates
   - Set up alerts for provisioning failures

## Development

For local development without 1Password:

```bash
helm install provisioning ./charts/provisioning \
  --namespace provisioning \
  --create-namespace \
  --set provisioning.onepassword.enabled=false \
  --set postgresProvisioning.host=postgres \
  --set postgres.enabled=true
```

## Support

For issues related to:
- **Provisioning API**: Check `deployment/provisioning-api` logs
- **Provisioning Worker**: Check `deployment/provisioning-worker` logs
- **PostgreSQL**: Check `statefulset/provisioning-postgres` logs or connect directly
- **Secrets**: Verify 1Password integration or secret creation
