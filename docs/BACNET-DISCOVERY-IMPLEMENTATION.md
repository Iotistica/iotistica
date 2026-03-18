# BACnet Discovery Implementation

## Overview
Implemented BACnet/IP discovery following the same architectural patterns as existing protocols (Modbus, OPC-UA, SNMP, MQTT).

## Files Created/Modified

### New Files
1. **`agent/src/features/discovery/bacnet.discovery.ts`** (485 lines)
   - BACnetDiscoveryPlugin class extending BaseDiscoveryPlugin
   - Phase 1: Who-Is broadcast discovery
   - Phase 2: Validation via object list browsing
   - Uses `bacstack` library for BACnet/IP communication

### Modified Files
1. **`agent/src/features/discovery/fingerprint.ts`**
   - Added `generateBACnetFingerprint(ipAddress, deviceInstance)` function
   - Pattern: SHA256("bacnet:IP:DeviceInstance")

2. **`agent/src/features/discovery/discovery-service.ts`**
   - Added BACnetDiscoveryPlugin import
   - Registered 'bacnet' plugin in `initializePlugins()`
   - Updated `DiscoveryProtocol` type to include 'bacnet'

3. **`agent/src/features/discovery/base.discovery.ts`**
   - Updated `DiscoveredDevice.protocol` type to include 'bacnet'

## Implementation Details

### Discovery Strategy (Phase 1)
- **Method**: BACnet Who-Is broadcast on UDP port 47808
- **Response**: I-Am messages from all devices
- **Device Properties Read**:
  - Object-Name (property 77)
  - Vendor-Name (property 121)
  - Model-Name (property 70)
  - Description (property 28)
- **Confidence**: High if objectName available, Medium otherwise
- **Fingerprint**: Based on IP + device instance number (stable across reboots)

### Validation Strategy (Phase 2)
- **Reads**: Object-List (property 76) from device
- **Browses**: First 50 objects (timeout protection)
- **Object Properties Read**:
  - Object-Name (property 77)
  - Present-Value (property 85) for I/O objects
  - Units (property 117) for analog objects
- **Validation Data**:
  - Total objects count
  - Object type breakdown (analog-input, binary-output, etc.)
  - Capabilities list

### Data Points Generated
Each discovered BACnet object becomes a data point:
```typescript
{
  name: "chiller_1_supply_temp",  // Sanitized object name
  objectType: "analog-input",      // BACnet object type
  objectInstance: 2,               // Object instance number
  presentValue: 7.5,               // Current value
  units: "degreesCelsius",         // Engineering units
  propertyId: 85                   // Present-Value property
}
```

### Connection Config
```typescript
{
  host: "192.168.1.100",
  port: 47808,
  deviceInstance: 1001,
  maxApdu: 1476,
  interface: "eth0"  // Optional
}
```

### BACnet Object Types Supported
- Analog Input (0)
- Analog Output (1)
- Analog Value (2)
- Binary Input (3)
- Binary Output (4)
- Binary Value (5)
- Multi-State Input (13)
- Multi-State Output (14)
- Multi-State Value (19)
- Device (8)

## Dependencies
- **`bacstack`** NPM package (BACnet/IP client library)
  - Install: `npm install bacstack`
  - Used for Who-Is broadcasts, I-Am parsing, property reads

## Configuration Options
```typescript
interface BACnetDiscoveryOptions {
  networkInterfaces?: string[];     // Network interfaces to scan
  broadcastAddress?: string;        // Default: 255.255.255.255
  port?: number;                    // Default: 47808
  timeout?: number;                 // Default: 5000ms
  maxDevices?: number;              // Default: 100
  deviceIdRange?: [number, number]; // Default: [0, 4194303]
}
```

## Usage Example
```typescript
const discovery = new DiscoveryService(logger, agentConfig);
await discovery.init();

// Manual BACnet discovery with validation
await discovery.runDiscovery({
  trigger: 'manual',
  validate: true,
  protocols: ['bacnet']
});

// Results saved automatically to endpoints table
```

## Testing with Simulator
The BACnet simulator is now running with 3 devices:
- **Chiller-1** (device 1001): 4 objects (status, supply temp, return temp, power)
- **AHU-1** (device 2001): 5 objects (supply temp, return temp, airflow, fan status, cooling valve)
- **AHU-2** (device 2002): 5 objects (supply temp, return temp, airflow, fan status, cooling valve)

Run discovery:
```bash
# Via discovery API endpoint
curl -X POST http://localhost:48484/api/v2/discovery/run \
  -H "Content-Type: application/json" \
  -d '{"trigger": "manual", "validate": true, "protocols": ["bacnet"]}'
```

## Architecture Compliance
✅ Follows BaseDiscoveryPlugin pattern
✅ Two-phase discovery (fast scan + optional validation)
✅ Cryptographic fingerprinting for device identity
✅ Saves directly to SQLite endpoints table
✅ Emits 'discovery-complete' and 'endpoint-enabled' events
✅ Rate limiting and concurrency control
✅ Comprehensive logging with LogComponents
✅ TypeScript type safety throughout

## Next Steps
1. Install `bacstack` dependency:
   ```bash
   cd agent && npm install bacstack
   ```

2. Rebuild agent:
   ```bash
   npm run build
   ```

3. Test discovery:
   - Ensure BACnet simulator is running
   - Trigger discovery via API or agent startup
   - Verify devices appear in database
   - Check object properties are correctly mapped

## Notes
- BACnet/IP uses UDP (connectionless), so device availability is checked via broadcast
- Validation can be slow for devices with many objects (limited to 50 objects)
- Device instance number must be unique on network
- Fingerprint survives IP changes if device instance remains the same
