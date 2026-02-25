# Customer Instance Upgrade System

This document describes the system-wide upgrade workflow for deploying new versions of components to all customer instances.

## Overview

The upgrade system allows you to deploy new versions of components (API, Dashboard, Exporter, Mosquitto) across all customer instances with different strategies:

- **All**: Upgrade all customers at once
- **Canary**: Upgrade a small percentage first, then proceed if successful
- **Batch**: Upgrade customers in batches

## Architecture

### Components

1. **UpgradeService** (`src/services/upgrade-service.ts`)
   - Manages upgrade lifecycle
   - Executes Helm upgrades for each customer
   - Tracks progress and failures

2. **Upgrade Routes** (`src/routes/upgrades.ts`)
   - REST API endpoints for starting/monitoring upgrades
   - POST `/api/upgrades/deploy` - Start an upgrade
   - GET `/api/upgrades/:id/status` - Check progress
   - GET `/api/upgrades/:id/logs` - View upgrade logs
   - POST `/api/upgrades/:id/rollback/:customerId` - Rollback a customer
   - POST `/api/upgrades/:id/continue` - Continue canary to all customers

3. **Deployment Worker** (`src/workers/deployment-worker.ts`)
   - Processes upgrade jobs asynchronously via Bull queue
   - Handles 'system-upgrade' job type

4. **Database Tables**
   - `system_upgrades` - Tracks overall upgrade status
   - `customer_upgrade_logs` - Individual customer upgrade attempts

## Usage

### 1. Push New Docker Image

```bash
# Build and push new version
cd api
docker build -t iotistic/api:v1.2.0 .
docker push iotistic/api:v1.2.0

# Also tag as latest if desired
docker tag iotistic/api:v1.2.0 iotistic/api:latest
docker push iotistic/api:latest
```

### 2. Start Upgrade via Script

```powershell
# Canary deployment (10% of customers first)
.\billing\scripts\upgrade-customers.ps1 -Component api -Version v1.2.0 -Strategy canary -CanaryPercent 10

# Upgrade all customers at once
.\billing\scripts\upgrade-customers.ps1 -Component dashboard -Version v2.0.0 -Strategy all

# Batch upgrade (10 customers at a time)
.\billing\scripts\upgrade-customers.ps1 -Component exporter -Version v1.1.0 -Strategy batch -BatchSize 10
```

### 3. Start Upgrade via API

```bash
# Start canary upgrade
curl -X POST http://localhost:3100/api/upgrades/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "component": "api",
    "version": "v1.2.0",
    "strategy": "canary",
    "canaryPercent": 10
  }'

# Response:
# {
#   "upgradeId": "123",
#   "jobId": "bull-job-456",
#   "strategy": "canary",
#   "message": "Canary upgrade started for 5 customers"
# }
```

### 4. Monitor Progress

```bash
# Check upgrade status
curl http://localhost:3100/api/upgrades/123/status

# Response:
# {
#   "upgradeId": "123",
#   "component": "api",
#   "version": "v1.2.0",
#   "strategy": "canary",
#   "total": 50,
#   "completed": 45,
#   "failed": 2,
#   "inProgress": 3,
#   "status": "in_progress",
#   "startedAt": "2025-10-22T17:00:00.000Z",
#   "completedAt": null
# }
```

### 5. View Upgrade Logs

```bash
# Get detailed logs for specific upgrade
curl http://localhost:3100/api/upgrades/123/logs

# Response includes per-customer upgrade attempts
```

### 6. Continue Canary Upgrade

After verifying canary customers are healthy:

```bash
# Continue to all remaining customers
curl -X POST http://localhost:3100/api/upgrades/123/continue
```

### 7. Rollback Individual Customer

If a customer encounters issues:

```bash
# Rollback specific customer to previous version
curl -X POST http://localhost:3100/api/upgrades/123/rollback/cust_abc123
```

## Upgrade Strategies

### Canary Deployment

Best for **high-risk changes** or **major version updates**.

```powershell
.\upgrade-customers.ps1 -Component api -Version v2.0.0 -Strategy canary -CanaryPercent 5
```

**Flow:**
1. Upgrades 5% of customers
2. Monitor for issues (check logs, metrics, customer feedback)
3. If successful, run continue command to upgrade remaining 95%
4. If issues found, rollback canary customers

**When to use:**
- Major version updates
- Breaking changes
- New features that need validation
- Uncertain about stability

### All-at-Once

Best for **low-risk changes** or **urgent hotfixes**.

```powershell
.\upgrade-customers.ps1 -Component api -Version v1.2.1 -Strategy all
```

**Flow:**
1. Upgrades all customers simultaneously
2. Fastest deployment
3. Highest risk if issues arise

**When to use:**
- Hotfixes for critical bugs
- Minor version bumps
- Well-tested changes
- Small customer base

### Batch Deployment

Best for **controlled rollout** with **moderate risk**.

```powershell
.\upgrade-customers.ps1 -Component dashboard -Version v1.3.0 -Strategy batch -BatchSize 20
```

**Flow:**
1. Upgrades customers in batches of 20
2. Each batch completes before next starts
3. Balanced between speed and safety

**When to use:**
- Large customer base
- Want controlled rollout without full canary
- Moderate confidence in changes

## Best Practices

### Before Upgrading

1. **Test thoroughly** in staging environment
2. **Tag images** with semantic versions (v1.2.0, not just 'latest')
3. **Review Helm chart** changes if any
4. **Check dependencies** between components
5. **Prepare rollback plan**

### During Upgrade

1. **Monitor Bull Board** dashboard: http://localhost:3100/admin/queues
2. **Watch logs** for each customer upgrade
3. **Check Kubernetes pods** are healthy after upgrade
4. **Verify customer applications** are functional

### After Upgrade

1. **Validate key customer instances** are working
2. **Monitor metrics** (error rates, performance, etc.)
3. **Keep old image versions** available for rollback
4. **Document any issues** encountered
5. **Update version tracking** in customer metadata

## Database Schema

### system_upgrades

```sql
CREATE TABLE system_upgrades (
  id SERIAL PRIMARY KEY,
  component VARCHAR(50) NOT NULL,
  from_version VARCHAR(50),
  to_version VARCHAR(50) NOT NULL,
  strategy VARCHAR(20) NOT NULL,
  total_customers INT NOT NULL DEFAULT 0,
  completed_customers INT NOT NULL DEFAULT 0,
  failed_customers INT NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  metadata JSONB
);
```

### customer_upgrade_logs

```sql
CREATE TABLE customer_upgrade_logs (
  id SERIAL PRIMARY KEY,
  upgrade_id INT REFERENCES system_upgrades(id) ON DELETE CASCADE,
  customer_id VARCHAR(255) NOT NULL,
  component VARCHAR(50) NOT NULL,
  from_version VARCHAR(50),
  to_version VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  output TEXT,
  error TEXT
);
```

## Troubleshooting

### Upgrade Stuck or Taking Too Long

```bash
# Check Bull queue
curl http://localhost:3100/api/queue/stats

# Check specific job
curl http://localhost:3100/api/queue/jobs/:jobId

# Check Kubernetes events
kubectl get events -A --sort-by='.lastTimestamp'
```

### Customer Upgrade Failed

```bash
# View error details
curl http://localhost:3100/api/upgrades/123/logs | jq '.logs[] | select(.status=="failed")'

# Check customer's namespace
kubectl get all -n customer-abc123

# Check pod logs
kubectl logs <pod-name> -n customer-abc123

# Rollback if needed
curl -X POST http://localhost:3100/api/upgrades/123/rollback/cust_abc123
```

### Rollback All Customers

If an upgrade needs to be reversed:

```bash
# For each customer namespace
kubectl get ns | grep customer- | awk '{print $1}' | while read ns; do
  helm rollback ${ns} -n ${ns}
done
```

Or via script:

```powershell
# Get all customer namespaces
$namespaces = kubectl get ns -o json | ConvertFrom-Json | 
  Select-Object -ExpandProperty items | 
  Where-Object { $_.metadata.name -like "customer-*" } |
  Select-Object -ExpandProperty metadata |
  Select-Object -ExpandProperty name

# Rollback each
foreach ($ns in $namespaces) {
  Write-Host "Rolling back $ns..."
  helm rollback $ns -n $ns
}
```

## API Reference

### POST /api/upgrades/deploy

Start a system-wide upgrade.

**Request:**
```json
{
  "component": "api|dashboard|exporter|mosquitto",
  "version": "v1.2.0",
  "strategy": "all|canary|batch",
  "canaryPercent": 10,
  "batchSize": 10
}
```

**Response:**
```json
{
  "upgradeId": "123",
  "jobId": "bull-job-456",
  "strategy": "canary",
  "message": "Canary upgrade started for 5 customers"
}
```

### GET /api/upgrades/:upgradeId/status

Get upgrade progress.

**Response:**
```json
{
  "upgradeId": "123",
  "component": "api",
  "version": "v1.2.0",
  "strategy": "canary",
  "total": 50,
  "completed": 45,
  "failed": 2,
  "inProgress": 3,
  "status": "in_progress",
  "startedAt": "2025-10-22T17:00:00.000Z",
  "completedAt": null
}
```

### GET /api/upgrades/:upgradeId/logs

Get detailed upgrade logs.

**Response:**
```json
{
  "upgradeId": "123",
  "count": 50,
  "logs": [
    {
      "id": 1,
      "customer_id": "cust_abc123",
      "component": "api",
      "from_version": "v1.1.0",
      "to_version": "v1.2.0",
      "status": "completed",
      "started_at": "2025-10-22T17:00:00.000Z",
      "completed_at": "2025-10-22T17:01:30.000Z",
      "output": "Helm upgrade successful...",
      "error": null
    }
  ]
}
```

### POST /api/upgrades/:upgradeId/continue

Continue canary upgrade to all remaining customers.

**Response:**
```json
{
  "message": "Upgrade continuation queued",
  "upgradeId": "123",
  "jobId": "bull-job-789"
}
```

### POST /api/upgrades/:upgradeId/rollback/:customerId

Rollback a specific customer to previous version.

**Response:**
```json
{
  "message": "Rollback completed",
  "customerId": "cust_abc123",
  "namespace": "customer-abc123"
}
```

## Examples

### Example 1: Safe API Upgrade with Canary

```powershell
# 1. Build and push new API version
cd api
docker build -t iotistic/api:v1.3.0 .
docker push iotistic/api:v1.3.0

# 2. Start canary (5% of customers)
.\billing\scripts\upgrade-customers.ps1 -Component api -Version v1.3.0 -Strategy canary -CanaryPercent 5

# 3. Monitor canary customers for 24 hours
# Check logs, metrics, customer feedback

# 4. If successful, continue to all
curl -X POST http://localhost:3100/api/upgrades/123/continue
```

### Example 2: Emergency Hotfix

```powershell
# Critical bug fix - deploy immediately to all
.\billing\scripts\upgrade-customers.ps1 -Component api -Version v1.2.1-hotfix -Strategy all
```

### Example 3: Gradual Dashboard Rollout

```powershell
# Upgrade in batches of 15 customers
.\billing\scripts\upgrade-customers.ps1 -Component dashboard -Version v2.0.0 -Strategy batch -BatchSize 15
```

## Future Enhancements

- [ ] Health checks before/after upgrade
- [ ] Automatic rollback on failure
- [ ] Blue-green deployments
- [ ] Upgrade scheduling (maintenance windows)
- [ ] Customer notification system
- [ ] Metrics integration (Prometheus/Grafana)
- [ ] Slack/email notifications
- [ ] Version compatibility checks
