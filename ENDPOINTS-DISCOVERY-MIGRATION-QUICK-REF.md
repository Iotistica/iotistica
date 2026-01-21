# Endpoints-Based Discovery Migration - Quick Reference

## Current vs Proposed Architecture

### BEFORE (Dual System - Confusing!)

```
┌─────────────────────────────────────────────────────────────┐
│ Target State JSON                                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  endpoints: [                                                │
│    { name: "power_meter_1", ... }  ← Dashboard manages      │
│  ]                                                           │
│                                                              │
│  protocols: {                        ← Agent reads for      │
│    modbus: {                           discovery only       │
│      connections: [...]                                     │
│    }                                                         │
│  }                                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
        ↓                           ↓
   Dashboard UI              Agent Discovery
   (operational)             (finds devices)
```

**Problems**:
- ❌ Two places to configure same thing
- ❌ Dashboard can't see discovery config
- ❌ Unclear which section controls what

---

### AFTER (Unified System - Clear!)

```
┌─────────────────────────────────────────────────────────────┐
│ Target State JSON                                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  endpoints: [                                                │
│    // Operational device                                    │
│    {                                                         │
│      name: "power_meter_1",                                 │
│      isDiscoveryTarget: false,  ← Normal device            │
│      source: "manual",                                      │
│      dataPoints: [...]                                      │
│    },                                                        │
│                                                              │
│    // Discovery target                                      │
│    {                                                         │
│      name: "modbus-discovery",                              │
│      isDiscoveryTarget: true,   ← Discovery config         │
│      source: "manual",                                      │
│      connection: {                                          │
│        slaveRange: { start: 1, end: 247 }                  │
│      },                                                      │
│      discoveryConfig: { scanInterval: 86400000 }           │
│    }                                                         │
│  ]                                                           │
│                                                              │
│  protocols: { /* DEPRECATED */ }                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
        ↓
   Single source of truth
   Dashboard + Agent both read endpoints[]
```

**Benefits**:
- ✅ Everything in one place
- ✅ Dashboard can manage discovery targets
- ✅ Clear separation via `isDiscoveryTarget` flag

---

## Key Schema Changes

### New Fields on Endpoint

```typescript
interface EndpointConfig {
  // Existing fields
  name: string;
  uuid: string;
  enabled: boolean;
  protocol: 'modbus' | 'opcua' | 'snmp' | 'bacnet';
  connection: any;
  dataPoints?: any[];
  pollInterval?: number;

  // NEW FIELDS
  source?: 'manual' | 'discovered';      // Where did this come from?
  isDiscoveryTarget?: boolean;           // Is this for discovery or operation?
  discoveryConfig?: {                    // Discovery-specific settings
    scanInterval?: number;               // ms between scans
    validationEnabled?: boolean;         // Run deep validation?
    profile?: string;                    // Modbus profile
    maxDevices?: number;                 // BACnet limit
  };
}
```

### Connection Schema Extensions

#### Modbus Connection (Operational vs Discovery)

**Operational Device** (single slave):
```json
{
  "connection": {
    "host": "192.168.1.100",
    "port": 502,
    "type": "tcp",
    "slaveId": 1,           ← Single device
    "timeout": 5000
  }
}
```

**Discovery Target** (slave range):
```json
{
  "connection": {
    "host": "10.0.0.60",
    "port": 503,
    "type": "tcp",
    "slaveRange": {         ← Range to scan
      "start": 1,
      "end": 247
    },
    "timeout": 5000
  }
}
```

---

## Migration Stages

### Stage 1: Dual Support (Backward Compatible)

```typescript
// Agent reads BOTH sources
getDiscoveryTargets(protocol) {
  // Try endpoints[] first
  const fromEndpoints = config.endpoints.filter(
    e => e.protocol === protocol && e.isDiscoveryTarget
  );
  
  if (fromEndpoints.length > 0) {
    return fromEndpoints;
  }
  
  // Fallback to protocols{} (old format)
  return config.protocols?.[protocol]?.connections || [];
}
```

**Agent Behavior**:
- ✅ Reads `endpoints[]` with `isDiscoveryTarget=true`
- ✅ Falls back to `protocols{}` if no endpoints found
- ✅ Logs warning about deprecated format

---

### Stage 2: Migration Tool

```bash
# Automated migration script
npm run migrate-protocols -- <device-uuid>

# What it does:
# 1. Read protocols{} section
# 2. Convert to endpoints[] format
# 3. Add isDiscoveryTarget=true flag
# 4. Keep protocols{} for backward compatibility
```

**Example Migration**:

**BEFORE**:
```json
{
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

**AFTER**:
```json
{
  "endpoints": [
    {
      "name": "modbus-discovery-10.0.0.60-503",
      "uuid": "auto-generated",
      "enabled": true,
      "protocol": "modbus",
      "source": "manual",
      "isDiscoveryTarget": true,
      "connection": {
        "host": "10.0.0.60",
        "port": 503,
        "type": "tcp",
        "slaveRange": { "start": 1, "end": 3 }
      },
      "discoveryConfig": {
        "scanInterval": 86400000,
        "validationEnabled": true
      },
      "dataPoints": [],
      "pollInterval": 86400000
    }
  ],
  "protocols": {
    "modbus": { /* Kept for old agents */ }
  }
}
```

---

### Stage 3: Dashboard UI

**New "Discovery Targets" Tab**:

```
┌─────────────────────────────────────────────────────────────┐
│ Sensors                                                      │
├──────────────────────────────────────────┬──────────────────┤
│ [Devices] [Discovery Targets]            │ [+ Add Device]  │
├──────────────────────────────────────────┴──────────────────┤
│                                                              │
│ Discovery Targets                                           │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ Name                Protocol   Target        Enabled │   │
│ ├──────────────────────────────────────────────────────┤   │
│ │ modbus-building-1   Modbus     10.0.0.60:503   ✓    │   │
│ │ opcua-plc           OPC-UA     opc.tcp://...   ✓    │   │
│ │ snmp-network        SNMP       192.168.1.0/24  ✓    │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                              │
│ [+ Add Discovery Target]                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Add Discovery Target Dialog**:
- Same UI as "Add Sensor" but with:
  - Slave range instead of slave ID (Modbus)
  - Scan interval setting
  - Validation toggle
  - No data points (discovered devices get those)

---

## Agent Code Changes Checklist

### Core Files to Modify

- [ ] `agent/src/features/endpoints/types.ts`
  - Add `DiscoveryConfig` interface
  - Add `isDiscoveryTarget`, `source` to `EndpointConfig`

- [ ] `agent/src/config/agent-config.ts`
  - Add `getDiscoveryTargets(protocol)` method
  - Add `normalizeDiscoveryTarget()` helper

- [ ] `agent/src/features/discovery/*.discovery.ts`
  - Replace `getModbusConfig()` with `getDiscoveryTargets('modbus')`
  - Same for opcua, snmp, bacnet

- [ ] `agent/src/bootstrap/init.ts`
  - Add deprecation warnings for `protocols{}`

### Dashboard Files to Create/Modify

- [ ] `dashboard/src/schemas/sensor-schemas.ts`
  - Add `DiscoveryTargetSchema`
  - Add `isDiscoveryTarget`, `discoveryConfig` fields

- [ ] `dashboard/src/pages/SensorsPage.tsx`
  - Add "Discovery Targets" tab
  - Filter sensors by `isDiscoveryTarget`

- [ ] `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx` (NEW)
  - Clone from `AddSensorDialog.tsx`
  - Remove data points table
  - Add slave range input (Modbus)
  - Add scan interval setting

- [ ] `api/src/routes/device-sensors.ts`
  - Add `POST /discovery-targets`
  - Add `PUT /discovery-targets/:name`
  - Add `DELETE /discovery-targets/:name`

---

## Testing Checklist

### Agent Tests

```typescript
✅ Read discovery targets from endpoints[] with isDiscoveryTarget=true
✅ Fallback to protocols{} if no endpoints[] targets
✅ Prioritize endpoints[] over protocols{} when both exist
✅ Log deprecation warning when using protocols{}
✅ Discovery works with both old and new format
```

### API Tests

```typescript
✅ Create discovery target via POST /discovery-targets
✅ Update discovery target via PUT /discovery-targets/:name
✅ Delete discovery target via DELETE /discovery-targets/:name
✅ List discovery targets separately from devices
✅ Discovery targets have isDiscoveryTarget=true in database
```

### Dashboard Tests

```typescript
✅ Discovery Targets tab shows only isDiscoveryTarget=true items
✅ Devices tab shows only isDiscoveryTarget=false items
✅ Add Discovery Target dialog works for Modbus
✅ Add Discovery Target dialog works for OPC-UA
✅ Edit discovery target pre-populates form
✅ Migration banner shows when protocols{} detected
```

---

## API Endpoints Reference

### Discovery Targets CRUD

```bash
# Create discovery target
POST /api/v1/devices/:uuid/discovery-targets
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

# Update discovery target
PUT /api/v1/devices/:uuid/discovery-targets/:name
{
  "enabled": false,
  "discoveryConfig": { "scanInterval": 43200000 }
}

# Delete discovery target
DELETE /api/v1/devices/:uuid/discovery-targets/:name

# List all endpoints (includes discovery targets)
GET /api/v1/devices/:uuid/sensors
# Filter client-side: .filter(s => s.isDiscoveryTarget)
```

---

## Backward Compatibility Matrix

| Agent Version | Reads endpoints[] | Reads protocols{} | Status |
|---------------|-------------------|-------------------|--------|
| < 1.0.230 | ❌ No | ✅ Yes | Old behavior |
| 1.0.230 - 1.0.250 | ✅ Yes | ✅ Yes (deprecated) | Migration phase |
| 1.0.250+ | ✅ Yes | ⚠️ Read-only | `protocols{}` locked |
| 2.0.0+ | ✅ Yes | ❌ Ignored | `protocols{}` removed |

---

## Common Patterns

### Pattern 1: Operational Device (User-Added)

```json
{
  "name": "power_meter_1",
  "uuid": "062f4f7e-...",
  "enabled": true,
  "protocol": "modbus",
  "source": "manual",
  "isDiscoveryTarget": false,
  "connection": {
    "host": "192.168.1.100",
    "port": 502,
    "type": "tcp",
    "slaveId": 1
  },
  "dataPoints": [
    { "name": "voltage", "address": 0, "type": "holding" }
  ],
  "pollInterval": 5000
}
```

**Use Case**: User manually adds device via dashboard

---

### Pattern 2: Discovery Target (Network Scanner)

```json
{
  "name": "modbus-discovery-building-1",
  "uuid": "d8a3b1c2-...",
  "enabled": true,
  "protocol": "modbus",
  "source": "manual",
  "isDiscoveryTarget": true,
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
  },
  "dataPoints": [],
  "pollInterval": 86400000
}
```

**Use Case**: Agent scans this network range every 24 hours

---

### Pattern 3: Discovered Device (Auto-Added)

```json
{
  "name": "discovered-slave-5-10.0.0.60",
  "uuid": "auto-generated",
  "enabled": false,
  "protocol": "modbus",
  "source": "discovered",
  "isDiscoveryTarget": false,
  "connection": {
    "host": "10.0.0.60",
    "port": 503,
    "type": "tcp",
    "slaveId": 5
  },
  "dataPoints": [],
  "pollInterval": 5000,
  "metadata": {
    "discoveredAt": "2025-01-21T10:30:00Z",
    "discoveryTargetUuid": "d8a3b1c2-...",
    "deviceInfo": "Schneider PM5560"
  }
}
```

**Use Case**: Agent found device during scan, user can enable + add data points

---

## Rollback Strategy

If migration causes issues:

### Rollback Steps

1. **Agent Rollback**:
   ```bash
   # Deploy previous agent version
   docker pull iotistic/agent:1.0.229
   docker-compose up -d agent
   ```

2. **Database Rollback**:
   - `protocols{}` section is never deleted
   - Safe to revert target_state JSON
   - No schema changes needed

3. **Dashboard Rollback**:
   - Hide "Discovery Targets" tab
   - Dashboard continues to work with `endpoints[]` for devices

### Safety Net

- ✅ `protocols{}` always kept for backward compatibility
- ✅ Agent supports both formats during migration
- ✅ No destructive database migrations
- ✅ Can run old and new agents side-by-side

---

## Success Criteria

**Migration is complete when**:

1. ✅ All devices have discovery targets in `endpoints[]`
2. ✅ Dashboard shows "Discovery Targets" tab
3. ✅ Users can add/edit discovery targets via UI
4. ✅ Agent logs no `protocols{}` deprecation warnings
5. ✅ `protocols{}` section is empty or removed

**Performance targets**:

- ⚡ Discovery time unchanged (< 5 min for 100 devices)
- ⚡ UI response time < 200ms for discovery target CRUD
- ⚡ Zero downtime during migration

---

## Next Actions

### Immediate (Week 1)

1. Review and approve this plan
2. Create GitHub issues for Phase 1 tasks
3. Update TypeScript types (`types.ts`)
4. Implement `AgentConfig.getDiscoveryTargets()`
5. Write unit tests for dual-source reading

### Short-term (Weeks 2-4)

1. Update all discovery plugins (Modbus, OPC-UA, SNMP, BACnet)
2. Add deprecation warnings to agent logs
3. Build dashboard "Discovery Targets" UI
4. Create API endpoints for discovery target CRUD
5. Write E2E tests

### Medium-term (Weeks 5-6)

1. Build migration tool (`migrate-protocols.ts`)
2. Test migration on staging devices
3. Document migration process
4. Roll out to production

### Long-term (Months 2-3)

1. Monitor adoption metrics
2. Remove `protocols{}` support in v2.0.0
3. Clean up legacy code paths

---

## FAQ

**Q: Will my existing devices break during migration?**
A: No, agent supports both formats simultaneously.

**Q: Do I need to migrate all devices at once?**
A: No, migrate device-by-device at your own pace.

**Q: What if I want to revert?**
A: `protocols{}` is never deleted, just supplemented. Safe to rollback.

**Q: Can discovered devices become operational?**
A: Yes, user enables them and adds data points. `source` changes from `discovered` → `manual`.

**Q: How do I know which devices are discovery targets vs operational?**
A: Check `isDiscoveryTarget` field. Dashboard shows them in separate tabs.

**Q: Will discovery performance change?**
A: No, same underlying scanning logic, just different config source.

---

**Full Details**: See [ENDPOINTS-DISCOVERY-MIGRATION-PLAN.md](./docs/ENDPOINTS-DISCOVERY-MIGRATION-PLAN.md)
