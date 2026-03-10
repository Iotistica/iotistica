# Iotistic IoT Platform - AI Coding Agent Instructions

**A multi-tenant SaaS IoT platform** combining edge device management (Raspberry Pi) with cloud-based Kubernetes deployment, Stripe billing, and JWT license validation.

## ⚠️ Architecture Alert: Two Deployment Models

This codebase supports **TWO DISTINCT ARCHITECTURES** - understand which you're working with:

### 1. **Edge Device Stack** (Raspberry Pi / x86_64)
- Single-tenant: One device, one customer
- Docker Compose orchestration (`docker-compose.yml`, `docker-compose.dev.yml`)
- Services: `agent/`, `api/`, `dashboard/`, `mosquitto/`, `postgres/`, `neo4j/`, `vpn-client/`
- VPN tunnel to cloud (10.8.0.0/24 subnet)
- Target: On-premise hardware (Raspberry Pi arm64/armv7l, x86_64)

### 2. **Multi-Tenant SaaS** (Current Focus - Kubernetes)
- Cloud-hosted: Multiple customers, isolated namespaces
- Three namespace types:
  1. **Global billing**: Billing API + Managed PostgreSQL (AWS RDS/Cloud SQL/Azure)
  2. **Global vpn-server**: OpenVPN server + Certificate Manager API
  3. **Per-customer**: API, Dashboard, PostgreSQL, Mosquitto, Redis, Billing Exporter, Prometheus
- Kubernetes/Helm deployment (`charts/customer-instance/`)
- Target: Cloud K8s clusters (AWS EKS, GKE, AKS, etc.)

**When editing**: Always clarify which deployment model your changes affect. Many services (API, Mosquitto) exist in both contexts but with different configurations.

---

## Critical Architecture Patterns

### 1. Multi-Tenant SaaS (Kubernetes)

**The "Why"**: One billing service deploys isolated customer instances. Customer signs up → 14-day trial → K8s namespace deployed → JWT license issued.

**Flow**: `billing/` → Stripe checkout → `k8s-deployment-service.ts` → Helm chart → Customer namespace

**Key Files**:
- `billing/src/services/k8s-deployment-service.ts` - Helm orchestration
- `charts/customer-instance/` - Helm chart templates
- `billing/src/services/license-generator.ts` - RS256 JWT signing
- `api/src/middleware/license-validator.ts` - JWT verification

**Namespace Convention**: `customer-{12-char-hash}` (e.g., `customer-a3f5c8d9e2b1`)
- SHA256 hash of Stripe customer ID to prevent collisions
- Deterministic: Same customer ID always produces same namespace
- Security: 12 hex chars = 48 bits = ~281 trillion combinations
- Each namespace gets: API, Dashboard, PostgreSQL (dedicated), Mosquitto, Redis, Billing Exporter
- Prometheus: Shared (Starter/Pro) or Dedicated (Enterprise)

**Kubernetes Architecture**:
```
Global billing namespace:
  - Billing API (port 3100)
  - Managed PostgreSQL (AWS RDS/Cloud SQL/Azure Database)
  
Global vpn-server namespace:
  - OpenVPN Server (port 1194, UDP)
  - Certificate Manager API (port 8080)
  - PostgreSQL (device registry)

Per-customer namespace (customer-{id}):
  - API (port 3002) - Device management, MQTT ACLs, Neo4j
  - Dashboard (port 3000) - React UI, Digital Twin
  - PostgreSQL (dedicated) - Device shadow, MQTT ACLs, metrics
  - Mosquitto (port 1883) - MQTT broker with PostgreSQL auth
  - Redis (port 6379) - Real-time metrics, Bull queues, caching
  - Billing Exporter - Usage metrics to Prometheus
  - Prometheus - Shared (monitoring namespace) or Dedicated (Enterprise)
  
Edge devices:
  - VPN Client - OpenVPN tunnel (10.8.0.x IP)
  - Agent - Container orchestrator
  - Local API - Device management
```

**License Validation Pattern**:
```typescript
// billing/ signs with PRIVATE key
const jwt = sign(payload, privateKey, { algorithm: 'RS256' });

// api/ validates with PUBLIC key
const decoded = verify(token, publicKey, { algorithms: ['RS256'] });
```

**Environment Variables - CRITICAL**:
- `SIMULATE_K8S_DEPLOYMENT=true` - Skip actual Helm for local dev
- `LICENSE_PUBLIC_KEY` - Must match billing service's private key (PEM format with newlines!)
- `IOTISTIC_LICENSE_KEY` - JWT passed to customer instances
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` - Billing integration

**When adding features**: Check if feature requires billing plan upgrade. Use `LicenseValidator.checkFeatureAccess()` to gate features.

**Monitoring Architecture**:
- **Shared Prometheus** (Starter/Professional): ServiceMonitor in customer namespace, scraped by cluster Prometheus in `monitoring` namespace
- **Dedicated Prometheus** (Enterprise): Full Prometheus + Grafana stack deployed in customer namespace with 30-day retention and 50GB storage
- License JWT contains monitoring flags: `hasDedicatedPrometheus`, `prometheusRetentionDays`, `prometheusStorageGb`
- Deployment service automatically configures monitoring based on license

### 2. Edge Device Stack (Raspberry Pi)

**The "Why"**: Single-tenant IoT stack on customer's own hardware for environmental monitoring and data collection.

**Services** (Docker Compose):
- `agent/` - localhost debug or Container orchestrator (inspired by Balena Supervisor)
- `mosquitto/` - MQTT broker (1883, 9001)

**Pattern**: `docker-compose.yml.tmpl` + `envsubst` → `docker-compose.yml`
- See `bin/install.sh::set_device_type()` for architecture detection


**Service Communication**:
- Use container names: `mqtt://mosquitto:1883`, `http://influxdb:8086`
- Exception: Agent uses `network_mode: host` → accesses via `localhost:port`

### 3. Database Patterns

**PostgreSQL** (Multi-tenant SaaS):
- `billing/` - Customer/subscription/usage tables (managed instance: AWS RDS/Cloud SQL/Azure)
- `api/` - Device shadow state, MQTT ACLs (dedicated per-customer instance in K8s)
- `vpn-server/` - Device registry, certificate tracking (global instance)
- Shared auth: Mosquitto uses PostgreSQL for ACL via `mosquitto-go-auth`

**Neo4j** (Digital Twin):
- Graph database for spatial relationships
- IFC file parsing for building information models
- Device-space mapping
- 3D visualization support

**Redis** (Per-customer):
- Real-time metrics (Redis Streams)
- Bull queues for async jobs
- Caching layer

**Migration Commands**:
```bash
# Billing service
cd billing && npx knex migrate:latest

# Customer API instance
cd api && npx knex migrate:latest
```

**MQTT ACL Pattern** (Critical for multi-tenancy):
```sql
-- mosquitto-go-auth queries postgres
SELECT 1 FROM mqtt_acls 
WHERE username = $1 AND topic = $2 AND rw >= $3
```

**Connection String Convention**:
- K8s: `postgresql://postgres:password@postgres:5432/iotistic`
- Local: `postgresql://localhost:5432/iotistic`

---

## Development Workflows

### Starting Services

**Multi-Tenant SaaS (Local Dev)**:
```powershell
# Start billing + postgres
docker-compose up -d postgres
cd billing && npm run dev

# Start customer API instance
cd api && npm run dev

# Test signup flow
.\billing\scripts\test-signup-flow.ps1
```

**Edge Device Stack**:
```bash
# Development mode
docker-compose -f docker-compose.dev.yml up -d

# Build agent
cd agent && npm run build

# Access services
curl http://localhost:48484/v2/device  # Agent API
http://localhost:1880                  # Node-RED
http://localhost:3000                  # Grafana (admin/admin)
```

**Sensor Simulator** (No hardware testing):
```bash
docker-compose -f docker-compose.dev.yml up -d sensor-simulator
# Generates 3 fake sensors publishing to MQTT
```

### Testing Kubernetes Deployment

**Local (Simulated)**:
```powershell
cd billing
$env:SIMULATE_K8S_DEPLOYMENT="true"
npm run dev

# Signup creates customer but skips Helm
curl -X POST http://localhost:3100/api/customers/signup `
  -H "Content-Type: application/json" `
  -d '{...}'
```

**Real K8s Cluster**:
```bash
# Deploy billing service
kubectl apply -f billing/k8s/

# Test customer signup (creates namespace + Helm release)
curl -X POST https://billing.iotistic.cloud/api/customers/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", ...}'

# Verify deployment
kubectl get namespaces | grep customer-
kubectl get pods -n customer-dc5fec42
```

### Database Migrations

**Create New Migration**:
```bash
cd api && npx knex migrate:make add_feature_table
cd billing && npx knex migrate:make update_subscriptions
```

**Run Migrations**:
```bash
# Local
npx knex migrate:latest

# K8s (run inside pod)
kubectl exec -it -n billing deployment/billing-api -- npm run migrate
```

---

## Critical Conventions

### Service Communication

**Rule**: Always use **container names** for inter-service URLs (not `localhost`)

**Correct**:
```typescript
const mqttUrl = 'mqtt://mosquitto:1883';
const dbHost = 'postgres';
const apiUrl = 'http://api:3002';
```

**Exception**: Agent (edge device) uses `network_mode: host`:
```typescript
// Only in agent/
const mqttUrl = 'mqtt://localhost:1883';
```

### Environment Variables

**Naming Convention**:
- Database: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- MQTT: `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`
- Ports: `API_PORT_EXT`, `MOSQUITTO_PORT_EXT` (external), `PORT` (internal)

**Multi-Tenant Critical**:
- `LICENSE_PUBLIC_KEY` - RSA public key (PEM format, newlines preserved!)
- `IOTISTIC_LICENSE_KEY` - JWT token (passed to customer instances)
- `SIMULATE_K8S_DEPLOYMENT` - Skip Helm for local dev

**Port Allocation**:
- Internal: Standard (1883, 3000, 8086, etc.)
- External: 5xxxx range for custom mappings (`GRAFANA_PORT_EXT=53000`)

### Container State Control (Agent)

**State Field**: Add `state` field to service config for declarative container control

**Values**:
- `"running"` (default) - Container should be running
- `"stopped"` - Container gracefully stopped (SIGTERM), config preserved
- `"paused"` - Container processes frozen (SIGSTOP), instant suspend/resume

**Example** (target state JSON):
```json
{
  "1001": {
    "appId": "1001",
    "appName": "test-app",
    "services": [
      {
        "serviceId": "2",
        "serviceName": "nodered",
        "imageName": "nodered/node-red:latest",
        "state": "paused",  // Optional: defaults to "running" if omitted
        "config": {
          "ports": ["1880:1880"],
          "volumes": ["nodered-data:/data"]
        }
      }
    ]
  }
}
```

**Implementation Details**:
- `agent/src/orchestrator/types.ts`: `ServiceConfig.state` field definition
- `agent/src/compose/container-manager.ts`: Reconciliation logic (lines 1138-1270)
- `agent/src/compose/docker-manager.ts`: Docker pause/unpause methods (lines 364-406)
- State synced from Docker: `syncCurrentStateFromDocker()` maps container.state → service.state
- Works with both Docker Compose and K3s orchestrators

**When to Use**:
- **Pause**: Temporary suspension (preserves container ID, instant resume, RAM preserved). Use this for quick suspend/resume cycles without losing container identity.
- **Stop**: Long-term shutdown (frees RAM, graceful SIGTERM, container recreated on restart). Note: Manually stopping in Docker Desktop also triggers this behavior.
- **Running**: Normal operation (default if state omitted)

**Critical Docker Behavior**: When a container is stopped (either via `state: "stopped"` or manual Docker Desktop stop), it enters "exited" state. Docker cannot restart exited containers - they must be removed and recreated. This causes container ID changes. If you need to preserve container IDs, always use `state: "paused"` instead of stopping.

### MQTT Topic Structure

**Pattern**: `<category>/<metric>`

**Topics**:
```
sensor/temperature      # Sensor readings
sensor/humidity
sensor/pressure
sensor/gas              # Air quality
system/status           # Device health
alerts/environmental    # Threshold alerts
```

**Payload Format**:
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "value": 23.5,
  "unit": "°C",
  "sensor_id": "bme688_001"
}
```

---

## Key Files Reference

### Multi-Tenant SaaS
- `billing/src/services/k8s-deployment-service.ts` - Helm orchestration
- `billing/src/services/license-generator.ts` - JWT signing (RS256)
- `billing/src/workers/deployment-worker.ts` - Async deployment queue
- `charts/customer-instance/templates/` - K8s manifests
- `api/src/middleware/license-validator.ts` - Feature gating
- `billing-exporter/src/collectors/` - Usage metrics
- `vpn-server/src/` - Certificate manager, device registry, OpenVPN config
- `vpn-server/scripts/` - PKI initialization, cert generation/revocation

### Edge Device Stack
- `agent/src/compose/container-manager.ts` - Docker orchestration with state management
- `agent/src/compose/docker-driver.ts` - Docker Compose driver implementation
- `agent/src/k3s/k3s-driver.ts` - K3s Kubernetes driver implementation (577 lines)
- `agent/src/device-api/` - REST API (port 48484)
- `bin/install.sh` - Installation script (CI + hardware detection)
- `ansible/roles/` - Deployment automation

**Container State Management** (agent/):
- **State Field**: `state?: "running" | "stopped" | "paused"` (optional, defaults to "running")
- **Docker Native**: Uses `docker pause/unpause/stop` commands (NOT replicas field)
- **State Transitions**: All 6 transitions supported (running↔paused, running↔stopped, paused↔stopped)
- **Container Preservation**: pause/unpause preserves container ID; stop/start recreates container (Docker limitation)
- **Orchestrator Abstraction**: Works with both Docker Compose and K3s drivers

**StateReconciler Architecture** (agent/):
- **Top-level orchestrator**: Coordinates `ContainerManager` and `ConfigManager`
- **SQLite persistence**: Target state saved to database, survives agent restarts
- **Unified interface**: Single entry point for both apps and device config
- **Event-driven**: Emits `target-state-changed`, `state-applied`, `reconciliation-complete`
- **Core pattern**: `setTarget()` → saves to DB → delegates to managers → reconcile → emit events
- See `agent/src/drivers/state-reconciler.ts` for implementation

**State Transition Behaviors**:
| Transition | Command | Container ID | Speed | RAM | Trigger |
|------------|---------|--------------|-------|-----|---------|
| running → paused | `docker pause` | Preserved ✅ | Instant | Preserved | Set `state: "paused"` |
| paused → running | `docker unpause` | Preserved ✅ | Instant | Preserved | Set `state: "running"` |
| running → stopped | `docker stop` | Preserved but exited | ~10s | Freed | Set `state: "stopped"` OR manual stop in Docker Desktop |
| stopped → running | Remove + recreate | Changes ❌ | ~10-30s | Allocated | Set `state: "running"` after stopped |

**Best Practice**: Use `state: "paused"` for temporary suspension to avoid container recreation and preserve IDs.

**Important**: If you manually stop a container in Docker Desktop (or via `docker stop`), the system will **recreate** it when target state is `"running"`. This is a Docker limitation - exited containers cannot be restarted, only removed and recreated. To preserve container IDs, use `state: "paused"` instead of stopping.

### Shared Services
- `api/src/routes/` - REST endpoints (both contexts)
- `api/src/services/neo4j.service.ts` - Digital Twin graph database
- `api/src/services/ifc-parser.service.ts` - Building information model parsing
- `dashboard/src/` - React admin panel (Vite + TypeScript)
- `dashboard/src/pages/DigitalTwinPage.tsx` - Digital Twin UI
- `dashboard/src/components/DigitalTwinGraph.tsx` - 3D visualization
- `mosquitto/mosquitto.conf` - MQTT broker config

### Agent Architecture Patterns
- `agent/src/drivers/state-reconciler.ts` - Top-level state orchestrator (containers + config)
- `agent/src/sync/index.ts` - CloudSync service (device ↔ cloud state synchronization)
- `agent/src/network/connection-monitor.ts` - Connection health tracking (online/degraded/offline)
- `agent/src/logging/agent-logger.ts` - Structured logging with log levels and components
- `agent/src/logging/cloud-backend.ts` - Cloud log aggregation with sampling
- `agent/src/updater.ts` - MQTT-triggered agent self-updates

---

## Testing Infrastructure

### Agent Testing (Jest)

**Test Types**:
- **Unit tests**: `npm run test:unit` - Fast, isolated component tests
- **Integration tests**: `npm run test:integration` - Docker interactions, database tests
- **Coverage**: `npm run test:coverage` - Generate coverage reports

**Test Structure**:
```bash
agent/
├── jest.config.js           # Main config
├── jest.config.unit.js      # Unit tests only
├── jest.config.integration.js  # Integration tests only
└── test/                    # Test files (*.test.ts)
```

**Running Tests**:
```bash
cd agent

# All tests
npm test

# Unit tests only (fast)
npm run test:unit

# Integration tests (requires Docker)
npm run test:integration

# Watch mode (auto-rerun on changes)
npm run test:watch:unit
```

### Dashboard Testing (Playwright)

**E2E Tests**:
```bash
cd dashboard
npm run test:e2e           # Run Playwright tests
npm run test:e2e:ui        # Interactive UI mode
```

**Test Location**: `dashboard/e2e/` - End-to-end browser tests

---

## Logging Conventions

### Agent Logging Pattern

**Rule**: Use `AgentLogger` (NOT `console.log`) for all agent code

**Correct**:
```typescript
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

class MyService {
  constructor(private logger?: AgentLogger) {}
  
  async doWork() {
    this.logger?.infoSync('Starting work', {
      component: LogComponents.agent,
      operation: 'doWork'
    });
    
    this.logger?.errorSync('Work failed', {
      component: LogComponents.agent,
      error: err.message
    });
  }
}
```

**Incorrect**:
```typescript
console.log('Starting work');  // ❌ Don't use in agent code
```

**Log Levels**:
- `debugSync()` - Verbose debugging (disabled by default)
- `infoSync()` - Informational messages
- `warnSync()` - Warnings (non-fatal issues)
- `errorSync()` - Errors (failures that need attention)

**Log Components** (`LogComponents` enum):
- `agent` - Main agent lifecycle
- `containerManager` - Container orchestration
- `stateReconciler` - State reconciliation
- `cloudSync` - Cloud synchronization
- `mqtt` - MQTT operations
- `vpn` - VPN client
- `provisioning` - Device provisioning

**Dynamic Log Levels**:
```typescript
// Set log level via environment
process.env.LOG_LEVEL = 'debug';  // or 'info', 'warn', 'error'

// Or programmatically
this.agentLogger.setLogLevel('debug');
```

**Cloud Log Backend**:
- Logs uploaded to cloud API via NDJSON format (gzip optional)
- Sampling rates configurable per level (100% errors, 100% warnings, 10% debug)
- See `agent/src/logging/cloud-backend.ts` for implementation

### API/Billing Logging

**Rule**: Use `logger` instance (Winston-based) instead of `console.log`

**Correct**:
```typescript
import { logger } from '../utils/logger';

logger.info('Customer created', { customerId, email });
logger.error('Deployment failed', { error: err.message, customerId });
```

---

## CloudSync Pattern (Agent ↔ Cloud)

### Pull-Based Synchronization

**The "Why"**: Devices poll cloud API for target state changes, avoiding complex push infrastructure

**Flow**:
```
Device (agent)              Cloud API
┌────────────┐             ┌──────────┐
│            │             │          │
│  Poll for  ├────────────>│ Target   │
│  changes   │  (ETag)     │ State    │
│            │             │          │
│            │<────────────┤ 304 or   │
│            │  (state)    │ 200+data │
│            │             │          │
│  Report    ├────────────>│ Current  │
│  state +   │  (PATCH)    │ State    │
│  metrics   │             │          │
└────────────┘             └──────────┘
```

**Key Files**:
- `agent/src/sync/index.ts` - CloudSync service implementation
- `agent/src/network/connection-monitor.ts` - Connection health tracking
- `api/src/routes/cloud.ts` - Cloud API endpoints

**Critical Patterns**:
- **ETag caching**: Server returns ETag hash, device sends `If-None-Match` to avoid redundant downloads
- **Connection monitoring**: Tracks consecutive failures, emits `online`/`degraded`/`offline` events
- **Graceful degradation**: Device continues operating if cloud unreachable (uses last-known target state)
- **Backoff strategy**: Exponential backoff on repeated failures (1s → 2s → 4s → 8s → max 60s)
- **Metrics reporting**: Device sends CPU/memory/temperature/uptime with each state report

**Environment Variables**:
```bash
# Agent
CLOUD_API_URL=https://api.iotistic.ca
POLL_INTERVAL_MS=30000        # How often to check for target state changes
REPORT_INTERVAL_MS=60000      # How often to report current state + metrics
```

**Connection States**:
- `online` - All operations succeeding
- `degraded` - Some failures but still connected (2+ consecutive failures)
- `offline` - Marked offline after 3 consecutive failures

**MQTT Update Trigger**:
- Cloud can publish to `agent/{uuid}/update` topic to trigger immediate poll
- Used for real-time updates without waiting for next poll interval
- See `agent/src/updater.ts` for MQTT-triggered agent self-updates

---

## Common Commands

### Multi-Tenant SaaS
```powershell
# Start billing stack
docker-compose up -d postgres
cd billing && npm run dev

# IMPORTANT: For API code changes (TypeScript/Node), restart is not enough.
# Always rebuild the API container so code is recompiled and copied into the image.
docker compose up -d api --build
# Avoid: docker compose restart api

# Generate license keys (first-time setup)
cd billing && npm run generate-keys

# Test signup flow
.\billing\scripts\test-signup-flow.ps1

# View deployment queue
curl http://localhost:3100/api/admin/jobs
```

### Edge Device Stack
```bash
# Install on Raspberry Pi
curl -sSL https://raw.githubusercontent.com/Iotistica/iotistic/master/bin/install.sh | bash

# Local development
docker-compose -f docker-compose.dev.yml up -d
cd agent && npm run dev

# Run tests
cd agent && npm run test:unit         # Fast unit tests
cd agent && npm run test:integration  # Requires Docker

# Ansible deployment
cd ansible && ./run.sh
```

### Kubernetes
```bash
# Deploy billing service
helm install billing ./charts/billing --namespace billing --create-namespace

# List customer instances
kubectl get namespaces -l managed-by=iotistic

# Check customer deployment
kubectl get pods -n customer-dc5fec42
kubectl logs -n customer-dc5fec42 deployment/customer-dc5fec42-api
```

### Agent Development
```bash
# Start agent in dev mode (auto-reload)
cd agent && npm run dev

# Build agent
npm run build

# Run specific test file
npm test -- container-manager.test.ts

# Watch mode for TDD
npm run test:watch:unit
```

---

## Troubleshooting Quick Reference

### License Validation Fails
**Symptom**: API returns 402 Payment Required

**Check**:
```bash
# Verify public key matches private key
cd billing && npm run verify-keys

# Check license JWT structure
echo $IOTISTIC_LICENSE_KEY | cut -d'.' -f2 | base64 -d | jq

# Test validation
curl http://localhost:3002/api/license/verify
```

### K8s Deployment Fails
**Symptom**: Customer status stuck in "provisioning" or Helm install errors

**Most Common Issue**: ServiceMonitor CRD not installed

```bash
# Error you'll see:
# "no matches for kind 'ServiceMonitor' in version 'monitoring.coreos.com/v1'"

# Fix: Install ServiceMonitor CRD (REQUIRED before any deployments)
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml

# Verify
kubectl get crd servicemonitors.monitoring.coreos.com

# Retry deployment
curl -X POST http://localhost:3100/api/customers/<customer-id>/deploy
```

**Other checks**:
```bash
# View deployment logs
kubectl logs -n billing deployment/billing-api

# Check Helm release
helm list --all-namespaces | grep customer-

# View deployment job status
curl http://localhost:3100/api/admin/jobs | jq

# Check customer namespace
kubectl get pods -n customer-<id>
kubectl get events -n customer-<id> --sort-by='.lastTimestamp'
```

### MQTT Connection Refused
**Symptom**: Devices can't connect to broker

**Check**:
```bash
# Verify mosquitto running
docker ps | grep mosquitto
kubectl get pods -n customer-dc5fec42 | grep mosquitto

# Test connection
mosquitto_pub -h localhost -p 1883 -t test -m "hello"

# Check ACL (K8s)
kubectl exec -it -n customer-dc5fec42 deployment/postgres -- \
  psql -U postgres -d iotistic -c "SELECT * FROM mqtt_acls;"
```

---

## Documentation Structure

**Primary Docs**:
- `README.md` - Project overview and quick start
- `charts/README.md` - **Complete Kubernetes guide** (cluster setup + Helm chart deployment)
- `docs/K8S-DEPLOYMENT-GUIDE.md` - Production Kubernetes deployment
- `docs/CUSTOMER-SIGNUP-K8S-DEPLOYMENT.md` - Signup flow implementation
- `billing/docs/README.md` - Complete billing system guide (3700 lines!)

**Service-Specific**:
- `agent/README.md` - Container orchestration (Balena-style)
- `api/README.md` - Unified API (Grafana + Docker + Cloud management)
- `dashboard/README.md` - React dashboard
- `billing-exporter/README.md` - Metrics collection

**Topic Directories** (`docs/`):
- `mqtt/` - MQTT centralization, topics, debugging
- `provisioning/` - Device provisioning workflows
- `security/` - Auth, JWT, provisioning security
- `database/` - PostgreSQL optimization, state records

---

## Architecture Philosophy

1. **Multi-Tenancy First**: Namespace isolation, resource quotas, network policies
2. **License-Driven Features**: All premium features gated by JWT validation
3. **Dual Deployment**: Cloud K8s for SaaS, Docker Compose for edge devices
4. **Configuration over Code**: Environment variables for all deployment decisions
5. **Developer Experience**: Simulated modes, comprehensive logging, clear error messages
6. **Code Style**: 
   - No emojis in code, logs, or documentation - use plain text only
   - Use `logger` instead of `console.log` when logger is available
7. **Docker Containers**: When working with local development, key services run in Docker containers:
   - PostgreSQL: `iotistic-postgres` (port 5432)
   - Mosquitto MQTT: `iotistic-mosquitto` (ports 5883, 59002)

**When making changes**: Always test both deployment contexts (K8s + Docker Compose) and verify license feature gating works correctly.
