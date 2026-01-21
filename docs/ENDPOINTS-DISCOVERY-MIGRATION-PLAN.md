# Endpoints-Based Discovery Implementation Plan

## Executive Summary

**Goal**: Migrate discovery configuration from `protocols{}` to `endpoints[]` using structural detection - no new fields needed.

**Current State**:
- `endpoints` table (SQLite) - Discovered and manually-added operational devices only (has `slaveId`)
- `protocols{}` (target-state.json) - Discovery targets (WHERE to scan - has `slaveRange`)

**Target State**:
- `endpoints` table - Both operational devices AND discovery targets (distinguished by `slaveId` vs `slaveRange`)
- `protocols{}` - Removed (development phase, no backward compatibility needed)

**Key Insight**: Discovery targets use `slaveRange` (Modbus), `endpointUrl` (OPC-UA), `host+community` (SNMP) - we just need to **add discovery targets to the endpoints table**

**Discovery Behavior by Protocol**:
- **Modbus**: Scans `slaveRange` to find responding devices → applies profile dataPoints (user-configured)
- **OPC-UA**: Browses server `endpointUrl` → discovers nodes/variables automatically  
- **SNMP**: Queries `host` with `community` string → discovers OIDs automatically

---

## Architecture Overview

### Current Architecture (Dual System)

```json
{
  "endpoints": [
    {
      "name": "power_meter_1",
      "uuid": "062f4f7e-...",
      "enabled": true,
      "protocol": "modbus",
      "connection": { "host": "192.168.1.100", "port": 502 },
      "dataPoints": [...],
      "pollInterval": 5000
    }
  ],
  "protocols": {
    "modbus": {
      "enabled": true,
      "connections": [
        {
          "host": "10.0.0.60",
          "port": 503,
          "addressing": { "slaveRange": { "start": 1, "end": 3 } }
        }
      ]
    }
  }
}
```

**Issues with Current Architecture**:
1. **Duplicate Configuration**: Same connection details in both sections
2. **Unclear Ownership**: Discovery creates devices, but where do they live?
3. **Inconsistent Enablement**: `protocols.modbus.enabled` vs `endpoints[].enabled`
4. **Dashboard Disconnect**: Dashboard only manages `endpoints[]`, not `protocols{}`

**Development Status**: Since we're still in development, we can make breaking changes without backward compatibility concerns.

---

### Proposed Architecture (Unified System)

```json
{
  "endpoints": [
    {
      "name": "power_meter_1",
      "uuid": "062f4f7e-...",
      "enabled": true,
      "protocol": "modbus",
      "connection": {
        "host": "192.168.1.100",
        "port": 502,
        "slaveId": 10  // Operational device - single slave ID
      },
      "dataPoints": [...],
      "pollInterval": 5000
    },
    {
      "name": "modbus-discovery-target",
      "uuid": "d8a3b1c2-...",
      "enabled": true,
      "protocol": "modbus",
      "connection": {
        "host": "10.0.0.60",
        "port": 503,
        "slaveRange": { "start": 1, "end": 247 }  // Discovery target - scan range
      }
    }
  ],
  "intervals": {
    "discovery": {
      "fullIntervalMs": 86400000,   // 24h - boot discovery with validation
      "lightIntervalMs": 14400000   // 4h - scheduled discovery without validation
    }
  }
}
```

**Detection Logic by Protocol**:
- **Modbus**: `slaveRange` present = discovery target (scan range), `slaveId` present = operational device (specific slave)
- **OPC-UA**: `endpointUrl` without `nodeId` = discovery target (browse server), with `nodeId` = operational device
- **SNMP**: `community` present without specific OIDs = discovery target (query device), with OIDs = operational device

**Benefits**:
1. **No New Fields**: Uses existing connection structure
2. **Single Source of Truth**: All devices in one place
3. **Dashboard Integration**: Discovery targets visible in UI
4. **Simple Detection**: Structural differences distinguish device types
5. **Global Scheduling**: Existing `intervals.discovery` controls timing

---

## Implementation Phases

### Phase 1: Agent Reads from Endpoints (Week 1)

**Goals**:
- Agent reads ONLY from `endpoints[]` for discovery (detect by `slaveRange` presence)
- Map existing `protocols{}` structure to `endpoints[]` (no schema changes needed)
- Update discovery plugins to filter by connection structure

**Agent Changes**:

#### 1.1 Verify TypeScript Types (No Changes Needed)

**File**: `agent/src/features/endpoints/types.ts`

```typescript
// No changes needed - existing types already support discovery!

export interface EndpointConfig {
  name: string;
  uuid: string;
  enabled: boolean;
  protocol: 'modbus' | 'opcua' | 'snmp' | 'bacnet' | 'mqtt' | 'can';
  connection: ModbusConnection | OPCUAConnection | SNMPConnection | BACnetConnection;
  dataPoints?: any[];
  pollInterval?: number;
  metadata?: Record<string, any>;
}

export interface ModbusConnection {
  host: string;
  port: number;
  type: 'tcp' | 'rtu';
  timeout?: number;
  slaveId?: number;          // For operational devices (single address)
  slaveRange?: { start: number; end: number };  // For discovery targets (scan range)
  // RTU fields
  serialPort?: string;
  baudRate?: number;
  parity?: string;
  dataBits?: number;
  stopBits?: number;
}
```

**Key Point**: `slaveId` vs `slaveRange` already distinguishes operational devices from discovery targets!

#### 1.2 Add AgentConfig.getDiscoveryTargets()

**File**: `agent/src/config/agent-config.ts`

Add new method (replaces `getModbusConfig()` for discovery):

```typescript
/**
 * Get discovery targets from endpoints[]
 * Detects by connection structure: slaveRange = discovery, slaveId = operational
 */
public getDiscoveryTargets(protocol: 'modbus' | 'opcua' | 'snmp' | 'bacnet'): any[] {
  const config = this.getTargetConfig();
  if (!config?.endpoints) {
    return [];
  }

  return config.endpoints
    .filter((ep: any) => {
      if (ep.protocol !== protocol || ep.enabled === false) {
        return false;
      }
      
      // Structural detection based on protocol
      if (protocol === 'modbus') {
        return ep.connection.slaveRange !== undefined;  // Scan range = discovery target
      }
      if (protocol === 'opcua') {
        // endpointUrl without dataPoints = browse server for nodes
        return ep.connection.endpointUrl && (!ep.dataPoints || ep.dataPoints.length === 0);
      }
      if (protocol === 'snmp') {
        // Community string without specific OIDs = query device
        return ep.connection.community && (!ep.dataPoints || ep.dataPoints.length === 0);
      }
      if (protocol === 'bacnet') {
        return ep.connection.deviceInstanceRange !== undefined;  // Device range
      }
      return false;
    })
    .map(ep => ({
      ...ep.connection,
      name: ep.name,
      uuid: ep.uuid,
      enabled: ep.enabled,
      addressing: ep.connection.slaveRange 
        ? { slaveRange: ep.connection.slaveRange }
        : undefined
    }));
}
```

#### 1.3 Update Discovery Service

**File**: `agent/src/features/discovery/modbus.discovery.ts`

Replace this block (lines 64-78):

```typescript
// Get profile data points from target state (pushed via CloudSync)
const modbusConfig = this.agentConfig?.getModbusConfig();

// Multi-connection mode detection
if (modbusConfig?.connections && modbusConfig.connections.length > 0) {
  const connections = modbusConfig.connections;
  // ...
}
```

With:

```typescript
// Get discovery targets from endpoints[] only
const discoveryTargets = this.agentConfig?.getDiscoveryTargets('modbus') || [];

if (discoveryTargets.length === 0) {
  this.logger?.infoSync('No Modbus discovery targets configured', {
    component: LogComponents.discovery + "] [" + this.protocol as any
  });
  return [];
}

this.logger?.debugSync(`Starting Modbus discovery (${discoveryTargets.length} targets)`, {
  component: LogComponents.discovery + "] [" + this.protocol as any,
  targetCount: discoveryTargets.length
});

// Same scanning logic
for (const target of discoveryTargets) {
  // Scan this target...
}
```

**Similar changes needed for**:
- `opcua.discovery.ts`
- `snmp.discovery.ts`
- `bacnet.discovery.ts`

---

### Phase 2: Dashboard Integration (Week 2)

**Goals**:
- Add "Discovery Targets" section to Sensors page
- Allow adding/editing discovery targets via UI
- Migrate existing `protocols{}` to `endpoints[]` via migration tool

#### 2.1 Add Discovery Target UI

**File**: `dashboard/src/pages/SensorsPage.tsx`

Add new tab:

```tsx
<Tabs defaultValue="devices">
  <TabsList>
    <TabsTrigger value="devices">Devices</TabsTrigger>
    <TabsTrigger value="discovery">Discovery Targets</TabsTrigger>
  </TabsList>

  <TabsContent value="devices">
    {/* Existing device table */}
  </TabsContent>

  <TabsContent value="discovery">
    <DiscoveryTargetsTable 
      targets={sensors.filter(s => s.isDiscoveryTarget)}
      onAdd={handleAddDiscoveryTarget}
      onEdit={handleEditDiscoveryTarget}
      onDelete={handleDeleteDiscoveryTarget}
    />
  </TabsContent>
</Tabs>
```

#### 2.2 Add Discovery Target Dialog

**File**: `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx`

Same as device dialog, but use `slaveRange` instead of `slaveId`:

```tsx
<Form {...form}>
  <FormField
    control={form.control}
    name="name"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Discovery Target Name</FormLabel>
        <FormControl>
          <Input placeholder="modbus-building-1" {...field} />
        </FormControl>
      </FormItem>
    )}
  />

  <FormField
    control={form.control}
    name="connection.host"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Host</FormLabel>
        <FormControl>
          <Input placeholder="10.0.0.60" {...field} />
        </FormControl>
      </FormItem>
    )}
  />

  <FormField
    control={form.control}
    name="connection.port"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Port</FormLabel>
        <FormControl>
          <Input type="number" placeholder="502" {...field} />
        </FormControl>
      </FormItem>
    )}
  />

  <FormField
    control={form.control}
    name="connection.slaveRange"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Slave ID Range (Discovery Scan)</FormLabel>
        <FormControl>
          <div className="flex gap-2">
            <Input 
              type="number" 
              placeholder="Start (1)" 
              value={field.value?.start || 1} 
              onChange={e => field.onChange({ ...field.value, start: parseInt(e.target.value) })}
            />
            <Input 
              type="number" 
              placeholder="End (247)" 
              value={field.value?.end || 247}
              onChange={e => field.onChange({ ...field.value, end: parseInt(e.target.value) })}
            />
          </div>
        </FormControl>
        <FormDescription>
          Agent will scan this slave ID range for devices
        </FormDescription>
      </FormItem>
    )}
  />
</Form>
```

**Note**: Scan intervals controlled by global `intervals.discovery` setting, not per-target.

#### 2.3 API Endpoints for Discovery Targets

**File**: `api/src/routes/device-sensors.ts`

Add new routes (or reuse existing sensor routes):

```typescript
// POST /api/v1/devices/:uuid/sensors (works for both devices and discovery targets)
router.post('/:uuid/sensors', async (req, res) => {
  const { uuid } = req.params;
  const sensorConfig = req.body;

  // Auto-generate UUID if not provided
  sensorConfig.uuid = sensorConfig.uuid || crypto.randomUUID();

  // Same dual-write pattern for both discovery targets and devices
  // Detection happens in agent based on connection.slaveRange vs connection.slaveId
  await deviceSensorSync.addDeviceSensor({
    deviceUuid: uuid,
    name: sensorConfig.name,
    protocol: sensorConfig.protocol,
    connection: sensorConfig.connection,  // Has slaveRange = discovery, slaveId = device
    dataPoints: sensorConfig.dataPoints || [],
    pollInterval: sensorConfig.pollInterval || 5000,
    enabled: sensorConfig.enabled ?? true,
    username: req.user?.username || req.user?.email || 'dashboard'
  });

  res.json({ success: true, uuid: sensorConfig.uuid });
});
```

**Note**: No separate `/discovery-targets` endpoint needed - same API handles both!

---

### Phase 3: Remove protocols{} Section (Week 3)

**Goals**:
- Remove all `protocols{}` reading code from agent
- Clean up target-state.json
- Update documentation

#### 3.1 Remove protocols{} from Agent

**File**: `scripts/migrate-protocols-to-endpoints.ts`

```typescript
import { db } from '../api/src/db/connection';
import crypto from 'crypto';

interface MigrationReport {
  deviceUuid: string;
  protocolsFound: string[];
  endpointsCreated: number;
  errors: string[];
}

async function migrateProtocolsToEndpoints(deviceUuid: string): Promise<MigrationReport> {
  const report: MigrationReport = {
    deviceUuid,
    protocolsFound: [],
    endpointsCreated: 0,
    errors: []
  };

  // 1. Fetch current target state
  const targetState = await db('device_target_state')
    .where({ device_uuid: deviceUuid })
    .first();

  if (!targetState) {
    report.errors.push('Device not found');
    return report;
  }

  const config = JSON.parse(targetState.config);

  if (!config.protocols) {
    report.errors.push('No protocols section found');
    return report;
  }

  // 2. Convert protocols{} to endpoints[]
  const newEndpoints: any[] = config.endpoints || [];

  for (const [protocol, protocolConfig] of Object.entries(config.protocols)) {
    if (!protocolConfig.enabled) continue;

    report.protocolsFound.push(protocol);

    if (protocol === 'modbus' && protocolConfig.connections) {
      for (const conn of protocolConfig.connections) {
        newEndpoints.push({
          name: conn.name || `${protocol}-discovery-${conn.host}-${conn.port}`,
          uuid: crypto.randomUUID(),
          enabled: conn.enabled ?? true,
          protocol: 'modbus',
          connection: {
            host: conn.host,
            port: conn.port,
            timeout: conn.timeoutMs || 5000,
            slaveRange: conn.addressing?.slaveRange || { start: 1, end: 247 }  // Key field!
          }
        });
        report.endpointsCreated++;
      }
    } else if (protocol === 'opcua' && protocolConfig.connections) {
      for (const url of protocolConfig.connections) {
        newEndpoints.push({
          name: `opcua-discovery-${url.replace(/[^a-zA-Z0-9]/g, '-')}`,
          uuid: crypto.randomUUID(),
          enabled: true,
          protocol: 'opcua',
          connection: { url }  // URL without nodeId = discovery target
        });
        report.endpointsCreated++;
      }
    }
    // Add similar blocks for SNMP, BACnet, MQTT
  }

  // 3. Update target state (keep protocols{} for backward compatibility)
  config.endpoints = newEndpoints;
  await db('device_target_state')
    .where({ device_uuid: deviceUuid })
    .update({
      config: JSON.stringify(config, null, 2),
      updated_at: new Date()
    });

  console.log(`✅ Migrated ${report.endpointsCreated} discovery targets for device ${deviceUuid}`);
  return report;
}

// Run migration
const deviceUuid = process.argv[2];
if (!deviceUuid) {
  console.error('Usage: npm run migrate-protocols -- <device-uuid>');
  process.exit(1);
}

migrateProtocolsToEndpoints(deviceUuid)
  .then(report => {
    console.log('\n📊 Migration Report:');
    console.log(`  Protocols found: ${report.protocolsFound.join(', ')}`);
    console.log(`  Endpoints created: ${report.endpointsCreated}`);
    if (report.errors.length > 0) {
      console.log(`  Errors: ${report.errors.join(', ')}`);
    }
  })
  .catch(console.error);
```

**Usage**:
```bash
cd api
npm run migrate-protocols -- a1b2c3d4-uuid
```

---

### Phase 4: Deprecation (Week 6+)

**Goals**:
- Mark `protocols{}` as deprecated
- Log warnings when `protocols{}` is used
- Eventually remove `protocols{}` support

#### 4.1 Add Deprecation Warnings

**File**: `agent/src/config/agent-config.ts`

```typescript
public getDiscoveryTargets(protocol: string): any[] {
  const targets: any[] = [];

  // Source 1: endpoints[]
  if (this.cloudConfig?.endpoints) {
    const endpointTargets = this.cloudConfig.endpoints.filter(
      (ep: any) => ep.protocol === protocol && ep.isDiscoveryTarget === true
    );
    targets.push(...endpointTargets.map(this.normalizeDiscoveryTarget));
  }

  // Source 2: protocols{} (DEPRECATED)
  if (targets.length === 0 && this.cloudConfig?.protocols?.[protocol]) {
    this.logger?.warnSync(
      `⚠️ DEPRECATED: Using protocols.${protocol} for discovery. ` +
      `Please migrate to endpoints[] with isDiscoveryTarget=true. ` +
      `Run: npm run migrate-protocols -- <device-uuid>`,
      { component: LogComponents.agent }
    );
    // ... fallback logic
  }

  return targets;
}
```

---

## Database Schema Changes

### Current Schema (device_target_state table)

```sql
CREATE TABLE device_target_state (
  device_uuid TEXT PRIMARY KEY,
  config TEXT NOT NULL,  -- JSON with endpoints[] and protocols{}
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**No schema changes needed** - `endpoints[]` structure is flexible enough.

### Endpoint Schema Comparison

**Current Endpoints Table** (SQLite - only discovered/manual devices):
```sql
-- Discovered operational device (from discovery scan)
id=1, name="modbus-sim-2_slave_1", connection='{"type":"tcp","host":"10.0.0.60","port":503,"slaveId":1}'
  dataPoints=[...], discovery_metadata='{"slaveId":1,"discoveryMethod":"register_read",...}'

-- Manually added device (via dashboard)
id=9, name="power_meter_1", connection='{"host":"192.168.1.100","port":502,"type":"tcp"}'
  dataPoints=[...], discovery_metadata='{}'
```

**What's MISSING**: Discovery targets (WHERE to scan) - currently in `protocols{}`
Modbus discovery target (scan slave IDs, apply profile dataPoints to found devices)
id=10, name="modbus-discovery-building-1", 
  connection='{"host":"10.0.0.60","port":503,"slaveRange":{"start":1,"end":247}}'
  dataPoints=NULL, discovery_metadata='{"profile":"Generic"}'

-- OPC-UA discovery target (browse server, discover nodes automatically)
id=11, name="opcua-discovery-server-1",
  connection='{"endpointUrl":"opc.tcp://10.0.0.60:4840"}'
  dataPoints=NULL, discovery_metadata='{"browseDepth":3}'

-- SNMP discovery target (query device, discover OIDs automatically)
id=12, name="snmp-discovery-network-1",
  connection='{"host":"10.0.0.60","community":"public"}'
  dataPoints=NULL, discovery_metadata='{"scanType":"full"}'
```

**Discovery Behavior**:
- **Modbus**: Scans `slaveRange`, finds responding slaves → creates endpoint rows with profile-defined dataPoints
- **OPC-UA**: Browses `endpointUrl`, discovers nodes → creates endpoint row with discovered nodeIds as dataPoints
- **SNMP**: Queries `host`, discovers OIDs → creates endpoint row with discovered OIDs as dataPoint
- `connection.slaveRange` present → Discovery target (scan this range)
- `connection.slaveId` present → Operational device (poll this specific slave)
- Agent reads discovery targets from endpoints table, scans range, creates new endpoint rows for found devices

---

## Agent Code Changes Summary

### Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `agent/src/config/agent-config.ts` | Add `getDiscoveryTargets()` method (structural detection) | HIGH |
| `agent/src/features/discovery/modbus.discovery.ts` | Use `getDiscoveryTargets('modbus')` | HIGH |
| `agent/src/features/discovery/opcua.discovery.ts` | Use `getDiscoveryTargets('opcua')` | HIGH |
| `agent/src/features/discovery/snmp.discovery.ts` | Use `getDiscoveryTargets('snmp')` | HIGH |
| `agent/src/features/discovery/bacnet.discovery.ts` | Use `getDiscoveryTargets('bacnet')` | HIGH |
| `dashboard/src/pages/SensorsPage.tsx` | Add "Discovery Targets" tab (filter by slaveRange) | HIGH |
| `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx` | New file (use slaveRange field) | HIGH |
| `scripts/migrate-protocols-to-endpoints.ts` | Migration script (map to endpoints[]) | MEDIUM |

**Note**: No TypeScript type changes needed - existing schema already supports discovery!

---

## Implementation Summary

### Week 1: Agent Implementation
- Implement `getDiscoveryTargets()` in AgentConfig (structural detection)
- Update discovery plugins (modbus, opcua, snmp, bacnet)
- Write unit tests for detection logic

### Week 2: Dashboard & Migration
- Add "Discovery Targets" tab to SensorsPage (filter by `slaveRange`)
- Create AddDiscoveryTargetDialog (reuse sensor form with slaveRange)
- Run migration script to convert `protocols{}` → `endpoints[]`

### Week 3: Cleanup
- Remove all `protocols{}` reading code
- Delete `getModbusConfig()` etc. (replaced by `getDiscoveryTargets()`)
- Clean up target-state.json manually
- Update documentation

---

## Testing Strategy

### Agent Tests

```typescript
describe('Discovery Target Reading', () => {
  it('should detect discovery targets by slaveRange presence', async () => {
    const config = {
      endpoints: [
        {
          name: 'modbus-discovery',
          protocol: 'modbus',
          connection: { host: '10.0.0.60', port: 502, slaveRange: { start: 1, end: 10 } }
        },
        {
          name: 'modbus-device',
          protocol: 'modbus',
          connection: { host: '192.168.1.100', port: 502, slaveId: 10 }
        }
      ]
    };
    const targets = agentConfig.getDiscoveryTargets('modbus');
    expect(targets).toHaveLength(1);  // Only the one with slaveRange
    expect(targets[0].host).toBe('10.0.0.60');
  });

  it('should return empty array if no discovery targets', async () => {
    const config = { endpoints: [] };
    const targets = agentConfig.getDiscoveryTargets('modbus');
    expect(targets).toHaveLength(0);
  });

  it('should filter by protocol', async () => {
    const config = {
      endpoints: [
        { name: 'modbus-1', protocol: 'modbus', isDiscoveryTarget: true },
        { name: 'opcua-1', protocol: 'opcua', isDiscoveryTarget: true }
      ]
    };
    const modbusTargets = agentConfig.getDiscoveryTargets('modbus');
    expect(modbusTargets).toHaveLength(1);
    expect(modbusTargets[0].name).toBe('modbus-1');
  });

  it('should exclude disabled targets', async () => {
    const config = {
      endpoints: [
        { name: 'enabled', protocol: 'modbus', isDiscoveryTarget: true, enabled: true },
        { name: 'disabled', protocol: 'modbus', isDiscoveryTarget: true, enabled: false }
      ]
    };
    const targets = agentConfig.getDiscoveryTargets('modbus');
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('enabled');
  });

  it('should run boot discovery with validation', async () => {
    const result = await discoveryService.runDiscovery({
      trigger: 'first_boot',
      validate: true
    });
    expect(result.discovered).toBeGreaterThan(0);
  });

  it('should run scheduled discovery without validation', async () => {
    const result = await discoveryService.runDiscovery({
      trigger: 'scheduled',
      validate: false
    });
    expect(result.scanTime).toBeLessThan(result.fullScanTime);
  });
});
```

### Dashboard Tests

```typescript
describe('Discovery Target CRUD', () => {
  it('should create discovery target via API', async () => {
    const response = await fetch('/api/v1/devices/test-uuid/discovery-targets', {
      method: 'POST',
      body: JSON.stringify({
        name: 'test-discovery',
        protocol: 'modbus',
        connection: { host: '10.0.0.60', port: 502, slaveRange: { start: 1, end: 10 } },
        discoveryConfig: { scanInterval: 86400000 }
      })
    });
    expect(response.ok).toBe(true);
  });

  it('should list discovery targets separately from devices', async () => {
    const sensors = await fetchSensors('test-uuid');
    const discoveryTargets = sensors.filter(s => s.isDiscoveryTarget);
    const devices = sensors.filter(s => !s.isDiscoveryTarget);
    expect(discoveryTargets.length).toBeGreaterThan(0);
    expect(devices.length).toBeGreaterThan(0);
  });
});
```

---

## Success Metrics

1. **Discovery Success Rate**: No regression in device discovery rates (maintain current performance)
2. **Performance**: Discovery time remains < 5 minutes for 100 devices
3. **UI Usability**: Discovery targets easily manageable via dashboard
4. **Code Quality**: Clean separation of concerns, no dual-source complexity

---

## Timeline

| Week | Phase | Deliverables |
|------|-------|--------------|
| 1 | Phase 1 | Agent endpoints-only support, discovery plugin updates |
| 2 | Phase 2 | Dashboard UI, API endpoints, E2E tests |
| 3 | Phase 3 | Remove protocols{} code, cleanup, documentation |

**Total Time**: 3 weeks

---

## Next Steps

1. **Start Phase 1.1** - Update TypeScript types in `agent/src/features/endpoints/types.ts`
2. **Implement AgentConfig.getDiscoveryTargets()** - Read from endpoints[] only
3. **Update discovery plugins** - Modbus, OPC-UA, SNMP, BACnet
4. **Write tests** - Unit tests for discovery target filtering
5. **Dashboard UI** - Add Discovery Targets tab
6. **Cleanup** - Remove all `protocols{}` references

---

## Design Decisions
/endpointUrl/community already exist)
- ✅ No schema changes (existing types support discovery)
- ✅ Structural detection (slaveRange vs slaveId, endpointUrl with/without dataPoints, etc.)
- ✅ Global scheduling (intervals.discovery already configured)
- ✅ Single source of truth (`endpoints` table)
- ✅ Dashboard integration (filter by connection structure)

**Discovery Scope**:
- **Modbus**: Discovers responding slave IDs (dataPoints from profiles)
- **OPC-UA**: Discovers nodes/variables automatically (full discovery)
- **SNMP**: Discovers OIDs automatically (full discovery)

**Total changes**: Update `AgentConfig.getDiscoveryTargets()` to read from `endpoints[]` instead of `protocols{}`, using structural detection per protocol

This implementation is **purely a mapping problem**:
- ✅ No new fields needed (slaveRange already exists)
- ✅ No schema changes (existing types support discovery)
- ✅ Structural detection (slaveRange vs slaveId)
- ✅ Global scheduling (intervals.discovery already configured)
- ✅ Single source of truth (`endpoints[]`)
- ✅ Dashboard integration (filter by connection structure)

**Total changes**: Just update `AgentConfig.getDiscoveryTargets()` to read from `endpoints[]` instead of `protocols{}`.

**Migration**: Map `protocols.modbus.connections[]` → `endpoints[]` with `slaveRange` field.
