# Modbus Multi-Connection Support - Comprehensive Proposal

**Status**: Planning Phase (Implementation Rolled Back)  
**Created**: 2026-01-07  
**Author**: AI Assistant  
**Objective**: Enable Modbus protocol adapter to support multiple gateways/connections simultaneously

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Current Architecture Analysis](#current-architecture-analysis)
4. [Proposed Solution](#proposed-solution)
5. [Complete Impact Analysis](#complete-impact-analysis)
6. [Data Flow Diagrams](#data-flow-diagrams)
7. [Configuration Examples](#configuration-examples)
8. [Migration Strategy](#migration-strategy)
9. [Testing Requirements](#testing-requirements)
10. [Implementation Phases](#implementation-phases)
11. [Risk Assessment](#risk-assessment)
12. [Open Questions](#open-questions)
13. [References](#references)

---

## Executive Summary

### Problem
The current Modbus implementation only supports a **single connection** (one IP:port combination). Users with multiple Modbus gateways (e.g., multiple generators at different IPs) cannot discover or monitor all devices from a single agent instance.

### Proposed Solution
Introduce a `connections[]` array in the Modbus configuration, allowing users to define multiple gateways with per-connection settings (profile, addressing, points). The system will:
- Discover devices across all connections
- Maintain backward compatibility with single-connection config
- Preserve device identity across connections via connection metadata
- Support per-connection profile overrides

### Scope
This change affects **6 major components** across agent and API:

**Agent-side** (4 components):
1. **Configuration Layer** - Config parsing and validation
2. **Discovery** - Multi-connection scanning
3. **Adapter** - Device configuration generation
4. **Reconciler** - State synchronization (local SQLite)

**API-side** (2 components):
5. **State Sync Handler** - Process device state reports from agent
6. **PostgreSQL Schema** - `endpoints` table metadata column

**Note**: MQTT Publishing is **NOT impacted** - all connections write to the same protocol-level socket (`/tmp/modbus.sock`) and publish to the same topic. Connection metadata is transparent to the publishing layer.

### Risks
- **Medium**: Adapter configuration mismatch between discovery output and expected input
- **Medium**: State sync may not preserve connection metadata (agent + API)
- **Low**: API schema migration for `endpoints` table (additive column)
- **Low**: Performance impact of sequential multi-connection scanning

### Recommendation
**Proceed with phased implementation** after comprehensive planning documented in this proposal.

---

## Problem Statement

### Current Limitation

Users with **multiple Modbus gateways** cannot discover or monitor all devices:

**Example Scenario**:
- Site has 3 diesel generators
- Generator 1: `10.0.0.60:502` (COMAP controller)
- Generator 2: `10.0.0.61:502` (COMAP controller)
- Generator 3: `10.0.0.62:502` (COMAP controller)

**Current Workaround**:
- Deploy 3 separate agent instances (one per generator)
- Manual configuration duplication
- Increased infrastructure complexity

**Desired State**:
- Single agent instance discovers all 3 generators
- Shared profile configuration (COMAP)
- Per-connection addressing if needed

### User Request Quote

> "how to add one more modbus device ... will profile be applicable for all in case different gateway?"

User wants:
1. Add second Modbus connection (`10.0.0.60:503`)
2. Share same profile (COMAP) across both connections
3. Automatic discovery and registration

---

## Current Architecture Analysis

### 1. Configuration Layer

**File**: `agent/src/config/agent-config.ts`

**Current Structure**:
```typescript
interface ModbusConfig {
  enabled: boolean;
  tcpHost: string;        // Single IP only
  tcpPort: number;        // Single port only
  slaveRangeStart: number;
  slaveRangeEnd: number;
  timeout: number;
  profile: string;
  profileDataPoints?: any[];
}
```

**Current Behavior**:
- `getModbusConfig()` parses single connection from `protocols.modbus.connection`
- Fallback to legacy fields (`tcpHost`, `tcpPort`)
- No array support

**Limitations**:
- Hard-coded single connection assumption
- No connection-level metadata
- No per-connection overrides

### 2. Discovery Layer

**File**: `agent/src/features/discovery/modbus.discovery.ts`

**Current Flow**:
1. `discover()` - Opens single Modbus connection
2. Scans slave IDs (1-10 by default)
3. Creates `DiscoveredDevice` for each responding slave
4. Stores profile in `metadata.profile`

**Current Device Structure**:
```typescript
{
  name: "modbus_slave_1",
  protocol: "modbus",
  connection: { type: "tcp", host: "10.0.0.60", port: 502, slaveId: 1 },
  dataPoints: [...],
  metadata: {
    slaveId: 1,
    profile: "COMAP"
  }
}
```

**Limitations**:
- Single call to `openConnection()` with one IP
- No connection naming/tracking
- No concept of "connection identity"

### 3. Adapter Layer

**File**: `agent/src/features/endpoints/modbus/adapter.ts`

**Expected Input**:
```typescript
interface ModbusAdapterConfig {
  devices: Array<{
    deviceName: string;
    connection: { host: string; port: number; slaveId: number };
    registers: Array<{ name: string; address: number; functionCode: number; dataType: string }>;
  }>;
}
```

**Current Behavior**:
- Adapter expects `config.devices[]` array
- Each device has embedded connection config
- **CRITICAL**: Discovery output does NOT match this structure

**Gap Identified**:
```
Discovery Output                Adapter Expects
─────────────────               ───────────────
per-connection devices    !=    device-centric config
(connectionName metadata)       (embedded connection)
```

### 4. Reconciler Layer

**File**: `agent/src/device-manager/reconciler.ts`

**Current Behavior**:
- Syncs discovered devices to endpoints table
- Compares fingerprints for identity matching
- Preserves endpoint UUID on re-discovery

**Unknown Behavior**:
- How does reconciler handle connection metadata?
- Does it preserve `metadata.connectionName` field?
- What happens when connection info changes?

**Critical Question**:
Will reconciliation preserve connection association when device moves between connections?

### 5. Endpoint Registration

**File**: `agent/src/features/endpoints/index.ts`

**Current Behavior**:
- `SensorsFeature.startModbusAdapter()` loads config from database
- Creates `ModbusAdapter` instance with device config
- Starts socket server for data routing

**Current Database Schema** (`endpoints` table):
```sql
CREATE TABLE endpoints (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  connection JSON NOT NULL,   -- { type, host, port, slaveId }
  data_points JSON NOT NULL,  -- Array of point definitions
  metadata JSON               -- { slaveId, profile, ... }
);
```

**Schema Question**:
- Is `metadata.connectionName` preserved in database?
- Does `connection` field uniquely identify devices?
- How to differentiate same slave ID on different connections?

### 6. API State Sync

**Files**: 
- `api/src/routes/cloud.ts` - State report endpoint
- `api/src/models/device-sensor.model.ts` - PostgreSQL ORM

**Current Behavior**:
- Agent sends state reports to cloud API: `PATCH /api/cloud/devices/:uuid/state`
- API updates `endpoints` table in PostgreSQL
- Syncs endpoint data: name, protocol, connection, data_points, metadata

**Current Schema** (`endpoints` table):
```sql
CREATE TABLE endpoints (
  id SERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  protocol VARCHAR(50) NOT NULL,
  connection JSONB NOT NULL,   -- { type, host, port, slaveId }
  data_points JSONB NOT NULL,
  metadata JSONB,              -- { slaveId, profile }
  last_seen TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Critical Question**:
- Does API preserve `metadata.connectionName` from agent state reports?
- Is JSONB column flexible enough (yes, but needs explicit handling)?

**Impact**:
If API doesn't preserve `connectionName`, metadata will be lost when:
1. Agent reports state to API
2. API updates `endpoints` table
3. Dashboard queries devices (loses connection context)

---

### 7. MQTT Publishing

**File**: `agent/src/features/sensor-publish/publish.ts`

**Current Architecture**:
```
ModbusAdapter (all connections) → /tmp/modbus.sock → Sensor → sensors/modbus/data
```

**Multi-Connection Impact**: ✅ **NONE** - Transparent to publishing layer

**Why No Changes Needed**:
- All Modbus devices (regardless of connection) write to **same Unix socket** (`/tmp/modbus.sock`)
- Sensor reads from socket and publishes to **protocol-level topic** (`sensors/modbus/data`)
- Connection distinction only matters for discovery/adapter, not publishing
- Topic structure remains unchanged
- No breaking changes to MQTT consumers

**Optional Enhancement** (Not Required):
If users want connection-level filtering in MQTT payloads, could add `connectionName` field:
```typescript
// Optional - only if needed by downstream consumers
const publishData = {
  sensor: this.getSensorName(),
  connectionName: this.metadata?.connectionName,  // Optional
  messages: this.messageBatch.messages
};
```

**Recommendation**: Skip for MVP - add only if users request connection-aware filtering

---

## Proposed Solution

### 1. Configuration Pattern

**Root-level shared settings** + **Per-connection overrides**

```json
{
  "protocols": {
    "modbus": {
      "enabled": true,
      "profile": "COMAP",          // Default for all connections
      "bufferCapacity": 131072,
      "addressing": {
        "slaveRange": { "start": 1, "end": 10 }  // Default
      },
      "points": { ... },            // Shared points
      "connections": [
        {
          "name": "comap-gen-502",  // Required: Connection identifier
          "host": "10.0.0.60",
          "port": 502,
          "timeoutMs": 2000,
          "profile": "COMAP",        // Optional: Override root profile
          "addressing": {            // Optional: Override root addressing
            "slaveRange": { "start": 1, "end": 5 }
          },
          "points": { ... }          // Optional: Override root points
        },
        {
          "name": "comap-gen-503",
          "host": "10.0.0.60",
          "port": 503,
          "timeoutMs": 2000
          // Uses root profile, addressing, points
        }
      ]
    }
  }
}
```

**Priority Resolution**:
1. Connection-specific setting (highest)
2. Root-level setting
3. Hardcoded default (fallback)

**Example**:
```
Connection "comap-gen-502" profile:
  conn.profile → "COMAP" (explicit override)

Connection "comap-gen-503" profile:
  No conn.profile → root.profile → "COMAP"
```

### 2. Discovery Enhancement

**Multi-Connection Scanning**:
```typescript
async discover(options?: ModbusDiscoveryOptions): Promise<DiscoveredDevice[]> {
  const modbusConfig = this.agentConfig?.getModbusConfig();
  
  // Multi-connection mode detection
  if (modbusConfig?.connections?.length > 0) {
    const allDiscovered: DiscoveredDevice[] = [];
    
    // Sequential scanning (industrial safety - avoid bus contention)
    for (const conn of modbusConfig.connections) {
      const connOptions = {
        tcpHost: conn.host,
        tcpPort: conn.port,
        timeout: conn.timeoutMs,
        slaveIdRange: conn.addressing?.slaveRange || [1, 10]
      };
      
      const profile = conn.profile || modbusConfig.profile;
      const dataPoints = conn.points || modbusConfig.points;
      
      const discovered = await this.discoverOnBus(
        connOptions, 
        profile, 
        dataPoints, 
        conn.name  // Pass connection name
      );
      
      allDiscovered.push(...discovered);
    }
    
    return allDiscovered;
  }
  
  // Legacy single-connection mode (backward compat)
  return this.discoverOnBus(legacyOptions, profile, dataPoints);
}
```

**Device Naming**:
```
Connection Name      Slave ID    Device Name
─────────────────    ────────    ─────────────────────
comap-gen-502        1           comap-gen-502_slave_1
comap-gen-502        2           comap-gen-502_slave_2
comap-gen-503        1           comap-gen-503_slave_1
```

**Metadata Enhancement**:
```typescript
metadata: {
  slaveId: 1,
  profile: "COMAP",
  connectionName: "comap-gen-502"  // NEW: Track connection association
}
```

### 3. Adapter Configuration Generation

**Problem**: Discovery creates per-connection devices, but adapter expects device-centric config

**Solution Option A: Auto-Generation** (Recommended)
```typescript
// In endpoints/index.ts: startModbusAdapter()

// Load discovered endpoints from database
const endpoints = await EndpointModel.findByProtocol('modbus');

// Transform to adapter format
const modbusConfig: ModbusAdapterConfig = {
  devices: endpoints.map(endpoint => ({
    deviceName: endpoint.name,
    connection: endpoint.connection,  // Already has { host, port, slaveId }
    registers: endpoint.data_points.map(point => ({
      name: point.name,
      address: point.address,
      functionCode: point.functionCode || typeToFunctionCode(point.type),
      dataType: point.dataType,
      count: point.count || 1
    }))
  }))
};

const adapter = new ModbusAdapter(modbusConfig, this.logger);
```

**Solution Option B: Manual Config** (Not recommended)
- Require users to manually configure adapter separately from discovery
- More complex, error-prone
- Lose benefits of automatic discovery

**Recommendation**: Option A - Auto-generate adapter config from discovered endpoints

### 4. Reconciler Enhancements

**Preserve Connection Metadata**:
```typescript
// In reconciler
const updatedEndpoint = {
  ...existingEndpoint,
  connection: discoveredDevice.connection,  // Update connection info
  metadata: {
    ...existingEndpoint.metadata,
    connectionName: discoveredDevice.metadata.connectionName  // Preserve
  }
};
```

**Connection Change Detection**:
- If `metadata.connectionName` changes → log warning
- Preserve endpoint UUID (fingerprint-based)
- Update connection info in database

### 5. MQTT Topic Strategy

**Option A: Device-centric** (Current - No Change)
```
sensors/<device-uuid>/data

Payload:
{
  sensor: "modbus_slave_1",
  timestamp: "...",
  messages: [...]
}
```

**Option B: Connection-aware** (Alternative)
```
sensors/<device-uuid>/<connection-name>/data

Payload includes connectionName:
{
  sensor: "modbus_slave_1",
  connectionName: "comap-gen-502",
  timestamp: "...",
  messages: [...]
}
```

**Recommendation**: Option A (no topic change), add `connectionName` to payload metadata

**Implementation**:
```typescript
// In publish.ts
const publishData = {
  sensor: this.getSensorName(),
  connectionName: this.getConnectionName(),  // NEW
  timestamp: new Date().toISOString(),
  messages: this.messageBatch.messages
};
```

---

## Complete Impact Analysis

### Component 1: Configuration Layer (`agent-config.ts`)

**Changes Required**:
1. Add `ModbusConnectionConfig` interface
2. Update `ModbusConfig` interface:
   - Add `connections?: ModbusConnectionConfig[]`
   - Make legacy fields optional (`tcpHost?`, `tcpPort?`)
3. Update `getModbusConfig()` method:
   - Parse `connections[]` array
   - Apply override resolution logic
   - Maintain backward compatibility

**Breaking Changes**: ❌ None (backward compatible)

**Testing Needs**:
- [ ] Parse legacy single connection
- [ ] Parse multi-connection array
- [ ] Profile override resolution
- [ ] Points override resolution
- [ ] Addressing override resolution

**Lines of Code**: ~50 lines added

**Complexity**: 🟢 Low

---

### Component 2: Discovery Layer (`modbus.discovery.ts`)

**Changes Required**:
1. Add `discoverOnBus()` helper method (extracts per-connection logic)
2. Update `discover()` method:
   - Detect multi-connection mode
   - Loop through connections sequentially
   - Pass connection name to helper
3. Update device metadata:
   - Add `connectionName` field

**Breaking Changes**: ❌ None (backward compatible)

**Testing Needs**:
- [ ] Single connection discovery (legacy)
- [ ] Multi-connection discovery
- [ ] Connection name in metadata
- [ ] Profile per connection
- [ ] Sequential scanning order

**Lines of Code**: ~90 lines added

**Complexity**: 🟡 Medium

---

### Component 3: Adapter Layer (`endpoints/index.ts`)

**Changes Required**:
1. **Auto-generate adapter config** from discovered endpoints:
   ```typescript
   const endpoints = await EndpointModel.findByProtocol('modbus');
   const modbusConfig = {
     devices: endpoints.map(ep => ({
       deviceName: ep.name,
       connection: ep.connection,
       registers: ep.data_points.map(transformToRegister)
     }))
   };
   ```

2. **Type resolution**: Convert `point.type` → `functionCode` if missing:
   ```typescript
   functionCode: point.functionCode ?? typeMap[point.type?.toLowerCase()] ?? 3
   ```

**Breaking Changes**: ❌ None (backward compatible - auto-generation is transparent)

**Testing Needs**:
- [ ] Auto-generation from single device
- [ ] Auto-generation from multi-connection devices
- [ ] Type → functionCode fallback
- [ ] Connection info preserved
- [ ] Device name matching

**Lines of Code**: ~30 lines modified

**Complexity**: 🟡 Medium

**Risk**: 🟡 Medium - Mismatch between discovery and adapter expected format

---

### Component 4: Reconciler Layer (`reconciler.ts`)

**Changes Required**:
1. **Preserve connection metadata** during updates:
   ```typescript
   metadata: {
     ...existingEndpoint.metadata,
     connectionName: discoveredDevice.metadata.connectionName
   }
   ```

2. **Connection change detection**:
   ```typescript
   if (existingEndpoint.metadata.connectionName !== discoveredDevice.metadata.connectionName) {
     logger.warn('Device connection changed', {
       oldConnection: existingEndpoint.metadata.connectionName,
       newConnection: discoveredDevice.metadata.connectionName
     });
   }
   ```

**Breaking Changes**: ❌ None (new metadata field)

**Testing Needs**:
- [ ] New device creation with connectionName
- [ ] Existing device update preserves connectionName
- [ ] Connection change detection logs warning
- [ ] Fingerprint-based identity preserved

**Lines of Code**: ~20 lines added

**Complexity**: 🟢 Low

---

### Component 5: Database Schema (`endpoints` table)

**Changes Required**: ❌ None

**Reason**: `metadata` column is JSON - already supports arbitrary fields

**Verification**:
```sql
-- Check existing schema
SELECT sql FROM sqlite_master WHERE name = 'endpoints';

-- Verify metadata field is JSON
SELECT metadata FROM endpoints WHERE protocol = 'modbus' LIMIT 1;
```

**Testing Needs**:
- [ ] Store `metadata.connectionName`
- [ ] Query by connectionName
- [ ] JSON field supports new structure

**Lines of Code**: 0 (no migration needed)

**Complexity**: 🟢 None

---

### Component 6: API State Sync (`api/src/routes/cloud.ts`)

**Changes Required**:
1. **Preserve connection metadata** in state report handler:
   ```typescript
   // In PATCH /api/cloud/devices/:uuid/state
   await DeviceSensorModel.upsert({
     device_uuid: uuid,
     name: reportedState.name,
     protocol: reportedState.protocol,
     connection: reportedState.connection,
     data_points: reportedState.data_points,
     metadata: {
       ...existingMetadata,
       ...reportedState.metadata,  // Preserve connectionName
       slaveId: reportedState.metadata?.slaveId,
       profile: reportedState.metadata?.profile,
       connectionName: reportedState.metadata?.connectionName  // NEW
     },
     last_seen: new Date()
   });
   ```

2. **Validation** (optional but recommended):
   ```typescript
   // Validate connectionName format
   if (metadata.connectionName && !/^[a-z0-9-]+$/.test(metadata.connectionName)) {
     throw new Error('Invalid connectionName format');
   }
   ```

**Schema Migration**: ❌ None (JSONB already supports arbitrary fields)

**Breaking Changes**: ❌ None (additive)

**Testing Needs**:
- [ ] State report with connectionName preserved
- [ ] Existing devices without connectionName (backward compat)
- [ ] Query devices by connectionName
- [ ] Dashboard displays connection metadata

**Lines of Code**: ~15 lines modified

**Complexity**: 🟢 Low

**Risk**: 🟢 Low - JSONB column already flexible, just ensure explicit preservation

---

### Component 7: MQTT Publishing (`publish.ts`)

**Changes Required**: ❌ **NONE**

**Reason**: Multi-connection support is **transparent** to publishing layer

**Architecture**:
```
All Modbus Connections → Same Unix Socket → Same MQTT Topic
  conn1 (10.0.0.60:502) ─┐
  conn2 (10.0.0.60:503) ─┤
  conn3 (10.0.0.61:502) ─┴→ /tmp/modbus.sock → sensors/modbus/data
```

**Why No Changes**:
- Socket Server doesn't differentiate connections
- All Modbus data batched together
- Topic is protocol-level, not connection-level
- Connection metadata only relevant for discovery/adapter

**Optional Enhancement** (Deferred):
If users need connection-aware filtering, could add optional `connectionName` field to payload. Skip for MVP.

**Breaking Changes**: ❌ None

**Testing Needs**: ❌ None (no changes)

**Lines of Code**: 0

**Complexity**: 🟢 None

---

### Summary Table

| Component | LOC Change | Complexity | Breaking | Risk |
|-----------|------------|------------|----------|------|
| **Agent Components** |
| agent-config.ts | +50 | 🟢 Low | ❌ No | 🟢 Low |
| modbus.discovery.ts | +90 | 🟡 Medium | ❌ No | 🟡 Medium |
| endpoints/index.ts | ~30 | 🟡 Medium | ❌ No | 🟡 Medium |
| reconciler.ts | +20 | 🟢 Low | ❌ No | 🟢 Low |
| Agent DB Schema (SQLite) | 0 | 🟢 None | ❌ No | 🟢 None |
| publish.ts | 0 | 🟢 None | ❌ No | 🟢 None |
| **API Components** |
| api/routes/cloud.ts | +15 | 🟢 Low | ❌ No | 🟢 Low |
| API DB Schema (PostgreSQL) | 0 | 🟢 None | ❌ No | 🟢 None |
| **TOTAL** | **~205** | **🟡 Medium** | **❌ None** | **🟡 Medium** |

---

## Data Flow Diagrams

### Current Architecture (Single Connection)

```
┌─────────────────┐
│ Target State    │
│  (Cloud API)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ AgentConfig     │ ◄── Parses modbus.connection
│ getModbusConfig │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Discovery       │ ◄── Scans single IP:port
│ discover()      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Discovered      │ ◄── Device per slave ID
│ Devices         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Reconciler      │ ◄── Syncs to endpoints table
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Endpoints DB    │ ◄── Stores discovered devices
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ SensorsFeature  │ ◄── Loads endpoints
│ startModbus()   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ModbusAdapter   │ ◄── EXPECTS device-centric config
│                 │     ⚠️ GAP: Discovery output ≠ expected input
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Socket Server   │ ◄── Writes data points
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Sensor (Publish)│ ◄── Reads from socket
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MQTT Broker     │ ◄── Publishes to sensors/<uuid>/data
│                 │
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ Agent CloudSync │ ◄── Reports state to API
│                 │     PATCH /api/cloud/devices/:uuid/state
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ API State       │ ◄── Updates endpoints table
│ Handler         │     ⚠️ Must preserve metadata.connectionName
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ PostgreSQL      │ ◄── endpoints table (JSONB metadata)
│ (Cloud DB)      │
└─────────────────┘
```

### Proposed Architecture (Multi-Connection)

```
┌─────────────────┐
│ Target State    │
│  (Cloud API)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ AgentConfig     │ ◄── Parses modbus.connections[]
│ getModbusConfig │     Returns array of ConnectionConfig
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Discovery       │ ◄── Loops through connections[]
│ discover()      │     Sequential scanning per connection
│   ├─ Loop       │
│   │  ├─ discoverOnBus(conn1) ──┐
│   │  ├─ discoverOnBus(conn2)   │
│   │  └─ discoverOnBus(conn3)   │
└───┴──────────────┘              │
         │                        │
         ▼                        │
┌─────────────────────────────────┘
│ Discovered Devices
│ [
│   {name: "conn1_slave_1", metadata: {connectionName: "conn1"}},
│   {name: "conn1_slave_2", metadata: {connectionName: "conn1"}},
│   {name: "conn2_slave_1", metadata: {connectionName: "conn2"}}
│ ]
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Reconciler      │ ◄── Preserves metadata.connectionName
│                 │     Updates connection info if changed
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Endpoints DB    │ ◄── Stores with connectionName
│ JSON metadata   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ SensorsFeature  │ ◄── Auto-generates adapter config
│ startModbus()   │     from endpoints (NEW LOGIC)
│   │             │
│   └─ Transform: │
│      endpoints.map(ep => ({
│        deviceName: ep.name,
│        connection: ep.connection,
│        registers: ep.data_points.map(...)
│      }))
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ModbusAdapter   │ ◄── Receives auto-generated config
│                 │     ✅ Format matches expectations
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Socket Server   │ ◄── Writes data points (unchanged)
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Sensor (Publish)│ ◄── Adds connectionName to payload
│                 │     {sensor, connectionName, messages}
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MQTT Broker     │ ◄── Topic: sensors/<uuid>/data (unchanged)
│                 │     Payload includes connectionName
└─────────────────┘
         │
         ▼
┌─────────────────┐
│ Agent CloudSync │ ◄── Reports state with metadata.connectionName
│                 │     PATCH /api/cloud/devices/:uuid/state
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ API State       │ ◄── Preserves metadata.connectionName
│ Handler         │     Updates endpoints table
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ PostgreSQL      │ ◄── Stores connectionName in JSONB metadata
│ (Cloud DB)      │     {slaveId, profile, connectionName}
└─────────────────┘
```

### Key Changes Highlighted

1. **Config Parsing**: `connections[]` array instead of single object
2. **Discovery**: Sequential loop through connections, adds `connectionName` to metadata
3. **Reconciler**: Preserves `metadata.connectionName` during updates (agent SQLite)
4. **Adapter Startup**: **Auto-generates config** from endpoints (CRITICAL FIX)
5. **API State Sync**: Preserves `metadata.connectionName` in PostgreSQL
6. **MQTT Publishing**: No changes (transparent to publishing layer)

---

## Configuration Examples

### Example 1: Legacy Single Connection (Backward Compat)

**Cloud Target State** (`test.json`):
```json
{
  "protocols": {
    "modbus": {
      "enabled": true,
      "profile": "COMAP",
      "connection": {
        "host": "10.0.0.60",
        "port": 502,
        "timeoutMs": 2000
      },
      "addressing": {
        "slaveRange": { "start": 1, "end": 10 }
      },
      "points": { ... }
    }
  }
}
```

**Behavior**: Works exactly as before (no changes)

---

### Example 2: Multi-Connection with Shared Profile

**Cloud Target State**:
```json
{
  "protocols": {
    "modbus": {
      "enabled": true,
      "profile": "COMAP",          // Shared profile
      "addressing": {
        "slaveRange": { "start": 1, "end": 10 }  // Shared addressing
      },
      "points": { ... },            // Shared points
      "connections": [
        {
          "name": "comap-gen-502",
          "host": "10.0.0.60",
          "port": 502,
          "timeoutMs": 2000
        },
        {
          "name": "comap-gen-503",
          "host": "10.0.0.60",
          "port": 503,
          "timeoutMs": 2000
        },
        {
          "name": "comap-gen-504",
          "host": "10.0.0.60",
          "port": 504,
          "timeoutMs": 2000
        }
      ]
    }
  }
}
```

**Discovered Devices**:
```
comap-gen-502_slave_1  (10.0.0.60:502, slaveId=1, profile=COMAP)
comap-gen-502_slave_2  (10.0.0.60:502, slaveId=2, profile=COMAP)
comap-gen-503_slave_1  (10.0.0.60:503, slaveId=1, profile=COMAP)
comap-gen-504_slave_1  (10.0.0.60:504, slaveId=1, profile=COMAP)
```

---

### Example 3: Multi-Connection with Per-Connection Overrides

**Cloud Target State**:
```json
{
  "protocols": {
    "modbus": {
      "enabled": true,
      "profile": "GENERIC",         // Default profile
      "addressing": {
        "slaveRange": { "start": 1, "end": 10 }
      },
      "connections": [
        {
          "name": "comap-gen-502",
          "host": "10.0.0.60",
          "port": 502,
          "profile": "COMAP",        // Override: Use COMAP profile
          "addressing": {
            "slaveRange": { "start": 1, "end": 5 }  // Smaller range
          }
        },
        {
          "name": "deepsea-gen-503",
          "host": "10.0.0.61",
          "port": 502,
          "profile": "DEEPSEA",      // Override: Different profile
          "addressing": {
            "slaveRange": { "start": 10, "end": 15 }  // Different range
          }
        },
        {
          "name": "generic-plc",
          "host": "10.0.0.62",
          "port": 502
          // Uses default profile (GENERIC) and addressing (1-10)
        }
      ]
    }
  }
}
```

**Resolution**:
```
Connection "comap-gen-502":
  profile: "COMAP" (override)
  addressing: 1-5 (override)

Connection "deepsea-gen-503":
  profile: "DEEPSEA" (override)
  addressing: 10-15 (override)

Connection "generic-plc":
  profile: "GENERIC" (root default)
  addressing: 1-10 (root default)
```

---

## Migration Strategy

### Phase 1: Non-Breaking Foundation (Week 1)

**Goal**: Add multi-connection support without breaking existing deployments

**Tasks**:
1. ✅ Update `ModbusConfig` interface (add `connections?` optional field)
2. ✅ Update `getModbusConfig()` to parse connections array
3. ✅ Add `discoverOnBus()` helper in discovery
4. ✅ Update `discover()` to detect and loop connections
5. ✅ Add `metadata.connectionName` field

**Testing**:
- Existing single-connection configs continue working
- New connections array parsed correctly
- Connection name appears in metadata

**Rollout**: Cloud API update (push new target state format)

---

### Phase 2: Adapter Auto-Configuration (Week 2)

**Goal**: Bridge gap between discovery output and adapter expected input

**Tasks**:
1. Implement auto-generation in `SensorsFeature.startModbusAdapter()`
2. Load endpoints from database
3. Transform to `ModbusAdapterConfig` format
4. Add type → functionCode fallback logic

**Testing**:
- Auto-generated config matches adapter expectations
- Multi-connection devices load correctly
- Adapter starts without errors

**Risk Mitigation**:
- Feature flag: `ENABLE_ADAPTER_AUTO_CONFIG=true`
- Fallback to manual config if auto-gen fails

---

### Phase 3: Reconciler & API Sync (Week 3)

**Goal**: Complete data flow end-to-end (agent + cloud)

**Tasks**:
1. Update agent reconciler to preserve `metadata.connectionName` (SQLite)
2. Add connection change detection logging (agent)
3. **Update API state sync handler** to preserve `metadata.connectionName` (PostgreSQL)
4. Add API validation for connectionName format (optional)
5. Test full pipeline: Config → Discovery → Reconcile → Adapter → State Report → API → PostgreSQL

**Testing**:
- connectionName preserved through agent reconciliation (SQLite)
- connectionName preserved through API state sync (PostgreSQL)
- Dashboard queries show connection metadata
- No duplicate device creation
- Backward compat: devices without connectionName still work

---

### Phase 4: Integration Testing (Week 4)

**Goal**: Validate across all scenarios

**Test Scenarios**:
1. **Legacy Single Connection**: Backward compatibility
2. **Multi-Connection Shared Profile**: 3 generators, same profile
3. **Multi-Connection Per-Profile**: Mixed vendor gateways
4. **Connection Change**: Device moves to different IP
5. **Profile Change**: Update profile, verify re-discovery
6. **Failover**: One connection offline, others continue

**Acceptance Criteria**:
- ✅ All devices discovered across all connections
- ✅ Data published to MQTT from all devices
- ✅ Connection metadata preserved in database
- ✅ No breaking changes to existing deployments
- ✅ Performance acceptable (sequential scanning < 30s per connection)

---

### Phase 5: Documentation & Rollout (Week 5)

**Tasks**:
1. Update configuration documentation
2. Create migration guide for existing users
3. Add examples to README
4. Update API docs with new fields
5. Deploy to production

**Migration Path for Users**:
```markdown
# Migrating to Multi-Connection Modbus

## Before (Single Connection)
```json
{
  "modbus": {
    "connection": { "host": "10.0.0.60", "port": 502 }
  }
}
```

## After (Multi-Connection)
```json
{
  "modbus": {
    "connections": [
      { "name": "gen-502", "host": "10.0.0.60", "port": 502 },
      { "name": "gen-503", "host": "10.0.0.60", "port": 503 }
    ]
  }
}
```

## Backward Compatibility
✅ Old format still works - no action required
✅ Upgrade when you need multi-connection support
```

---

## Testing Requirements

### Unit Tests

**File**: `agent/test/unit/config/agent-config.test.ts`

Test Cases:
- [ ] Parse legacy single connection
- [ ] Parse multi-connection array
- [ ] Profile override resolution
- [ ] Points override resolution
- [ ] Addressing override resolution
- [ ] Empty connections array handling
- [ ] Missing connection name handling

**File**: `agent/test/unit/discovery/modbus.discovery.test.ts`

Test Cases:
- [ ] Single connection discovery (legacy)
- [ ] Multi-connection discovery
- [ ] Sequential scanning order
- [ ] Connection name in metadata
- [ ] Per-connection profile
- [ ] Per-connection addressing
- [ ] Per-connection points override

**File**: `agent/test/unit/endpoints/sensors-feature.test.ts`

Test Cases:
- [ ] Auto-generate adapter config from endpoints
- [ ] Type → functionCode fallback
- [ ] Empty endpoints array handling
- [ ] Connection info preservation

---

### Integration Tests

**File**: `agent/test/integration/modbus-multi-connection.test.ts`

Test Scenarios:
1. **Multi-Connection Discovery**:
   - Spin up 2 Modbus simulators (ports 502, 503)
   - Configure connections array
   - Run discovery
   - Verify 2 devices discovered
   - Check connection names in metadata

2. **Adapter Auto-Configuration**:
   - Load discovered endpoints
   - Auto-generate adapter config
   - Start adapter
   - Verify data points published

3. **End-to-End Flow**:
   - Config → Discovery → Reconcile → Adapter → Publish
   - Verify MQTT payload includes connectionName
   - Check database has correct metadata

4. **Backward Compatibility**:
   - Use legacy single connection config
   - Run discovery
   - Verify single device discovered
   - Check no connectionName in metadata (undefined)

5. **Connection Failover**:
   - Stop one simulator
   - Run discovery
   - Verify other connection still works
   - Check failed connection logged

---

### Performance Tests

**Metrics**:
- Discovery time per connection: < 10s
- Total discovery time (3 connections): < 30s
- Memory overhead: < 50MB per connection
- CPU usage during discovery: < 30%

**Load Test**:
- 10 connections
- 10 slaves per connection
- Total: 100 devices
- Expected: Complete discovery in < 2 minutes

---

## Implementation Phases

### Phase 1: Configuration & Discovery (Week 1) - ✅ COMPLETED (Rolled Back)

**Status**: Implementation completed, then rolled back for proper planning

**Completed Work**:
- ✅ `ModbusConnectionConfig` interface
- ✅ Updated `ModbusConfig` interface
- ✅ `getModbusConfig()` parsing logic
- ✅ `discoverOnBus()` helper method
- ✅ Multi-connection detection in `discover()`
- ✅ Connection name in metadata

**Rollback Reason**: Discovered adapter configuration mismatch mid-implementation

**Next Steps**:
1. Review proposal (this document)
2. Plan adapter auto-configuration strategy
3. Re-implement with full end-to-end testing

---

### Phase 2: Adapter Integration (Week 2) - ⏳ PENDING

**Tasks**:
- [ ] Implement auto-generation in `startModbusAdapter()`
- [ ] Add type → functionCode fallback
- [ ] Test adapter startup with multi-connection devices
- [ ] Verify data collection from all connections

**Acceptance Criteria**:
- Auto-generated config matches adapter expectations
- No manual configuration required
- All devices publish data

---

### Phase 3: Reconciler & Publishing (Week 3) - ⏳ PENDING

**Tasks**:
- [ ] Update reconciler to preserve connectionName
- [ ] Add connection change detection
- [ ] Update publish.ts payload
- [ ] Test MQTT message structure

**Acceptance Criteria**:
- connectionName preserved through sync
- MQTT messages include connection context
- No breaking changes to consumers

---

### Phase 4: Testing & Validation (Week 4) - ⏳ PENDING

**Tasks**:
- [ ] Write unit tests for all components
- [ ] Create integration test suite
- [ ] Performance testing with multiple connections
- [ ] Backward compatibility verification

**Acceptance Criteria**:
- 90%+ test coverage for new code
- All integration tests passing
- Performance within acceptable limits

---

### Phase 5: Documentation & Deployment (Week 5) - ⏳ PENDING

**Tasks**:
- [ ] Update configuration docs
- [ ] Create migration guide
- [ ] Add examples to README
- [ ] Deploy to staging
- [ ] Production rollout

**Acceptance Criteria**:
- Documentation complete
- Migration path clear
- Zero downtime deployment

---

## Risk Assessment

### High Risks

None identified - backward compatibility maintained throughout

### Medium Risks

**Risk 1: Adapter Configuration Mismatch**
- **Probability**: 🟡 Medium
- **Impact**: High (prevents data collection)
- **Mitigation**: Auto-generation from endpoints (proposed solution)
- **Contingency**: Manual config option as fallback

**Risk 2: State Sync Issues**
- **Probability**: 🟡 Medium
- **Impact**: Medium (duplicate devices or lost metadata)
- **Mitigation**: Preserve connectionName in reconciler
- **Contingency**: Manual database cleanup if needed

**Risk 3: Performance Impact**
- **Probability**: 🟡 Medium
- **Impact**: Low (slower discovery with many connections)
- **Mitigation**: Sequential scanning (already designed)
- **Contingency**: Parallel scanning option (future enhancement)

### Low Risks

**Risk 4: MQTT Consumer Breaking Changes**
- **Probability**: 🟢 Low
- **Impact**: Low (additive field only)
- **Mitigation**: connectionName is optional field
- **Contingency**: Legacy consumers ignore new field

**Risk 5: Database Schema Incompatibility**
- **Probability**: 🟢 Low
- **Impact**: None (JSON metadata supports new field)
- **Mitigation**: No migration needed
- **Contingency**: N/A

---

## Open Questions

### Q1: Concurrent vs Sequential Scanning

**Question**: Should connections be scanned in parallel for faster discovery?

**Options**:
- **A. Sequential** (current proposal):
  - Safer for shared bus scenarios
  - Predictable timing
  - Easier debugging

- **B. Parallel**:
  - Faster overall discovery
  - Risk of bus contention (industrial concern)
  - More complex error handling

**Recommendation**: Start with sequential, add parallel option later if needed

**Decision**: ⏳ Pending user feedback

---

### Q2: Connection Health Monitoring

**Question**: Should we track per-connection health status?

**Use Case**: Alert if a specific connection goes offline

**Implementation**:
```typescript
metadata: {
  connectionName: "comap-gen-502",
  connectionHealth: {
    status: "online" | "offline" | "degraded",
    lastSeen: "2025-01-07T10:00:00Z",
    failureCount: 0
  }
}
```

**Decision**: ⏳ Defer to future enhancement (not required for MVP)

---

### Q3: Device Deduplication Across Connections

**Question**: What if same physical device appears on multiple connections?

**Example**:
- Device has 2 network interfaces
- Accessible via `10.0.0.60:502` AND `10.0.0.61:502`
- Same slave ID, same registers

**Current Behavior**: Creates 2 separate devices

**Options**:
- **A. Keep separate** (current):
  - Simpler implementation
  - User can manually disable duplicate

- **B. Auto-deduplicate**:
  - Use register fingerprinting
  - Merge into single device
  - Complex edge cases

**Recommendation**: Keep separate for MVP, revisit if users report issues

**Decision**: ⏳ Pending

---

### Q4: MQTT Topic Structure

**Question**: Should topic structure change to reflect connections?

**Current**: `sensors/<uuid>/data`

**Option A**: Keep current (recommended)
- No breaking changes
- connectionName in payload

**Option B**: Connection-aware topics
- `sensors/<uuid>/<connection>/data`
- More granular subscription
- Breaking change for consumers

**Recommendation**: Option A (no topic change)

**Decision**: ⏳ Pending user feedback

---

## References

### Related Files

1. **Configuration**:
   - `agent/src/config/agent-config.ts` - Config parsing
   - `test.json` - Example target state

2. **Discovery**:
   - `agent/src/features/discovery/modbus.discovery.ts` - Device discovery
   - `agent/src/features/discovery/base-discovery.ts` - Base class

3. **Adapter**:
   - `agent/src/features/endpoints/modbus/adapter.ts` - Device polling
   - `agent/src/features/endpoints/modbus/client.ts` - Connection management
   - `agent/src/features/endpoints/index.ts` - Adapter startup

4. **Reconciler**:
   - `agent/src/device-manager/reconciler.ts` - State sync

5. **Publishing**:
   - `agent/src/features/sensor-publish/publish.ts` - MQTT publishing

6. **Database**:
   - `agent/src/database/endpoints.model.ts` - Endpoints storage

### Related Documentation

1. **Architecture Docs**:
   - `docs/MODBUS-FUNCTIONALITY.md` - Current Modbus implementation
   - `docs/ARCHITECTURE-DIAGRAMS.md` - System overview

2. **Instructions**:
   - `.github/instructions/modbus-functionality.instructions.md` - Detailed guidance

3. **Issue Tracker**:
   - Original request: "how to add one more modbus device"

---

## Appendix A: Full Configuration Schema

```typescript
interface ModbusProtocolConfig {
  enabled: boolean;
  profile?: string;               // Default profile for all connections
  bufferCapacity?: number;
  addressing?: {
    slaveRange?: {
      start: number;
      end: number;
    };
  };
  points?: Record<string, {      // Shared points (V2 format)
    type: 'holding' | 'input' | 'coil' | 'discrete';
    address: number;
    dataType: 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'boolean';
    unit?: string;
    count?: number;
  }>;
  profileDataPoints?: Array<{    // Shared points (V1 format)
    name: string;
    type: string;
    address: number;
    dataType: string;
    unit?: string;
  }>;
  connections?: Array<{          // Multi-connection support
    name: string;                // Required: Connection identifier
    host: string;
    port: number;
    timeoutMs?: number;
    profile?: string;            // Optional: Override root profile
    addressing?: {               // Optional: Override root addressing
      slaveRange?: {
        start: number;
        end: number;
      };
    };
    points?: Record<string, any>;  // Optional: Override root points
  }>;
  // Legacy single-connection fields (for backward compat)
  connection?: {
    host: string;
    port: number;
    timeoutMs?: number;
  };
  tcpHost?: string;
  tcpPort?: number;
  timeout?: number;
}
```

---

## Appendix B: Database Schema

**Table**: `endpoints`

```sql
CREATE TABLE endpoints (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  connection JSON NOT NULL,
  data_points JSON NOT NULL,
  metadata JSON,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Example record (multi-connection device)
{
  "uuid": "abc-123",
  "name": "comap-gen-502_slave_1",
  "protocol": "modbus",
  "connection": {
    "type": "tcp",
    "host": "10.0.0.60",
    "port": 502,
    "slaveId": 1
  },
  "data_points": [
    {
      "name": "engine_rpm",
      "address": 99,
      "type": "holding",
      "dataType": "uint16",
      "unit": "RPM"
    }
  ],
  "metadata": {
    "slaveId": 1,
    "profile": "COMAP",
    "connectionName": "comap-gen-502"  // NEW FIELD
  }
}
```

---

## Conclusion

This proposal provides a comprehensive plan for implementing multi-connection Modbus support with:

1. **✅ Backward Compatibility**: Existing single-connection configs continue working
2. **✅ Clear Architecture**: Well-defined data flow and component interactions
3. **✅ Risk Mitigation**: Identified gaps (adapter config) with solutions
4. **✅ Phased Rollout**: 5-week plan with clear milestones
5. **✅ Testing Strategy**: Unit, integration, and performance tests defined
6. **✅ Documentation**: Complete examples and migration guide

**Recommended Next Steps**:
1. Review proposal with team
2. Address open questions (Q1-Q4)
3. Begin Phase 2 implementation (adapter auto-config)
4. Set up test environment with multiple Modbus simulators
5. Proceed with phased rollout

**Approval Required**: Confirm architectural decisions before proceeding with implementation.

---

**Document Version**: 1.0  
**Last Updated**: 2026-01-07  
**Next Review**: After Phase 2 completion
