# Gradual Device Enablement - Implementation Plan

## Problem Statement

**Scenario**: Agent with 40 modbus devices crashes with OOMKill before publishing any data.

**Current Behavior**:
1. Discovery runs and finds 40 modbus devices
2. Saves all 40 to SQLite with `enabled: true` (because `MODBUS_ENABLED=true`)
3. Adapter loads all 40 devices at startup
4. Memory exhaustion during initialization → OOMKill

**Root Cause**: Discovery saves devices as `enabled: true` based on protocol config, causing immediate load spike during adapter initialization.

---

## Solution Overview

**Strategy**: Decouple discovery from enablement
- Discovery finds and saves all devices as **disabled**
- Gradual enablement service activates them one-by-one with jitter
- Adapter reloads incrementally as each device is enabled

**Benefits**:
- Spreads initialization load over 5-10 minutes instead of all at once
- Allows measuring memory impact incrementally
- Prevents startup OOM
- Can be paused/adjusted based on metrics

---

## Implementation Phases

### Phase 1: Discovery Save Override (MINIMAL CODE CHANGE)

**Goal**: Make discovery save all devices as disabled regardless of protocol config.

**Code Change**: `agent/src/features/discovery/discovery-service.ts`

```typescript
private isProtocolEnabled(protocol: string): boolean {
  // Override: Save all discovered devices as disabled for gradual enablement
  if (process.env.DISCOVERY_SAVE_DISABLED === 'true') {
    return false;
  }
  
  // ... existing logic
}
```

**Configuration**:
```bash
DISCOVERY_SAVE_DISABLED=true  # Save devices as disabled
ENABLE_FIRST_BOOT_DISCOVERY=true  # Run discovery
```

**Expected Result**:
- Discovery runs and finds 40 devices
- All saved to SQLite with `enabled: false`
- Adapter starts with 0 enabled devices
- No polling, no OOM

**Testing**:
```bash
# Run locally
cd agent
DISCOVERY_SAVE_DISABLED=true \
MODBUS_ENABLED=true \
MODBUS_TCP_HOST=localhost \
MODBUS_SLAVE_RANGE_START=1 \
MODBUS_SLAVE_RANGE_END=10 \
npm run dev

# Verify in SQLite
sqlite3 data/agent.db "SELECT name, protocol, enabled FROM device_endpoints;"
# Expected: All devices with enabled=0
```

---

### Phase 2: Device Enabler Service (NEW SERVICE)

**Goal**: Gradually enable disabled devices with configurable jitter.

**New File**: `agent/src/features/endpoints/device-enabler.ts`

**Key Features**:
- Runs after discovery completes
- Enables devices one-by-one (or batches)
- Random jitter between min/max interval
- Emits events for each enablement
- Stops when all devices enabled

**Configuration**:
```bash
DEVICE_ENABLER_ENABLED=true        # Enable gradual activation
DEVICE_ENABLER_MIN_INTERVAL=5000   # 5s min jitter
DEVICE_ENABLER_MAX_INTERVAL=15000  # 15s max jitter
DEVICE_ENABLER_BATCH_SIZE=1        # Enable 1 device at a time
```

**Flow**:
```
Discovery Complete (40 devices, all disabled)
    ↓
DeviceEnabler starts
    ↓
Enable 1 device → Wait 5-15s → Enable next → Wait 5-15s → ...
    ↓                ↓                ↓
Emit event    Emit event       Emit event
    ↓                ↓                ↓
Adapter reload  Adapter reload  Adapter reload
```

**Events**:
- `device-enabled`: Single device enabled (triggers adapter reload)
- `all-devices-enabled`: All devices activated (stops service)

---

### Phase 3: Bootstrap Integration (WIRE IT UP)

**Goal**: Integrate DeviceEnabler into agent bootstrap.

**Code Change**: `agent/src/bootstrap/init.ts`

```typescript
// Listen for discovery-complete event
discoveryService.on('discovery-complete', async (data) => {
  // If devices were saved as disabled, start gradual enablement
  if (process.env.DEVICE_ENABLER_ENABLED === 'true' && data.savedCount > 0) {
    const enabler = new DeviceEnabler({
      enabled: true,
      minInterval: parseInt(process.env.DEVICE_ENABLER_MIN_INTERVAL || '5000'),
      maxInterval: parseInt(process.env.DEVICE_ENABLER_MAX_INTERVAL || '15000'),
      batchSize: parseInt(process.env.DEVICE_ENABLER_BATCH_SIZE || '1'),
      protocols: ['modbus', 'opcua', 'snmp', 'mqtt']
    }, logger);
    
    // Listen for individual device enables
    enabler.on('device-enabled', async (event) => {
      logger.info(`Device ${event.name} enabled (${event.remaining} remaining)`);
      
      // Reload adapter to pick up newly enabled device
      if (features.sensors) {
        await features.sensors.stop();
        features.sensors = undefined;
      }
      features.sensors = await initializeProtocolAdapters(context);
    });
    
    await enabler.start();
  }
});
```

---

## Testing Strategy

### Test 1: Discovery Only (Baseline)

**Setup**:
```bash
DISCOVERY_SAVE_DISABLED=true
ENABLE_FIRST_BOOT_DISCOVERY=true
MODBUS_TCP_HOST=localhost
MODBUS_SLAVE_RANGE_START=1
MODBUS_SLAVE_RANGE_END=10
```

**Expected**:
- Agent starts successfully
- Discovery finds 10 devices
- All saved as disabled
- Adapter polls 0 devices
- Memory usage low (~200-300Mi)

**Verification**:
```bash
# Check SQLite
sqlite3 data/agent.db "SELECT COUNT(*) FROM device_endpoints WHERE enabled=1;"
# Expected: 0

sqlite3 data/agent.db "SELECT COUNT(*) FROM device_endpoints WHERE enabled=0;"
# Expected: 10
```

---

### Test 2: Manual Enablement (Adapter Reload)

**Goal**: Verify adapter reloads when device enabled manually.

**Steps**:
1. Run Test 1 (all devices disabled)
2. Manually enable 1 device:
   ```bash
   sqlite3 data/agent.db "UPDATE device_endpoints SET enabled=1 WHERE name='modbus-localhost-1';"
   ```
3. Trigger adapter reload via API or restart agent

**Expected**:
- Adapter now polls 1 device
- Memory usage increases slightly
- Data published to MQTT

---

### Test 3: Gradual Enablement (Full Flow)

**Setup**:
```bash
DISCOVERY_SAVE_DISABLED=true
ENABLE_FIRST_BOOT_DISCOVERY=true
DEVICE_ENABLER_ENABLED=true
DEVICE_ENABLER_MIN_INTERVAL=5000
DEVICE_ENABLER_MAX_INTERVAL=10000
DEVICE_ENABLER_BATCH_SIZE=1
MODBUS_TCP_HOST=localhost
MODBUS_SLAVE_RANGE_START=1
MODBUS_SLAVE_RANGE_END=10
```

**Expected Timeline**:
```
T+0s:     Agent starts
T+10s:    Discovery completes (10 devices saved as disabled)
T+15s:    Device 1 enabled (first jitter: 5-10s)
T+23s:    Device 2 enabled (jitter: 5-10s after previous)
T+30s:    Device 3 enabled
...
T+120s:   Device 10 enabled
T+120s:   All devices enabled, enabler stops
```

**Monitoring**:
```bash
# Watch memory in real-time
watch -n 1 'ps aux | grep agent'

# Watch SQLite enabled count
watch -n 2 'sqlite3 data/agent.db "SELECT COUNT(*) FROM device_endpoints WHERE enabled=1;"'

# Watch logs
tail -f logs/agent.log | grep -E "device-enabled|Device enabled"
```

---

### Test 4: Load Test (40 Devices)

**Setup**:
```bash
DISCOVERY_SAVE_DISABLED=true
DEVICE_ENABLER_ENABLED=true
DEVICE_ENABLER_MIN_INTERVAL=3000   # Faster for testing
DEVICE_ENABLER_MAX_INTERVAL=5000
DEVICE_ENABLER_BATCH_SIZE=2        # Enable 2 at a time
MODBUS_SLAVE_RANGE_START=1
MODBUS_SLAVE_RANGE_END=40
```

**Expected Timeline**:
```
T+0s:     Agent starts
T+15s:    Discovery completes (40 devices)
T+18s:    Devices 1-2 enabled
T+22s:    Devices 3-4 enabled
T+26s:    Devices 5-6 enabled
...
T+~2min:  All 40 devices enabled
```

**Success Criteria**:
- ✅ No OOMKill during entire process
- ✅ Memory increases gradually (not spike)
- ✅ All 40 devices eventually enabled
- ✅ All devices publishing data

**Failure Scenarios**:
- OOMKill before all enabled → Reduce batch size or increase jitter
- Memory stays high → Possible memory leak, investigate
- Some devices never enable → Check enabler logs

---

## Configuration Reference

### Discovery Override

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOVERY_SAVE_DISABLED` | `false` | If `true`, save all discovered devices as disabled |

### Device Enabler

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVICE_ENABLER_ENABLED` | `false` | Enable gradual device activation |
| `DEVICE_ENABLER_MIN_INTERVAL` | `5000` | Minimum ms between enables (5s) |
| `DEVICE_ENABLER_MAX_INTERVAL` | `30000` | Maximum ms between enables (30s) |
| `DEVICE_ENABLER_BATCH_SIZE` | `1` | Number of devices to enable per batch |

---

## Expected Memory Profile

### Without Gradual Enablement (Current)

```
Memory (Mi)
  500 |                    💥 OOMKill (512Mi limit)
      |                   /|
  400 |                 / |
      |               /   |
  300 |             /     |
      |           /       |
  200 |         /         |
      |       /           |
  100 |     /             |
      |___/______________ |_________________
       0   10   20   30   40 devices
       Startup → Discovery → Init all 40 → Crash
```

### With Gradual Enablement (Target)

```
Memory (Mi)
  500 |
      |                                    
  400 |                                   _____ Plateau
      |                              ____/
  300 |                        _____/
      |                   ____/
  200 |              ____/
      |         ____/
  100 |    ____/
      |___/___________________________________________
       0   1min   2min   3min   4min   5min
       Startup → Discovery → Enable 1 → 2 → 3... → 40
```

**Key Differences**:
- **Slope**: Gradual vs instant
- **Peak**: Never exceeds limit
- **Observability**: Can measure per-device impact

---

## Rollback Plan

If gradual enablement causes issues:

1. **Disable the feature**:
   ```bash
   DEVICE_ENABLER_ENABLED=false
   ```

2. **Revert to normal discovery**:
   ```bash
   DISCOVERY_SAVE_DISABLED=false
   ```

3. **Manually enable all devices**:
   ```bash
   sqlite3 data/agent.db "UPDATE device_endpoints SET enabled=1;"
   ```

4. **Restart agent**

---

## Success Metrics

### Phase 1 (Discovery Override)
- ✅ Discovery saves devices as `enabled=0`
- ✅ Adapter starts with 0 polling devices
- ✅ No OOMKill

### Phase 2 (Device Enabler)
- ✅ Devices enabled incrementally
- ✅ Events emitted for each enable
- ✅ Service stops when complete

### Phase 3 (Integration)
- ✅ Adapter reloads after each enable
- ✅ Newly enabled devices start polling
- ✅ Data published to MQTT

### Phase 4 (Load Test)
- ✅ 40 devices enabled without OOM
- ✅ Memory stays under limit
- ✅ All devices publishing data
- ✅ No performance degradation

---

## Next Steps

1. **Review this plan** with team
2. **Implement Phase 1** (discovery override) - minimal change
3. **Test locally** with 10 devices
4. **Implement Phase 2** (enabler service) - if Phase 1 succeeds
5. **Test with 20 devices** - measure memory impact
6. **Implement Phase 3** (integration) - wire it up
7. **Load test with 40 devices** - final validation
8. **Deploy to K8s** - production testing

---

## Open Questions

1. **Should enabler persist state?** (survive restarts)
   - Pro: Resume where left off after crash
   - Con: More complexity

2. **Should we support dynamic adjustment?** (change jitter based on memory)
   - Pro: Self-adaptive load shedding
   - Con: Complex logic

3. **Should we add priority?** (enable critical devices first)
   - Pro: Important devices come online faster
   - Con: Need priority metadata

4. **Should we support manual pause/resume?** (via API)
   - Pro: Manual control during issues
   - Con: More API surface

---

## Alternative Approaches Considered

### A. Increase memory limits (REJECTED)
- **Problem**: Masks root cause, doesn't scale
- **Why rejected**: Want to support resource-constrained edge devices

### B. Reduce concurrency (PARTIAL SOLUTION)
- **Problem**: Only slows initialization, still OOMs
- **Why partial**: Helps but doesn't eliminate spike

### C. Lazy initialization (COMPLEX)
- **Problem**: Initialize devices only when first polled
- **Why rejected**: Complex refactor, unclear benefits

### D. External orchestration (OVERKILL)
- **Problem**: Use Kubernetes Job to enable devices
- **Why rejected**: Too complex for this problem

**Chosen approach (Gradual Enablement)** is simple, effective, and testable.
