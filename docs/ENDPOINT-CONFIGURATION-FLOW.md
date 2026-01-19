# Endpoint Configuration Flow

## Architecture Overview: Discovery → Target State → Agent Sync

This document explains how discovered devices flow from discovery into target state configuration and how they're synchronized between cloud and edge for enable/disable control.

---

## Current Implementation

### 1. **Discovery Phase** (Agent-Side)

**When**: 
- First boot discovery (if enabled)
- Manual trigger via API
- Scheduled discovery (light or full)

**Where**: `agent/src/features/discovery/discovery-service.ts`

**Flow**:
```typescript
// Discovery runs on agent
await discoveryService.runDiscovery({ trigger: 'manual', validate: true });

// Discovery plugins find devices
const modbusDevices = await modbusPlugin.discover(options);
const opcuaDevices = await opcuaPlugin.discover(options);

// Devices saved to SQLite device_sensors table
await DeviceEndpointModel.create({
  name: 'modbus-sim-2_slave_1',
  protocol: 'modbus',
  enabled: false, // Inherited from parent connection.enabled
  poll_interval: 5000,
  connection: { host: '10.0.0.60', port: 503, slaveId: 1 },
  data_points: [...],
  metadata: { ... }
});
```

**Database**: Agent's local SQLite `device_sensors` table

---

### 2. **Cloud Sync Phase** (Agent → Cloud)

**When**: Agent reports current state to cloud

**Where**: 
- Agent: `agent/src/device-manager/sync.ts` (CloudSync service)
- API: `api/src/routes/device-state.ts` → `api/src/services/device-state.ts`

**Flow**:
```typescript
// Agent sends current state report
await cloudSync.reportCurrentState();

// Report includes endpoints from device_sensors table
const currentState = {
  apps: { ... },
  config: {
    endpoints: [
      {
        id: 'uuid-123',
        name: 'modbus-sim-2_slave_1',
        protocol: 'modbus',
        enabled: 0, // SQLite boolean (0/1)
        connectionString: '{"host":"10.0.0.60","port":503,"slaveId":1}',
        pollInterval: 5000,
        dataPoints: [...],
        metadata: { ... }
      }
    ],
    logging: { ... },
    features: { ... }
  },
  version: 1
};

// Cloud API receives report and reconciles
// api/src/services/device-state.ts::processDeviceStateReport()
if (deviceState.config?.endpoints) {
  await deviceSensorSync.syncCurrentStateToTable(uuid, deviceState);
}
```

**Key Service**: `api/src/services/device-endpoints.ts::syncCurrentStateToTable()`

**What It Does**:
- Takes agent's reported endpoints
- Converts agent format → API format
- **Syncs to cloud PostgreSQL `device_sensors` table**
- Marks as `deployment_status='deployed'` (reconciled)

**Database**: Cloud PostgreSQL `device_sensors` table (replica of agent's state)

---

### 3. **Dashboard Display** (Cloud → UI)

**When**: User opens Sensors page

**Where**: 
- Dashboard: `dashboard/src/pages/SensorsPage.tsx`
- API: `api/src/services/device-endpoints.ts::getEndpoints()`

**Flow**:
```typescript
// Dashboard fetches sensors
const response = await fetch(`/api/devices/${deviceUuid}/sensors`);
const sensors = await response.json();

// API reads from device_sensors table
const endpoints = await deviceSensorSync.getEndpoints(deviceUuid);

// IMPORTANT: enabled field comes from target state, NOT table!
// api/src/services/device-endpoints.ts::getEndpoints()
const targetState = await DeviceTargetStateModel.get(deviceUuid);
const targetSensors = targetState.config.endpoints || [];

// Merge: table data + target state 'enabled' value
const enabledFromTarget = targetSensor?.enabled ?? row.enabled;
```

**Why This Pattern?**:
- **Table** = Actual deployed state (what exists on device)
- **Target State** = Desired state (what user wants)
- User sees **desired state** for enabled field, **actual state** for health

---

### 4. **User Toggles Endpoint** (UI → Cloud)

**When**: User clicks enable/disable toggle

**Where**: `dashboard/src/pages/SensorsPage.tsx`

**Flow** (CORRECT - Override Pattern):
```typescript
// User toggles sensor in dashboard
const handleToggleSensorEnabled = async (sensor: Sensor, currentEnabled: boolean) => {
  const newEnabled = !currentEnabled;
  
  // Get current config from pending or target state
  const currentConfig = getPendingConfig(deviceUuid) || getTargetConfig(deviceUuid);
  
  // Find or create endpoint override
  const existingOverride = currentConfig.endpoints?.find(e => e.uuid === sensor.uuid);
  
  if (existingOverride) {
    // Update existing override
    existingOverride.enabled = newEnabled;
  } else {
    // Create new override (ONLY uuid + enabled, no discovery data!)
    currentConfig.endpoints = currentConfig.endpoints || [];
    currentConfig.endpoints.push({
      uuid: sensor.uuid,
      enabled: newEnabled
    });
  }
  
  // Save to target state (marks needs_deployment=true)
  // IMPORTANT: Only stores override, not full endpoint details!
  await saveTargetStateWithConfig(deviceUuid, currentConfig);
};
```

**Database**: Updates `device_target_state.config.endpoints` in PostgreSQL

**Key Point**: This does NOT increment version yet - change is saved but not deployed!

**What's Stored in Target State** (Override-Only Pattern):
```json
{
  "config": {
    "endpoints": [
      {
        "uuid": "550e8400-e29b-41d4-a716-446655440001",
        "enabled": true,
        "pollInterval": 10000,
        "alias": "Main Temperature Sensor",
        "tags": ["production", "critical"]
      },
      {
        "uuid": "550e8400-e29b-41d4-a716-446655440002",
        "enabled": false
      },
      {
        "uuid": "550e8400-e29b-41d4-a716-446655440003",
        "enabled": true,
        "pollInterval": 30000
      }
    ],
    "protocols": {
      "modbus": {
        "enabled": true,
        "connections": [
          {
            "name": "modbus-sim-2",
            "host": "10.0.0.60",
            "port": 503,
            "enabled": true,
            "addressing": {
              "slaveRange": { "start": 1, "end": 10 }
            },
            "points": { /* discovery template */ }
          }
        ]
      }
    },
    "logging": { "level": "info" },
    "features": { "anomalyDetection": true }
  },
  "version": 5
}

// IMPORTANT: No connection, dataPoints, or metadata in endpoints!
// Those are in device_sensors table
```

**Complete Example with Merge**:

**What's in device_sensors table** (discovered data):
```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440001",
  "device_uuid": "device-abc-123",
  "name": "modbus-sim-2_slave_1",
  "protocol": "modbus",
  "enabled": 0,
  "poll_interval": 5000,
  "connection": {
    "host": "10.0.0.60",
    "port": 503,
    "slaveId": 1,
    "timeout": 5000
  },
  "data_points": [
    {
      "name": "holding_register_0",
      "address": 0,
      "type": "holding",
      "dataType": "uint16",
      "description": "Register 0"
    },
    {
      "name": "holding_register_1",
      "address": 1,
      "type": "holding",
      "dataType": "uint16",
      "description": "Register 1"
    }
  ],
  "metadata": {
    "discoveredAt": "2026-01-18T10:30:00Z",
    "discoveryMethod": "modbus_scan",
    "modbusUnitId": 1
  }
}
```

**What's in config.endpoints** (user overrides):
```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440001",
  "enabled": true,
  "pollInterval": 10000,
  "alias": "Main Temperature Sensor",
  "tags": ["production", "critical"]
}
```

**Agent merges to create final runtime config**:
```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440001",
  "device_uuid": "device-abc-123",
  "name": "modbus-sim-2_slave_1",
  "alias": "Main Temperature Sensor",
  "protocol": "modbus",
  "enabled": true,
  "pollInterval": 10000,
  "tags": ["production", "critical"],
  "connection": {
    "host": "10.0.0.60",
    "port": 503,
    "slaveId": 1,
    "timeout": 5000
  },
  "dataPoints": [
    {
      "name": "holding_register_0",
      "address": 0,
      "type": "holding",
      "dataType": "uint16",
      "description": "Register 0"
    },
    {
      "name": "holding_register_1",
      "address": 1,
      "type": "holding",
      "dataType": "uint16",
      "description": "Register 1"
    }
  ],
  "metadata": {
    "discoveredAt": "2026-01-18T10:30:00Z",
    "discoveryMethod": "modbus_scan",
    "modbusUnitId": 1
  }
}
```

---

### 5. **Deploy Phase** (Cloud → Trigger)

**When**: User clicks "Sync" button in dashboard header

**Where**: `dashboard/src/components/Header.tsx` → API `/api/devices/:uuid/deploy`

**Flow**:
```typescript
// User clicks "Sync" button
const handleDeploy = async () => {
  const response = await fetch(`/api/devices/${deviceUuid}/deploy`, {
    method: 'POST'
  });
};

// API increments version and syncs to table
// api/src/db/models.ts::DeviceTargetStateModel.deploy()
const result = await query(
  `UPDATE device_target_state SET
     version = version + 1, -- Triggers agent to poll
     needs_deployment = false,
     last_deployed_at = CURRENT_TIMESTAMP
   WHERE device_uuid = $1`,
  [deviceUuid]
);

// Sync config.endpoints → device_sensors table
await deviceSensorSync.syncConfigToTable(
  deviceUuid,
  deployedState.config.endpoints,
  deployedState.version,
  deployedBy
);
```

**Database**: 
- Increments `device_target_state.version` (agent polls this)
- Updates `device_sensors.deployment_status='pending'` for changed endpoints

---

### 6. **Agent Polls Target State** (Cloud → Agent)

**When**: Agent polls every 60 seconds (configurable)

**Where**: 
- Agent: `agent/src/device-manager/sync.ts::pollTargetState()`
- API: `api/src/routes/device-state.ts` → GET `/api/v1/device/state`

**Flow**:
```typescript
// Agent polls for target state
const response = await this.httpClient.get('/api/v1/device/state', {
  headers: {
    'If-None-Match': this.targetStateETag // ETag caching
  }
});

// API returns target state if version changed
if (targetState.version > currentState.version) {
  return {
    [deviceUuid]: {
      apps: targetState.apps,
      config: targetState.config, // Includes endpoints array!
      version: targetState.version,
      needs_deployment: false
    }
  };
}
```

**What Agent Receives**:
```json
{
  "device-uuid-123": {
    "apps": { ... },
    "config": {
      "endpoints": [
        {
          "id": "uuid-123",
          "uuid": "uuid-123",
          "name": "modbus-sim-2_slave_1",
          "enabled": true, // User toggled this!
          "protocol": "modbus",
          "connection": { "host": "10.0.0.60", "port": 503, "slaveId": 1 },
          "dataPoints": [...],
          "pollInterval": 5000,
          "metadata": { ... }
        }
      ],
      "logging": { ... },
      "features": { ... }
    },
    "version": 2
  }
}
```

---

### 7. **Agent Reconciles Endpoints** (Agent-Side)

**When**: Agent receives new target state

**Where**: `agent/src/device-manager/reconciler.ts` → `agent/src/device-manager/config.ts`

**Flow** (CORRECT - Merge Pattern):
```typescript
// StateReconciler sets new target state
await stateReconciler.setTarget(newTargetState);

// ConfigManager reconciles endpoints
// agent/src/device-manager/config.ts::setTarget()
this.targetConfig = config;
await this.reconcile();

// CRITICAL: Merge discovery data + config overrides
const currentEndpoints = await DeviceEndpointModel.getAll(); // From device_sensors table

for (const endpoint of currentEndpoints) {
  // Find override in target state
  const override = config.endpoints?.find(e => e.uuid === endpoint.uuid);
  
  if (override) {
    // Apply ONLY the override fields (enabled, pollInterval, etc.)
    // DO NOT replace connection, dataPoints, metadata from target state!
    await DeviceEndpointModel.update(endpoint.uuid, {
      enabled: override.enabled ?? endpoint.enabled,
      poll_interval: override.pollInterval ?? endpoint.poll_interval,
      alias: override.alias ?? endpoint.alias,
      tags: override.tags ?? endpoint.tags
      // connection, data_points, metadata stay unchanged (from discovery)
    });
  }
}
```

**Database**: Updates agent's SQLite `device_sensors` table with **ONLY override fields**

**Key Point**: Discovery data (connection, dataPoints) remains intact! Only user configuration is updated.

**What Gets Updated**:
- ✅ `enabled` - User toggle (enable/disable device)
- ✅ `poll_interval` - User override (custom polling interval)
- ✅ `alias` - User override (friendly name, overrides discovered name)
- ✅ `tags` - User categorization
- ✅ `connection` - User override (can modify IP, port, etc. after discovery)
- ✅ `data_points` - User override (can add/remove/modify data points)
- ❌ `name` - Discovery data, read-only! (e.g., "modbus-sim-2_slave_1")
- ❌ `protocol` - Discovery data, read-only!
- ❌ `metadata` - Discovery data, read-only!

---

### 8. **Protocol Adapters Reload** (Agent-Side)

**When**: ConfigManager emits 'config-applied' event OR endpoint discovery triggers reload

**Where**: `agent/src/features/endpoints/` (Modbus, OPC UA, SNMP adapters)

**Flow**:
```typescript
// Adapter reloads devices from device_sensors table
const endpoints = await DeviceEndpointModel.getAll();

// Filter by protocol and enabled=true
const enabledModbusDevices = endpoints.filter(e => 
  e.protocol === 'modbus' && e.enabled === true
);

// Start polling enabled devices
for (const device of enabledModbusDevices) {
  this.startPolling(device);
}
```

**Result**: Only enabled devices are polled!

---

## Configuration Schema

### Target State Schema (Revised Architecture)

**CRITICAL PRINCIPLE**: Target state endpoints should **ONLY** contain configuration overrides, NOT discovery data!

- ✅ **device_sensors table** = Source of truth for discovered device details (connection, data points, metadata)
- ✅ **config.endpoints** = Configuration overrides only (enabled, pollInterval, custom settings)
- ❌ **Don't duplicate** full endpoint definitions in target state

```typescript
interface TargetState {
  apps: {
    [appId: string]: {
      appId: string;
      appName: string;
      services: ServiceConfig[];
    };
  };
  config: {
    // ENDPOINTS CONFIGURATION (overrides only!)
    // Only include fields that USER configured/modified (not discovery metadata)
    endpoints?: Array<{
      uuid: string;          // UUID - references device_sensors table entry
      enabled?: boolean;     // User override: enable/disable device
      pollInterval?: number; // User override: custom poll interval
      alias?: string;        // User override: friendly name (overrides discovered name)
      tags?: string[];       // User override: custom tags/categories
      connection?: any;      // User override: modified connection settings (IP, port, etc.)
      dataPoints?: any[];    // User override: modified/added data points
      // NO name, protocol, metadata! Those are read-only discovery data
    }>;
    
    // PROTOCOL DISCOVERY SECTION (scanning config)
    protocols?: {
      modbus?: {
        enabled: boolean;
        connections: Array<{
          name: string;
          host: string;
          port: number;
          enabled: boolean;
          addressing: {
            slaveRange: { start: number; end: number; }
          };
          points: any; // Template data points for discovery
        }>;
      };
      opcua?: {
        enabled: boolean;
        connections: string[]; // URLs to scan
      };
      snmp?: {
        enabled: boolean;
        connections: string[]; // IP ranges to scan
      };
    };
    
    // OTHER CONFIG SECTIONS
    logging?: { ... };
    features?: { ... };
    intervals?: { ... };
    anomalyDetection?: { ... };
  };
  version: number; // Incremented on deploy
}

// Agent Reconciliation Pattern (CORRECT)
// 1. Read full endpoint from device_sensors table (discovery data)
// 2. Apply overrides from config.endpoints (user configuration)
// 3. Result = merged endpoint configuration
const endpoint = {
  ...deviceSensorsRow,              // Base: discovered data
  ...targetState.config.endpoints.find(e => e.uuid === row.uuid) // Override: user config
};
```

### Why This Matters

**❌ Current Problem** (if endpoints contains full data):
- Duplicates discovery data in target state
- Large payload size (hundreds of data points per endpoint)
- Sync conflicts: which is source of truth?
- User edits discovery data → breaks next discovery

**✅ Correct Pattern** (endpoints as overrides):
- Target state only contains **user decisions** (enabled/disabled)
- Discovery data stays in `device_sensors` table
- Small payload size (just UUIDs + overrides)
- Clear separation: discovery vs. configuration
```

---

## Database Schema

### Cloud PostgreSQL: `device_sensors` Table

```sql
CREATE TABLE device_sensors (
  id SERIAL PRIMARY KEY,
  uuid UUID UNIQUE,              -- Stable identifier (survives renames)
  name VARCHAR(255) NOT NULL,    -- Discovered name (e.g., "modbus-sim-2_slave_1")
  protocol VARCHAR(50) NOT NULL, -- 'modbus', 'opcua', 'snmp', etc.
  enabled BOOLEAN DEFAULT FALSE, -- Synced from config.endpoints override
  poll_interval INTEGER DEFAULT 5000, -- Synced from config.endpoints override
  connection JSONB,              -- Protocol-specific connection (from discovery)
  data_points JSONB,             -- Registers/nodes to read (from discovery)
  metadata JSONB,                -- Discovery metadata (discovery time, protocol info) read
  metadata JSONB,                -- Discovery metadata
  
  -- Deployment tracking
  config_version INTEGER,        -- Which target state version deployed this
  synced_to_config BOOLEAN DEFAULT FALSE,
  deployment_status VARCHAR(50), -- 'pending' | 'deployed' | 'failed'
  last_deployed_at TIMESTAMP,
  deployment_error TEXT,
  
  -- Health tracking (from agent reports)
  health_status VARCHAR(50),     -- 'healthy' | 'degraded' | 'offline'
  health_connected BOOLEAN,      -- Actual runtime state
  health_last_poll TIMESTAMP,
  health_error_count INTEGER,
  health_last_error TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);Override Pattern (NOT Dual-Write!)

**Problem**: Target state config vs database table - which is source of truth?

**Solution**: **device_sensors table** is the source of truth, **config.endpoints** is overrides only!

- **Database Table** (`device_sensors`): Source of truth for **discovered data** (connection, dataPoints, metadata)
- **Target State Config** (`config.endpoints`): Source of truth for **user configuration** (enabled, pollInterval, alias)

**WRONG** (Current Implementation?):
```typescript
// DON'T store full endpoint in config.endpoints!
config.endpoints = [
  {
    uuid: "abc-123",
    name: "device1",
    protocol: "modbus",
    connection: { host: "10.0.0.60", port: 503, slaveId: 1 }, // ❌ Duplicate!
    dataPoints: [ /* 100 data points */ ], // ❌ Huge payload!
    enabled: true
  }
];
```

**CORRECT** (Override Pattern):
```typescript
// ONLY store user configuration in config.endpoints!
config.endpoints = [
  {
    uuid: "abc-123",
    enabled: true,           // ✅ User override
    pollInterval: 10000,     // ✅ User override (custom interval)
    alias: "My Custom Name",  // ✅ User override (friendly name, optional)
    dataPoints: [            // ✅ User override (modified data points)
      { name: "temp", address: 100, type: "holding", dataType: "float32" }
    ]
    // NO name, protocol, metadata (read-only discovery data)!
  }
];

// Agent merges: device_sensors (discovery) + config.endpoints (overrides)
const finalConfig = {
  ...deviceSensorsRow,  // Discovery data (name, connection, dataPoints, metadata)
  ...configOverride     // User configuration (enabled, pollInterval, alias)
};

// Example result:
{
  uuid: "abc-123",
  name: "modbus-sim-2_slave_1",  // From discovery (device_sensors)
  alias: "My Custom Name",        // From user config (config.endpoints)
  protocol: "modbus",             // From discovery
  connection: { host: "10.0.0.60", port: 503, slaveId: 1 }, // From discovery
  dataPoints: [...],              // From discovery
  enabled: true,                  // From user config
  pollInterval: 10000             // From user config
}
```

**Sync Services** (NEEDS REFACTORING):
- ~~`syncConfigToTable()`~~: Should NOT copy full endpoint to table!
- ~~`syncTableToConfig()`~~: Should NOT copy full endpoint to config!
- `applyConfigOverrides()`: Apply ONLY override fields to device_sensors

**Problem**: Target state config vs database table - which is source of truth?

**Solution**: Both! Different purposes:
- **Target State Config** (`config.endpoints`): Source of truth for **desired state** (what user wants)
- **Database Table** (`device_sensors`): Source of truth for **deployed state** (what exists on device)

**Sync Services**:
- `syncConfigToTable()`: Config → Table (when deploying)
- `syncTableToConfig()`: Table → Config (when adding discovered devices)
- `syncCurrentStateToTable()`: Agent reality → Table (reconciliation)

### Pattern 2: Event Sourcing Loop

```
User Action (Toggle Enable)
  ↓
Target State Updated (config.endpoints.enabled = true)
  ↓
Deploy (version++)
  ↓
Agent Polls (gets new version)
  ↓
Agent Reconciles (updates SQLite device_sensors)
  ↓
Adapters Reload (start polling enabled devices)
  ↓
Agent Reports Current State (endpoints.enabled = 1)
  ↓
Cloud Reconciles (device_sensors.deployment_status = 'deployed')
  ↓
Loop Closed! ✅
```

### Pattern 3: Enabled Field Source of Truth

**Rule**: Always read `enabled` from **target state**, never from table!

**Why?**: Table shows **actual state**, target state shows **desired state**

**Implementation**:
```typescript
// api/src/services/device-endpoints.ts::getEndpoints()
const targetState = await DeviceTargetStateModel.get(deviceUuid);
const targetSensors = targetState.config.endpoints || [];

const enabledFromTarget = targetSensor?.enabled ?? row.enabled;
```

---

## How to Extend This System

### Adding New Protocol Discovery

1. Create discovery plugin in `agent/src/features/discovery/` (e.g., `bacnet.discovery.ts`)
2. Discovery saves to `device_sensors` table via `DeviceEndpointModel.create()`
3. Agent reports endpoints in next state report
4. Cloud syncs to cloud `device_sensors` table
5. Target state automatically includes new endpoints
6. No changes needed to dashboard or sync logic!

### Adding Per-Endpoint Configuration

1. Add fields to `device_sensors` table (both cloud and agent)
2. Add fields to `EndpointDeviceConfig` interface (`api/src/services/device-endpoints.ts`)
3. Dashboard form updates to show/edit new fields
4. Sync services automatically handle new fields (JSONB columns)
5. Adapters read new fields from `device_sensors` table

---

## Testing the Flow

### Manual Test Scenario

1. **Discovery**:
   ```bash
   # Trigger discovery on agent
   curl -X POST http://localhost:48484/api/v2/discovery/run \
     -H "Content-Type: application/json" \
     -d '{"trigger":"manual","validate":true}'
   ```

2. **Verify Database** (Agent):
   ```bash
   sqlite3 agent/data/device.sqlite
   SELECT name, protocol, enabled FROM device_sensors;
   # Should show discovered devices with enabled=0
   ```

3. **Agent Reports State**:
   - Wait for next report cycle (60s) or restart agent
   - Check cloud API logs for reconciliation

4. **Verify Database** (Cloud):
   ```sql
   SELECT name, protocol, enabled, deployment_status, health_connected 
   FROM device_sensors 
   WHERE device_uuid = 'your-device-uuid';
   ```

5. **Enable in Dashboard**:
   - Open Sensors page
   - Toggle endpoint enabled
   - Click "Sync" button

6. **Verify Target State** (Cloud):
   ```sql
   SELECT config->'endpoints'->0->'enabled' 
   FROM device_target_state 
   WHERE device_uuid = 'your-device-uuid';
   -- Should be true
   ```

7. **Agent Polls**:
   - Wait 60s for next poll or restart agent
   - Agent logs should show "Starting config reconciliation"

8. **Verify Agent Updated**:
   ```bash
   sqlite3 agent/data/device.sqlite
   SELECT name, enabled FROM device_sensors WHERE name = 'your-endpoint';
   # Should show enabled=1
   ```

9. **Verify Adapter Polling**:
   - Check adapter logs for polling activity
   - Should see data being collected from enabled endpoint

---

## Common Issues

### Issue: Endpoint toggle doesn't work

**Symptom**: User toggles endpoint but nothing happens

**Debug**:
1. Check target state was updated:discovery + override system**:

### Architecture Principles

1. **device_sensors table** = Source of truth for **baseline data**
   - Device name (discovered, read-only)
   - Protocol (discovered, read-only)
   - Connection details (discovered baseline, user-editable)
   - Data points (discovered baseline, user-editable)
   - Metadata (discovery time, read-only)

2. **config.endpoints** = Source of truth for **user modifications**
   - Enabled/disabled state
   - Custom poll intervals
   - Alias (friendly name override)
   - Tags and categories
   - Connection (if user modified from discovery)
   - Data points (if user added/modified from discovery)
   - **ONLY stores fields modified by user, NOT read-only discovery metadata!**

3. **Agent reconciliation** = Merge pattern
   - Read base from device_sensors table
   - Apply overrides from config.endpoints
   - Result = final runtime configuration

### Flow

1. **Discovery** (Agent → Cloud):
   - Agent discovers devices → SQLite `device_sensors` (full details)
   - Agent reports state → Cloud PostgreSQL `device_sensors` (full details)
   - **NO automatic population of config.endpoints** (user configures manually)

2. **Configuration** (Cloud → Agent):
   - User toggles endpoint → Creates/updates `config.endpoints[uuid].enabled = true`
   - Deploy increments version → Agent polls
   - Agent merges device_sensors + config overrides → Final config
   - Adapters reload → Respect merged `enabled` flag

3. **Reconciliation** (Bidirectional):
   - Agent reports actual state → Cloud marks `deployment_status='deployed'`
   - Discovery data stays in device_sensors table
   - Config overrides stay in target state
   - No duplication!

### Files That Need Refactoring

**CRITICAL**: Current implementation may duplicate full endpoints in config.endpoints!

**Files to Check/Fix**:
1. `api/src/services/device-endpoints.ts`:
   - ❌ `syncConfigToTable()` - May copy full endpoint to config
   - ❌ `syncTableToConfig()` - May copy full endpoint from table
   - ✅ `getEndpoints()` - Should merge table + overrides for UI
   - ✅ `updateEndpoint()` - Should only update override fields

2. `agent/src/device-manager/config.ts`:
   - ❌ `setTarget()` - May store full endpoint from config
   - ✅ `reconcile()` - Should merge device_sensors + config overrides
   - ✅ `getCurrentConfig()` - Returns full endpoints from device_sensors

3. `dashboard/src/pages/SensorsPage.tsx`:
   - ✅ Toggle should only store `{ uuid, enabled }` in config.endpoints
   - ❌ May currently store full endpoint object

**Refactoring Checklist**:
```
[ ] Audit config.endpoints usage across codebase
[ ] Remove full endpoint storage in target state
[ ] Implement override-only pattern in dashboard
[ ] Update API syncConfigToTable to apply overrides only
[ ] Update agent reconciliation to merge pattern
[ ] Update documentation with correct pattern
[ ] Test: config.endpoints should be < 1KB, not megabytes
``
**Debug**:
1. Check agent database:
   ```bash
   sqlite3 agent/data/device.sqlite
   SELECT COUNT(*) FROM device_sensors;
   ```
2. Check agent state report includes endpoints:
   - Agent logs: "Including endpoint health in report"
3. Check cloud reconciliation:
   - API logs: "Reconciling current state from agent"
4. Check cloud database:
   ```sql
   SELECT COUNT(*) FROM device_sensors WHERE device_uuid = '...';
   ```

**Common Causes**:
- Agent hasn't reported state yet (wait 60s)
- `config.endpoints` missing from state report
- Reconciliation skipped (agent reported 0 endpoints)

---

## Summary

The endpoint configuration flow is a **bidirectional sync system**:

1. **Discovery** (Agent → Cloud):
   - Agent discovers devices → SQLite `device_sensors`
   - Agent reports state → Cloud PostgreSQL `device_sensors`
   - Cloud generates `config.endpoints` in target state

2. **Configuration** (Cloud → Agent):
   - User toggles endpoint → Updates `config.endpoints`
   - Deploy increments version → Agent polls
   - Agent reconciles → Updates SQLite `device_sensors`
   - Adapters reload → Respect `enabled` flag

3. **Reconciliation** (Bidirectional):
   - Agent reports actual state → Cloud marks `deployment_status='deployed'`
   - Eventual consistency between cloud and edge

**Key Files to Modify**:
- Discovery: `agent/src/features/discovery/discovery-service.ts`
- Agent Sync: `agent/src/device-manager/sync.ts`
- Cloud Sync: `api/src/services/device-endpoints.ts`
- Config Reconciliation: `agent/src/device-manager/config.ts`
- Adapters: `agent/src/features/endpoints/{protocol}/adapter.ts`
