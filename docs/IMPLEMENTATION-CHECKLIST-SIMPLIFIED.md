# Endpoints-Based Discovery - Implementation Checklist (Simplified)

## Overview

**Goal**: Implement `endpoints[]`-based discovery - NO backward compatibility needed

**Timeline**: 3 weeks
**Team**: 2-3 developers
**Complexity**: Low (clean implementation, no dual-source logic)

---

## Week 1: Core Implementation

### Day 1-2: Types and Configuration

- [ ] **Update TypeScript Types** (4h)
  - [ ] `agent/src/features/endpoints/types.ts`:
    - Add `isDiscoveryTarget?: boolean`
    - Add `source?: 'manual' | 'discovered'`
    - Add `discoveryConfig?: DiscoveryConfig` interface
    - Add `slaveRange?: { start: number; end: number }` to ModbusConnection
  - [ ] Write type tests

- [ ] **Implement AgentConfig.getDiscoveryTargets()** (6h)
  - [ ] `agent/src/config/agent-config.ts`:
    ```typescript
    public getDiscoveryTargets(protocol: string): any[] {
      if (!this.cloudConfig?.endpoints) return [];
      
      return this.cloudConfig.endpoints
        .filter(ep => 
          ep.protocol === protocol && 
          ep.isDiscoveryTarget === true &&
          ep.enabled !== false
        )
        .map(this.normalizeDiscoveryTarget);
    }
    ```
  - [ ] Write unit tests (protocol filtering, enabled/disabled, empty array)

### Day 3-5: Discovery Plugins

- [ ] **Update Modbus Discovery** (6h)
  - [ ] Replace `getModbusConfig()` with `getDiscoveryTargets('modbus')`
  - [ ] Update logging
  - [ ] Integration tests with simulator

- [ ] **Update OPC-UA Discovery** (4h)
  - [ ] Replace config reading with `getDiscoveryTargets('opcua')`
  - [ ] Integration tests

- [ ] **Update SNMP Discovery** (4h)
  - [ ] Replace config reading with `getDiscoveryTargets('snmp')`
  - [ ] Integration tests

- [ ] **Update BACnet Discovery** (4h)
  - [ ] Replace config reading with `getDiscoveryTargets('bacnet')`
  - [ ] Integration tests

- [ ] **Test Boot & Scheduled Discovery** (4h)
  - [ ] Boot discovery (`first_boot` trigger with validation)
  - [ ] Scheduled discovery (`scheduled` trigger without validation)
  - [ ] Verify intervals work correctly

---

## Week 2: Dashboard & API

### Day 1-2: Dashboard UI

- [ ] **Update Sensor Schemas** (4h)
  - [ ] `dashboard/src/schemas/sensor-schemas.ts`:
    - Add `DiscoveryTargetSchema`
    - Add `isDiscoveryTarget`, `source`, `discoveryConfig` fields
    - Update `ModbusConnectionSchema` with `slaveRange`

- [ ] **Add Discovery Targets Tab** (8h)
  - [ ] `dashboard/src/pages/SensorsPage.tsx`:
    - Add Tabs component
    - Add "Devices" tab (existing table, filter `!isDiscoveryTarget`)
    - Add "Discovery Targets" tab (new table, filter `isDiscoveryTarget`)

- [ ] **Create Discovery Target Table** (6h)
  - [ ] `dashboard/src/components/sensors/DiscoveryTargetsTable.tsx`
  - [ ] Columns: Name, Protocol, Target, Scan Interval, Status, Actions
  - [ ] Edit/Delete actions

### Day 3-4: Discovery Target Dialogs

- [ ] **Add Discovery Target Dialog** (12h)
  - [ ] `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx`
  - [ ] ModbusDiscoveryForm (connection + slave range + scan interval)
  - [ ] OPCUADiscoveryForm (URL + scan interval)
  - [ ] SNMPDiscoveryForm (IP ranges + scan interval)
  - [ ] Form validation

- [ ] **Edit Discovery Target Dialog** (6h)
  - [ ] Copy AddDiscoveryTargetDialog
  - [ ] Pre-populate with existing values
  - [ ] PUT endpoint integration

### Day 5: API Endpoints

- [ ] **Create API Endpoints** (8h)
  - [ ] `api/src/routes/device-sensors.ts`:
    - `POST /api/v1/devices/:uuid/discovery-targets`
    - `PUT /api/v1/devices/:uuid/discovery-targets/:name`
    - `DELETE /api/v1/devices/:uuid/discovery-targets/:name`
  - [ ] Set `isDiscoveryTarget: true` flag
  - [ ] Dual-write to PostgreSQL + target_state JSON

- [ ] **E2E Testing** (8h)
  - [ ] Create Modbus discovery target
  - [ ] Create OPC-UA discovery target
  - [ ] Edit discovery target
  - [ ] Delete discovery target
  - [ ] Enable/disable discovery target
  - [ ] Verify agent picks up changes

---

## Week 3: Cleanup & Documentation

### Day 1-2: Remove protocols{}

- [ ] **Remove Legacy Code** (6h)
  - [ ] `agent/src/config/agent-config.ts`:
    - Remove `getModbusConfig()`, `getOPCUAConfig()` methods
    - Remove all `this.cloudConfig.protocols` references
  - [ ] `agent/src/bootstrap/init.ts`:
    - Remove protocol adapter config building (lines 390-450)
  - [ ] Run full test suite

- [ ] **Clean target-state.json** (2h)
  - [ ] Remove `protocols{}` section
  - [ ] Test boot discovery
  - [ ] Test scheduled discovery

### Day 3-4: Documentation

- [ ] **Update Documentation** (8h)
  - [ ] README.md - Remove `protocols{}` examples
  - [ ] Configuration guide - Show only `endpoints[]` format
  - [ ] Add discovery target configuration examples
  - [ ] Update troubleshooting guide
  - [ ] Add discovery scheduling documentation

### Day 5: Final Testing & Polish

- [ ] **Full Integration Testing** (8h)
  - [ ] Complete workflow: Add discovery target → Agent scans → Device found → User enables → Add data points
  - [ ] Test all protocols (Modbus, OPC-UA, SNMP, BACnet)
  - [ ] Performance: < 5 min for 100 devices
  - [ ] No regressions

- [ ] **Code Review & Cleanup** (4h)
  - [ ] Remove dead code
  - [ ] Add code comments
  - [ ] Update type documentation
  - [ ] Final PR review

---

## Testing Checklist

### Unit Tests
- [ ] `getDiscoveryTargets()` filters by protocol
- [ ] `getDiscoveryTargets()` filters by `isDiscoveryTarget`
- [ ] `getDiscoveryTargets()` excludes disabled targets
- [ ] `normalizeDiscoveryTarget()` handles all protocols

### Integration Tests
- [ ] Modbus discovery works with endpoints[] config
- [ ] OPC-UA discovery works with endpoints[] config
- [ ] SNMP discovery works with endpoints[] config
- [ ] BACnet discovery works with endpoints[] config
- [ ] Boot discovery runs on startup
- [ ] Scheduled discovery runs on interval

### E2E Tests
- [ ] Add discovery target via dashboard
- [ ] Agent picks up new discovery target
- [ ] Discovery finds devices
- [ ] Discovered devices appear in dashboard (disabled)
- [ ] User enables device + adds data points
- [ ] Device becomes operational

---

## Success Criteria

**Week 1**:
- ✅ Agent reads discovery targets from `endpoints[]`
- ✅ All discovery plugins updated
- ✅ Boot & scheduled discovery work

**Week 2**:
- ✅ Dashboard "Discovery Targets" tab works
- ✅ API endpoints functional
- ✅ E2E tests passing

**Week 3**:
- ✅ No `protocols{}` code remaining
- ✅ Documentation complete
- ✅ All tests green

**Final**:
- ✅ Discovery success rate maintained
- ✅ Performance < 5 min for 100 devices
- ✅ Clean, maintainable code

---

## Key Files to Modify

| File | Changes |
|------|---------|
| `agent/src/features/endpoints/types.ts` | Add discovery fields |
| `agent/src/config/agent-config.ts` | Add `getDiscoveryTargets()` |
| `agent/src/features/discovery/modbus.discovery.ts` | Use new config method |
| `agent/src/features/discovery/opcua.discovery.ts` | Use new config method |
| `agent/src/features/discovery/snmp.discovery.ts` | Use new config method |
| `agent/src/features/discovery/bacnet.discovery.ts` | Use new config method |
| `dashboard/src/schemas/sensor-schemas.ts` | Add discovery schemas |
| `dashboard/src/pages/SensorsPage.tsx` | Add Discovery Targets tab |
| `dashboard/src/components/sensors/AddDiscoveryTargetDialog.tsx` | NEW - Create dialog |
| `api/src/routes/device-sensors.ts` | Add discovery target endpoints |
| `target-state.json` | Remove `protocols{}` section |

---

## Discovery Scheduling (Preserved)

**Boot Discovery**: `first_boot` trigger with validation
**Scheduled Discovery**: `scheduled` trigger without validation
**Manual Discovery**: User-triggered via API/dashboard

**Intervals** (from target_state):
```json
{
  "intervals": {
    "discovery": {
      "fullIntervalMs": 86400000,    // 24 hours
      "lightIntervalMs": 14400000    // 4 hours
    }
  }
}
```

**No changes needed** to discovery scheduling logic - just the config source.

---

## Next Steps

1. [ ] Create feature branch `feature/endpoints-discovery`
2. [ ] Start Day 1: Update TypeScript types
3. [ ] Daily standups to track progress
4. [ ] PR reviews after each week
5. [ ] Deploy to staging after Week 2
6. [ ] Deploy to production after Week 3

---

**Last Updated**: 2025-01-21
**Status**: ✅ Ready to Start
**Complexity**: Simple (no backward compatibility)
