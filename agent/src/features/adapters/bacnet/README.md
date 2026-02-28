# BACnet Adapter Implementation

## Overview
Created a complete BACnet adapter following the same architecture pattern as existing protocol adapters (Modbus, OPC-UA, SNMP, MQTT).

## Files Created

### 1. `agent/src/features/endpoints/bacnet/types.ts`
- **BACnetObjectType** enum: Common object types (analog-input, binary-value, etc.)
- **BACnetProperty** enum: Property identifiers (PRESENT_VALUE, DESCRIPTION, UNITS, etc.)
- **BACnetObject** schema: Configuration for individual BACnet points
- **BACnetDevice** schema: Device connection and polling configuration
- **BACnetAdapterConfig** schema: Top-level adapter configuration

### 2. `agent/src/features/endpoints/bacnet/client.ts`
- **BACnetClient** class: Wraps `bacstack` library
- **Methods**:
  - `connect()`: Establish connection to device (UDP-based)
  - `disconnect()`: Close connection
  - `readObject()`: Read single object's present value
  - `readObjects()`: Batch read multiple objects with concurrency control
- **Features**:
  - Timeout handling
  - Error handling with quality codes
  - Concurrent reads (configurable per device)

### 3. `agent/src/features/endpoints/bacnet/adapter.ts`
- **BACnetAdapter** class: Main coordinator for BACnet devices
- **Events emitted**:
  - `'started'`: Adapter initialized successfully
  - `'stopped'`: Adapter stopped
  - `'data'`: Emits SensorDataPoint[] for sensor-publish
  - `'device-connected'`: Device connected
  - `'device-disconnected'`: Device disconnected
  - `'device-error'`: Device error occurred
- **Features**:
  - Global poll loop (1-second tick)
  - Per-device poll intervals
  - Parallel device initialization with concurrency limits
  - Success rate tracking (last 100 polls)
  - Change detection (only emit when values change)
  - Automatic retry with exponential backoff
  - Device status tracking (connected, errors, response time)

### 4. `agent/src/features/endpoints/bacnet/index.ts`
- Exports all BACnet adapter types and classes

### 5. `agent/src/features/endpoints/index.ts` (Modified)
- Added BACnet imports
- Added `bacnet` to `SensorConfig` interface
- Added `startBACnetAdapter()` method
- Integrated BACnet adapter into main feature lifecycle

## Architecture

```
SensorsFeature (endpoints/index.ts)
  └── BACnetAdapter (bacnet/adapter.ts)
        ├── BACnetClient (bacnet/client.ts)  [Device 1]
        ├── BACnetClient (bacnet/client.ts)  [Device 2]
        └── BACnetClient (bacnet/client.ts)  [Device N]
              └── bacstack library (UDP read/write)

Data Flow:
1. BACnetAdapter polls devices on schedule
2. BACnetClient reads objects via bacstack
3. Adapter emits 'data' event with SensorDataPoint[]
4. SensorsFeature routes to SocketServer
5. Sensor-Publish reads from socket → publishes to MQTT
```

## Configuration Example

```typescript
{
  bacnet: {
    enabled: true,
    port: 47809,  // Agent's BACnet port (different from device port 47808)
    devices: [
      {
        name: "Condo-Building-1",
        ipAddress: "10.0.0.60",
        port: 47808,
        deviceInstance: 1001,
        enabled: true,
        pollIntervalMs: 5000,
        maxConcurrentReads: 5,
        objects: [
          {
            name: "Chiller-1 Supply Temp",
            objectType: "analog-input",
            objectInstance: 2,
            propertyId: 85,  // PRESENT_VALUE
            unit: "°C",
            enabled: true
          },
          {
            name: "AHU-1 Fan Status",
            objectType: "binary-input",
            objectInstance: 14,
            propertyId: 85,
            unit: "",
            enabled: true
          }
        ]
      }
    ],
    globalPollIntervalMs: 5000,
    maxConcurrentDevices: 10
  }
}
```

## Database Schema Required

The adapter expects devices in `device_endpoints` table with:

```sql
{
  "name": "Condo-Building-1",
  "protocol": "bacnet",
  "enabled": true,
  "connection": {
    "ipAddress": "10.0.0.60",
    "port": 47808,
    "deviceInstance": 1001,
    "maxConcurrentReads": 5,
    "connectionTimeoutMs": 5000,
    "retryAttempts": 3,
    "retryDelayMs": 1000,
    "objects": [
      {
        "name": "Chiller-1 Supply Temp",
        "objectType": "analog-input",
        "objectInstance": 2,
        "propertyId": 85,
        "unit": "°C",
        "enabled": true
      }
    ]
  },
  "poll_interval": 5000
}
```

## SensorDataPoint Output Format

```json
{
  "deviceName": "Condo-Building-1",
  "metric": "Chiller-1 Supply Temp",
  "value": 7.2,
  "unit": "°C",
  "timestamp": "2026-01-16T16:30:00.000Z",
  "quality": "GOOD",
  "protocol": "bacnet"
}
```

## Features Compared to Other Adapters

| Feature | Modbus | OPC-UA | SNMP | MQTT | **BACnet** |
|---------|--------|--------|------|------|------------|
| Parallel device init | ✅ | ✅ | ✅ | ✅ | ✅ |
| Global poll loop | ✅ | ✅ | ✅ | N/A | ✅ |
| Per-device intervals | ✅ | ✅ | ✅ | N/A | ✅ |
| Success rate tracking | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change detection | ✅ | ✅ | ❌ | N/A | ✅ |
| Concurrent reads | ✅ | ✅ | ✅ | N/A | ✅ |
| Quality codes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Socket-agnostic | ✅ | ✅ | ✅ | ✅ | ✅ |

## Next Steps

1. **Test the adapter** with your BACnet simulator:
   ```bash
   # Add BACnet device to database via API
   # Enable bacnet in target state
   # Rebuild agent
   docker-compose up -d --build agent-27
   ```

2. **Create API endpoints** to manage BACnet devices:
   - POST `/api/endpoints/bacnet` - Add device
   - GET `/api/endpoints/bacnet` - List devices
   - PATCH `/api/endpoints/bacnet/:id` - Update device

3. **Add to discovery** - Auto-populate database from BACnet discovery results

4. **Dashboard integration** - Show BACnet devices in UI

## Dependencies

- `bacstack` (already installed): BACnet/IP protocol library
- `p-limit` (already used): Concurrency control
- `zod` (already used): Schema validation

No additional npm packages required! ✅
