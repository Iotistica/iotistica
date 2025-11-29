# Agent - AI Coding Agent Instructions

Critical patterns and workflows for the Iotistic edge device agent.

## Architecture Overview

The **Agent** is the core orchestration service running on edge devices (Raspberry Pi, x86_64). It manages:

- **Container Orchestration**: Docker Compose
- **Device Provisioning**: Two-phase authentication with cloud API
- **Cloud Synchronization**: Pull-based state polling and metrics reporting
- **MQTT Communication**: Secure MQTT/MQTTS with PostgreSQL-backed ACLs
- **System Monitoring**: CPU, memory, temperature, network metrics
- **Anomaly Detection**: Real-time ML-based anomaly detection
- **Local SQLite Database**: Device state, configuration, and logs

### Key Components

**Core Classes** (`agent/src/agent.ts`):
```typescript
export default class DeviceAgent {
  private stateReconciler: StateReconciler;      // Top-level state orchestrator
  private containerManager: ContainerManager;    // Docker/K3s operations
  private deviceManager: DeviceManager;          // Provisioning logic
  private cloudSync: CloudSync;                  // Cloud communication
  private mqttManager: MqttManager;              // MQTT client
  private agentLogger: AgentLogger;              // Structured logging
  private anomalyService: AnomalyDetectionService; // ML anomaly detection
  private firewall: AgentFirewall;               // Network security
  private updater: AgentUpdater;                 // Self-update handler
}
```

**Service Hierarchy**:
```
DeviceAgent (main orchestrator)
├── StateReconciler (container + config state)
│   ├── ContainerManager (Docker/K3s)
│   └── ConfigManager (device config)
├── DeviceManager (provisioning)
├── CloudSync (cloud communication)
├── MqttManager (MQTT client)
├── DeviceAPI (REST API on port 48484)
├── AnomalyDetectionService (ML monitoring)
└── SimulationOrchestrator (testing framework)
```

---

## SQLite Database

### Database Location

**Path**: `${DATABASE_PATH}` or `<cwd>/data/device.sqlite`

**Connection**:
```typescript
// agent/src/db/connection.ts
const db = knex({
  client: 'sqlite3',
  connection: {
    filename: databasePath,
  },
  useNullAsDefault: true,
});
```

**Access Patterns**:
```typescript
// Via models() helper
import { models } from './db/connection';
const device = await models('device').first();

// Via model classes
import { DeviceModel } from './db/models/device.model';
const deviceModel = new DeviceModel();
const device = await deviceModel.getDevice();
```

### Tables

**`device`** - Core device information (single row):
```sql
CREATE TABLE device (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,          -- Device UUID (generated on first run)
  deviceId TEXT,                      -- Cloud device ID (from provisioning)
  deviceName TEXT,                    -- Human-readable name
  deviceType TEXT,                    -- Device type (e.g., 'edge-gateway')
  apiKey TEXT,                        -- Device API key (for cloud auth)
  apiEndpoint TEXT,                   -- Cloud API URL
  registeredAt INTEGER,               -- Unix timestamp
  provisioned BOOLEAN DEFAULT FALSE,  -- Provisioning status
  mqttBrokerUrl TEXT,                 -- MQTT broker URL
  mqttUsername TEXT,                  -- MQTT username
  mqttPassword TEXT,                  -- MQTT password (encrypted)
  mqttBrokerConfig TEXT,              -- JSON: broker config (host, port, TLS)
  apiTlsConfig TEXT,                  -- JSON: API TLS config (CA cert, etc.)
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**`target_state`** - Target container state from cloud:
```sql
CREATE TABLE target_state (
  id INTEGER PRIMARY KEY,
  apps TEXT NOT NULL,                 -- JSON: { "1001": { appId, services: [...] } }
  config TEXT,                        -- JSON: device config (optional)
  state_hash TEXT,                    -- SHA256 hash for change detection
  version INTEGER,                    -- State version number
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**`device_sensors`** - Sensor configurations:
```sql
CREATE TABLE device_sensors (
  id INTEGER PRIMARY KEY,
  configId TEXT NOT NULL UNIQUE,     -- Cloud-assigned config ID
  name TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'modbus', 'opcua', etc.
  protocol TEXT NOT NULL,
  config TEXT NOT NULL,               -- JSON: protocol-specific config
  enabled BOOLEAN DEFAULT TRUE,
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP
);
```

**`endpoint_outputs`** - Sensor output definitions:
```sql
CREATE TABLE endpoint_outputs (
  id INTEGER PRIMARY KEY,
  sensorId INTEGER NOT NULL,          -- FK to device_sensors
  name TEXT NOT NULL,
  dataType TEXT NOT NULL,             -- 'temperature', 'humidity', etc.
  unit TEXT,
  topic TEXT NOT NULL,                -- MQTT topic
  config TEXT,                        -- JSON: output-specific config
  FOREIGN KEY (sensorId) REFERENCES device_sensors(id) ON DELETE CASCADE
);
```

**`anomaly_detections`** - Anomaly detection history:
```sql
CREATE TABLE anomaly_detections (
  id INTEGER PRIMARY KEY,
  metric TEXT NOT NULL,               -- 'cpu_temp', 'memory_percent', etc.
  value REAL NOT NULL,
  expected REAL,
  deviation REAL,
  method TEXT NOT NULL,               -- 'z_score', 'mad', 'iqr', 'rate_change', 'lstm'
  severity TEXT NOT NULL,             -- 'low', 'medium', 'high', 'critical'
  confidence REAL NOT NULL,           -- 0.0 to 1.0
  timestamp INTEGER NOT NULL,         -- Unix timestamp
  metadata TEXT                       -- JSON: additional context
);
```

### Migrations

**Auto-Run**: Migrations run automatically on agent startup via `db.migrate.latest()`

**Location**: `agent/src/db/migrations/*.js`

**Naming**: `YYYYMMDDHHMMSS_description.js` (e.g., `20250102000000_add_device.js`)

**NPM Command**: `npm run build` - TypeScript compilation + copies migrations to `dist/`

**Pattern**:
```javascript
// Knex migration format (JavaScript, not SQL)
export async function up(knex) {
  await knex.schema.createTable('my_table', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.timestamp('createdAt').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('my_table');
}
```

**Recent Migrations**:
- `20250102000000_add_device.js` - Device table for provisioning
- `20250103000000_add_provisioning_keys.js` - RSA key exchange support
- `20251020000000_add_mqtt_credentials.js` - MQTT auth storage
- `20251112000000_add_mqtt_broker_config.js` - MQTTS TLS config
- `20251113000000_add_api_tls_config.js` - API TLS config

---

## Provisioning Workflow

### First-Time Provisioning

**Trigger**: Agent starts with `REQUIRE_PROVISIONING=true` and no device in database

**Flow**:
1. **Generate UUID**: If no device exists, generate UUID via `uuid.v4()`
2. **Key Exchange** (Phase 1):
   ```typescript
   POST /api/provisioning/v2/key-exchange
   Body: { deviceUuid, provisioningApiKey }
   Response: { apiPublicKey, keyId }
   ```
3. **Generate RSA Keypair**: Agent creates 2048-bit RSA keypair
4. **Send Device Public Key**:
   ```typescript
   POST /api/provisioning/v2/key-exchange
   Body: { deviceUuid, provisioningApiKey, devicePublicKey }
   ```
5. **Encrypt Registration Data** (Phase 2):
   ```typescript
   // Encrypt sensitive data with API's public key
   const encrypted = crypto.publicEncrypt(apiPublicKey, Buffer.from(JSON.stringify({
     deviceUuid,
     provisioningApiKey,
     deviceName,
     deviceType,
     macAddress,
     osVersion,
   })));
   ```
6. **Register Device**:
   ```typescript
   POST /api/provisioning/v2/register
   Body: { encryptedPayload: encrypted.toString('base64') }
   Response: {
     device: { deviceId, deviceName, uuid },
     mqtt: {
       brokerUrl: "mqtts://mosquitto:8883",
       username: "device_<uuid>",
       password: "<generated_password>",
       brokerConfig: {
         protocol: "mqtts",
         host: "mosquitto",
         port: 8883,
         useTls: true,
         caCert: "-----BEGIN CERTIFICATE-----\n...",
         verifyCertificate: true
       }
     },
     api: {
       endpoint: "https://api.iotistic.ca",
       deviceApiKey: "<generated_key>",
       tlsConfig: { caCert: "...", verifyCertificate: true }
     }
   }
   ```
7. **Store Device Info**: Save to SQLite `device` table
8. **Initialize Services**: Start MQTT, CloudSync, etc.

**Key Files**:
- `agent/src/provisioning/device-manager.ts` - Provisioning orchestration
- `agent/src/agent.ts` - Main provisioning flow (`ensureProvisioned()`)
- `agent/cli/commands/provision.ts` - CLI provisioning command

### Re-Provisioning

```bash
# Delete device database (forces re-provisioning)
docker exec agent-1 rm /app/data/device.sqlite
docker restart agent-1

# Or via CLI
docker exec agent-1 iotctl factory-reset
```

### Deprovision (Keep UUID)

```bash
# Remove cloud registration but keep UUID/API key
docker exec agent-1 iotctl deprovision
```

---

## State Reconciliation Pattern

### StateReconciler Architecture

**The "Why"**: Central orchestrator for both containers and device configuration

**Pattern**:
```typescript
// agent/src/drivers/state-reconciler.ts
export class StateReconciler extends EventEmitter {
  private targetState: DeviceState = { apps: {}, config: {} };
  private containerManager: ContainerManager;
  private configManager: ConfigManager;
  
  // Set target state (from cloud or local)
  async setTarget(state: DeviceState): Promise<void> {
    this.targetState = state;
    await this.saveTargetStateToDB(); // Persist to SQLite
    await this.reconcile();            // Apply changes
  }
  
  // Reconcile current state with target
  async reconcile(): Promise<void> {
    // 1. Delegate apps to ContainerManager
    await this.containerManager.setTargetState({ apps: this.targetState.apps });
    await this.containerManager.reconcile();
    
    // 2. Delegate config to ConfigManager
    await this.configManager.setTargetConfig(this.targetState.config);
    await this.configManager.apply();
  }
}
```

**Key Behaviors**:
- **SQLite Persistence**: Target state saved to `target_state` table (survives restarts)
- **Event-Driven**: Emits `target-state-changed`, `state-applied`, `reconciliation-complete`
- **Atomic Operations**: Each reconciliation is a complete sync operation
- **Crash Recovery**: On restart, loads target state from DB and reconciles

**Reconciliation Loop**:
```typescript
// In agent.ts
async startReconciliationLoop(): Promise<void> {
  setInterval(async () => {
    try {
      await this.stateReconciler.reconcile();
    } catch (err) {
      this.agentLogger.errorSync('Reconciliation failed', {
        component: LogComponents.agent,
        error: err.message
      });
    }
  }, this.reconciliationIntervalMs); // Default: 30000ms
}
```

### Container State Management

**State Field**: Services have optional `state` field for declarative control

**Values**:
- `"running"` (default) - Container should be running
- `"stopped"` - Container gracefully stopped (SIGTERM), config preserved
- `"paused"` - Container processes frozen (SIGSTOP), instant suspend/resume

**Example Target State**:
```json
{
  "apps": {
    "1001": {
      "appId": 1001,
      "appName": "web-server",
      "services": [
        {
          "serviceId": "1",
          "serviceName": "nginx",
          "imageName": "nginx:latest",
          "state": "paused",  // Optional: defaults to "running"
          "config": {
            "image": "nginx:latest",
            "ports": ["80:80"],
            "volumes": ["nginx-data:/usr/share/nginx/html"]
          }
        }
      ]
    }
  }
}
```

**State Transitions**:
| From | To | Docker Command | Container ID | Speed | RAM |
|------|-----|----------------|--------------|-------|-----|
| running | paused | `docker pause` | Preserved ✅ | Instant | Preserved |
| paused | running | `docker unpause` | Preserved ✅ | Instant | Preserved |
| running | stopped | `docker stop` | Exited (must recreate) | ~10s | Freed |
| stopped | running | Remove + recreate | Changes ❌ | ~30s | Allocated |

**Critical Docker Limitation**: Stopped (exited) containers cannot be restarted - they must be removed and recreated. Use `paused` to preserve container IDs.

**Implementation**:
- `agent/src/compose/container-manager.ts` - Reconciliation logic (lines 1138-1270)
- `agent/src/compose/docker-manager.ts` - Docker pause/unpause methods (lines 364-406)

---

## Cloud Synchronization (CloudSync)

### Pull-Based Pattern

**The "Why"**: Devices poll cloud for target state changes, avoiding complex push infrastructure

**Architecture**:
```
Device (Agent)              Cloud API
┌────────────┐             ┌──────────┐
│  Poll for  ├────────────>│ Target   │
│  changes   │  (ETag)     │ State    │
│            │             │          │
│            │<────────────┤ 304 or   │
│  (every    │  (state)    │ 200+data │
│   60s)     │             │          │
│            │             │          │
│  Report    ├────────────>│ Current  │
│  state +   │  (PATCH)    │ State +  │
│  metrics   │  (every 10s)│ Metrics  │
└────────────┘             └──────────┘
```

**Key Features**:
- **ETag Caching**: Server returns `ETag` hash, device sends `If-None-Match` to avoid redundant downloads
- **Diff-Based Reporting**: Only send metrics that changed since last report
- **Graceful Degradation**: Device continues operating if cloud unreachable
- **Exponential Backoff**: 1s → 2s → 4s → 8s → max 60s on repeated failures
- **Connection States**: `online`, `degraded` (2+ failures), `offline` (3+ failures)

**Environment Variables**:
```bash
CLOUD_API_ENDPOINT=https://api.iotistic.ca   # Cloud API URL
POLL_INTERVAL_MS=60000                       # How often to poll for target state
REPORT_INTERVAL_MS=10000                     # How often to report current state
METRICS_INTERVAL_MS=300000                   # Detailed metrics every 5min
```

**Polling Loop** (`agent/src/sync/index.ts`):
```typescript
export class CloudSync extends EventEmitter {
  async startPolling(): Promise<void> {
    setInterval(async () => {
      try {
        const response = await this.httpClient.get(
          `/api/v1/device/${deviceUuid}/state`,
          {
            headers: { 'If-None-Match': this.lastETag }
          }
        );
        
        if (response.status === 304) {
          // No changes, skip
          return;
        }
        
        const targetState = response.data;
        this.lastETag = response.headers['etag'];
        
        // Apply new target state
        await this.stateReconciler.setTarget(targetState);
        
      } catch (err) {
        this.handlePollError(err);
      }
    }, this.pollInterval);
  }
}
```

**Reporting Loop**:
```typescript
async reportCurrentState(): Promise<void> {
  const currentState = await this.stateReconciler.getCurrentState();
  const metrics = await getSystemMetrics();
  
  const report = {
    [deviceUuid]: {
      apps: currentState.apps,
      config: currentState.config,
      cpu_usage: metrics.cpu_usage,
      memory_usage: metrics.memory_usage,
      temperature: metrics.temperature,
      uptime: metrics.uptime,
      // ... other metrics
    }
  };
  
  await this.httpClient.patch('/api/v1/device/state', report);
}
```

**MQTT Update Trigger**: Cloud can publish to `agent/{uuid}/update` to trigger immediate poll

---

## Logging Architecture

### AgentLogger (Structured Logging)

**Rule**: Always use `AgentLogger` (NOT `console.log`) in agent code

**Pattern**:
```typescript
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

class MyService {
  constructor(private logger?: AgentLogger) {}
  
  async doWork() {
    this.logger?.infoSync('Starting work', {
      component: LogComponents.myService,
      operation: 'doWork',
      context: { itemCount: 5 }
    });
    
    this.logger?.errorSync('Work failed', {
      component: LogComponents.myService,
      error: err.message,
      stack: err.stack
    });
  }
}
```

**Log Levels**:
- `debugSync()` - Verbose debugging (disabled by default, set `LOG_LEVEL=debug`)
- `infoSync()` - Informational messages
- `warnSync()` - Warnings (non-fatal issues)
- `errorSync()` - Errors (failures that need attention)

**Log Components** (`LogComponents` enum):
```typescript
export enum LogComponents {
  agent = 'agent',
  containerManager = 'containerManager',
  stateReconciler = 'stateReconciler',
  cloudSync = 'cloudSync',
  mqtt = 'mqtt',
  vpn = 'vpn',
  provisioning = 'provisioning',
  anomalyDetection = 'anomalyDetection',
  database = 'database',
  // ... 20+ components
}
```

### Cloud Log Backend

**Upload Pattern**: Logs buffered and uploaded to cloud API in NDJSON format

**Configuration**:
```typescript
// Environment variables
LOG_COMPRESSION=true              // Gzip compress uploads
CLOUD_LOG_UPLOAD_INTERVAL=60000  // Upload every 60s
CLOUD_LOG_SAMPLING_RATE_DEBUG=0.1 // 10% of debug logs
CLOUD_LOG_SAMPLING_RATE_INFO=0.5  // 50% of info logs
CLOUD_LOG_SAMPLING_RATE_WARN=1.0  // 100% of warnings
CLOUD_LOG_SAMPLING_RATE_ERROR=1.0 // 100% of errors
```

**Implementation** (`agent/src/logging/cloud-backend.ts`):
```typescript
export class CloudLogBackend implements LogBackend {
  async flush(): Promise<void> {
    const logs = this.buffer.splice(0); // Drain buffer
    const ndjson = logs.map(log => JSON.stringify(log)).join('\n');
    
    const body = this.compress
      ? await gzipAsync(Buffer.from(ndjson))
      : ndjson;
    
    await this.httpClient.post('/api/v1/device/${deviceUuid}/logs', body, {
      headers: {
        'Content-Type': this.compress ? 'application/x-ndjson+gzip' : 'application/x-ndjson'
      }
    });
  }
}
```

---

## Anomaly Detection

### Detection Engine

**Monitored Metrics**:
- CPU usage (`cpu_usage_percent`)
- CPU temperature (`cpu_temp`)
- Memory usage (`memory_percent`)
- Storage usage (`storage_percent`)
- Network latency (`network_latency_ms`)

**Detection Methods** (`agent/src/ai/anomaly/algorithms/`):
1. **Z-Score** - Statistical deviation from mean (µ ± 3σ)
2. **MAD** (Median Absolute Deviation) - Robust outlier detection
3. **IQR** (Interquartile Range) - Quartile-based outliers (Q1-1.5×IQR, Q3+1.5×IQR)
4. **Rate of Change** - Sudden spikes/drops exceeding threshold
5. **LSTM** - Machine learning predictions (if model available)

**Configuration**:
```bash
ANOMALY_DETECTION_ENABLED=true
ANOMALY_DETECTION_WINDOW_SIZE=100     # Samples for baseline
ANOMALY_DETECTION_Z_THRESHOLD=3.0     # Z-score threshold
ANOMALY_DETECTION_MAD_THRESHOLD=3.0   # MAD threshold
ANOMALY_DETECTION_RATE_THRESHOLD=50   # Rate change % threshold
```

**Output Format**:
```typescript
interface AnomalyDetection {
  metric: string;          // 'cpu_temp'
  value: number;           // 85.3
  expected?: number;       // 55.2 (if available)
  deviation: number;       // 30.1
  method: string;          // 'z_score'
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;      // 0.0-1.0
  timestamp: number;       // Unix timestamp
  metadata?: any;          // Method-specific context
}
```

**Storage**: Saved to `anomaly_detections` table in SQLite

**Cloud Reporting**: Summary sent to cloud every 60s via CloudSync

---

## Simulation Mode

### Testing Framework

**Purpose**: Test agent behavior without physical hardware

**Configuration**:
```bash
SIMULATION_MODE=true
SIMULATION_CONFIG='{
  "scenarios": {
    "sensor_data": {
      "enabled": true,
      "pattern": "realistic",
      "publishIntervalMs": 10000
    },
    "anomaly_injection": {
      "enabled": true,
      "metrics": ["cpu_temp", "memory_percent"],
      "pattern": "spike",
      "intervalMs": 30000,
      "magnitude": 3
    },
    "memory_leak": {
      "enabled": false,
      "leakRateMb": 5,
      "intervalMs": 10000
    }
  }
}'
```

**Scenarios** (`agent/src/simulation/scenarios/`):

1. **Sensor Data** (`sensor-data.ts`):
   - Generates realistic BME688-style data (temperature, humidity, pressure, gas)
   - Patterns: `realistic`, `sine`, `random`
   - Publishes to MQTT topics

2. **Anomaly Injection** (`anomaly.ts`):
   - Injects anomalies into system metrics
   - Patterns: `spike`, `drop`, `drift`, `random`
   - Magnitude: 1-5 (multiplier of std deviation)

3. **Memory Leak** (`memory-leak.ts`):
   - Simulates gradual memory growth
   - Configurable leak rate (MB/interval)
   - Tests monitoring and alerting

**Use Cases**:
- CI/CD integration testing
- UI/dashboard development
- Anomaly detection algorithm testing
- Stress testing cloud sync

---

## Common Operations

### Database Access

**Interactive SQLite**:
```powershell
# Connect to agent database
docker exec -it agent-1 sqlite3 /app/data/device.sqlite

# Common queries
SELECT * FROM device;                  -- Device info
SELECT * FROM target_state;            -- Current target state
SELECT * FROM anomaly_detections ORDER BY timestamp DESC LIMIT 10;
SELECT * FROM device_sensors;          -- Sensor configs
```

**Programmatic Access**:
```typescript
import { models } from './db/connection';

// Get device info
const device = await models('device').first();

// Get target state
const targetState = await models('target_state').first();

// Get recent anomalies
const anomalies = await models('anomaly_detections')
  .where('timestamp', '>', Date.now() - 3600000)
  .orderBy('timestamp', 'desc');
```

### CLI Tool (iotctl)

**Critical Commands**:
```bash
# Device status and diagnostics
docker exec agent-1 iotctl status
docker exec agent-1 iotctl diagnostics

# Provisioning
docker exec agent-1 iotctl provision <key> --api https://api.iotistic.ca
docker exec agent-1 iotctl provision status

# Configuration
docker exec agent-1 iotctl config show
docker exec agent-1 iotctl config set-api https://new-api.iotistic.ca

# Apps (stacks)
docker exec agent-1 iotctl apps list
docker exec agent-1 iotctl apps start 1001
docker exec agent-1 iotctl apps stop 1001

# Services (individual containers)
docker exec agent-1 iotctl services list
docker exec agent-1 iotctl services restart nginx-1
docker exec agent-1 iotctl services logs web-1 -f

# Factory reset (WARNING: deletes everything)
docker exec agent-1 iotctl factory-reset
```

### Development Workflows

**Local Development**:
```powershell
# Start agent in dev mode (auto-reload)
cd agent; npm run dev

# Run with specific environment
$env:CLOUD_API_ENDPOINT='https://localhost:3443'
$env:REQUIRE_PROVISIONING='false'
$env:LOG_LEVEL='debug'
npm run dev
```

**Testing**:
```bash
# Unit tests (fast, no Docker required)
npm run test:unit

# Integration tests (requires Docker)
npm run test:integration

# Watch mode (TDD)
npm run test:watch:unit

# Coverage
npm run test:coverage
```

**Building**:
```bash
# TypeScript compilation + copy migrations
npm run build

# Build Docker image
docker build -t iotistic/agent:latest .
```

---

## Environment Variables Reference

**Provisioning**:
- `REQUIRE_PROVISIONING=true` - Enforce provisioning before starting
- `PROVISIONING_API_KEY=<key>` - Pre-shared key from dashboard
- `CLOUD_API_ENDPOINT=https://api.iotistic.ca` - Cloud API URL
- `DEVICE_NAME=<name>` - Optional device name
- `DEVICE_TYPE=edge-gateway` - Device type

**Database**:
- `DATABASE_PATH=/app/data/device.sqlite` - SQLite database path

**Cloud Sync**:
- `POLL_INTERVAL_MS=60000` - How often to poll for target state
- `REPORT_INTERVAL_MS=10000` - How often to report current state
- `METRICS_INTERVAL_MS=300000` - Detailed metrics interval

**MQTT**:
- `MQTT_BROKER_URL=mqtts://mosquitto:8883` - MQTT broker (set by provisioning)
- `MQTT_USERNAME=device_<uuid>` - MQTT username (set by provisioning)
- `MQTT_PASSWORD=<password>` - MQTT password (set by provisioning)

**Logging**:
- `LOG_LEVEL=info` - Log level (debug, info, warn, error)
- `LOG_COMPRESSION=true` - Gzip compress cloud log uploads
- `CLOUD_LOG_UPLOAD_INTERVAL=60000` - Log upload interval

**Anomaly Detection**:
- `ANOMALY_DETECTION_ENABLED=true` - Enable anomaly detection
- `ANOMALY_DETECTION_WINDOW_SIZE=100` - Baseline window size
- `ANOMALY_DETECTION_Z_THRESHOLD=3.0` - Z-score threshold

**Simulation**:
- `SIMULATION_MODE=true` - Enable simulation framework
- `SIMULATION_CONFIG='<json>'` - Simulation scenario config

**Device API**:
- `DEVICE_API_PORT=48484` - REST API port

**Reconciliation**:
- `RECONCILIATION_INTERVAL_MS=30000` - Container reconciliation interval

---

## Troubleshooting

### Provisioning Fails

**Error: "Failed to provision device"**

```powershell
# Check provisioning key is valid
docker exec agent-1 iotctl provision status

# Check cloud API is reachable
docker exec agent-1 curl -I https://api.iotistic.ca/health

# Check logs
docker logs agent-1 | Select-String provision

# Retry provisioning
docker exec agent-1 iotctl deprovision
docker exec agent-1 iotctl provision <new-key>
```

### Database Corrupted

**Error: "database disk image is malformed"**

```powershell
# Backup existing database
docker cp agent-1:/app/data/device.sqlite ./backup.sqlite

# Delete corrupted database (forces re-provisioning)
docker exec agent-1 rm /app/data/device.sqlite
docker restart agent-1

# Or restore from backup
docker cp ./backup.sqlite agent-1:/app/data/device.sqlite
docker restart agent-1
```

### Container Reconciliation Issues

**Error: "Container not starting"**

```powershell
# Check target state
docker exec agent-1 sqlite3 /app/data/device.sqlite "SELECT * FROM target_state;"

# Check Docker daemon
docker exec agent-1 docker ps

# Check agent logs
docker logs agent-1 | Select-String -Pattern "containerManager|reconcil"

# Force reconciliation
docker exec agent-1 iotctl apps restart 1001
```

### Cloud Sync Offline

**Error: "Connection offline"**

```powershell
# Check cloud API endpoint
docker exec agent-1 iotctl config get-api

# Test connectivity
docker exec agent-1 curl https://api.iotistic.ca/health

# Check CloudSync status
docker logs agent-1 | Select-String -Pattern "cloudSync|online|offline"

# Update API endpoint if needed
docker exec agent-1 iotctl config set-api https://new-api.iotistic.ca
```

---

## Key Files Reference

**Core**:
- `agent/src/agent.ts` - Main DeviceAgent class (1565 lines)
- `agent/src/app.ts` - Application entry point
- `agent/package.json` - Dependencies and scripts

**State Management**:
- `agent/src/drivers/state-reconciler.ts` - StateReconciler orchestrator
- `agent/src/compose/container-manager.ts` - Docker/K3s operations
- `agent/src/drivers/config-manager.ts` - Device configuration

**Database**:
- `agent/src/db/connection.ts` - SQLite connection and migrations
- `agent/src/db/models/*.ts` - Data models (Device, Sensor, etc.)
- `agent/src/db/migrations/*.js` - Knex migrations

**Provisioning**:
- `agent/src/provisioning/device-manager.ts` - Provisioning logic
- `agent/src/provisioning/types.ts` - Type definitions
- `agent/cli/commands/provision.ts` - CLI provisioning

**Cloud**:
- `agent/src/sync/index.ts` - CloudSync service
- `agent/src/network/connection-monitor.ts` - Connection tracking

**Logging**:
- `agent/src/logging/agent-logger.ts` - Structured logger
- `agent/src/logging/cloud-backend.ts` - Cloud log uploads
- `agent/src/logging/types.ts` - Log types and components

**Monitoring**:
- `agent/src/ai/anomaly/index.ts` - Anomaly detection service
- `agent/src/system/metrics.ts` - System metrics collection
- `agent/src/simulation/index.ts` - Simulation framework

**CLI**:
- `agent/cli/iotctl.ts` - CLI entry point
- `agent/cli/commands/*.ts` - CLI command implementations