# Endpoints-Based Discovery Migration - Visual Flow

## Current Architecture (Dual System)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Target State JSON                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ endpoints: [                                                 │    │
│  │   {                                                          │    │
│  │     name: "power_meter_1",                                   │    │
│  │     uuid: "062f4f7e-...",                                    │    │
│  │     protocol: "modbus",                                      │    │
│  │     connection: { host: "192.168.1.100", port: 502 },       │    │
│  │     dataPoints: [...]                                        │    │
│  │   }                                                          │    │
│  │ ]                                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ protocols: {                                                 │    │
│  │   modbus: {                                                  │    │
│  │     enabled: true,                                           │    │
│  │     connections: [                                           │    │
│  │       {                                                      │    │
│  │         host: "10.0.0.60",                                   │    │
│  │         port: 503,                                           │    │
│  │         addressing: {                                        │    │
│  │           slaveRange: { start: 1, end: 247 }                │    │
│  │         }                                                    │    │
│  │       }                                                      │    │
│  │     ]                                                        │    │
│  │   }                                                          │    │
│  │ }                                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
              │                                    │
              │                                    │
              ▼                                    ▼
    ┌──────────────────┐              ┌──────────────────────┐
    │   Dashboard UI   │              │  Agent Discovery     │
    │                  │              │                      │
    │  Manages:        │              │  Reads:              │
    │  • endpoints[]   │              │  • protocols{}       │
    │                  │              │  • Scans network     │
    │  ❌ Cannot see   │              │  • Finds devices     │
    │     protocols{}  │              │                      │
    └──────────────────┘              └──────────────────────┘
```

**Problems**:
1. ❌ Discovery config hidden from dashboard
2. ❌ Two separate configuration sections
3. ❌ Unclear which takes priority
4. ❌ Manual devices and discovery targets in different places

---

## Target Architecture (Unified System)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Target State JSON                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ endpoints: [                                                 │    │
│  │                                                              │    │
│  │   // Operational Device (User-Added)                        │    │
│  │   {                                                          │    │
│  │     name: "power_meter_1",                                   │    │
│  │     uuid: "062f4f7e-...",                                    │    │
│  │     enabled: true,                                           │    │
│  │     protocol: "modbus",                                      │    │
│  │     source: "manual",           ← NEW                       │    │
│  │     isDiscoveryTarget: false,   ← NEW                       │    │
│  │     connection: {                                            │    │
│  │       host: "192.168.1.100",                                 │    │
│  │       port: 502,                                             │    │
│  │       slaveId: 1                                             │    │
│  │     },                                                       │    │
│  │     dataPoints: [...],                                       │    │
│  │     pollInterval: 5000                                       │    │
│  │   },                                                         │    │
│  │                                                              │    │
│  │   // Discovery Target (Network Scanner)                     │    │
│  │   {                                                          │    │
│  │     name: "modbus-discovery-building-1",                     │    │
│  │     uuid: "d8a3b1c2-...",                                    │    │
│  │     enabled: true,                                           │    │
│  │     protocol: "modbus",                                      │    │
│  │     source: "manual",           ← NEW                       │    │
│  │     isDiscoveryTarget: true,    ← NEW                       │    │
│  │     connection: {                                            │    │
│  │       host: "10.0.0.60",                                     │    │
│  │       port: 503,                                             │    │
│  │       slaveRange: { start: 1, end: 247 }  ← Range scan     │    │
│  │     },                                                       │    │
│  │     discoveryConfig: {          ← NEW                       │    │
│  │       scanInterval: 86400000,                                │    │
│  │       validationEnabled: true,                               │    │
│  │       profile: "Generic"                                     │    │
│  │     },                                                       │    │
│  │     dataPoints: [],                                          │    │
│  │     pollInterval: 86400000                                   │    │
│  │   },                                                         │    │
│  │                                                              │    │
│  │   // Discovered Device (Auto-Added by Agent)                │    │
│  │   {                                                          │    │
│  │     name: "discovered-slave-5",                              │    │
│  │     uuid: "auto-gen",                                        │    │
│  │     enabled: false,             ← Disabled until user acts  │    │
│  │     protocol: "modbus",                                      │    │
│  │     source: "discovered",       ← NEW                       │    │
│  │     isDiscoveryTarget: false,                                │    │
│  │     connection: {                                            │    │
│  │       host: "10.0.0.60",                                     │    │
│  │       port: 503,                                             │    │
│  │       slaveId: 5                                             │    │
│  │     },                                                       │    │
│  │     dataPoints: [],             ← User adds these           │    │
│  │     pollInterval: 5000,                                      │    │
│  │     metadata: {                                              │    │
│  │       discoveredAt: "2025-01-21T10:30:00Z",                 │    │
│  │       deviceInfo: "Schneider PM5560"                        │    │
│  │     }                                                        │    │
│  │   }                                                          │    │
│  │                                                              │    │
│  │ ]                                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ protocols: {                                                 │    │
│  │   // DEPRECATED - Kept for backward compatibility           │    │
│  │   // Will be ignored if discovery targets exist in           │    │
│  │   // endpoints[] above                                       │    │
│  │ }                                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │
                              ▼
              ┌──────────────────────────────────┐
              │  Both Dashboard & Agent Read     │
              │  endpoints[]                     │
              └──────────────────────────────────┘
                     │                  │
                     ▼                  ▼
        ┌─────────────────┐   ┌─────────────────────┐
        │  Dashboard UI   │   │  Agent Discovery    │
        │                 │   │                     │
        │  Shows:         │   │  Scans:             │
        │  ✅ Devices     │   │  ✅ Discovery       │
        │  ✅ Discovery   │   │      targets        │
        │     targets     │   │  ✅ Finds devices   │
        │                 │   │  ✅ Adds to         │
        │  Can manage:    │   │      endpoints[]    │
        │  ✅ Add/edit    │   │                     │
        │     targets     │   │                     │
        └─────────────────┘   └─────────────────────┘
```

**Benefits**:
1. ✅ Single source of truth
2. ✅ Dashboard can manage discovery
3. ✅ Clear device lifecycle
4. ✅ Backward compatible

---

## Device Lifecycle Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DEVICE LIFECYCLE                                │
└─────────────────────────────────────────────────────────────────────┘

  Discovery Target                 Discovered Device              Operational Device
  (isDiscoveryTarget: true)       (source: "discovered")         (source: "manual")
          │                                │                            │
          │ Agent scans network            │                            │
          │ every 24h                      │                            │
          │                                │                            │
          ├──────────────────────────────► │                            │
          │   Device found!                │                            │
          │   Slave ID 5 responding        │ User enables              │
          │   at 10.0.0.60:503             │ + adds data points        │
          │                                │                            │
          │                                ├───────────────────────────►│
          │                                │   Becomes operational      │
          │                                │   source: discovered →     │
          │                                │          manual            │
          │                                │                            │
          │ Keeps scanning                 │ Disabled until user acts  │ Active polling
          │ for new devices                │ enabled: false             │ enabled: true
          │                                │                            │
          ▼                                ▼                            ▼
```

### State Transitions

```
┌──────────────────────────────────────────────────────────────────────┐
│ State 1: Discovery Target Added                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  {                                                                    │
│    name: "modbus-discovery-building-1",                              │
│    isDiscoveryTarget: true,           ← Agent scans this             │
│    enabled: true,                                                    │
│    connection: {                                                     │
│      host: "10.0.0.60",                                              │
│      slaveRange: { start: 1, end: 247 }  ← Scan all slaves          │
│    },                                                                │
│    discoveryConfig: { scanInterval: 86400000 }                       │
│  }                                                                    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ Agent runs discovery
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ State 2: Device Discovered (Auto-Created by Agent)                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  {                                                                    │
│    name: "discovered-slave-5-10.0.0.60",                             │
│    isDiscoveryTarget: false,          ← Not a scanner                │
│    source: "discovered",              ← Agent created this           │
│    enabled: false,                    ← Disabled by default          │
│    connection: {                                                     │
│      host: "10.0.0.60",                                              │
│      slaveId: 5                       ← Specific slave found         │
│    },                                                                │
│    dataPoints: [],                    ← No data points yet           │
│    metadata: {                                                       │
│      discoveredAt: "2025-01-21T10:30:00Z",                           │
│      discoveryTargetUuid: "d8a3b1c2-...",                            │
│      deviceInfo: "Schneider PM5560"                                 │
│    }                                                                 │
│  }                                                                    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              │ User enables + adds data points
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ State 3: Operational Device (User Configured)                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  {                                                                    │
│    name: "power_meter_building_1",    ← User renames                 │
│    isDiscoveryTarget: false,                                         │
│    source: "manual",                  ← Changed from "discovered"    │
│    enabled: true,                     ← User enabled                 │
│    connection: {                                                     │
│      host: "10.0.0.60",                                              │
│      slaveId: 5                                                      │
│    },                                                                │
│    dataPoints: [                      ← User added these             │
│      { name: "voltage", address: 0, type: "holding" },               │
│      { name: "current", address: 1, type: "holding" }                │
│    ],                                                                │
│    pollInterval: 5000                 ← Active polling               │
│  }                                                                    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Migration Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Add Dual-Source Support (Weeks 1-2)                         │
└──────────────────────────────────────────────────────────────────────┘

  Agent Code Before                       Agent Code After
  ┌──────────────────┐                   ┌─────────────────────────────┐
  │ const config =   │                   │ getDiscoveryTargets(proto)  │
  │   getModbusConfig│                   │ {                           │
  │   ();            │                   │   // Try endpoints[] first  │
  │                  │                   │   const targets =           │
  │ connections =    │      ══════►      │     endpoints.filter(       │
  │   config.        │                   │       isDiscoveryTarget     │
  │   connections    │                   │     );                      │
  │                  │                   │                             │
  │                  │                   │   // Fallback to protocols{}│
  │                  │                   │   if (targets.length === 0) │
  │                  │                   │     return protocols[proto] │
  │                  │                   │ }                           │
  └──────────────────┘                   └─────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Migration Tool (Week 5)                                     │
└──────────────────────────────────────────────────────────────────────┘

  protocols{}                             endpoints[]
  ┌──────────────────┐                   ┌─────────────────────────────┐
  │ modbus: {        │                   │ {                           │
  │   enabled: true, │                   │   name: "modbus-discovery", │
  │   connections: [ │                   │   isDiscoveryTarget: true,  │
  │     {            │                   │   protocol: "modbus",       │
  │       host: X,   │   Migration      │   connection: {             │
  │       port: Y,   │   ══════════►     │     host: X,                │
  │       slaveRange │      Script       │     port: Y,                │
  │     }            │                   │     slaveRange: {...}       │
  │   ]              │                   │   },                        │
  │ }                │                   │   discoveryConfig: {...}    │
  │                  │                   │ }                           │
  └──────────────────┘                   └─────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Dashboard Integration (Weeks 3-4)                           │
└──────────────────────────────────────────────────────────────────────┘

  Dashboard Before                        Dashboard After
  ┌──────────────────┐                   ┌─────────────────────────────┐
  │ Sensors          │                   │ Sensors                     │
  │ ┌──────────────┐ │                   │ ┌─────────────────────────┐ │
  │ │ Devices      │ │                   │ │ [Devices] [Discovery    │ │
  │ │              │ │                   │ │  Targets]               │ │
  │ │ • Device 1   │ │                   │ │                         │ │
  │ │ • Device 2   │ │      ══════►      │ │ Devices:                │ │
  │ └──────────────┘ │                   │ │ • Device 1              │ │
  │                  │                   │ │ • Device 2              │ │
  │ ❌ No discovery  │                   │ │                         │ │
  │    config UI     │                   │ │ Discovery Targets:      │ │
  │                  │                   │ │ • modbus-building-1     │ │
  │                  │                   │ │ • opcua-plc             │ │
  │                  │                   │ │                         │ │
  │                  │                   │ │ [+ Add Target]          │ │
  │                  │                   │ └─────────────────────────┘ │
  └──────────────────┘                   └─────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Deprecation (Week 6+)                                       │
└──────────────────────────────────────────────────────────────────────┘

  Agent v1.0.230                          Agent v2.0.0
  ┌──────────────────┐                   ┌─────────────────────────────┐
  │ if (endpoints)   │                   │ // Only read endpoints[]    │
  │   use endpoints  │                   │ const targets =             │
  │ else             │      ══════►      │   getDiscoveryTargets();    │
  │   ⚠️ WARN:       │                   │                             │
  │   "Deprecated!"  │                   │ // protocols{} removed      │
  │   use protocols  │                   │                             │
  └──────────────────┘                   └─────────────────────────────┘
```

---

## Agent Discovery Logic (Before vs After)

### BEFORE (Single Source)

```typescript
// modbus.discovery.ts (Current - Line 64)
async discover(options?: ModbusDiscoveryOptions): Promise<DiscoveredDevice[]> {
  const modbusConfig = this.agentConfig?.getModbusConfig();
  
  if (modbusConfig?.connections && modbusConfig.connections.length > 0) {
    const connections = modbusConfig.connections;  // ← From protocols{}
    
    for (const conn of connections) {
      await this.discoverOnBus({
        tcpHost: conn.host,
        tcpPort: conn.port,
        slaveIdRange: [conn.addressing.slaveRange.start, 
                       conn.addressing.slaveRange.end]
      });
    }
  }
}
```

### AFTER (Dual Source with Fallback)

```typescript
// modbus.discovery.ts (Proposed - New)
async discover(options?: ModbusDiscoveryOptions): Promise<DiscoveredDevice[]> {
  // NEW: Read from both sources
  const discoveryTargets = this.agentConfig?.getDiscoveryTargets('modbus') || [];
  
  if (discoveryTargets.length === 0) {
    this.logger?.info('No Modbus discovery targets configured');
    return [];
  }
  
  this.logger?.info(`Found ${discoveryTargets.length} Modbus discovery targets`, {
    fromEndpoints: discoveryTargets.filter(t => t.uuid).length,
    fromProtocols: discoveryTargets.filter(t => !t.uuid).length
  });
  
  for (const target of discoveryTargets) {
    await this.discoverOnBus({
      tcpHost: target.host,
      tcpPort: target.port,
      slaveIdRange: target.slaveRange 
        ? [target.slaveRange.start, target.slaveRange.end]
        : [1, 247]
    });
  }
}
```

---

## Dashboard Component Tree (After Migration)

```
SensorsPage
│
├─ Tabs
│  ├─ TabsList
│  │  ├─ TabsTrigger ("Devices")
│  │  └─ TabsTrigger ("Discovery Targets")     ← NEW
│  │
│  ├─ TabsContent ("devices")
│  │  ├─ DeviceTable
│  │  │  └─ DeviceRow (filtered: isDiscoveryTarget === false)
│  │  └─ AddSensorDialog
│  │
│  └─ TabsContent ("discovery")              ← NEW
│     ├─ DiscoveryTargetsTable
│     │  └─ DiscoveryTargetRow (filtered: isDiscoveryTarget === true)
│     └─ AddDiscoveryTargetDialog           ← NEW
│        ├─ ProtocolTabs
│        │  ├─ ModbusDiscoveryForm
│        │  │  ├─ ConnectionSettings (host, port)
│        │  │  ├─ SlaveRangeInput (start, end)
│        │  │  └─ ScanIntervalInput
│        │  ├─ OPCUADiscoveryForm
│        │  └─ SNMPDiscoveryForm
│        └─ SaveButton
```

---

## API Request/Response Examples

### Create Discovery Target

**Request**:
```http
POST /api/v1/devices/a1b2c3d4-uuid/discovery-targets
Content-Type: application/json

{
  "name": "modbus-building-1",
  "protocol": "modbus",
  "enabled": true,
  "connection": {
    "host": "10.0.0.60",
    "port": 503,
    "type": "tcp",
    "slaveRange": { "start": 1, "end": 247 }
  },
  "discoveryConfig": {
    "scanInterval": 86400000,
    "validationEnabled": true,
    "profile": "Generic"
  }
}
```

**Response**:
```json
{
  "success": true,
  "uuid": "d8a3b1c2-auto-generated",
  "message": "Discovery target created"
}
```

### Get All Endpoints (Including Discovery Targets)

**Request**:
```http
GET /api/v1/devices/a1b2c3d4-uuid/sensors
```

**Response**:
```json
{
  "sensors": [
    {
      "name": "power_meter_1",
      "uuid": "062f4f7e-...",
      "isDiscoveryTarget": false,
      "source": "manual",
      "protocol": "modbus",
      "enabled": true,
      "connection": { "host": "192.168.1.100", "port": 502, "slaveId": 1 },
      "dataPoints": [...],
      "pollInterval": 5000
    },
    {
      "name": "modbus-building-1",
      "uuid": "d8a3b1c2-...",
      "isDiscoveryTarget": true,
      "source": "manual",
      "protocol": "modbus",
      "enabled": true,
      "connection": { "host": "10.0.0.60", "port": 503, "slaveRange": {...} },
      "discoveryConfig": { "scanInterval": 86400000 },
      "dataPoints": [],
      "pollInterval": 86400000
    }
  ]
}
```

**Dashboard Filtering**:
```typescript
// Devices tab
const devices = sensors.filter(s => !s.isDiscoveryTarget);

// Discovery Targets tab
const discoveryTargets = sensors.filter(s => s.isDiscoveryTarget);
```

---

## Summary

**Before**: Confusing dual system with hidden discovery config
**After**: Unified system with clear device lifecycle and dashboard visibility

**Key Changes**:
1. Add `isDiscoveryTarget` flag to distinguish scanners from devices
2. Add `discoveryConfig` object for scan settings
3. Add `source` field to track origin (manual vs discovered)
4. Agent reads both `endpoints[]` and `protocols{}` during transition
5. Dashboard gets new "Discovery Targets" tab

**Migration**: Safe, gradual, backward-compatible
**Rollback**: Easy - `protocols{}` never deleted
**Benefits**: Better UX, clear lifecycle, single source of truth
