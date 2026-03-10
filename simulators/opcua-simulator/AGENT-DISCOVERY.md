# Agent Discovery of OPC UA Profiles

## Overview

The agent automatically discovers which profile is active by reading metadata nodes in the OPC UA server tree.

## Metadata Nodes

The OPC UA simulator exposes profile information under `ServerInfo` folder:

```
Objects/
├── ServerInfo/
│   ├── ProfileName          (string, read-only)  "factory"
│   ├── ProfileDescription   (string, read-only)  "Standard industrial factory..."
│   ├── SensorCount          (int, read-only)     25
│   └── SensorTypes          (string, read-only)  "5 temperature, 5 pressure, ..."
└── Factory/                 (or Test, Workshop, etc.)
    ├── Temperature/
    │   ├── Sensor_1
    │   └── ...
    └── ...
```

## Agent Discovery Flow

### 1. **Connect to OPC UA Server**
```typescript
const client = OPCUAClient.create({ endpoint: 'opc.tcp://localhost:4840' });
await client.connect();
const session = await client.createSession();
```

### 2. **Read Profile Metadata**
```typescript
// Read profile name
const profileName = await session.read({
  nodeId: 'ns=2;s=ServerInfo.ProfileName'
});
console.log('Active profile:', profileName.value.value); // "factory"

// Read sensor count
const sensorCount = await session.read({
  nodeId: 'ns=2;s=ServerInfo.SensorCount'
});
console.log('Total sensors:', sensorCount.value.value); // 25

// Read sensor types summary
const sensorTypes = await session.read({
  nodeId: 'ns=2;s=ServerInfo.SensorTypes'
});
console.log('Sensor distribution:', sensorTypes.value.value);
// "5 temperature, 5 pressure, 5 flow, 3 level, 4 vibration, 3 power"
```

### 3. **Browse Node Tree (Dynamic Discovery)**
```typescript
// Agent browses the tree to discover all available sensors
const browseResult = await session.browse('ns=2;i=1'); // ObjectsFolder
for (const ref of browseResult.references) {
  if (ref.browseName.name === 'Factory') {
    // Found main folder, browse children
    const sensors = await session.browse(ref.nodeId);
    // Process each sensor folder...
  }
}
```

## Agent Patterns

### Pattern 1: Metadata-Driven Discovery
**Best for**: Knowing what's available without browsing entire tree

```typescript
const metadata = {
  profile: await readNode('ns=2;s=ServerInfo.ProfileName'),
  count: await readNode('ns=2;s=ServerInfo.SensorCount'),
  types: await readNode('ns=2;s=ServerInfo.SensorTypes')
};

// Agent knows: "I'm connected to a factory profile with 25 sensors"
// Then browse specific folders as needed
```

### Pattern 2: Full Tree Browsing
**Best for**: Complete discovery, works with any profile

```typescript
async function discoverAllSensors(session) {
  const sensors = [];
  const objectsNode = session.rootNode.objects;
  
  // Browse all children of Objects
  const folders = await objectsNode.browseChildren();
  
  for (const folder of folders) {
    if (folder.browseName !== 'ServerInfo') {
      // Recursively browse sensor folders
      const sensorNodes = await folder.browseChildren();
      sensors.push(...sensorNodes);
    }
  }
  
  return sensors;
}

// Agent discovers all sensors regardless of profile structure
```

### Pattern 3: Subscription-Based Monitoring
**Best for**: Real-time updates from discovered sensors

```typescript
// After discovery, subscribe to all sensors
const subscription = await session.createSubscription2({
  requestedPublishingInterval: 1000,
  requestedMaxKeepAliveCount: 10,
  maxNotificationsPerPublish: 100
});

for (const sensor of discoveredSensors) {
  const monitoredItem = await subscription.monitor({
    nodeId: sensor.nodeId,
    attributeId: AttributeIds.Value
  });
  
  monitoredItem.on('changed', (dataValue) => {
    console.log(`${sensor.name}: ${dataValue.value.value}`);
    // Store in database, publish to MQTT, etc.
  });
}
```

## Profile Change Detection

If the simulator restarts with a different profile:

```typescript
// Monitor ProfileName for changes
const profileMonitor = await subscription.monitor({
  nodeId: 'ns=2;s=ServerInfo.ProfileName'
});

profileMonitor.on('changed', async (dataValue) => {
  const newProfile = dataValue.value.value;
  console.log(`Profile changed to: ${newProfile}`);
  
  // Re-discover sensors
  await discoverAllSensors(session);
  // Re-create subscriptions
  await setupMonitoring(discoveredSensors);
});
```

## No Configuration Needed

**Key Advantage**: Agent doesn't need to know about profiles in advance

- ✅ Connect to OPC UA server
- ✅ Browse the tree or read metadata
- ✅ Discover what's available
- ✅ Subscribe to discovered nodes
- ✅ Works with any profile (factory, test, workshop, custom)

## Example: Agent Startup Sequence

```typescript
class OPCUAAgent {
  async start() {
    // 1. Connect
    await this.connect('opc.tcp://localhost:4840');
    
    // 2. Read metadata
    const profile = await this.getServerInfo();
    this.logger.info(`Connected to OPC UA simulator`);
    this.logger.info(`  Profile: ${profile.name}`);
    this.logger.info(`  Sensors: ${profile.count}`);
    this.logger.info(`  Types: ${profile.types}`);
    
    // 3. Discover sensors
    const sensors = await this.discoverSensors();
    this.logger.info(`Discovered ${sensors.length} sensors`);
    
    // 4. Subscribe to all
    await this.subscribeToAll(sensors);
    this.logger.info(`Monitoring ${sensors.length} sensors`);
  }
  
  async getServerInfo() {
    return {
      name: await this.read('ns=2;s=ServerInfo.ProfileName'),
      description: await this.read('ns=2;s=ServerInfo.ProfileDescription'),
      count: await this.read('ns=2;s=ServerInfo.SensorCount'),
      types: await this.read('ns=2;s=ServerInfo.SensorTypes')
    };
  }
}
```

## Comparison with Modbus Simulator

| Feature | Modbus Simulator | OPC UA Simulator |
|---------|------------------|------------------|
| Profile Discovery | REST API `/api/status` | OPC UA metadata nodes |
| Sensor Discovery | Database query | OPC UA tree browsing |
| Profile Switching | POST `/api/profile/{name}` | Restart container (future: REST API) |
| Real-time Updates | MQTT publish | OPC UA subscriptions |
| Configuration | JSON + SQLite | JSON profiles |

## Future Enhancement: REST API

Add optional REST API for profile management (like Modbus simulator):

```python
# opcua_web_api.py (future)
from flask import Flask, jsonify

@app.route('/api/status')
def status():
    return jsonify({
        'profile': current_profile.name,
        'sensor_count': len(sensors),
        'uptime': get_uptime()
    })

@app.route('/api/profile/<name>', methods=['POST'])
def switch_profile(name):
    # Hot-reload profile without restart
    load_profile(name)
    recreate_nodes()
    return jsonify({'success': True, 'profile': name})
```

## Conclusion

The agent doesn't need pre-configured knowledge of profiles. It:

1. **Reads metadata** from `ServerInfo` nodes (profile name, count, types)
2. **Browses the tree** to discover all available sensors
3. **Subscribes** to discovered nodes for real-time updates
4. **Works with any profile** - factory, test, workshop, or custom

This follows the OPC UA philosophy of **self-describing servers** where clients discover capabilities at runtime.
