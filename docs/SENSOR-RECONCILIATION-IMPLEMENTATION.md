# Sensor Reconciliation Implementation

**Date**: 2025-11-02  
**Status**: ✅ COMPLETE  
**Pattern**: Event Sourcing / CQRS with Reconciliation Loop

---

## Overview

Implemented complete Event Sourcing/CQRS architecture for sensor device management with agent reconciliation loop. This ensures the `endpoints` table always reflects what's **actually deployed and running** on the agent.

---

## Architecture Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    EVENT SOURCING / CQRS LOOP                   │
└─────────────────────────────────────────────────────────────────┘

1. WRITE PATH (Desired State):
   User saves sensor → writes to device_target_state.config
                       (version++, needs_deployment=true)
                       ↓
                    IMMEDIATE sync to endpoints table
                    (for backward compatibility)

2. DEPLOY PATH (Agent Execution):
   Agent polls → reads device_target_state.config
                ↓
   Agent deploys → starts protocol adapters
                ↓
   Sensors running on agent

3. RECONCILIATION PATH (Reality Check):
   Agent reports → PATCH /api/v1/device/state
                  ↓
   API receives current state → syncCurrentStateToTable()
                  ↓
   endpoints table updated → reflects agent reality
                  ↓
   UI reads table → shows actual deployed state

4. READ PATH (Query Performance):
   UI queries → endpoints table (fast, indexed)
               ↓
   Shows what's actually running (not just desired)
```

---

## Key Components

### 1. **DeviceSensorSyncService** (`api/src/services/device-sensor-sync.ts`)

#### New Method: `syncCurrentStateToTable()`
```typescript
async syncCurrentStateToTable(deviceUuid: string, currentState: any): Promise<void>
```

**Purpose**: Reconciliation - sync agent's **actual running state** to table

**Flow**:
1. Extract `protocolAdapterDevices` from agent's current state
2. Call `syncConfigToTable()` with agent's running sensors
3. Table now reflects reality (not desired state)

**Called by**: PATCH `/api/v1/device/state` endpoint (when agent reports state)

**Example**:
```typescript
// Agent reports what's actually running
await deviceSensorSync.syncCurrentStateToTable(uuid, {
  config: {
    protocolAdapterDevices: [
      { name: 'modbus-sensor-1', protocol: 'modbus', ... },
      { name: 'can-sensor-2', protocol: 'can', ... }
    ]
  },
  version: 42
});

// Table now shows these 2 sensors (reality)
// Even if config has 3 sensors (desired state)
```

#### Updated Method: `getSensors()`
```typescript
async getSensors(deviceUuid: string, protocol?: string): Promise<any[]>
```

**Change**: Now reads from **endpoints TABLE** (deployed state)

**Before**: Read from `device_target_state.config` (desired state)  
**After**: Read from `endpoints` table (actual running state)

**Reason**: UI should show what's deployed, not what's desired

**Returns**:
- `id` - Database ID
- `name` - Sensor name
- `protocol` - modbus, can, opcua, mqtt
- `enabled` - Sensor status
- `pollInterval` - Polling frequency
- `connection` - Protocol-specific connection details
- `dataPoints` - Data points configuration
- `configVersion` - Which config version this came from
- `syncedToConfig` - Whether in sync with desired state
- `createdAt`, `updatedAt`, `createdBy`, `updatedBy` - Audit fields

#### Existing Methods (Unchanged):
- `addSensor()` - Write to config first, then sync to table
- `updateSensor()` - Update config first, then sync to table
- `deleteSensor()` - Delete from config first, then sync removes from table
- `syncConfigToTable()` - Handles config → table synchronization (inserts, updates, deletes)

---

### 2. **Device State Endpoint** (`api/src/routes/device-state.ts`)

#### Integration Point: `PATCH /api/v1/device/state`

**Added reconciliation call**:
```typescript
// After updating current state
await deviceSensorSync.syncCurrentStateToTable(uuid, deviceState);
```

**Location**: Line ~235 (after `DeviceCurrentStateModel.update()`)

**Error Handling**: Non-blocking - logs error but doesn't fail state report

**Impact**: Every time agent reports state, table is updated to match reality

---

## Database Schema

### `endpoints` Table

**Purpose**: Read model for deployed sensors (CQRS pattern)

**Key Columns**:
- `id` - Primary key
- `device_uuid` - Foreign key to devices
- `name` - Sensor name (unique per device)
- `protocol` - modbus, can, opcua, mqtt
- `enabled` - Sensor status
- `poll_interval` - Polling frequency (ms)
- `connection` - JSONB (protocol-specific)
- `data_points` - JSONB (registers, tags, etc.)
- `metadata` - JSONB (additional data)
- `config_version` - Which target state version
- `synced_to_config` - Sync tracking flag
- `created_by`, `updated_by` - Audit trail
- `created_at`, `updated_at` - Timestamps

**Indexes**:
- `idx_endpoints_device_uuid` - Fast device queries
- `idx_endpoints_protocol` - Filter by protocol
- `idx_endpoints_enabled` - Filter by status
- `idx_endpoints_device_protocol` - Composite queries
- `idx_endpoints_sync` - Sync status queries

---

## Data Flow Examples

### Example 1: User Adds Sensor

```typescript
// 1. User saves via API
POST /api/v1/devices/a24cd1ee/sensors
{
  "name": "modbus-sensor-1",
  "protocol": "modbus",
  "enabled": true,
  ...
}

// 2. API writes to config (desired state)
device_target_state.config.protocolAdapterDevices.push(sensor)
device_target_state.version = 43
device_target_state.needs_deployment = true

// 3. API syncs to table (immediate - for backward compatibility)
endpoints ← INSERT sensor (config_version=43)

// 4. Agent polls and deploys
GET /api/v1/device/:uuid/state
Agent receives config version 43 → deploys sensor

// 5. Agent reports current state (RECONCILIATION)
PATCH /api/v1/device/state
{
  config: { protocolAdapterDevices: [...all running sensors...] },
  version: 43
}

// 6. API reconciles table
endpoints ← UPDATE with agent's reality (config_version=43)

// 7. UI queries table
GET /api/v1/devices/:uuid/sensors
Returns: sensors actually running on agent
```

### Example 2: Agent Fails to Deploy

```typescript
// 1. User saves 3 sensors to config
device_target_state.config.protocolAdapterDevices = [sensor1, sensor2, sensor3]

// 2. Table shows 3 sensors (desired state)
endpoints: sensor1, sensor2, sensor3

// 3. Agent tries to deploy but sensor3 fails
Agent deploys: sensor1 ✅, sensor2 ✅, sensor3 ❌

// 4. Agent reports current state (only 2 running)
PATCH /api/v1/device/state
{
  config: { protocolAdapterDevices: [sensor1, sensor2] },
  version: 43
}

// 5. Reconciliation updates table
endpoints: sensor1, sensor2 (sensor3 removed)

// 6. UI shows reality
GET /api/v1/devices/:uuid/sensors
Returns: sensor1, sensor2 (UI shows actual deployed state)

// 7. Config still has 3 sensors (desired state)
device_target_state.config still has all 3
needs_deployment = true (drift detected)
```

### Example 3: Manual Agent Restart

```typescript
// 1. Agent restarts and reports initial state
PATCH /api/v1/device/state
{
  config: { protocolAdapterDevices: [...] },
  version: 40 (old version)
}

// 2. Reconciliation syncs table to old version
endpoints ← UPDATE to match agent's current reality (version 40)

// 3. Agent polls and sees newer config (version 43)
GET /api/v1/device/:uuid/state
Returns: config with version 43 (needs_deployment=true)

// 4. Agent deploys new config
Agent updates from version 40 → 43

// 5. Agent reports updated state
PATCH /api/v1/device/state
{
  config: { protocolAdapterDevices: [...new state...] },
  version: 43
}

// 6. Reconciliation syncs table to version 43
endpoints ← UPDATE to match agent's new reality (version 43)
```

---

## Benefits

### 1. **Truth Matters**
- Table shows what's **actually running**, not what's **desired**
- UI can't show sensors that failed to deploy
- Drift detection: compare config version vs table version

### 2. **Eventual Consistency**
- User saves → config updated immediately
- Table synced immediately (backward compat)
- Agent deploys → table reconciled with reality
- System self-heals over time

### 3. **Deployment Status Tracking**
- `config_version` in table vs `version` in target state
- If mismatch → deployment pending or failed
- If match → deployed successfully

### 4. **Fast Queries**
- UI reads from indexed table (not JSON parsing)
- Protocol filtering, status filtering all fast
- No need to parse `config` JSONB field

### 5. **Agent-Driven Accuracy**
- Agent is source of truth for "what's running"
- API doesn't assume deployment success
- Reconciliation handles failures gracefully

---

## Deployment Status Tracking

### ✅ IMPLEMENTED: Deployment Status Column

**Migration**: `041_add_sensor_deployment_status.sql`

**Schema**:
```sql
ALTER TABLE endpoints 
ADD COLUMN deployment_status VARCHAR(20) DEFAULT 'pending',
ADD COLUMN last_deployed_at TIMESTAMPTZ,
ADD COLUMN deployment_error TEXT,
ADD COLUMN deployment_attempts INTEGER DEFAULT 0;

-- Valid statuses: 'pending', 'deployed', 'failed', 'reconciling'
```

**Logic** (Implemented in `syncConfigToTable`):
```typescript
// When user saves sensor → status = 'pending'
const deploymentStatus = userId === 'agent-reconciliation' ? 'deployed' : 'pending';

// When agent reports current state → status = 'deployed'
await deviceSensorSync.syncCurrentStateToTable(uuid, currentState);
// ↑ This calls syncConfigToTable with userId='agent-reconciliation'
// ↑ Which sets deployment_status='deployed'
```

**API Response**:
```json
{
  "id": 123,
  "name": "modbus-sensor-1",
  "protocol": "modbus",
  "deploymentStatus": "deployed",
  "lastDeployedAt": "2025-11-02T10:30:00Z",
  "deploymentError": null,
  "deploymentAttempts": 0
}
```

### Optional: Add Drift Detection Event

```typescript
// In reconciliation
if (targetVersion !== currentVersion) {
  await eventPublisher.publish('device.config_drift', 'device', uuid, {
    target_version: targetVersion,
    current_version: currentVersion,
    drift_sensors: [...sensors not deployed...]
  });
}
```

### Optional: Manual Reconciliation Endpoint

```typescript
POST /api/v1/devices/:uuid/reconcile
// Force reconciliation without waiting for agent report
```

---

## Testing Strategy

### Test 1: User Saves Sensor
```bash
# Save sensor
curl -X POST http://localhost:3002/api/v1/devices/a24cd1ee/sensors \
  -H "Content-Type: application/json" \
  -d '{"name": "test-sensor", "protocol": "modbus", ...}'

# Verify in config
SELECT config FROM device_target_state WHERE device_uuid = 'a24cd1ee';

# Verify in table
SELECT * FROM endpoints WHERE device_uuid = 'a24cd1ee' AND name = 'test-sensor';
```

### Test 2: Agent Reports State
```bash
# Agent reports state
curl -X PATCH http://localhost:3002/api/v1/device/state \
  -H "Content-Type: application/json" \
  -d '{"a24cd1ee": {"config": {"protocolAdapterDevices": [...]}, "version": 42}}'

# Verify table updated
SELECT * FROM endpoints WHERE device_uuid = 'a24cd1ee';

# Check logs for reconciliation messages
# Should see: "🔄 Reconciling current state from agent for device a24cd1ee..."
```

### Test 3: Full Loop
```bash
# 1. Save sensor
POST /devices/:uuid/sensors

# 2. Check config version
SELECT version FROM device_target_state WHERE device_uuid = :uuid;

# 3. Agent polls
GET /device/:uuid/state

# 4. Agent reports after deployment
PATCH /device/state

# 5. Verify table matches agent reality
SELECT config_version FROM endpoints WHERE device_uuid = :uuid;
```

---

## Monitoring

### Metrics to Track

1. **Reconciliation Frequency**
   - How often agents report state
   - Average time between reports

2. **Config Drift**
   - Count of devices with `config_version` mismatch
   - Duration of drift before reconciliation

3. **Deployment Success Rate**
   - Sensors in config vs sensors in table
   - Failed deployments per device

4. **Sync Performance**
   - Time taken for `syncCurrentStateToTable()`
   - Number of sensors reconciled per call

### Log Messages

```
🔄 Reconciling current state from agent for device a24cd1ee...
  📊 Agent reports 3 running sensors (version 42)
  ✅ Updated: modbus-sensor-1 (modbus)
  ✅ Updated: can-sensor-2 (can)
  ➕ Inserted: opcua-sensor-3 (opcua)
✅ Reconciliation complete: agent reality → table (version 42)
```

---

## Summary

✅ **Implemented**: Complete Event Sourcing/CQRS pattern with reconciliation  
✅ **Pattern**: Config (write) → Agent (deploy) → Current State (reality) → Table (read)  
✅ **Key Method**: `syncCurrentStateToTable()` - reconciles agent reality to table  
✅ **Integration**: PATCH `/api/v1/device/state` endpoint calls reconciliation  
✅ **Read Model**: `getSensors()` now reads from table (deployed state)  
✅ **Write Model**: All CRUD operations write to config first (desired state)  

**Result**: Table always shows what's **actually running** on the agent, not just what's **desired** in config. UI gets fast queries and accurate deployment status.
