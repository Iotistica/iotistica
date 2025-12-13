# Dynamic Sensor Publish Enablement

## Current Behavior Analysis

### Discovery Flow
1. **Discovery runs** → Finds Modbus devices (slave IDs 1-10)
2. **Saves to database** → Creates `device_endpoints` with:
   - `enabled = isProtocolEnabled(protocol)` (checks if Modbus enabled in config)
   - Currently: `enabled = true` if `protocols.modbus.enabled = true`
3. **Sensor Publish initialization** → Reads enabled endpoints at startup only
4. **Problem**: If discovery runs after Sensor Publish starts, new endpoints not loaded

### Code References

**Discovery saves with enabled flag**: [discovery-service.ts:870](agent/src/features/discovery/discovery-service.ts#L870)
```typescript
const deviceSensor: DeviceEndpoint = {
  name: sensor.name,
  protocol: sensor.protocol as 'modbus' | 'can' | 'opcua',
  enabled: this.isProtocolEnabled(sensor.protocol), // ← Checks protocol config
  poll_interval: 5000,
  connection: sensor.connection,
  data_points: sensor.dataPoints || [],
  lastSeenAt: new Date(),
  metadata: { ... }
};
```

**isProtocolEnabled checks config**: [discovery-service.ts:426-443](agent/src/features/discovery/discovery-service.ts#L426-L443)
```typescript
private isProtocolEnabled(protocol: string): boolean {
  switch (protocol) {
    case 'modbus':
      return this.agentConfig.getModbusConfig().enabled ?? false;
    case 'opcua':
      return this.agentConfig.getOPCUAConfig().enabled ?? false;
    // ...
  }
}
```

**Sensor Publish loads once**: [init.ts:154-248](agent/src/bootstrap/init.ts#L154-L248)
```typescript
private async initSensorPublish(): Promise<void> {
  // Get all enabled protocols from database
  const allEndpoints = await DeviceEndpointModel.getAll();
  const enabledEndpoints = new Set(
    allEndpoints.filter((s: any) => s.enabled).map((s: any) => s.protocol)
  );
  
  // Build sensor configs only for enabled protocols
  const endpoints = endpointOutputs
    .filter(output => enabledEndpoints.has(output.protocol))
    .map((output) => ({ ... }));
  
  // Start sensor publish (no reload mechanism)
  await this.features.sensorPublish.start();
}
```

## Root Cause

**Discovery already enables devices automatically** - the `enabled` flag is set based on protocol config. The real issue is that **Sensor Publish doesn't reload when new endpoints are discovered**.

## Solution Options

### Option 1: Reload Sensor Publish on Discovery Events (Recommended)

Add event-driven reload when discovery saves new enabled endpoints.

**Implementation**:

1. **Emit event when new endpoints are saved** (discovery-service.ts):
```typescript
// After DeviceEndpointModel.create()
if (deviceSensor.enabled) {
  this.emit('endpoint-enabled', { protocol: sensor.protocol, endpoint: deviceSensor });
}
```

2. **Listen for events and reload Sensor Publish** (init.ts):
```typescript
// In initializeFeatures()
if (this.features.discoveryService) {
  this.features.discoveryService.on('endpoint-enabled', async (data) => {
    this.logger?.infoSync('New enabled endpoint discovered, reloading Sensor Publish', {
      component: LogComponents.agent,
      protocol: data.protocol,
      endpoint: data.endpoint.name
    });
    
    // Reload Sensor Publish
    if (this.features.sensorPublish) {
      await this.features.sensorPublish.stop();
    }
    await this.initSensorPublish();
  });
}
```

**Pros**:
- Instant reload when new devices discovered
- No polling overhead
- Clean event-driven architecture
- No restart needed

**Cons**:
- Requires adding EventEmitter to DiscoveryService
- More complex implementation

### Option 2: Poll Database for Changes (Simple)

Add periodic check for new enabled endpoints.

**Implementation**:

```typescript
// In init.ts
private async startEndpointWatcher(): Promise<void> {
  const POLL_INTERVAL = 60000; // Check every minute
  let knownEndpoints = new Set<string>();
  
  setInterval(async () => {
    try {
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      const allEndpoints = await DeviceEndpointModel.getAll();
      const enabledEndpoints = allEndpoints
        .filter((e: any) => e.enabled)
        .map((e: any) => e.name);
      
      const currentEndpoints = new Set(enabledEndpoints);
      
      // Check for new enabled endpoints
      const newEndpoints = enabledEndpoints.filter(name => !knownEndpoints.has(name));
      
      if (newEndpoints.length > 0) {
        this.logger?.infoSync('New enabled endpoints detected, reloading Sensor Publish', {
          component: LogComponents.agent,
          newEndpoints
        });
        
        // Reload Sensor Publish
        if (this.features.sensorPublish) {
          await this.features.sensorPublish.stop();
        }
        await this.initSensorPublish();
      }
      
      knownEndpoints = currentEndpoints;
    } catch (error) {
      this.logger?.errorSync('Error watching endpoints', error as Error, {
        component: LogComponents.agent
      });
    }
  }, POLL_INTERVAL);
}

// Call in initializeFeatures()
await this.startEndpointWatcher();
```

**Pros**:
- Simple implementation
- No architectural changes
- Easy to understand

**Cons**:
- Up to 1 minute delay before reload
- Continuous polling overhead
- Less efficient

### Option 3: Cloud-Triggered Reload (Existing Mechanism)

Use existing protocol config change handler.

**Current implementation**: [init.ts:421-452](agent/src/bootstrap/init.ts#L421-L452)
```typescript
private async handleProtocolConfigChanges(change: { old: any; new: any }): Promise<void> {
  // ... existing code ...
  
  // This already reloads Sensor Publish when protocol config changes!
  if (this.features.sensors) {
    if (this.features.sensorPublish) {
      await this.features.sensorPublish.stop();
    }
    await this.initSensorPublish();
  }
}
```

**How to use**:
1. Discovery saves devices with `enabled = true` (already working)
2. From cloud/dashboard, trigger protocol config update (even just toggling enabled flag)
3. Agent detects change and reloads Sensor Publish

**Pros**:
- Already implemented
- Works with cloud target state
- No agent code changes needed

**Cons**:
- Requires cloud/dashboard action
- Not fully automatic
- User must know to trigger reload

### Option 4: Hybrid - Event + Fallback Polling

Combine Option 1 and Option 2 for best reliability.

**Implementation**:
- Primary: Event-driven reload (instant)
- Fallback: Poll every 5 minutes (catch missed events)

## Recommended Approach

**Option 1 (Event-Driven) + Option 3 (Cloud-Triggered)**

This combination provides:
1. **Automatic local reload** when discovery finds devices (event-driven)
2. **Manual cloud reload** as backup (existing mechanism)
3. **No polling overhead** (efficient)
4. **Instant response** (user-friendly)

### Implementation Steps

1. **Make DiscoveryService emit events**:
```typescript
// agent/src/features/discovery/discovery-service.ts
import { EventEmitter } from 'events';

export class DiscoveryService extends EventEmitter {
  // ... existing code ...
  
  private async saveDevices(discovered: DiscoveredDevice[], traceId: string): Promise<void> {
    // ... existing save logic ...
    
    if (deviceSensor.enabled) {
      // Emit event for enabled endpoints
      this.emit('endpoint-enabled', {
        protocol: sensor.protocol,
        endpoint: deviceSensor
      });
    }
    
    await DeviceEndpointModel.create(deviceSensor);
  }
}
```

2. **Listen and reload in bootstrap**:
```typescript
// agent/src/bootstrap/init.ts
private async initializeFeatures(): Promise<void> {
  // ... existing init code ...
  
  // Watch for new enabled endpoints from discovery
  if (this.features.discoveryService) {
    this.features.discoveryService.on('endpoint-enabled', async (data) => {
      const { logger } = this.context;
      
      logger.infoSync('New enabled endpoint discovered, reloading Sensor Publish', {
        component: LogComponents.agent,
        protocol: data.protocol,
        endpoint: data.endpoint.name
      });
      
      // Reload Sensor Publish with new endpoints
      if (this.features.sensorPublish) {
        try {
          await this.features.sensorPublish.stop();
          logger.debugSync('Stopped Sensor Publish for reload', {
            component: LogComponents.agent
          });
        } catch (error) {
          logger.warnSync('Error stopping Sensor Publish', {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.features.sensorPublish = undefined;
      }
      
      // Reinitialize with new endpoints
      await this.initSensorPublish();
    });
  }
}
```

3. **Test the flow**:
```bash
# Start agent
npm run dev

# Discovery runs (scheduled or manual)
# → Finds 3 Modbus devices
# → Saves with enabled=true
# → Emits 'endpoint-enabled' event
# → Sensor Publish reloads automatically
# → Starts publishing from new devices

# No restart needed!
```

## Alternative: Change Discovery to Always Enable

If you want **all discovered devices enabled by default**:

```typescript
// agent/src/features/discovery/discovery-service.ts:870
const deviceSensor: DeviceEndpoint = {
  name: sensor.name,
  protocol: sensor.protocol as 'modbus' | 'can' | 'opcua',
  enabled: true, // ← Always enable discovered devices
  poll_interval: 5000,
  connection: sensor.connection,
  data_points: sensor.dataPoints || [],
  // ...
};
```

Then use Option 1 to reload Sensor Publish when new enabled endpoints appear.

## Summary

**Current state**: Discovery already enables devices automatically based on protocol config
**Issue**: Sensor Publish doesn't reload when new devices are discovered
**Best solution**: Add event listener to reload Sensor Publish when discovery saves new enabled endpoints
**Effort**: ~50 lines of code, no architectural changes
**Benefit**: Fully automatic, no restart needed, instant response
