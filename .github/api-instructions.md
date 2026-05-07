# API - AI Coding Agent Instructions

Critical patterns and workflows for the Iotistic Unified API service.

## Architecture Overview

The **API** is a TypeScript/Express REST API that serves as the central control plane for the Iotistic IoT platform. It manages:

- **Device Management**: Registration, provisioning, state management, metrics
- **Multi-Tenant Isolation**: Per-customer namespaces in Kubernetes deployments
- **License Validation**: JWT-based feature gating and usage limits
- **Digital Twin**: Neo4j graph database for spatial relationships and IFC models
- **MQTT Integration**: Mosquitto broker authentication and monitoring
- **VPN Management**: OpenVPN/WireGuard client provisioning
- **Job Scheduling**: Async task execution on edge devices
- **Image Registry**: Container image management and vulnerability scanning
- **Alerts & Webhooks**: Real-time alerting and external integrations

### Deployment Models

**1. Multi-Tenant SaaS (Kubernetes)**:
- Deployed per-customer in isolated namespaces (`customer-{id}`)
- Connects to dedicated PostgreSQL instance
- Receives license JWT from global billing API
- Environment: `IOTISTIC_LICENSE_KEY` set at deployment

**2. Edge Device Stack (Docker Compose)**:
- Single-tenant API alongside edge services
- Shared PostgreSQL container (`iotistic-postgres`)
- No license validation (self-hosted mode)

### Key Components

**Core Services** (`api/src/services/`):
```typescript
// License & Billing
LicenseValidator        // JWT validation, feature gating
BillingClient          // Usage reporting to global billing API

// Device Management
DeviceStateHandler     // Current vs target state reconciliation
HeartbeatMonitor       // Device online/offline tracking
DefaultTargetStateGenerator // Auto-generate target state for new devices

// Digital Twin
Neo4jService          // Graph database operations
IFCParserService      // Building information model parsing
EntityService         // Entity CRUD operations
RelationshipService   // Graph relationship management

// MQTT
MqttManager           // MQTT client and pub/sub
MQTTDatabaseService   // MQTT metrics persistence
MQTTMonitorService    // Real-time broker monitoring
MqttBootstrap         // Auto-create MQTT users/ACLs

// Jobs & Scheduling
JobScheduler          // Cron-based job scheduling
DeviceJobsNotifier    // MQTT notifications for job execution
StateTracker          // Job state tracking

// Security
AuthService           // User authentication (bcrypt)
ApiKeyRotation        // Automatic device API key rotation
AuditLogger           // Security event logging

// Image Management
DockerRegistry        // Private registry integration
TrivyScanner          // Vulnerability scanning
ImageMonitor          // Image update tracking

// VPN
WireGuardService      // WireGuard VPN management
VpnConfig             // OpenVPN configuration
```

**Route Modules** (`api/src/routes/`):
- `auth.ts` - User login/logout
- `users.ts` - User management (RBAC)
- `devices.ts` - Device CRUD operations
- `device-state.ts` - Target/current state management
- `device-logs.ts` - Log aggregation from agents
- `device-metrics.ts` - Time-series metrics storage
- `provisioning.ts` - Two-phase device authentication
- `apps.ts` - Application deployment management
- `digital-twin.ts` - IFC upload, entity management
- `digital-twin-graph.ts` - Graph visualization
- `mqtt-monitor.ts` - Real-time MQTT metrics
- `mqtt-broker.ts` - Broker configuration management
- `device-jobs.ts` - Job execution API
- `scheduled-jobs.ts` - Cron job management
- `alerts.ts` - Alert rule configuration
- `webhooks.ts` - Webhook integrations
- `image-registry.ts` - Container image management
- `license.ts` - License validation endpoint
- `billing.ts` - Usage reporting

---

## PostgreSQL Database

### Database Connection

**Multi-Tenant (Kubernetes)**:
```typescript
// Dedicated instance per customer
const connectionString = process.env.DATABASE_URL || 
  'postgresql://postgres:password@postgres:5432/iotistic';
```

**Local Development**:
```typescript
// Shared container
const connectionString = 'postgresql://localhost:5432/iotistic';
```

**Connection Pooling** (`api/src/db/connection.ts`):
```typescript
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Max connections
  idleTimeoutMillis: 30000,   // Close idle connections
  connectionTimeoutMillis: 2000,
});
```

### Core Tables (58+ Migrations)

**Devices** (`000_initial_schema.sql`):
```sql
CREATE TABLE devices (
  id SERIAL PRIMARY KEY,
  uuid UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  device_name VARCHAR(255),
  device_type VARCHAR(100),
  is_online BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  last_connectivity_event TIMESTAMP,
  ip_address INET,
  mac_address VARCHAR(17),
  os_version VARCHAR(100),
  agent_version VARCHAR(100),          -- Previously supervisor_version
  api_heartbeat_state VARCHAR(50) DEFAULT 'online',
  memory_usage BIGINT,
  memory_total BIGINT,
  cpu_usage DECIMAL(5,2),
  cpu_temp DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Device State** (Target vs Current):
```sql
-- What device SHOULD be running
CREATE TABLE device_target_state (
  id SERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  apps JSONB NOT NULL DEFAULT '{}',
  config JSONB DEFAULT '{}',
  version INTEGER DEFAULT 1,
  state_hash VARCHAR(64),              -- SHA256 for change detection
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_uuid)
);

-- What device IS currently running
CREATE TABLE device_current_state (
  id SERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  apps JSONB NOT NULL DEFAULT '{}',
  config JSONB DEFAULT '{}',
  system_info JSONB DEFAULT '{}',
  reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_uuid)
);
```

**Device Metrics** (Partitioned by month):
```sql
CREATE TABLE device_metrics (
  id BIGSERIAL NOT NULL,
  device_uuid UUID NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cpu_usage DECIMAL(5,2),
  cpu_temp DECIMAL(5,2),
  memory_usage BIGINT,
  memory_total BIGINT,
  storage_usage BIGINT,
  storage_total BIGINT,
  network_rx BIGINT,
  network_tx BIGINT,
  uptime BIGINT,
  top_processes JSONB,
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Partitions created monthly
CREATE TABLE device_metrics_2025_01 PARTITION OF device_metrics
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

**MQTT ACLs** (`017_add_user_auth_and_mqtt_acl.sql`):
```sql
CREATE TABLE mqtt_acls (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  topic VARCHAR(255) NOT NULL,
  rw INTEGER NOT NULL,                 -- 1=read, 2=write, 3=both
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(username, topic, rw)
);

CREATE INDEX idx_mqtt_acls_username ON mqtt_acls(username);
CREATE INDEX idx_mqtt_acls_topic ON mqtt_acls(topic);
```

**System Configuration** (`002_add_system_config.sql`):
```sql
CREATE TABLE system_config (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Critical config keys:
-- 'mqtt.brokers.1' - Primary MQTT broker config (host, port, TLS cert)
-- 'vpn.config' - VPN server configuration (OpenVPN/WireGuard)
-- 'license_data' - Cached license information
-- 'default_target_state_template' - Auto-apply apps to new devices
```

**Provisioning Keys** (`001_add_security_tables.sql`):
```sql
CREATE TABLE provisioning_keys (
  id SERIAL PRIMARY KEY,
  key_hash VARCHAR(255) NOT NULL UNIQUE,  -- bcrypt hash
  fleet_id VARCHAR(255),
  description TEXT,
  max_uses INTEGER,
  current_uses INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_by VARCHAR(255),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Device Jobs** (`011_add_device_jobs.sql`):
```sql
CREATE TABLE device_jobs (
  id SERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  job_type VARCHAR(50) NOT NULL,       -- 'restart', 'update', 'run_command', etc.
  status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  payload JSONB,
  result JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);
```

**Audit Logs** (`018_add_audit_logs.sql`):
```sql
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,    -- 'DEVICE_PROVISIONED', 'STATE_CHANGED', etc.
  severity VARCHAR(20) NOT NULL,       -- 'INFO', 'WARNING', 'CRITICAL'
  ip_address INET,
  user_agent TEXT,
  device_uuid UUID,
  user_id INTEGER,
  details JSONB,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Migrations

**Auto-Run**: Migrations run automatically on API startup (optional, controlled by env var)

**Location**: `api/database/migrations/*.sql`

**Naming**: `NNN_description.sql` (e.g., `000_initial_schema.sql`)

**Tracking** (`api/database/migrations/003_add_id_sequences.sql`):
```sql
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Manual Execution**:
```powershell
# Run pending migrations
cd api; npm run migrate

# Check status
npm run migrate:status

# Create new migration
npm run migrate:create add_new_feature

# Mark migration as applied (skip execution)
npm run migrate:mark-applied 042_migration_name
```

**Critical Pattern**: SQL migrations (NOT Knex JavaScript like agent)

---

## License Validation & Feature Gating

### License Flow (Multi-Tenant SaaS)

**Architecture**:
```
Global Billing API                    Customer API Instance
┌────────────────┐                   ┌─────────────────────┐
│ Private Key    │                   │ Public Key          │
│ (RS256 signing)│                   │ (verification only) │
└────────┬───────┘                   └─────────┬───────────┘
         │                                     │
         │ 1. Sign JWT                         │
         ├─────────────────────────────────────>│
         │    IOTISTIC_LICENSE_KEY             │
         │                                     │
         │                                     │ 2. Verify JWT
         │                                     │    Check features
         │                                     │    Enforce limits
```

**License JWT Payload**:
```typescript
interface LicenseData {
  customerId: string;
  customerName: string;
  plan: 'trial' | 'starter' | 'professional' | 'enterprise';
  
  features: {
    maxDevices: number;               // 3 (trial), 10 (starter), 50 (pro), unlimited (enterprise)
    canExecuteJobs: boolean;          // Run commands on devices
    canScheduleJobs: boolean;         // Cron jobs
    canRemoteAccess: boolean;         // SSH/console access
    canOtaUpdates: boolean;           // Over-the-air updates
    canExportData: boolean;           // Data export
    hasAdvancedAlerts: boolean;       // Complex alert rules
    hasCustomDashboards: boolean;     // Custom Grafana dashboards
  };
  
  limits: {
    maxJobTemplates?: number;
    maxAlertRules?: number;
    maxUsers?: number;
  };
  
  trial: {
    isTrialMode: boolean;
    expiresAt?: string;               // ISO date
  };
  
  subscription: {
    status: 'active' | 'past_due' | 'canceled' | 'trialing';
    currentPeriodEndsAt: string;
  };
  
  issuedAt: number;
  expiresAt: number;
}
```

### Feature Gating Pattern

**Middleware** (`api/src/services/license-validator.ts`):
```typescript
export class LicenseValidator {
  // Validate license on startup
  async init(): Promise<void> {
    const licenseKey = process.env.IOTISTIC_LICENSE_KEY;
    
    if (!licenseKey) {
      console.warn('No license key. Running in unlicensed mode.');
      this.licenseData = this.getDefaultUnlicensedMode();
      return;
    }
    
    // Verify JWT signature with public key
    this.licenseData = await this.validateLicense(licenseKey);
    
    // Cache in database for offline mode
    await SystemConfigModel.set('license_data', this.licenseData);
  }
  
  // Check if feature is available
  checkFeatureAccess(feature: keyof LicenseData['features']): boolean {
    if (!this.licenseData) return false;
    return this.licenseData.features[feature] === true;
  }
  
  // Check device count limit
  async checkDeviceLimit(currentCount: number): Promise<boolean> {
    if (!this.licenseData) return currentCount <= 3; // Unlicensed limit
    
    const maxDevices = this.licenseData.features.maxDevices;
    if (maxDevices === -1) return true; // Unlimited (enterprise)
    
    return currentCount < maxDevices;
  }
}
```

**Route Protection**:
```typescript
// In routes/device-jobs.ts
router.post('/jobs', async (req, res) => {
  const validator = LicenseValidator.getInstance();
  
  if (!validator.checkFeatureAccess('canExecuteJobs')) {
    return res.status(402).json({
      error: 'Feature not available',
      message: 'Job execution requires Professional plan or higher',
      upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistic.ca/upgrade'
    });
  }
  
  // Execute job...
});
```

**Device Limit Enforcement**:
```typescript
// In routes/provisioning.ts
router.post('/agent/register', async (req, res) => {
  const deviceCount = await query('SELECT COUNT(*) FROM devices WHERE is_active = true');
  const canProvision = await validator.checkDeviceLimit(deviceCount.rows[0].count);
  
  if (!canProvision) {
    return res.status(402).json({
      error: 'Device limit reached',
      message: `Your plan allows ${validator.getLicenseData()?.features.maxDevices} devices`,
      current: deviceCount.rows[0].count
    });
  }
  
  // Register device...
});
```

### Unlicensed Mode (Fallback)

**Default Limits** (when no license key provided):
```typescript
private getDefaultUnlicensedMode(): LicenseData {
  return {
    customerId: 'unlicensed',
    customerName: 'Unlicensed Instance',
    plan: 'trial',
    features: {
      maxDevices: 3,                   // Limit to 3 devices
      canExecuteJobs: true,            // Basic features enabled
      canScheduleJobs: false,          // Advanced features disabled
      canRemoteAccess: false,
      canOtaUpdates: true,
      canExportData: false,
      hasAdvancedAlerts: false,
      hasCustomDashboards: false,
    },
    limits: {},
    trial: {
      isTrialMode: true,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() // 14 days
    },
    subscription: {
      status: 'trialing',
      currentPeriodEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    },
    issuedAt: Date.now(),
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000
  };
}
```

---

## Device Provisioning (Two-Phase Authentication)

### Phase 1: Key Exchange

**Purpose**: Establish secure communication before sending sensitive data

**Flow**:
```typescript
// Agent requests API's public key
POST /api/v1/provisioning/v2/key-exchange
Body: {
  deviceUuid: "abc-123-def",
  provisioningApiKey: "3564a669790c..."
}

Response: {
  apiPublicKey: "-----BEGIN PUBLIC KEY-----\n...",
  keyId: "key_123"
}

// Agent generates RSA keypair, sends device public key
POST /api/v1/provisioning/v2/key-exchange
Body: {
  deviceUuid: "abc-123-def",
  provisioningApiKey: "3564a669790c...",
  devicePublicKey: "-----BEGIN PUBLIC KEY-----\n..."
}

Response: {
  success: true
}
```

**Implementation** (`api/src/routes/provisioning.ts`):
```typescript
router.post('/provisioning/v2/key-exchange', provisioningLimiter, async (req, res) => {
  const { deviceUuid, provisioningApiKey, devicePublicKey } = req.body;
  
  // Validate provisioning key (bcrypt hash check)
  const validation = await validateProvisioningKey(provisioningApiKey);
  if (!validation.valid) {
    await logProvisioningAttempt(req.ip, deviceUuid, false, 'Invalid provisioning key');
    return res.status(401).json({ error: 'Invalid provisioning key' });
  }
  
  // First call: return API's public key
  if (!devicePublicKey) {
    const apiPublicKey = await SystemConfigModel.get('api_rsa_public_key');
    return res.json({
      apiPublicKey,
      keyId: 'primary'
    });
  }
  
  // Second call: store device's public key
  await query(
    'INSERT INTO device_public_keys (device_uuid, public_key) VALUES ($1, $2) ON CONFLICT (device_uuid) DO UPDATE SET public_key = $2',
    [deviceUuid, devicePublicKey]
  );
  
  res.json({ success: true });
});
```

### Phase 2: Encrypted Registration

**Purpose**: Securely transmit sensitive device info (MAC address, credentials)

**Flow**:
```typescript
// Agent encrypts registration data with API's public key
const encryptedPayload = crypto.publicEncrypt(apiPublicKey, Buffer.from(JSON.stringify({
  deviceUuid: "abc-123-def",
  provisioningApiKey: "3564a669790c...",
  deviceName: "Factory Floor Gateway",
  deviceType: "edge-gateway",
  macAddress: "B8:27:EB:12:34:56",
  osVersion: "Raspberry Pi OS 11",
  agentVersion: "1.0.51"
})));

POST /api/v1/provisioning/v2/register
Body: {
  encryptedPayload: "<base64-encoded-encrypted-data>"
}

Response: {
  device: {
    deviceId: "dev_123",
    uuid: "abc-123-def",
    deviceName: "Factory Floor Gateway"
  },
  mqtt: {
    brokerUrl: "mqtts://mosquitto:8883",
    username: "device_abc-123-def",
    password: "<generated-password>",
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
    deviceApiKey: "<generated-api-key>",
    tlsConfig: {
      caCert: "-----BEGIN CERTIFICATE-----\n...",
      verifyCertificate: true
    }
  },
  vpn: {
    enabled: true,
    protocol: "wireguard",
    config: {
      serverPublicKey: "...",
      clientPrivateKey: "...",
      clientAddress: "10.8.0.5/24",
      endpoint: "vpn.iotistic.ca:51820"
    }
  }
}
```

**Implementation**:
```typescript
router.post('/provisioning/v2/register', provisioningLimiter, async (req, res) => {
  const { encryptedPayload } = req.body;
  
  // Decrypt with API's private key
  const apiPrivateKey = await SystemConfigModel.get('api_rsa_private_key');
  const decrypted = crypto.privateDecrypt(
    apiPrivateKey,
    Buffer.from(encryptedPayload, 'base64')
  );
  const data = JSON.parse(decrypted.toString());
  
  // Validate provisioning key
  const validation = await validateProvisioningKey(data.provisioningApiKey);
  if (!validation.valid) {
    return res.status(401).json({ error: 'Invalid provisioning key' });
  }
  
  // Check device limit
  const deviceCount = await query('SELECT COUNT(*) FROM devices WHERE is_active = true');
  const canProvision = await LicenseValidator.getInstance().checkDeviceLimit(deviceCount.rows[0].count);
  if (!canProvision) {
    return res.status(402).json({ error: 'Device limit reached' });
  }
  
  // Create device
  const device = await DeviceModel.create({
    uuid: data.deviceUuid,
    device_name: data.deviceName,
    device_type: data.deviceType,
    mac_address: data.macAddress,
    os_version: data.osVersion,
    agent_version: data.agentVersion
  });
  
  // Generate MQTT credentials
  const mqttPassword = crypto.randomBytes(32).toString('hex');
  const mqttUsername = `device_${device.uuid}`;
  
  await query(
    'INSERT INTO mqtt_users (username, password_hash, is_active) VALUES ($1, $2, true)',
    [mqttUsername, await bcrypt.hash(mqttPassword, 10)]
  );
  
  // Create default MQTT ACLs
  const topics = [
    { topic: `agent/${device.uuid}/#`, rw: 3 },       // Read/Write to own agent topics
    { topic: `sensor/${device.uuid}/#`, rw: 2 },      // Write to sensor topics
    { topic: `state/${device.uuid}/#`, rw: 3 },       // Read/Write state
  ];
  
  for (const { topic, rw } of topics) {
    await query(
      'INSERT INTO mqtt_acls (username, topic, rw) VALUES ($1, $2, $3)',
      [mqttUsername, topic, rw]
    );
  }
  
  // Get MQTT broker config with TLS cert
  const brokerConfig = await getBrokerConfigForDevice();
  
  // Generate VPN config (if enabled)
  let vpnConfig = null;
  const vpnEnabled = await SystemConfigModel.get<boolean>('vpn.enabled');
  if (vpnEnabled) {
    vpnConfig = await wireGuardService.createPeer(device.uuid, device.device_name);
  }
  
  // Generate default target state (auto-deploy apps)
  const defaultState = await generateDefaultTargetState(device.uuid);
  if (defaultState) {
    await DeviceTargetStateModel.set(device.uuid, defaultState);
  }
  
  // Publish event
  await eventPublisher.publish({
    type: 'DEVICE_PROVISIONED',
    deviceUuid: device.uuid,
    data: { deviceName: device.device_name, deviceType: device.device_type }
  });
  
  res.json({
    device: {
      deviceId: device.id,
      uuid: device.uuid,
      deviceName: device.device_name
    },
    mqtt: {
      brokerUrl: buildBrokerUrl(brokerConfig),
      username: mqttUsername,
      password: mqttPassword,
      brokerConfig: formatBrokerConfigForClient(brokerConfig)
    },
    api: {
      endpoint: process.env.CLOUD_API_ENDPOINT || 'https://api.iotistic.ca',
      deviceApiKey: device.api_key,
      tlsConfig: await SystemConfigModel.get('api.tlsConfig')
    },
    vpn: vpnConfig ? formatVpnConfigForDevice(vpnConfig) : null
  });
});
```

### Provisioning Key Management

**Create Key**:
```typescript
POST /api/v1/provisioning-keys
Body: {
  fleetId: "factory-floor",
  description: "Keys for factory floor devices",
  maxUses: 50,
  expiresAt: "2025-12-31T23:59:59Z"
}

Response: {
  id: "pkey_123",
  key: "3564a669790c24cf98ee5f7560c2dfad6b0334abbbf507d31db6efa724bfcf5b",  // Show once!
  keyHash: "$2b$10$...",
  fleetId: "factory-floor",
  maxUses: 50,
  currentUses: 0
}
```

**List Keys**:
```typescript
GET /api/v1/provisioning-keys?fleetId=factory-floor

Response: {
  keys: [
    {
      id: "pkey_123",
      fleetId: "factory-floor",
      description: "Keys for factory floor devices",
      maxUses: 50,
      currentUses: 23,
      isActive: true,
      expiresAt: "2025-12-31T23:59:59Z"
      // Note: raw key NOT included in list
    }
  ]
}
```

**Revoke Key**:
```typescript
DELETE /api/v1/provisioning-keys/pkey_123

Response: {
  success: true,
  message: "Provisioning key revoked"
}
```

---

## Digital Twin (Neo4j Graph)

### Architecture

**Purpose**: Store spatial relationships between buildings, floors, spaces, and IoT devices

**Graph Schema**:
```
Project (IFC model root)
  └─ CONTAINS ─> Site
       └─ CONTAINS ─> Building
            └─ CONTAINS_FLOOR ─> Floor
                 └─ CONTAINS_SPACE ─> Space
                      ├─ HAS_DEVICE ─> EdgeDevice
                      └─ HAS_SENSOR ─> Sensor
```

**Node Types**:
- `Project` - IFC model root (e.g., "Office Building Alpha")
- `Site` - Physical location
- `Building` - Structure
- `Floor` - Level within building
- `Space` - Room or area (IfcSpace)
- `EdgeDevice` - IoT gateway (links to `devices` table via UUID)
- `Sensor` - Physical sensor (temperature, humidity, etc.)

**Relationship Types**:
- `CONTAINS` - Generic containment
- `CONTAINS_FLOOR` - Building → Floor
- `CONTAINS_SPACE` - Floor → Space
- `HAS_DEVICE` - Space → EdgeDevice
- `HAS_SENSOR` - Space/Device → Sensor

### IFC File Upload

**Flow**:
```typescript
POST /api/v1/digital-twin/upload
Content-Type: multipart/form-data
Body: file=<ifc-file>

// API parses IFC file, extracts hierarchy
// Creates Neo4j nodes and relationships
// Returns project ID for future queries
Response: {
  projectId: "ifc_project_123",
  stats: {
    buildings: 1,
    floors: 3,
    spaces: 45,
    relationships: 93
  }
}
```

**Implementation** (`api/src/services/ifc-parser.service.ts`):
```typescript
export class IFCParserService {
  async parseIFC(fileBuffer: Buffer): Promise<IFCHierarchy> {
    const ifcApi = new IfcAPI();
    await ifcApi.Init();
    
    const modelID = ifcApi.OpenModel(fileBuffer);
    
    // Extract IfcProject (root)
    const projects = ifcApi.GetLineIDsWithType(modelID, IFCPROJECT);
    const project = ifcApi.GetLine(modelID, projects.get(0));
    
    // Extract IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace
    const hierarchy = {
      project: this.parseProject(ifcApi, modelID, project),
      sites: this.parseSites(ifcApi, modelID),
      buildings: this.parseBuildings(ifcApi, modelID),
      floors: this.parseFloors(ifcApi, modelID),
      spaces: this.parseSpaces(ifcApi, modelID)
    };
    
    ifcApi.CloseModel(modelID);
    return hierarchy;
  }
}
```

**Graph Storage** (`api/src/services/neo4j.service.ts`):
```typescript
export class Neo4jService {
  async storeIFCHierarchy(hierarchy: IFCHierarchy): Promise<string> {
    const session = this.getSession();
    
    try {
      // Create Project node
      const projectResult = await session.run(
        `CREATE (p:Project {
          expressId: $expressId,
          name: $name,
          description: $description,
          ifcSchema: $ifcSchema
        }) RETURN p`,
        {
          expressId: hierarchy.project.expressId,
          name: hierarchy.project.name,
          description: hierarchy.project.description,
          ifcSchema: hierarchy.project.schema
        }
      );
      
      // Create Site → Building → Floor → Space hierarchy
      for (const site of hierarchy.sites) {
        await session.run(
          `MATCH (p:Project {expressId: $projectId})
           CREATE (s:Site {expressId: $siteId, name: $name})
           CREATE (p)-[:CONTAINS]->(s)`,
          { projectId: hierarchy.project.expressId, siteId: site.expressId, name: site.name }
        );
        
        for (const building of site.buildings) {
          await session.run(
            `MATCH (s:Site {expressId: $siteId})
             CREATE (b:Building {expressId: $buildingId, name: $name})
             CREATE (s)-[:CONTAINS]->(b)`,
            { siteId: site.expressId, buildingId: building.expressId, name: building.name }
          );
          
          for (const floor of building.floors) {
            await session.run(
              `MATCH (b:Building {expressId: $buildingId})
               CREATE (f:Floor {expressId: $floorId, name: $name, elevation: $elevation})
               CREATE (b)-[:CONTAINS_FLOOR]->(f)`,
              { 
                buildingId: building.expressId, 
                floorId: floor.expressId, 
                name: floor.name,
                elevation: floor.elevation
              }
            );
            
            for (const space of floor.spaces) {
              await session.run(
                `MATCH (f:Floor {expressId: $floorId})
                 CREATE (s:Space {expressId: $spaceId, name: $name, longName: $longName})
                 CREATE (f)-[:CONTAINS_SPACE]->(s)`,
                { 
                  floorId: floor.expressId, 
                  spaceId: space.expressId, 
                  name: space.name,
                  longName: space.longName
                }
              );
            }
          }
        }
      }
      
      return hierarchy.project.expressId;
    } finally {
      await session.close();
    }
  }
}
```

### Device-Space Mapping

**Link Device to Space**:
```typescript
POST /api/v1/digital-twin/devices
Body: {
  deviceUuid: "abc-123-def",
  spaceId: "ifc_space_456",
  position: { x: 10.5, y: 3.2, z: 1.5 }
}

// Creates relationship: (Space)-[:HAS_DEVICE]->(EdgeDevice)
```

**Implementation**:
```typescript
router.post('/digital-twin/devices', async (req, res) => {
  const { deviceUuid, spaceId, position } = req.body;
  
  const neo4j = Neo4jService.getInstance();
  const session = neo4j.getSession();
  
  try {
    // Check if device exists in PostgreSQL
    const device = await DeviceModel.getByUuid(deviceUuid);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Create EdgeDevice node and link to Space
    await session.run(
      `MATCH (s:Space {expressId: $spaceId})
       MERGE (d:EdgeDevice {uuid: $deviceUuid})
       ON CREATE SET d.name = $deviceName, d.deviceType = $deviceType
       MERGE (s)-[r:HAS_DEVICE]->(d)
       SET r.position = $position`,
      {
        spaceId,
        deviceUuid,
        deviceName: device.device_name,
        deviceType: device.device_type,
        position
      }
    );
    
    res.json({ success: true });
  } finally {
    await session.close();
  }
});
```

### Graph Visualization

**Get Full Graph**:
```typescript
GET /api/v1/digital-twin/graph?projectId=ifc_project_123

Response: {
  nodes: [
    { id: "proj_1", labels: ["Project"], properties: { name: "Office Building" } },
    { id: "build_1", labels: ["Building"], properties: { name: "Main Building" } },
    { id: "floor_1", labels: ["Floor"], properties: { name: "Ground Floor", elevation: 0 } },
    { id: "space_1", labels: ["Space"], properties: { name: "Room 101" } },
    { id: "dev_1", labels: ["EdgeDevice"], properties: { uuid: "abc-123", name: "Gateway 1" } }
  ],
  relationships: [
    { type: "CONTAINS", from: "proj_1", to: "build_1" },
    { type: "CONTAINS_FLOOR", from: "build_1", to: "floor_1" },
    { type: "CONTAINS_SPACE", from: "floor_1", to: "space_1" },
    { type: "HAS_DEVICE", from: "space_1", to: "dev_1", properties: { position: {...} } }
  ]
}
```

**Implementation**:
```typescript
async getProjectGraph(projectId: string): Promise<GraphVisualizationData> {
  const session = this.getSession();
  
  try {
    const result = await session.run(
      `MATCH (p:Project {expressId: $projectId})
       MATCH path = (p)-[*]->(n)
       RETURN nodes(path) as nodes, relationships(path) as rels`,
      { projectId }
    );
    
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    
    result.records.forEach(record => {
      const pathNodes = record.get('nodes');
      const pathRels = record.get('rels');
      
      pathNodes.forEach((node: any) => {
        if (!nodes.find(n => n.id === node.identity.toString())) {
          nodes.push({
            id: node.identity.toString(),
            labels: node.labels,
            properties: node.properties
          });
        }
      });
      
      pathRels.forEach((rel: any) => {
        relationships.push({
          type: rel.type,
          from: rel.start.toString(),
          to: rel.end.toString(),
          properties: rel.properties
        });
      });
    });
    
    return { nodes, relationships };
  } finally {
    await session.close();
  }
}
```

---

## MQTT Integration

### Mosquitto HTTP Auth Backend

**Pattern**: Mosquitto uses `mosquitto-go-auth` plugin to query PostgreSQL for authentication

**Configuration** (`mosquitto/mosquitto.conf`):
```conf
auth_plugin /mosquitto/go-auth.so

auth_opt_backends postgres
auth_opt_pg_host postgres
auth_opt_pg_port 5432
auth_opt_pg_dbname iotistic
auth_opt_pg_user postgres
auth_opt_pg_password password

# Authentication query
auth_opt_pg_userquery SELECT password_hash FROM mqtt_users WHERE username = $1 AND is_active = true

# ACL query
auth_opt_pg_aclquery SELECT 1 FROM mqtt_acls WHERE username = $1 AND topic = $2 AND rw >= $3
```

**HTTP Auth Endpoint** (`api/src/routes/mosquitto-auth.ts`):
```typescript
// Mosquitto HTTP Auth Backend (mosquitto-go-auth calls this)
router.post('/user', async (req, res) => {
  const { username, password } = req.body;
  
  // Query PostgreSQL for user
  const result = await query(
    'SELECT password_hash FROM mqtt_users WHERE username = $1 AND is_active = true',
    [username]
  );
  
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'User not found' });
  }
  
  // Verify bcrypt password
  const valid = await bcrypt.compare(password, result.rows[0].password_hash);
  
  if (!valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  res.status(200).json({ ok: true });
});

router.post('/acl', async (req, res) => {
  const { username, topic, acc } = req.body;  // acc: 1=read, 2=write
  
  // Query PostgreSQL for ACL
  const result = await query(
    'SELECT 1 FROM mqtt_acls WHERE username = $1 AND topic = $2 AND rw >= $3',
    [username, topic, acc]
  );
  
  if (result.rows.length === 0) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  res.status(200).json({ ok: true });
});
```

### MQTT Monitoring

**Real-Time Metrics** (`api/src/services/mqtt-monitor.ts`):
```typescript
export class MQTTMonitorService {
  async getRealtimeMetrics(): Promise<BrokerMetrics> {
    // Query $SYS topics for broker stats
    const stats = await this.mqttClient.subscribe('$SYS/broker/#');
    
    return {
      connectedClients: stats['$SYS/broker/clients/connected'],
      messagesReceived: stats['$SYS/broker/messages/received'],
      messagesSent: stats['$SYS/broker/messages/sent'],
      bytesReceived: stats['$SYS/broker/bytes/received'],
      bytesSent: stats['$SYS/broker/bytes/sent'],
      uptime: stats['$SYS/broker/uptime']
    };
  }
}
```

**Topic Metrics** (stored in PostgreSQL):
```sql
CREATE TABLE mqtt_topic_metrics (
  id BIGSERIAL PRIMARY KEY,
  topic VARCHAR(255) NOT NULL,
  message_count BIGINT DEFAULT 0,
  bytes_received BIGINT DEFAULT 0,
  message_rate DECIMAL(10,2),         -- Messages per second
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Common Operations

### Database Access

**Query Helper** (`api/src/db/connection.ts`):
```typescript
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  
  logger.debug('Executed query', { text, duration, rows: res.rowCount });
  return res;
}
```

**Interactive psql**:
```powershell
# Connect to database
docker exec -it iotistic-postgres psql -U postgres -d iotistic

# Common queries
SELECT uuid, device_name, is_online FROM devices;
SELECT * FROM device_target_state WHERE device_uuid = '<uuid>';
SELECT username, topic, rw FROM mqtt_acls ORDER BY username;
SELECT key, value FROM system_config WHERE key LIKE 'mqtt%';
```

### Development Workflows

**Local Development**:
```powershell
# Start API in dev mode (auto-reload)
cd api; npm run dev

# Run with specific environment
$env:DATABASE_URL='postgresql://localhost:5432/iotistic'
$env:IOTISTIC_LICENSE_KEY='eyJhbGc...'
$env:NEO4J_URI='bolt://localhost:7687'
npm run dev
```

**Database Operations**:
```powershell
# Run migrations
npm run migrate

# Check migration status
npm run migrate:status

# Create new migration
npm run migrate:create add_new_feature

# Mark migration as applied (skip execution)
npm run migrate:mark-applied 042_migration_name
```

**Partition Maintenance** (for metrics tables):
```powershell
# Check partitions
npm run check-partitions

# Create missing partitions
npm run fix-partitions

# Maintain partitions (cron job)
npm run maintain-partitions
```

---

## Environment Variables Reference

**Database**:
- `DATABASE_URL=postgresql://postgres:password@postgres:5432/iotistic` - PostgreSQL connection
- `DB_POOL_MAX=20` - Max connections

**License & Billing**:
- `IOTISTIC_LICENSE_KEY=<jwt>` - License JWT (multi-tenant deployments)
- `LICENSE_PUBLIC_KEY=<pem>` - RSA public key for JWT verification
- `BILLING_API_URL=https://billing.iotistic.cloud` - Global billing API
- `BILLING_UPGRADE_URL=https://iotistic.ca/upgrade` - Upgrade page

**MQTT**:
- `MQTT_BROKER_URL=mqtts://mosquitto:8883` - MQTT broker
- `MQTT_USERNAME=api_server` - API MQTT username
- `MQTT_PASSWORD=<password>` - API MQTT password
- `MQTT_MONITOR_ENABLED=true` - Enable MQTT monitoring

**Neo4j** (Digital Twin):
- `NEO4J_URI=bolt://localhost:7687` - Neo4j connection
- `NEO4J_USERNAME=neo4j` - Neo4j username
- `NEO4J_PASSWORD=iotistic123` - Neo4j password

**Redis** (Optional):
- `REDIS_URL=redis://redis:6379` - Redis connection
- `REDIS_PASSWORD=<password>` - Redis password

**Cloud API**:
- `CLOUD_API_ENDPOINT=https://api.iotistic.ca` - External API URL (for devices)
- `PORT=3002` - API port
- `API_VERSION=v1` - API version prefix

**VPN**:
- `VPN_ENABLED=true` - Enable VPN provisioning
- `VPN_PROTOCOL=wireguard` - VPN protocol (wireguard or openvpn)
- `WIREGUARD_SERVER_ENDPOINT=vpn.iotistic.ca:51820` - WireGuard server

**Logging**:
- `LOG_LEVEL=info` - Log level (debug, info, warn, error)
- `LOG_FORMAT=json` - Log format (json or text)

**Jobs**:
- `JOB_SCHEDULER_ENABLED=true` - Enable job scheduler
- `JOB_RETENTION_DAYS=30` - Keep job history for N days

---

## Troubleshooting

### License Validation Fails

**Error: "License validation failed"**

```powershell
# Check license key is set
docker exec api-1 node -e "console.log(process.env.IOTISTIC_LICENSE_KEY)"

# Verify public key format (must have actual newlines, not \n literals)
docker exec api-1 node -e "console.log(process.env.LICENSE_PUBLIC_KEY)"

# Test JWT decoding (without verification)
$jwt = $env:IOTISTIC_LICENSE_KEY
$payload = $jwt.Split('.')[1]
$decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
Write-Output $decoded | ConvertFrom-Json

# Check logs for validation errors
docker logs api-1 | Select-String -Pattern "license|validation"
```

### Database Connection Issues

**Error: "Connection timeout"**

```powershell
# Check PostgreSQL is running
docker ps | Select-String postgres

# Test connection from API container
docker exec api-1 psql $env:DATABASE_URL -c "SELECT 1"

# Check connection string format
docker exec api-1 node -e "console.log(process.env.DATABASE_URL)"

# Verify pool settings
docker exec api-1 node -e "const pool = require('./dist/db/connection'); pool.query('SELECT NOW()').then(console.log)"
```

### Neo4j Connection Issues

**Error: "Failed to connect to Neo4j"**

```powershell
# Check Neo4j is running
docker ps | Select-String neo4j

# Test connection
docker exec api-1 node -e "const neo4j = require('neo4j-driver'); const driver = neo4j.driver('$env:NEO4J_URI', neo4j.auth.basic('$env:NEO4J_USERNAME', '$env:NEO4J_PASSWORD')); driver.verifyConnectivity().then(() => console.log('OK')).catch(console.error)"

# Check Neo4j logs
docker logs neo4j-1
```

### MQTT Authentication Fails

**Error: "Connection refused" from devices**

```powershell
# Check MQTT users table
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "SELECT username, is_active FROM mqtt_users;"

# Check MQTT ACLs
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "SELECT username, topic, rw FROM mqtt_acls WHERE username = 'device_<uuid>';"

# Test MQTT auth endpoint
curl -X POST http://localhost:3002/mosquitto-auth/user `
  -H "Content-Type: application/json" `
  -d '{"username": "device_abc", "password": "test123"}'

# Check mosquitto logs
docker logs mosquitto-1
```

---

## Key Files Reference

**Core**:
- `api/src/index.ts` - Main Express server (689 lines)
- `api/src/db/connection.ts` - PostgreSQL connection pool
- `api/package.json` - Dependencies and scripts

**Routes** (33 route files):
- `api/src/routes/provisioning.ts` - Two-phase device auth (1197 lines)
- `api/src/routes/device-state.ts` - Target/current state management
- `api/src/routes/devices.ts` - Device CRUD operations
- `api/src/routes/digital-twin.ts` - IFC upload, entity management
- `api/src/routes/digital-twin-graph.ts` - Graph visualization
- `api/src/routes/mqtt-monitor.ts` - Real-time MQTT metrics
- `api/src/routes/device-jobs.ts` - Job execution API
- `api/src/routes/license.ts` - License validation endpoint

**Services** (30+ service files):
- `api/src/services/license-validator.ts` - JWT validation, feature gating (251 lines)
- `api/src/services/neo4j.service.ts` - Graph database operations (422 lines)
- `api/src/services/ifc-parser.service.ts` - Building model parsing
- `api/src/services/mqtt-monitor.ts` - MQTT monitoring
- `api/src/services/device-state-handler.ts` - State reconciliation
- `api/src/services/billing-client.ts` - Usage reporting
- `api/src/services/job-scheduler.ts` - Cron job management

**Database**:
- `api/database/migrations/*.sql` - 58+ SQL migrations
- `api/src/db/models/*.ts` - Data models (Device, TargetState, etc.)
- `api/src/db/system-config-model.ts` - System configuration helper

**MQTT**:
- `api/src/mqtt/index.ts` - MQTT service initialization
- `api/src/mqtt/mqtt-manager.ts` - MQTT client wrapper
- `api/src/mqtt/handlers/*.ts` - Message handlers
- `api/src/routes/mosquitto-auth.ts` - HTTP auth backend

**Utilities**:
- `api/src/utils/logger.ts` - Winston logger
- `api/src/utils/audit-logger.ts` - Security event logging
- `api/src/utils/provisioning-keys.ts` - Key management
- `api/src/utils/mqtt-broker-config.ts` - Broker config helper
- `api/src/utils/vpn-config.ts` - VPN config helper