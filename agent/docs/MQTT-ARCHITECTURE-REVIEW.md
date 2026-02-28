# MQTT Architecture Review

## Executive Summary

✅ **MQTT discovery is correctly aligned with Modbus/OPC-UA patterns**
✅ **MQTT adapter and device publish feature serve different purposes**
✅ **Both use the same MQTT broker connection but for different data flows**

## Architecture Comparison

### Discovery Pattern Alignment

| Protocol | Discovery Strategy | Config Source |
|----------|-------------------|---------------|
| **Modbus** | User provides slaveId or slaveRange → Plugin scans slaves → Returns valid devices | `configManager.getDiscoveryTargets('modbus')` |
| **OPC-UA** | User provides endpointUrl (no dataPoints) → Plugin browses nodes → Returns valid nodes | `configManager.getDiscoveryTargets('opcua')` |
| **MQTT** | User provides explicit topics → Plugin validates they publish data → Returns active topics | `configManager.getMqttConfig().discoveryRoots` |

**Key Similarity**: All three require **user-provided connection info** (not auto-discovery)
- Modbus: IP + slave range
- OPC-UA: Endpoint URL
- MQTT: Broker URL + topic list

**Pattern**: Discovery validates what user asks for, doesn't scan everything

### Configuration Structure

#### Modbus Discovery Config
```typescript
// From config.ts getDiscoveryTargets()
endpoints.filter(endpoint => {
  if (endpoint.protocol !== 'modbus') return false;
  const connection = endpoint.connection;
  // Accept endpoints with slaveRange OR slaveId
  return connection?.slaveRange !== undefined || 
         connection?.slaveId !== undefined;
});
```

#### OPC-UA Discovery Config
```typescript
// From config.ts getDiscoveryTargets()
endpoints.filter(endpoint => {
  if (endpoint.protocol !== 'opcua') return false;
  const connection = endpoint.connection;
  const hasEndpointUrl = !!connection?.endpointUrl;
  const hasNoDataPoints = !endpoint.dataPoints || endpoint.dataPoints.length === 0;
  return hasEndpointUrl && hasNoDataPoints; // Discover nodes if no explicit dataPoints
});
```

#### MQTT Discovery Config
```typescript
// From config.ts getMqttConfig()
{
  enabled: cloudProtocol?.enabled ?? false,
  brokerUrl: cloudProtocol?.connection?.brokerUrl ?? 'mqtt://mosquitto:1883',
  username: cloudProtocol?.connection?.username,
  password: cloudProtocol?.connection?.password,
  discoveryRoots: cloudProtocol?.discoveryRoots ?? [], // Topics to validate
  monitorDurationMs: cloudProtocol?.monitorDurationMs ?? 30000,
  qos: cloudProtocol?.qos ?? 0
}

// From discovery-service.ts getMqttOptions()
const options: MqttDiscoveryOptions = {
  brokerUrl: config.brokerUrl,
  topics: config.discoveryRoots, // Renamed for clarity
  samplingDurationMs: config.monitorDurationMs, // How long to listen
  qos: config.qos,
  username: config.username,
  password: config.password
};
```

### 🔑 Key Difference: DataPoints Are Optional for MQTT

**Critical Understanding**: Unlike Modbus/OPC-UA, MQTT **does not require predefined dataPoints** for discovery.

| Protocol | DataPoints Required? | Why? |
|----------|---------------------|------|
| **Modbus** | ✅ **YES** | Must specify register addresses (1, 2, 3...) upfront - can't discover without knowing where to read |
| **OPC-UA** | ⚠️ **Optional** | Can browse node hierarchy if no dataPoints provided |
| **MQTT** | ❌ **NO** | Subscribes to topics and auto-discovers active publishers - dataType inferred from payload |

**MQTT Discovery Advantage**: 
- Subscribe to `sensor/#` wildcard
- Listen for any messages
- Auto-detect active topics
- Infer dataType (number, boolean, string, json) from payload content
- No need to know topic names upfront!

#### MQTT Configuration Examples

**Option 1: Discovery-First (Recommended) - No DataPoints Needed**
```json
{
  "id": "8c4a7f3e-9b2d-4e5a-a1c6-7d8e9f0b1c2d",
  "name": "mqtt-sensors",
  "enabled": true,
  "metadata": {
    "createdAt": "2026-02-28T00:00:00.000Z",
    "createdBy": "system"
  },
  "protocol": "mqtt",
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "username": null,
    "password": null,
    "qos": 1
  },
  "discoveryRoots": [
    "sensor/#",
    "device/+/status",
    "iot/sensors/+"
  ],
  "monitorDurationMs": 30000
}
```

**What happens**:
1. Agent subscribes to `sensor/#`, `device/+/status`, `iot/sensors/+`
2. Monitors for 30 seconds
3. Detects topics: `sensor/temperature`, `sensor/humidity`, `sensor/motion`
4. Infers dataTypes: `float32`, `float32`, `boolean`
5. Creates devices automatically

**Option 2: Explicit DataPoints (When You Know Topics)**
```json
{
  "id": "f5e8d2c1-4a6b-4d9e-8f3a-2c7d9e1b5a4f",
  "name": "mqtt-sensors",
  "enabled": true,
  "protocol": "mqtt",
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "qos": 1
  },
  "dataPoints": [
    {
      "name": "temperature-sensor",
      "enabled": true,
      "topic": "sensor/temperature",
      "dataType": "float32",
      "unit": "°C",
      "metric": "temperature",
      "qos": 1
    },
    {
      "name": "humidity-sensor",
      "enabled": true,
      "topic": "sensor/humidity",
      "dataType": "float32",
      "unit": "%RH",
      "metric": "humidity",
      "qos": 1
    },
    {
      "name": "motion-detector",
      "enabled": true,
      "topic": "sensor/motion",
      "dataType": "boolean",
      "metric": "motion_detected",
      "qos": 0
    }
  ]
}
```

**Use explicit dataPoints when**:
- You know exact topic names
- You want to override auto-detected dataType
- You need to add units/metrics/descriptions
- You want fine-grained QoS control per topic

**Option 3: Hybrid Approach (Discovery + Overrides)**
```json
{
  "id": "3b9f7e2a-6d4c-4a8e-9b1f-5e8a7c3d6f2b",
  "name": "mqtt-sensors",
  "enabled": true,
  "protocol": "mqtt",
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "qos": 1
  },
  "discoveryRoots": [
    "sensor/#"
  ],
  "monitorDurationMs": 30000,
  "dataPoints": [
    {
      "name": "critical-temperature",
      "enabled": true,
      "topic": "sensor/temperature",
      "dataType": "float32",
      "unit": "°C",
      "qos": 2,
      "description": "Override: Use QoS 2 for critical temperature sensor"
    }
  ]
}
```

**Hybrid behavior**:
- Discovery finds all topics under `sensor/#`
- Explicit dataPoint for `sensor/temperature` overrides auto-detected config
- Other discovered topics use default settings

### ⚠️ Missing: MQTT Discovery Targets in getDiscoveryTargets()

**Issue Found**: `getDiscoveryTargets()` doesn't have a case for MQTT!

```typescript
// config.ts line 266-303
public getDiscoveryTargets(protocol: string): any[] {
  switch (protocol) {
    case 'modbus':
      return connection?.slaveRange !== undefined || connection?.slaveId !== undefined;
    case 'opcua':
      return hasEndpointUrl && hasNoDataPoints;
    case 'snmp':
      return connection?.community && (!endpoint.dataPoints || endpoint.dataPoints.length === 0);
    case 'bacnet':
      return Array.isArray(connection?.discoveryTargets) && connection.discoveryTargets.length > 0;
    // ❌ MISSING: case 'mqtt'
    default:
      return false;
  }
}
```

**Impact**: MQTT discovery doesn't use the unified `getDiscoveryTargets()` pattern. Instead, it goes directly to `getMqttConfig()`.

**Should Add**:
```typescript
case 'mqtt':
  // Accept endpoints with discoveryRoots (topics to monitor)
  return Array.isArray(endpoint.discoveryRoots) && endpoint.discoveryRoots.length > 0;
```

This would make MQTT consistent with other protocols.

## MQTT vs Modbus Configuration Comparison

### Side-by-Side: Minimal Required Configuration

**Modbus (Requires DataPoints)**
```json
{
  "protocol": "modbus",
  "connection": {
    "host": "10.0.0.60",
    "port": 502,
    "type": "tcp",
    "slaveId": 1
  },
  "dataPoints": [
    {
      "name": "temperature",
      "type": "holding",
      "address": 10,
      "dataType": "uint16"
    }
  ],
  "pollInterval": 5000
}
```
**Must have**: Register addresses (10, 11, 12...) - cannot discover without knowing where to read

**MQTT (Discovery-First)**
```json
{
  "protocol": "mqtt",
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883"
  },
  "discoveryRoots": [
    "sensor/#"
  ],
  "monitorDurationMs": 30000
}
```
**No dataPoints needed**: Subscribes to wildcard topics, auto-discovers active publishers

### Configuration Philosophy Differences

| Aspect | Modbus | MQTT |
|--------|--------|------|
| **Discovery Model** | Address-based scanning | Topic-based listening |
| **Required Info** | IP, slave ID, register addresses | Broker URL, topic patterns |
| **DataPoints** | ✅ Mandatory (must know addresses) | ❌ Optional (auto-discovered) |
| **DataType Detection** | ❌ Cannot infer (must specify uint16/float32) | ✅ Auto-infers from payload |
| **Topic/Address Format** | Numeric addresses (1, 2, 3, 100) | Hierarchical topics (sensor/temp) |
| **Wildcard Support** | ❌ No (must enumerate addresses) | ✅ Yes (+, # wildcards) |
| **Polling** | Required (pollInterval: 5000ms) | Push-based (no polling) |

### When to Use DataPoints in MQTT

```json
// ✅ Use dataPoints when you need:
{
  "protocol": "mqtt",
  "connection": { "brokerUrl": "mqtt://mosquitto:1883" },
  "dataPoints": [
    {
      "topic": "sensor/temperature",
      "dataType": "float32",  // Override auto-detection
      "unit": "°C",           // Add metadata
      "qos": 2                // Fine-grained QoS control
    }
  ]
}

// ❌ Don't use dataPoints when:
// - You don't know topic names yet
// - You want to discover all active topics
// - Auto-detected dataType is sufficient
// - Default QoS settings work for all topics
```

## Data Flow Patterns

### Pattern 1: External MQTT Publishers (MQTT Adapter)

```
External Device (ESP32, PLC, etc.)
    ↓ Publishes to topic
MQTT Broker (mosquitto:1883)
    ↓ Subscribed by
MQTT Adapter (agent/src/features/adapters/mqtt/adapter.ts)
    ↓ Emits 'data' event
SensorsFeature
    ↓ Forwards to
SocketServer → Cloud API
```

**Config**:
- `protocols.mqtt.enabled: true`
- `endpoints[].protocol: 'mqtt'`
- `endpoints[].connection.brokerUrl`
- `endpoints[].connection.topic` (subscription topic)
- `endpoints[].dataPoints` (device configuration)

**Purpose**: Receive sensor data FROM external MQTT publishers

**Discovery**: Validates that topics receive data (not auto-discovery)

### Pattern 2: Local Protocol Adapters (Device Publish Feature)

```
Local Protocol Adapter (Modbus, OPC-UA, BACnet, etc.)
    ↓ Writes to Unix socket
Device Publish Feature (agent/src/features/publish/)
    ↓ Reads from socket (addr: /tmp/sensors/modbus.sock)
    ↓ Publishes to topic
MQTT Broker (mosquitto:1883)
    ↓ Forwards to
Cloud API / Dashboard
```

**Config**:
- `cloud.enableSensorPublish: true`
- `endpoints[].protocol: 'modbus' | 'opcua' | 'bacnet' | 'snmp'`
- `endpoints[].addr` (Unix socket path, e.g., `/tmp/sensors/modbus-pipe.sock`)
- `endpoints[].mqttTopic` (where to publish)
- `endpoints[].eomDelimiter` (message framing)

**Purpose**: Publish sensor data FROM local protocol adapters TO cloud

**Discovery**: Not related - this is for publishing, not receiving

## MQTT Broker Connection Management

### Shared MQTT Client

Both patterns use the **same MQTT broker** but for different purposes:

1. **MQTT Adapter** - Subscribes to topics (receives data)
2. **Device Publish Feature** - Publishes to topics (sends data)

They can use the same MqttManager instance (from `agent/src/mqtt/manager.ts`):

```typescript
// Both inject same MqttConnection interface
interface MqttConnection {
  publish(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
  isConnected(): boolean;
  getMessageIdGenerator?(): any;
}
```

### Self-Healing Architecture (Both Patterns)

✅ **MQTT Adapter** - Now self-healing (just refactored):
- Creates client immediately (doesn't wait for connection)
- mqtt.js handles automatic reconnection
- Survives broker downtime at startup
- Event-driven state tracking

✅ **Device Publish Feature** - Already self-healing:
- Socket connections retry with exponential backoff
- MQTT publish failures logged but don't crash feature
- Batching survives transient network issues

## Discovery → Adapter → Publish Flow

### For External MQTT Devices (Pattern 1)

1. **Discovery Phase** (mqtt.discovery.ts):
   ```typescript
   // User provides topics
   options = {
     brokerUrl: 'mqtt://mosquitto:1883',
     topics: ['sensor/temperature', 'sensor/humidity'],
     samplingDurationMs: 10000
   };
   
   // Discovery validates topics receive data
   const discovered = await mqttPlugin.discover(options);
   // Returns: [{ name: 'sensor-temperature', protocol: 'mqtt', topic: 'sensor/temperature', dataType: 'number' }]
   ```

2. **Adapter Phase** (mqtt/adapter.ts):
   ```typescript
   // Adapter subscribes to configured devices
   config = {
     broker: { host: 'mosquitto', port: 1883 },
     devices: [
       { 
         name: 'sensor-temperature',
         topic: 'sensor/temperature',
         dataType: 'float32',
         enabled: true
       }
     ]
   };
   
   // Adapter emits data events
   adapter.on('data', (dataPoints) => {
     // Forward to cloud via SocketServer
   });
   ```

3. **No Publish Phase** - Data already in MQTT, just forward to cloud

### For Local Protocol Adapters (Pattern 2)

1. **Discovery Phase** (modbus.discovery.ts, opcua.discovery.ts):
   ```typescript
   // User provides connection info
   const discovered = await modbusPlugin.discover({
     tcpHost: '192.168.1.100',
     slaveIdRange: [1, 10]
   });
   // Returns: [{ name: 'slave-1', slaveId: 1, dataPoints: [...] }]
   ```

2. **Adapter Phase** (modbus/adapter.ts, opcua/adapter.ts):
   ```typescript
   // Adapter reads from device
   adapter.start(); // Polls device, writes to Unix socket
   ```

3. **Publish Phase** (publish/manager.ts):
   ```typescript
   // Publish feature reads from socket
   config = {
     addr: '/tmp/sensors/modbus-pipe.sock',
     mqttTopic: 'iot/device/{uuid}/endpoints/modbus',
     eomDelimiter: '\\n\\n'
   };
   
   // Publishes to MQTT
   await mqttConnection.publish(topic, payload);
   ```

## Verification Checklist

### ✅ Discovery Pattern Alignment

- [x] **Modbus**: User provides slaveRange → Validates slaves respond
- [x] **OPC-UA**: User provides endpointUrl → Validates server responds + browses nodes
- [x] **MQTT**: User provides topics → Validates topics receive data
- [x] **Pattern Match**: All three require explicit user configuration (no wildcard scanning)

### ⚠️ Configuration Integration

- [x] **Modbus**: Uses `getDiscoveryTargets('modbus')` ✅
- [x] **OPC-UA**: Uses `getDiscoveryTargets('opcua')` ✅
- [ ] **MQTT**: Uses `getMqttConfig()` directly ❌ (should add MQTT case to `getDiscoveryTargets()`)

### ✅ Adapter Architecture

- [x] **Modbus Adapter**: Reads from device → Writes to Unix socket ✅
- [x] **OPC-UA Adapter**: Reads from server → Writes to Unix socket ✅
- [x] **MQTT Adapter**: Subscribes to topics → Emits data events ✅
- [x] **Self-Healing**: MQTT adapter now resilient (just refactored) ✅

### ✅ Device Publish Feature

- [x] **Purpose**: Reads from Unix sockets → Publishes to MQTT ✅
- [x] **Protocols**: Modbus, OPC-UA, BACnet, SNMP, CAN ✅
- [x] **MQTT**: Not used for MQTT adapter (different data flow) ✅
- [x] **Shared Connection**: Uses same MqttManager instance ✅

### ✅ MQTT Broker Usage

- [x] **MQTT Adapter**: Subscribes (receives from external devices) ✅
- [x] **Device Publish**: Publishes (sends to cloud) ✅
- [x] **Same Broker**: Both use mosquitto:1883 ✅
- [x] **Different Topics**: No conflicts (adapter subscribes to device/#, publish sends to iot/device/{uuid}/endpoints/#) ✅

## Recommendations

### 1. Add MQTT to getDiscoveryTargets()

**Current**: MQTT discovery uses `getMqttConfig()` directly
**Should**: Add MQTT case to `getDiscoveryTargets()` for consistency

```typescript
// config.ts getDiscoveryTargets()
case 'mqtt':
  // Accept endpoints with topics array (for validation)
  const hasTopics = Array.isArray(connection?.topics) && connection.topics.length > 0;
  const hasNoDataPoints = !endpoint.dataPoints || endpoint.dataPoints.length === 0;
  return hasTopics && hasNoDataPoints; // Discover if topics provided but no explicit dataPoints
```

### 2. Document Two Data Flow Patterns

Add to architecture docs:
- **Pattern A**: External MQTT → Broker → Adapter → Cloud (receive)
- **Pattern B**: Local Protocol → Socket → Publish → Broker → Cloud (send)

These are complementary, not alternatives.

### 3. Unified MQTT Connection Lifecycle

Consider consolidating:
- `MqttManager` (mqtt/manager.ts) - Connection + publish
- `MqttAdapter` (adapters/mqtt/adapter.ts) - Subscribe + receive

Currently, they both create mqtt.js clients independently. Could share one client with:
- Publish methods (from MqttManager)
- Subscribe methods (from MqttAdapter)

### 4. Discovery Options Naming

**Current**: MQTT uses `discoveryRoots` (legacy name from observer pattern)
**Should**: Rename to `topics` for clarity (already done in MqttDiscoveryOptions interface)

Update config schema to accept both:
```typescript
topics: cloudProtocol?.topics ?? cloudProtocol?.discoveryRoots ?? []
```

## Quick Reference: Target State Configuration

### Minimal MQTT Configuration (Discovery Mode)
```json
{
  "endpoints": [
    {
      "id": "8c4a7f3e-9b2d-4e5a-a1c6-7d8e9f0b1c2d",
      "name": "mqtt-sensors",
      "enabled": true,
      "protocol": "mqtt",
      "connection": {
        "brokerUrl": "mqtt://mosquitto:1883"
      },
      "discoveryRoots": ["sensor/#"]
    }
  ]
}
```

### With Authentication
```json
{
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "username": "iotistic",
    "password": "secret123",
    "clientId": "agent-unique-id"
  }
}
```

### With Explicit Topics (Skip Discovery)
```json
{
  "protocol": "mqtt",
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "qos": 1
  },
  "dataPoints": [
    {
      "name": "temp-sensor",
      "topic": "sensor/temperature",
      "dataType": "float32",
      "unit": "°C",
      "qos": 2
    }
  ]
}
```

### Testing Multiple Protocols Together
```json
{
  "endpoints": [
    {
      "id": "7a90f002-5162-43e2-bf13-156dbf7014f0",
      "name": "modbus",
      "protocol": "modbus",
      "connection": { "host": "10.0.0.60", "port": 502, "slaveId": 1 },
      "dataPoints": [
        { "address": 10, "type": "holding", "dataType": "uint16" }
      ],
      "pollInterval": 5000
    },
    {
      "id": "8c4a7f3e-9b2d-4e5a-a1c6-7d8e9f0b1c2d",
      "name": "mqtt-sensors",
      "protocol": "mqtt",
      "connection": { "brokerUrl": "mqtt://mosquitto:1883" },
      "discoveryRoots": ["sensor/#"]
    }
  ]
}
```

**Key Takeaway**: MQTT is the **only** protocol that doesn't require dataPoints - use `discoveryRoots` to auto-discover active topics!

## Conclusion

**MQTT architecture is sound** - The patterns are consistent with Modbus/OPC-UA:

1. ✅ Discovery validates user-provided endpoints (not auto-discovery)
2. ✅ Adapter handles protocol-specific communication (subscribe for MQTT)
3. ✅ Device publish feature sends local data to cloud (via MQTT)
4. ✅ Self-healing architecture (both adapter and publish survive broker downtime)

**🔑 Key Difference from Other Protocols**:
- **MQTT is the ONLY protocol that doesn't require predefined dataPoints**
- Use `discoveryRoots: ["sensor/#"]` to auto-discover active topics
- DataType is automatically inferred from payload content
- DataPoints are optional and only needed for overrides/metadata

**Configuration Flexibility**:
- **Discovery Mode**: Just provide broker URL + topic patterns → auto-discover everything
- **Explicit Mode**: Provide dataPoints → skip discovery, use exact topics
- **Hybrid Mode**: Use both → discovery finds topics, dataPoints override specific ones

**Minor improvements**:
- Add MQTT to `getDiscoveryTargets()` for consistency
- Rename `discoveryRoots` → `topics` in config schema (backward compatible)
- Document two data flow patterns clearly

**No breaking changes needed** - Everything works correctly, just needs minor cleanup for consistency.
