# Protocol Simulator Integration Guide

## Overview

The protocol simulators (`iotistic-modbus-sim`, `iotistic-opcua-sim`, `iotistic-canbus-sim`) need to connect with the agent through **protocol adapters** that convert protocol-specific data to Unix sockets for `sensor-publish` to consume.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Network                           │
│                                                             │
│  ┌────────────────┐                                        │
│  │ Modbus         │                                        │
│  │ Simulator      │                                        │
│  │ (port 502)     │                                        │
│  └───────┬────────┘                                        │
│          │                                                  │
│          │ Modbus TCP                                       │
│          ▼                                                  │
│  ┌─────────────────────────────────────────────┐          │
│  │         Agent Container                      │          │
│  │                                              │          │
│  │  ┌────────────────┐      ┌───────────────┐ │          │
│  │  │ Protocol       │      │ Sensor        │ │          │
│  │  │ Adapter        │─────▶│ Publish       │────────┐   │
│  │  │ (Modbus)       │sock  │               │        │   │
│  │  └────────────────┘      └───────────────┘        │   │
│  │                                                     │   │
│  │  ┌────────────────┐      ┌───────────────┐        │   │
│  │  │ Protocol       │      │               │        │   │
│  │  │ Adapter        │─────▶│               │        │   │
│  │  │ (CAN Bus)      │sock  │               │        │   │
│  │  └────────────────┘      └───────────────┘        │   │
│  │                                                     │   │
│  │  ┌────────────────┐                                │   │
│  │  │ Protocol       │                                │   │
│  │  │ Adapter        │─────▶                          │   │
│  │  │ (OPC-UA)       │sock                            │   │
│  │  └────────────────┘                                │   │
│  └──────────────────────────────────────────────────┘│   │
│                                                        │   │
│  ┌────────────────┐                                   │   │
│  │ Mosquitto      │◀──────────────────────────────────┘   │
│  │ MQTT Broker    │   MQTT                                │
│  │ (port 1883)    │                                       │
│  └────────────────┘                                       │
│                                                            │
│  ┌────────────────┐                                       │
│  │ CAN Bus        │                                       │
│  │ Simulator      │                                       │
│  │ (port 11898)   │                                       │
│  └────────────────┘                                       │
│                                                            │
│  ┌────────────────┐                                       │
│  │ OPC-UA         │                                       │
│  │ Simulator      │                                       │
│  │ (port 4840)    │                                       │
│  └────────────────┘                                       │
└────────────────────────────────────────────────────────────┘
```

## Architecture: Dual-Database Configuration

**Two databases work together:**

1. **Cloud API Database (PostgreSQL)** - `endpoints` table
   - Stores sensor configurations from Dashboard
   - Used for querying, filtering, historical tracking
   - Synced to target state config

2. **Agent Local Database (SQLite)** - `sensors` table
   - Local cache of sensor configurations
   - Persists across agent restarts
   - Protocol adapters read from here

### Configuration Flow

```
Dashboard → API (PostgreSQL) → endpoints table
                                      ↓
                              device_target_state.config.protocolAdapterDevices
                                      ↓
                              Agent polls target state
                                      ↓
                              Agent syncs to local SQLite → sensors table
                                      ↓
                              Protocol Adapters read from local sensors table
                                      ↓
                              Connect to simulators:
                              - Modbus: TCP modbus-simulator:502 ✅
                              - CAN Bus: TCP canbus-simulator:11898 ⚠️
                              - OPC-UA: opc.tcp://opcua-simulator:4840 ⚠️
                                      ↓
                              Write to Unix sockets (/tmp/sensors/*.sock)
                                      ↓
                              Sensor-Publish → MQTT
```

### Database Schemas

**Cloud API (PostgreSQL) - `endpoints` table:**
```sql
CREATE TABLE endpoints (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    protocol VARCHAR(50) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    poll_interval INTEGER DEFAULT 5000,
    connection JSONB NOT NULL,
    data_points JSONB NOT NULL,
    deployment_status VARCHAR(50),
    config_id VARCHAR(255),
    ...
);
```

**Agent SQLite - `sensors` table:**
```sql
CREATE TABLE sensors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    poll_interval INTEGER NOT NULL DEFAULT 5000,
    connection TEXT NOT NULL,     -- JSON string
    data_points TEXT,              -- JSON string  
    metadata TEXT,                 -- JSON string
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Agent SQLite - `endpoint_outputs` table:**
```sql
CREATE TABLE endpoint_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol TEXT NOT NULL UNIQUE,
    socket_path TEXT NOT NULL,
    data_format TEXT NOT NULL DEFAULT 'json',
    delimiter TEXT NOT NULL DEFAULT '\n',
    include_timestamp BOOLEAN NOT NULL DEFAULT 1,
    include_device_name BOOLEAN NOT NULL DEFAULT 1,
    logging TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## Solution: Dual-Database Architecture

The system uses **two databases** that sync via the target state config:

### Flow Overview

1. **Dashboard adds sensor** → Inserts into API's `endpoints` table (PostgreSQL)
2. **API syncs table → config** → Updates `device_target_state.config.protocolAdapterDevices`
3. **Agent polls target state** → Gets updated config from API
4. **Agent syncs config → local DB** → Updates SQLite `sensors` table
5. **Protocol Adapters load config** → Query local SQLite `sensors` table
6. **Adapters connect to simulators** → Read data via native protocols
7. **Data flows to Unix sockets** → `/tmp/sensors/*.sock`
8. **Sensor-Publish reads sockets** → Publishes to MQTT

### Why This Architecture?

✅ **Cloud centralization**: All devices managed from one Dashboard  
✅ **Local persistence**: Agent has full config in SQLite  
✅ **Offline capable**: Agent can restart without cloud connection  
✅ **Fast queries**: Protocol adapters read from local SQLite (no network latency)  
✅ **Deployment tracking**: Cloud tracks which configs are deployed  

❌ **NOT using**: Static JSON config files (outdated approach)

---

## Step-by-Step Setup

### Step 1: Add Sensor via API/Dashboard

Use the API to register a Modbus sensor that connects to the simulator:

```bash
curl -X POST http://localhost:4002/api/v1/devices/{device-uuid}/protocol-devices \
  -H "Content-Type: application/json" \
  -d '{
    "name": "modbus-sim-temperature",
    "protocol": "modbus",
    "enabled": true,
    "pollInterval": 5000,
    "connection": {
      "type": "tcp",
      "host": "modbus-simulator",
      "port": 502,
      "slaveId": 1,
      "timeout": 5000
    },
    "dataPoints": [
      {
        "name": "temperature_1",
        "address": 0,
        "functionCode": 3,
        "dataType": "int16",
        "scale": 0.1,
        "unit": "°C"
      },
      {
        "name": "pressure_1",
        "address": 10,
        "functionCode": 3,
        "dataType": "uint16",
        "unit": "mbar"
      }
    ]
  }'
```

**What happens:**
1. Record inserted into API's `endpoints` table (PostgreSQL)
2. Config synced to `device_target_state.config.protocolAdapterDevices`
3. `deployment_status` set to `"pending"`

### Step 2: Agent Polls and Syncs to Local Database

The agent's ConfigManager automatically:

1. **Polls target state** (every 30s by default)
2. **Detects new sensor** in `config.protocolAdapterDevices`
3. **Syncs to local SQLite** - Inserts/updates `sensors` table
4. **Notifies protocol adapters** of configuration change

**Agent SQLite after sync:**
```sql
-- Query agent's local database
SELECT * FROM sensors WHERE protocol = 'modbus';

-- Result:
-- id: 1
-- name: modbus-sim-temperature
-- protocol: modbus
-- enabled: 1
-- poll_interval: 5000
-- connection: {"type":"tcp","host":"modbus-simulator","port":502,"slaveId":1}
-- data_points: [{"name":"temperature_1","address":0,"functionCode":3}]
```

### Step 3: Protocol Adapter Reads from Local SQLite

The Modbus adapter queries the agent's local database:

```typescript
// agent/src/features/sensors/modbus/modbus-adapter.ts
async loadConfigFromLocalDB(): Promise<ModbusConfig> {
  // Query local SQLite sensors table
  const sensors = await this.db.query(`
    SELECT * FROM sensors 
    WHERE protocol = 'modbus' 
      AND enabled = 1
  `);
  
  // Convert to adapter config
  return {
    devices: sensors.map(s => ({
      name: s.name,
      slaveId: JSON.parse(s.connection).slaveId,
      connection: JSON.parse(s.connection),
      registers: JSON.parse(s.data_points),
      pollInterval: s.poll_interval
    }))
  };
}
```

### Step 4: Adapter Connects and Reports Status

**Adapter connects to simulator:**
```typescript
await modbusClient.connect({
  host: 'modbus-simulator',
  port: 502,
  slaveId: 1
});
```

**Agent reports deployment status back to API:**
```typescript
// Agent updates cloud via state report
await cloudSync.reportState({
  protocolAdapters: {
    modbus: {
      devices: [{
        name: 'modbus-sim-temperature',
        status: 'connected',
        lastPoll: '2025-11-17T10:30:00Z'
      }]
    }
  }
});
```

**API updates deployment_status:**
```sql
-- Cloud API updates endpoints table
UPDATE endpoints 
SET deployment_status = 'deployed',
    last_deployed_at = NOW()
WHERE name = 'modbus-sim-temperature';
```

### Step 5: Data Flows to Sensor-Publish

Protocol adapter writes to Unix socket:

```
Modbus Adapter → /tmp/sensors/modbus.sock → Sensor-Publish → MQTT (sensor/modbus)
```

---

## Database-Driven Configuration Examples

### Example 1: Modbus Temperature Sensor

**Database Record**:
```sql
INSERT INTO endpoints (device_uuid, name, protocol, connection, data_points)
VALUES (
  '12345678-1234-1234-1234-123456789012',
  'modbus-sim-temperature',
  'modbus',
  '{"type": "tcp", "host": "modbus-simulator", "port": 502, "slaveId": 1}'::jsonb,
  '[
    {"name": "temperature_1", "address": 0, "functionCode": 3, "dataType": "int16", "scale": 0.1, "unit": "°C"},
    {"name": "temperature_2", "address": 1, "functionCode": 3, "dataType": "int16", "scale": 0.1, "unit": "°C"}
  ]'::jsonb
);
```

**What Agent Sees** (in target state):
```json
{
  "config": {
    "protocolAdapterDevices": [
      {
        "name": "modbus-sim-temperature",
        "protocol": "modbus",
        "enabled": true,
        "pollInterval": 5000,
        "connection": {
          "type": "tcp",
          "host": "modbus-simulator",
          "port": 502,
          "slaveId": 1
        },
        "dataPoints": [
          {"name": "temperature_1", "address": 0, "functionCode": 3}
        ]
      }
    ]
  }
}
```

### Example 2: CAN Bus Simulator

```sql
INSERT INTO endpoints (device_uuid, name, protocol, connection, data_points)
VALUES (
  '12345678-1234-1234-1234-123456789012',
  'can-sim-vehicle',
  'can',
  '{"type": "tcp", "host": "canbus-simulator", "port": 11898}'::jsonb,
  '[
    {"can_id": "0x100", "name": "engine_rpm", "unit": "RPM"},
    {"can_id": "0x101", "name": "vehicle_speed", "unit": "km/h"}
  ]'::jsonb
);
```

### Example 3: OPC-UA Simulator

```sql
INSERT INTO endpoints (device_uuid, name, protocol, connection, data_points)
VALUES (
  '12345678-1234-1234-1234-123456789012',
  'opcua-sim-factory',
  'opcua',
  '{"endpoint": "opc.tcp://opcua-simulator:4840/iotistic/simulator"}'::jsonb,
  '[
    {"nodeId": "ns=2;s=Factory.Temperature.Sensor_1", "name": "temperature_1", "unit": "°C"},
    {"nodeId": "ns=2;s=Factory.Pressure.Sensor_1", "name": "pressure_1", "unit": "mbar"}
  ]'::jsonb
);
```

---

## Protocol Adapter Implementation Pattern

All protocol adapters follow this pattern:

### 1. Load Configuration from Local SQLite

```typescript
export class ProtocolAdapter {
  private db: any;  // SQLite connection
  
  async loadConfig(): Promise<AdapterConfig> {
    // Query local sensors table
    const sensors = await this.db.query(`
      SELECT * FROM sensors 
      WHERE protocol = ? 
        AND enabled = 1
      ORDER BY name
    `, [this.protocol]);
    
    return this.parseConfig(sensors);
  }
  
  private parseConfig(rows: any[]): AdapterConfig {
    return {
      devices: rows.map(row => ({
        name: row.name,
        enabled: row.enabled,
        pollInterval: row.poll_interval,
        connection: JSON.parse(row.connection),
        dataPoints: JSON.parse(row.data_points),
        metadata: row.metadata ? JSON.parse(row.metadata) : {}
      }))
    };
  }
}
```

### 2. Watch for Configuration Changes

```typescript
async watchConfigChanges(): Promise<void> {
  // ConfigManager will emit events when config synced from cloud
  this.configManager.on('sensors-updated', async () => {
    const newConfig = await this.loadConfig();
    if (!_.isEqual(this.currentConfig, newConfig)) {
      await this.reloadConfig(newConfig);
    }
  });
}
```

### 3. Report Status to Cloud

```typescript
// Agent reports device status via CloudSync
async reportDeviceStatus(): Promise<void> {
  const status = {
    protocol: this.protocol,
    devices: this.devices.map(device => ({
      name: device.name,
      status: device.connected ? 'connected' : 'disconnected',
      lastPoll: device.lastPollTime,
      errorCount: device.errorCount,
      lastError: device.lastError
    }))
  };
  
  // CloudSync sends this to API, which updates endpoints.deployment_status
  this.cloudSync.reportProtocolAdapterStatus(status);
}
```

---

## Modbus Adapter: SQLite Integration

The existing Modbus adapter needs to read from the local `sensors` table:

### Current Architecture (Needs Update)

```typescript
// ❌ OLD: Read from JSON file or cloud DB
const config = JSON.parse(fs.readFileSync('/config/modbus.json'));
```

### New Architecture (Local SQLite)

```typescript
// ✅ NEW: Read from local SQLite sensors table
class ModbusAdapter {
  constructor(private db: any, private configManager: ConfigManager) {}
  
  async init(): Promise<void> {
    // Load config from local SQLite
    const config = await this.loadConfigFromLocalDB();
    
    // Start polling devices
    await this.startDevices(config.devices);
    
    // Watch for config changes from cloud sync
    this.watchConfigChanges();
  }
  
  async loadConfigFromLocalDB(): Promise<ModbusConfig> {
    // Query local sensors table
    const result = await this.db.all(`
      SELECT * FROM sensors 
      WHERE protocol = 'modbus' 
        AND enabled = 1
    `);
    
    // Query endpoint_outputs for socket configuration
    const output = await this.db.get(`
      SELECT * FROM endpoint_outputs 
      WHERE protocol = 'modbus'
    `);
    
    return {
      devices: result.map(row => ({
        name: row.name,
        slaveId: JSON.parse(row.connection).slaveId,
        connection: JSON.parse(row.connection),
        registers: JSON.parse(row.data_points || '[]'),
        pollInterval: row.poll_interval,
        enabled: Boolean(row.enabled)
      })),
      output: output ? {
        socketPath: output.socket_path,
        dataFormat: output.data_format,
        delimiter: output.delimiter,
        includeTimestamp: Boolean(output.include_timestamp),
        includeDeviceName: Boolean(output.include_device_name)
      } : {
        socketPath: '/tmp/sensors/modbus.sock',
        dataFormat: 'json',
        delimiter: '\n',
        includeTimestamp: true,
        includeDeviceName: true
      }
    };
  }
  
  private watchConfigChanges(): void {
    this.configManager.on('config-applied', async () => {
      // Config was synced from cloud to local DB
      const newConfig = await this.loadConfigFromLocalDB();
      
      if (!_.isEqual(this.currentConfig, newConfig)) {
        this.logger.info('Modbus configuration changed, reloading...');
        await this.reloadDevices(newConfig.devices);
        this.currentConfig = newConfig;
      }
    });
  }
}
```

---

## Dashboard Integration

The Dashboard should use the `/api/v1/devices/:uuid/protocol-devices` endpoints:

### List Sensors

```typescript
const response = await fetch(`/api/v1/devices/${deviceUuid}/protocol-devices`);
const { devices } = await response.json();

// Returns:
{
  "devices": [
    {
      "id": 1,
      "name": "modbus-sim-temperature",
      "protocol": "modbus",
      "enabled": true,
      "pollInterval": 5000,
      "connection": { "host": "modbus-simulator", "port": 502 },
      "dataPoints": [...],
      "deploymentStatus": "deployed",
      "lastDeployedAt": "2025-11-17T10:30:00Z"
    }
  ]
}
```

### Add Sensor

```typescript
await fetch(`/api/v1/devices/${deviceUuid}/protocol-devices`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'new-modbus-sensor',
    protocol: 'modbus',
    connection: { host: 'modbus-simulator', port: 502 },
    dataPoints: [...]
  })
});
```

### Update Sensor

```typescript
await fetch(`/api/v1/devices/${deviceUuid}/protocol-devices/modbus-sim-temperature`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enabled: false  // Disable sensor
  })
});
```

### Delete Sensor

```typescript
await fetch(`/api/v1/devices/${deviceUuid}/protocol-devices/modbus-sim-temperature`, {
  method: 'DELETE'
});
```

---

## Docker Compose Configuration

No config file volumes needed - everything is in the database!

```yaml
services:
  agent:
    build:
      context: ./agent
    container_name: iotistic-agent
    volumes:
      - sensor-sockets:/tmp/sensors        # Unix sockets only
    environment:
      - DEVICE_UUID=${DEVICE_UUID}
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_NAME=iotistic
      - ENABLE_PROTOCOL_ADAPTERS=true
    networks:
      - iotistic-net
    depends_on:
      - postgres
      - modbus-simulator
      - mosquitto

  modbus-simulator:
    build:
      context: ./sensors/modbus-simulator
    container_name: iotistic-modbus-sim
    restart: unless-stopped
    ports:
      - "502:502"
    networks:
      - iotistic-net

  postgres:
    image: postgres:16-alpine
    container_name: iotistic-postgres
    environment:
      POSTGRES_DB: iotistic
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - iotistic-net

volumes:
  sensor-sockets:
  postgres-data:

networks:
  iotistic-net:
```

---

## Testing the Database-Driven Flow

### 1. Add Sensor via API

```bash
curl -X POST http://localhost:4002/api/v1/devices/${DEVICE_UUID}/protocol-devices \
  -H "Content-Type: application/json" \
  -d '{
    "name": "modbus-sim-all-sensors",
    "protocol": "modbus",
    "pollInterval": 5000,
    "connection": {
      "type": "tcp",
      "host": "modbus-simulator",
      "port": 502,
      "slaveId": 1
    },
    "dataPoints": [
      {"name": "temp_1", "address": 0, "functionCode": 3, "dataType": "int16", "scale": 0.1, "unit": "°C"},
      {"name": "temp_2", "address": 1, "functionCode": 3, "dataType": "int16", "scale": 0.1, "unit": "°C"},
      {"name": "pressure_1", "address": 10, "functionCode": 3, "dataType": "uint16", "unit": "mbar"}
    ]
  }'
```

### 2. Verify Database Record

```sql
SELECT name, protocol, enabled, deployment_status, connection, data_points 
FROM endpoints 
WHERE device_uuid = '12345678-1234-1234-1234-123456789012';
```

### 3. Check Target State Sync

```bash
curl http://localhost:4002/api/v1/devices/${DEVICE_UUID}/state | jq '.config.protocolAdapterDevices'
```

### 4. Watch Agent Logs

```bash
docker-compose logs -f agent | grep -E "(ConfigManager|Protocol|Modbus)"

# Expected:
# [ConfigManager] Detected new sensor: modbus-sim-all-sensors
# [Modbus Adapter] Loading config from database
# [Modbus Adapter] Connecting to modbus-simulator:502
# [Modbus Adapter] Connected to device modbus-sim-all-sensors
# [ConfigManager] Marked sensor deployed: modbus-sim-all-sensors
```

### 5. Verify Deployment Status

```bash
curl http://localhost:4002/api/v1/devices/${DEVICE_UUID}/protocol-devices | jq '.devices[] | {name, deploymentStatus, lastDeployedAt}'
```

### 6. Check MQTT Messages

```bash
mosquitto_sub -h localhost -p 1883 -t "sensor/modbus" -u admin -P password
```

---

## Troubleshooting

### Modbus Adapter Can't Connect to Simulator

```bash
# Check simulator is running
docker ps | grep modbus-sim

# Check network connectivity
docker exec iotistic-agent ping modbus-simulator

# Test Modbus connection manually
docker exec iotistic-agent telnet modbus-simulator 502
```

### Socket Not Found

```bash
# Check socket was created
docker exec iotistic-agent ls -la /tmp/sensors/

# Check protocol adapter logs
docker-compose logs agent | grep "Protocol Adapter"

# Verify volume mount
docker inspect iotistic-agent | grep -A 10 Mounts
```

### No MQTT Messages

```bash
# Check sensor-publish is running
docker-compose logs agent | grep "Sensor Publish"

# Check MQTT connection
docker-compose logs agent | grep MQTT

# Verify socket has data
docker exec iotistic-agent cat /tmp/sensors/modbus.sock
```

---

## Next Steps

1. **Implement CAN adapter** in `agent/src/features/sensors/can/`
2. **Implement OPC-UA adapter** in `agent/src/features/sensors/opcua/`
3. **Add dependencies** to `agent/package.json`:
   ```json
   {
     "dependencies": {
       "node-opcua": "^2.117.0",
       "socketcan": "^3.0.0"  // For real CAN hardware
     }
   }
   ```
4. **Create configuration files** in `config/` directory
5. **Update target state** to enable all protocol adapters
6. **Test end-to-end** with all three simulators

---

## Summary

**Dual-Database Architecture:**

1. ✅ **Cloud (PostgreSQL)**: `endpoints` table - Dashboard management, querying, history
2. ✅ **Agent (SQLite)**: `sensors` table - Local cache, offline capability, fast reads
3. ✅ **Modbus**: Adapter reads local SQLite, connects to `modbus-simulator:502`
4. ⚠️ **CAN Bus**: Implement adapter to read local SQLite, connect to `canbus-simulator:11898`
5. ⚠️ **OPC-UA**: Implement adapter to read local SQLite, connect to `opcua-simulator:4840`

**Data Flow:**
```
Dashboard → Cloud PostgreSQL (endpoints)
                    ↓
            Target state config
                    ↓
            Agent polls & syncs
                    ↓
          Agent SQLite (sensors table)
                    ↓
      Protocol Adapters read local DB
                    ↓
      Connect to simulators via native protocols
                    ↓
      Unix sockets (/tmp/sensors/*.sock)
                    ↓
      Sensor-Publish → MQTT
                    ↓
      Agent reports status → Cloud updates deployment_status
```

**Key Benefits:**
- ✅ Centralized management (Dashboard)
- ✅ Offline capable (local SQLite)
- ✅ Fast adapter startup (no network queries)
- ✅ Deployment status tracking (cloud monitors agents)
- ✅ Historical audit trail (cloud PostgreSQL)

**Priority**: Update existing Modbus adapter to read from local SQLite `sensors` table instead of JSON files or cloud database. This validates the dual-database architecture before implementing CAN and OPC-UA adapters.
