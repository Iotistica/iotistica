# MQTT Adapter Implementation Guide

**Goal**: Add MQTT as an input protocol (alongside Modbus/OPC-UA) to collect data from MQTT-capable devices publishing to the local Mosquitto broker.

**Architecture Pattern**: Mosquitto broker acts as the **endpoint** (data aggregation point), just like a Modbus gateway or OPC-UA server.

**Data Flow**: 
```
External MQTT Publishers → Mosquitto Broker (endpoint @ localhost:1883)
(ESP32, PLCs, IoT devices)      ↓
                        MQTT Adapter (subscribes to topics)
                             ↓
                        Sensor Publish (/tmp/mqtt.sock)
                             ↓
                        Cloud MQTT
```

**Protocol Comparison**:

| Protocol | Endpoint Type | Agent Role |
|----------|---------------|------------|
| Modbus | Gateway at IP:502 | Poll registers |
| OPC-UA | Server at IP:4840 | Browse nodes, subscribe |
| **MQTT** | **Mosquitto broker at localhost:1883** | **Subscribe to topics** |

---

## Phase 1: Database Schema Extension

### Step 1.1: Create Migration for MQTT Protocol Support

**File**: `agent/src/db/migrations/XXX_add_mqtt_protocol_support.sql`

```sql
-- Add MQTT to protocol enum
-- Note: SQLite doesn't have ENUM, but we document valid values

-- ============================================================================
-- endpoint_outputs: Sensor Publish IPC socket configuration
-- ============================================================================
-- This table defines WHERE protocol adapters publish data TO (Unix socket paths)
-- Each protocol adapter publishes to its own socket for IPC with Sensor Publish

-- Example MQTT socket configuration (for Sensor Publish IPC)
-- INSERT INTO endpoint_outputs (protocol, socket_path, format, enabled, buffer_capacity) VALUES (
--   'mqtt',
--   '/tmp/mqtt.sock',  -- Unix domain socket for IPC
--   'json',             -- Data format
--   1,                  -- Enabled
--   131072              -- 128KB buffer
-- );

-- Real examples from your database:
-- modbus → /tmp/modbus.sock
-- snmp   → /tmp/snmp.sock
-- opcua  → /tmp/opcua.sock
-- mqtt   → /tmp/mqtt.sock (to be added)

-- ============================================================================
-- endpoints: Discovered MQTT topics (populated by discovery)
-- ============================================================================
-- CRITICAL: Mosquitto broker is the ENDPOINT (data aggregation point)
--           External MQTT publishers (ESP32, PLCs, IoT devices) ALREADY publish to Mosquitto
--           Discovery monitors broker to see what's active
--
-- Flow:
--   1. External MQTT publishers → Publish to Mosquitto broker (localhost:1883)
--   2. MQTT config from target_state (broker URL: mosquitto:1883, discovery wildcards)
--   3. Discovery service connects to Mosquitto broker (the endpoint)
--   4. Discovery subscribes to wildcard topics (e.g., '#' to see everything)
--   5. Discovery monitors for 30s to see what topics are actively publishing
--   6. Discovery extracts metadata (deviceId, metric, dataType, unit) from messages
--   7. Discovery INSERTS discovered topics into endpoints table
--   8. MQTT adapter reads endpoints table and subscribes to specific topics
--   9. MQTT adapter receives messages from broker and publishes to /tmp/mqtt.sock
--   10. Sensor Publish forwards data to cloud MQTT

-- Example of what discovery automatically creates:
-- INSERT INTO endpoints (protocol, identifier, enabled, metadata, discovered_at, last_seen) VALUES (
--   'mqtt',
--   'device/sensor-01/temperature',  -- Discovered topic
--   1,
--   json_object(
--     'topic', 'device/sensor-01/temperature',
--     'qos', 1,
--     'dataType', 'float',         -- Inferred from payload
--     'unit', '°C',                -- Extracted from JSON payload
--     'deviceId', 'sensor-01',     -- Parsed from topic structure
--     'metric', 'temperature'      -- Parsed from topic structure
--   ),
--   datetime('now'),
--   datetime('now')
-- );

-- MQTT is already supported by existing schema
-- No structural changes needed
```

**Key Points**:
- Existing `endpoint_outputs` table supports MQTT via JSON config
- Existing `endpoints` table stores discovered MQTT topics
- No schema migration required - just configuration data

### Step 1.2: Add MQTT Default Configuration

**File**: `agent/src/config/default-protocols.ts` (or similar)

```typescript
export const DEFAULT_MQTT_CONFIG = {
  enabled: false, // Disabled by default, enabled via cloud config
  broker: { // ENDPOINT ADDRESS (like Modbus gateway IP or OPC-UA server URL)
    host: 'mosquitto', // Docker container name (endpoint host)
    port: 1883, // MQTT broker port (endpoint port)
    username: null, // Auth for broker (if required)
    password: null,
    clientId: null // Auto-generated if null
  },
  discovery: {
    topics: ['#'], // Wildcard for discovery (# = all topics, device/+/sensors/# = subset)
    duration_ms: 30000, // Monitor broker for 30 seconds to see active topics
    validate: true // Only save topics that published during discovery
  },
  qos: 1, // Quality of Service (0, 1, or 2)
  bufferCapacity: 131072, // 128KB
  reconnect: {
    period: 1000, // 1 second
    maxAttempts: 10
  }
};
```

---

## Architecture Deep Dive: MQTT Broker as Endpoint

### Conceptual Alignment with Modbus/OPC-UA

**Key Insight**: The Mosquitto broker serves the same architectural role as a Modbus gateway or OPC-UA server - it's a **centralized data aggregation point** that the agent connects to.

**Modbus Pattern**:
```
Modbus RTU Devices → Modbus Gateway (endpoint @ 192.168.1.10:502)
                          ↓
                     Agent polls registers
                          ↓
                     Sensor Publish
```

**OPC-UA Pattern**:
```
Field Devices → OPC-UA Server (endpoint @ opc.tcp://192.168.1.20:4840)
                     ↓
                Agent browses nodes + subscribes
                     ↓
                Sensor Publish
```

**MQTT Pattern** (THIS IMPLEMENTATION):
```
External MQTT Publishers → Mosquitto Broker (endpoint @ mqtt://mosquitto:1883)
(ESP32, PLCs, IoT devices)       ↓
                            Agent subscribes to topics
                                 ↓
                            Sensor Publish
```

### Why This Matters

1. **Discovery**: Agent doesn't discover sensors directly - it discovers what data is available at the endpoint (broker)
2. **Configuration**: Broker address (`mosquitto:1883`) is like Modbus gateway IP or OPC-UA server URL
3. **Connection**: Single connection to broker, multiple topic subscriptions (like single Modbus connection, multiple register reads)
4. **Data Flow**: Push-based (broker pushes to agent) vs Pull-based (agent polls Modbus/OPC-UA), but endpoint concept is identical

### Deployment Scenarios

**Scenario 1**: Edge IoT devices with MQTT capability
- ESP32/ESP8266 microcontrollers configured to publish to `mqtt://mosquitto:1883`
- Topics: `device/{device-id}/{metric}`
- Agent discovers active topics, subscribes, forwards to cloud

**Scenario 2**: MQTT-enabled industrial devices
- PLCs or gateways publishing process data to local broker
- Topics: `factory/line1/temperature`, `factory/line2/pressure`
- Agent treats broker like any other protocol endpoint

**Scenario 3**: Home automation integration
- Smart home devices (Zigbee2MQTT, Tasmota, ESPHome) publishing to Mosquitto
- Topics: Various conventions (Homie, Home Assistant, custom)
- Agent adapts via configurable discovery wildcards

---

## Phase 2: MQTT Adapter Implementation

### Step 2.1: Create MQTT Adapter Base

**File**: `agent/src/protocols/mqtt/mqtt-adapter.ts`

```typescript
import { EventEmitter } from 'events';
import * as mqtt from 'mqtt';
import { Database } from 'sqlite3';
import { LogComponents } from '../../logging/types';
import type { AgentLogger } from '../../logging/agent-logger';

export interface MqttAdapterConfig {
  broker: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    clientId?: string;
  };
  qos: 0 | 1 | 2;
  reconnect: {
    period: number;
    maxAttempts: number;
  };
}

export interface MqttEndpoint {
  id: number;
  protocol: 'mqtt';
  identifier: string; // Topic pattern
  enabled: boolean;
  metadata: {
    topic: string;
    qos: number;
    dataType: string;
    unit?: string;
    deviceId?: string;
    metric?: string;
  };
}

export class MqttAdapter extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private config: MqttAdapterConfig;
  private db: Database;
  private logger?: AgentLogger;
  private subscriptions: Map<string, MqttEndpoint> = new Map();
  private connected = false;

  constructor(
    config: MqttAdapterConfig,
    db: Database,
    logger?: AgentLogger
  ) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    const brokerUrl = `mqtt://${this.config.broker.host}:${this.config.broker.port}`;
    
    this.logger?.infoSync('Connecting to MQTT broker', {
      component: LogComponents.mqtt,
      broker: brokerUrl
    });

    this.client = mqtt.connect(brokerUrl, {
      clientId: this.config.broker.clientId || `iotistic-agent-${Date.now()}`,
      username: this.config.broker.username,
      password: this.config.broker.password,
      reconnectPeriod: this.config.reconnect.period,
      clean: true
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MQTT connection timeout'));
      }, 30000);

      this.client!.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        
        this.logger?.infoSync('MQTT broker connected', {
          component: LogComponents.mqtt,
          broker: brokerUrl
        });
        
        resolve();
      });

      this.client!.on('error', (err) => {
        this.logger?.errorSync('MQTT connection error', err, {
          component: LogComponents.mqtt
        });
      });

      this.client!.on('offline', () => {
        this.connected = false;
        this.logger?.warnSync('MQTT broker offline', {
          component: LogComponents.mqtt
        });
      });

      this.client!.on('reconnect', () => {
        this.logger?.infoSync('MQTT reconnecting', {
          component: LogComponents.mqtt
        });
      });
    });
  }

  /**
   * Load enabled endpoints from database and subscribe
   */
  async start(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    // Load enabled MQTT endpoints from database
    const endpoints = await this.loadEndpoints();
    
    this.logger?.infoSync('Starting MQTT subscriptions', {
      component: LogComponents.mqtt,
      endpointCount: endpoints.length
    });

    // Subscribe to all enabled topics
    for (const endpoint of endpoints) {
      await this.subscribe(endpoint);
    }

    // Handle incoming messages
    this.client!.on('message', (topic, payload) => {
      this.handleMessage(topic, payload);
    });
  }

  /**
   * Load enabled MQTT endpoints from database
   */
  private async loadEndpoints(): Promise<MqttEndpoint[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id, protocol, identifier, enabled, metadata 
         FROM endpoints 
         WHERE protocol = 'mqtt' AND enabled = 1`,
        (err, rows: any[]) => {
          if (err) {
            reject(err);
            return;
          }

          const endpoints = rows.map(row => ({
            ...row,
            metadata: JSON.parse(row.metadata)
          }));

          resolve(endpoints);
        }
      );
    });
  }

  /**
   * Subscribe to a topic
   */
  private async subscribe(endpoint: MqttEndpoint): Promise<void> {
    const topic = endpoint.identifier;
    const qos = endpoint.metadata.qos || this.config.qos;

    return new Promise((resolve, reject) => {
      this.client!.subscribe(topic, { qos }, (err) => {
        if (err) {
          this.logger?.errorSync('Failed to subscribe to topic', err, {
            component: LogComponents.mqtt,
            topic
          });
          reject(err);
          return;
        }

        this.subscriptions.set(topic, endpoint);
        
        this.logger?.infoSync('Subscribed to MQTT topic', {
          component: LogComponents.mqtt,
          topic,
          qos
        });

        resolve();
      });
    });
  }

  /**
   * Handle incoming MQTT message
   */
  private handleMessage(topic: string, payload: Buffer): void {
    const endpoint = this.subscriptions.get(topic);
    if (!endpoint) {
      this.logger?.debugSync('Received message for untracked topic', {
        component: LogComponents.mqtt,
        topic
      });
      return;
    }

    try {
      const value = this.parsePayload(payload, endpoint.metadata.dataType);
      
      // Emit data event in standard format (matches Modbus/OPC-UA)
      this.emit('data', {
        protocol: 'mqtt',
        endpoint: endpoint.identifier,
        metric: endpoint.metadata.metric || topic,
        value,
        unit: endpoint.metadata.unit,
        timestamp: Date.now(),
        metadata: {
          topic,
          qos: endpoint.metadata.qos,
          deviceId: endpoint.metadata.deviceId
        }
      });

      // Update last_seen in database
      this.updateLastSeen(endpoint.id);

    } catch (err) {
      this.logger?.errorSync('Failed to parse MQTT message', err as Error, {
        component: LogComponents.mqtt,
        topic,
        payload: payload.toString()
      });
    }
  }

  /**
   * Parse MQTT payload based on dataType
   */
  private parsePayload(payload: Buffer, dataType: string): any {
    const str = payload.toString();

    // Try JSON first
    try {
      const json = JSON.parse(str);
      
      // If JSON object with 'value' key, extract it
      if (typeof json === 'object' && json.value !== undefined) {
        return this.coerceType(json.value, dataType);
      }
      
      return this.coerceType(json, dataType);
    } catch {
      // Not JSON, parse as plain text
      return this.coerceType(str, dataType);
    }
  }

  /**
   * Coerce value to expected dataType
   */
  private coerceType(value: any, dataType: string): any {
    switch (dataType) {
      case 'float':
      case 'double':
        return parseFloat(value);
      case 'int':
      case 'integer':
        return parseInt(value, 10);
      case 'boolean':
        return value === 'true' || value === '1' || value === 1 || value === true;
      case 'string':
        return String(value);
      default:
        return value;
    }
  }

  /**
   * Update last_seen timestamp for endpoint
   */
  private updateLastSeen(endpointId: number): void {
    this.db.run(
      `UPDATE endpoints SET last_seen = datetime('now') WHERE id = ?`,
      [endpointId],
      (err) => {
        if (err) {
          this.logger?.errorSync('Failed to update endpoint last_seen', err, {
            component: LogComponents.mqtt,
            endpointId
          });
        }
      }
    );
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.connected = false;
      this.subscriptions.clear();
      
      this.logger?.infoSync('MQTT adapter disconnected', {
        component: LogComponents.mqtt
      });
    }
  }
}
```

**Key Points**:
- Connects to Mosquitto container (`mqtt://mosquitto:1883`)
- Loads enabled topics from `endpoints` table
- Emits `data` events in same format as Modbus/OPC-UA
- Auto-reconnects on connection loss
- Updates `last_seen` timestamp on messages

---

## Phase 3: MQTT Discovery Service

### Step 3.1: Create Discovery Module

**File**: `agent/src/protocols/mqtt/mqtt-discovery.ts`

```typescript
import * as mqtt from 'mqtt';
import { Database } from 'sqlite3';
import { LogComponents } from '../../logging/types';
import type { AgentLogger } from '../../logging/agent-logger';

export interface MqttDiscoveryConfig {
  broker: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  discovery: {
    topics: string[]; // Wildcard patterns
    duration_ms: number;
    validate: boolean;
  };
  qos: 0 | 1 | 2;
}

interface TopicMetadata {
  topic: string;
  firstSeen: number;
  lastSeen: number;
  messageCount: number;
  lastPayload: Buffer;
  metadata: {
    dataType: string;
    unit?: string;
    deviceId?: string;
    metric?: string;
  };
}

export class MqttDiscoveryService {
  private config: MqttDiscoveryConfig;
  private db: Database;
  private logger?: AgentLogger;

  constructor(
    config: MqttDiscoveryConfig,
    db: Database,
    logger?: AgentLogger
  ) {
    this.config = config;
    this.db = db;
    this.logger = logger;
  }

  /**
   * Discover MQTT topics by monitoring broker activity
   * 
   * Pattern: Connect to Mosquitto broker (the endpoint) and subscribe to wildcards
   *          to see what topics are actively being published (by ESP32s, PLCs, IoT devices, etc.).
   *          This is like scanning a Modbus gateway to see what devices are connected,
   *          or browsing an OPC-UA server to see what nodes exist.
   */
  async discover(): Promise<number> {
    const brokerUrl = `mqtt://${this.config.broker.host}:${this.config.broker.port}`;
    
    this.logger?.infoSync('Starting MQTT discovery - monitoring broker endpoint', {
      component: LogComponents.mqtt,
      brokerEndpoint: brokerUrl, // This is the endpoint address
      discoveryTopics: this.config.discovery.topics,
      duration: `${this.config.discovery.duration_ms}ms`
    });

    const client = mqtt.connect(brokerUrl, {
      clientId: `iotistic-discovery-${Date.now()}`,
      username: this.config.broker.username,
      password: this.config.broker.password,
      clean: true
    });

    return new Promise((resolve, reject) => {
      const discovered = new Map<string, TopicMetadata>();
      let discoveredCount = 0;

      client.on('connect', () => {
        this.logger?.infoSync('MQTT discovery connected', {
          component: LogComponents.mqtt
        });

        // Subscribe to discovery wildcards
        this.config.discovery.topics.forEach(topic => {
          client.subscribe(topic, { qos: this.config.qos }, (err) => {
            if (err) {
              this.logger?.errorSync('Failed to subscribe to discovery topic', err, {
                component: LogComponents.mqtt,
                topic
              });
            } else {
              this.logger?.infoSync('Subscribed to discovery topic', {
                component: LogComponents.mqtt,
                topic
              });
            }
          });
        });

        // Collect messages
        client.on('message', (topic, payload) => {
          const now = Date.now();

          if (!discovered.has(topic)) {
            // New topic discovered
            const metadata = this.parseTopicMetadata(topic, payload);
            
            discovered.set(topic, {
              topic,
              firstSeen: now,
              lastSeen: now,
              messageCount: 1,
              lastPayload: payload,
              metadata
            });

            this.logger?.debugSync('New MQTT topic discovered', {
              component: LogComponents.mqtt,
              topic,
              metadata
            });
          } else {
            // Update existing topic
            const existing = discovered.get(topic)!;
            existing.lastSeen = now;
            existing.messageCount++;
            existing.lastPayload = payload;
          }
        });

        // Stop discovery after duration
        setTimeout(async () => {
          this.logger?.infoSync('MQTT discovery period complete', {
            component: LogComponents.mqtt,
            topicsDiscovered: discovered.size
          });

          // Validate topics (optional)
          let validated = Array.from(discovered.values());
          
          if (this.config.discovery.validate) {
            validated = validated.filter(meta => meta.messageCount > 0);
            
            this.logger?.infoSync('MQTT topics validated', {
              component: LogComponents.mqtt,
              total: discovered.size,
              valid: validated.length
            });
          }

          // Save to database
          for (const meta of validated) {
            await this.saveEndpoint(meta);
            discoveredCount++;
          }

          client.end();
          resolve(discoveredCount);
        }, this.config.discovery.duration_ms);
      });

      client.on('error', (err) => {
        this.logger?.errorSync('MQTT discovery error', err, {
          component: LogComponents.mqtt
        });
        client.end();
        reject(err);
      });
    });
  }

  /**
   * Parse topic structure to extract metadata
   */
  private parseTopicMetadata(topic: string, payload: Buffer): TopicMetadata['metadata'] {
    // Try to parse payload as JSON to get metadata
    let payloadData: any = null;
    try {
      payloadData = JSON.parse(payload.toString());
    } catch {
      // Plain text payload
    }

    // Extract device ID and metric from topic structure
    // Example patterns:
    //   device/sensor-01/temperature → deviceId: sensor-01, metric: temperature
    //   homie/device-01/temperature → deviceId: device-01, metric: temperature
    const parts = topic.split('/');
    
    let deviceId: string | undefined;
    let metric: string | undefined;
    
    if (parts.length >= 3) {
      deviceId = parts[1];
      metric = parts[parts.length - 1];
    }

    // Determine data type from payload
    let dataType = 'string';
    let unit: string | undefined;
    
    if (payloadData !== null) {
      // JSON payload
      if (typeof payloadData === 'object') {
        // Extract from JSON structure
        const value = payloadData.value ?? payloadData;
        dataType = this.inferDataType(value);
        unit = payloadData.unit;
      } else {
        dataType = this.inferDataType(payloadData);
      }
    } else {
      // Plain text payload
      const str = payload.toString();
      dataType = this.inferDataType(str);
    }

    return {
      dataType,
      unit,
      deviceId,
      metric: metric || topic // Fallback to full topic as metric
    };
  }

  /**
   * Infer data type from value
   */
  private inferDataType(value: any): string {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'float';
    }
    
    // Try to parse as number
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return num.toString().includes('.') ? 'float' : 'integer';
    }
    
    // Boolean strings
    if (value === 'true' || value === 'false') return 'boolean';
    
    return 'string';
  }

  /**
   * Save discovered endpoint to database
   */
  private async saveEndpoint(meta: TopicMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO endpoints (protocol, identifier, enabled, metadata, discovered_at, last_seen)
         VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))
         ON CONFLICT(protocol, identifier) DO UPDATE SET
           last_seen = datetime('now'),
           metadata = excluded.metadata`,
        [
          'mqtt',
          meta.topic,
          JSON.stringify({
            topic: meta.topic,
            qos: this.config.qos,
            dataType: meta.metadata.dataType,
            unit: meta.metadata.unit,
            deviceId: meta.metadata.deviceId,
            metric: meta.metadata.metric
          })
        ],
        (err) => {
          if (err) {
            this.logger?.errorSync('Failed to save MQTT endpoint', err, {
              component: LogComponents.mqtt,
              topic: meta.topic
            });
            reject(err);
            return;
          }

          this.logger?.infoSync('MQTT endpoint saved', {
            component: LogComponents.mqtt,
            topic: meta.topic,
            metadata: meta.metadata
          });

          resolve();
        }
      );
    });
  }
}
```

**Key Points**:
- Subscribes to wildcard patterns (`device/+/sensors/#`)
- Collects topics for configurable duration (default 30s)
- Parses topic structure to extract device ID and metric name
- Infers data type from first message payload
- Saves discovered topics to `endpoints` table
- Supports validation (ensures topics publish during discovery)

---

## Phase 4: Integration with Protocol Adapters

### Step 4.1: Add MQTT to Protocol Manager

**File**: `agent/src/protocols/protocol-manager.ts` (create or update)

```typescript
import { MqttAdapter, MqttAdapterConfig } from './mqtt/mqtt-adapter';
import { MqttDiscoveryService, MqttDiscoveryConfig } from './mqtt/mqtt-discovery';
import { Database } from 'sqlite3';
import type { AgentLogger } from '../logging/agent-logger';

export class ProtocolManager {
  private db: Database;
  private logger?: AgentLogger;
  private mqttAdapter?: MqttAdapter;

  constructor(db: Database, logger?: AgentLogger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Initialize MQTT adapter from config
   */
  async initMqtt(config: any): Promise<void> {
    if (!config.mqtt?.enabled) {
      this.logger?.infoSync('MQTT protocol disabled', {
        component: 'ProtocolManager'
      });
      return;
    }

    const mqttConfig: MqttAdapterConfig = {
      broker: config.mqtt.broker,
      qos: config.mqtt.qos || 1,
      reconnect: config.mqtt.reconnect || {
        period: 1000,
        maxAttempts: 10
      }
    };

    this.mqttAdapter = new MqttAdapter(mqttConfig, this.db, this.logger);
    
    // Connect and start subscriptions
    await this.mqttAdapter.start();

    // Forward data events to Sensor Publish
    this.mqttAdapter.on('data', (data) => {
      // Emit to sensor-publish service
      this.emit('mqtt-data', data);
    });
  }

  /**
   * Run MQTT discovery
   */
  async discoverMqtt(config: any): Promise<number> {
    if (!config.mqtt?.enabled) {
      return 0;
    }

    const discoveryConfig: MqttDiscoveryConfig = {
      broker: config.mqtt.broker,
      discovery: config.mqtt.discovery,
      qos: config.mqtt.qos || 1
    };

    const discoveryService = new MqttDiscoveryService(
      discoveryConfig,
      this.db,
      this.logger
    );

    const count = await discoveryService.discover();
    
    this.logger?.infoSync('MQTT discovery complete', {
      component: 'ProtocolManager',
      endpointsDiscovered: count
    });

    return count;
  }

  /**
   * Stop all protocol adapters
   */
  async stop(): Promise<void> {
    if (this.mqttAdapter) {
      await this.mqttAdapter.disconnect();
    }
  }
}
```

---

## Phase 5: Configuration Updates

### Step 5.1: Add MQTT to Target State Schema

**File**: `agent/src/types/target-state.ts` (or similar)

```typescript
export interface ProtocolConfig {
  modbus?: ModbusConfig;
  opcua?: OpcUaConfig;
  mqtt?: MqttConfig; // NEW
  can?: CanConfig;
  snmp?: SnmpConfig;
}

export interface MqttConfig {
  enabled: boolean;
  broker: {
    host: string; // 'mosquitto' for Docker container
    port: number;
    username?: string;
    password?: string;
  };
  discovery: {
    topics: string[]; // ['device/+/sensors/#']
    duration_ms: number; // 30000
    validate: boolean; // true
  };
  qos: 0 | 1 | 2;
  bufferCapacity: number; // 131072
  reconnect?: {
    period: number;
    maxAttempts: number;
  };
}
```

### Step 5.2: Update Default Target State

**Example cloud config** (sent to agent via target state):

```json
{
  "config": {
    "protocols": {
      "mqtt": {
        "enabled": true,
        "broker": {
          "host": "mosquitto",
          "port": 1883,
          "username": null,
          "password": null
        },
        "discovery": {
          "topics": ["device/+/sensors/#", "homie/+/#"],
          "duration_ms": 30000,
          "validate": true
        },
        "qos": 1,
        "bufferCapacity": 131072,
        "reconnect": {
          "period": 1000,
          "maxAttempts": 10
        }
      }
    }
  }
}
```

---

## Phase 6: Testing Plan

### Step 6.1: Unit Tests

**File**: `agent/test/protocols/mqtt-adapter.test.ts`

```typescript
describe('MqttAdapter', () => {
  it('should connect to broker', async () => {
    // Test connection
  });

  it('should subscribe to topics', async () => {
    // Test subscription
  });

  it('should parse JSON payloads', () => {
    // Test payload parsing
  });

  it('should emit data events', async () => {
    // Test event emission
  });

  it('should update last_seen', async () => {
    // Test database updates
  });
});
```

### Step 6.2: Integration Tests

**Test Scenario 1: Discovery**

1. Start Mosquitto container
2. Publish test messages to various topics
3. Run discovery
4. Verify endpoints saved to database

**Test Scenario 2: Data Collection**

1. Configure MQTT protocol
2. Start MQTT adapter
3. Publish test messages
4. Verify data events emitted
5. Verify forwarded to Sensor Publish

**Test Scenario 3: Reconnection**

1. Start adapter
2. Stop Mosquitto container
3. Verify reconnection attempts
4. Restart Mosquitto
5. Verify successful reconnection and resumed subscriptions

### Step 6.3: Manual Testing Commands

```bash
# 1. Start Mosquitto broker (the endpoint)
docker-compose up -d mosquitto

# 2. Simulate external MQTT publishers (ESP32, PLCs, IoT devices, etc.)
#    In production, these would be real devices publishing to the broker
mosquitto_pub -h localhost -p 1883 -t "device/esp32-01/temperature" -m '{"value": 23.5, "unit": "°C"}'
mosquitto_pub -h localhost -p 1883 -t "factory/plc-01/pressure" -m '{"value": 1013.25, "unit": "hPa"}'
mosquitto_pub -h localhost -p 1883 -t "homie/weather-station/humidity" -m '65'

# 3. Verify broker is receiving data (monitor endpoint)
mosquitto_sub -h localhost -p 1883 -t "#" -v  # All topics

# Check agent database
sqlite3 /var/lib/iotistic/agent/device.sqlite
> SELECT * FROM endpoints WHERE protocol = 'mqtt';
> SELECT * FROM endpoint_outputs WHERE protocol = 'mqtt';
```

---

## Phase 7: Deployment Checklist

### Step 7.1: Dependencies

- [x] `mqtt` npm package (already installed)
- [x] Mosquitto Docker container (already running)
- [x] SQLite database (existing)

### Step 7.2: Files to Create/Modify

**New Files**:
- [ ] `agent/src/protocols/mqtt/mqtt-adapter.ts`
- [ ] `agent/src/protocols/mqtt/mqtt-discovery.ts`
- [ ] `agent/src/protocols/mqtt/index.ts` (exports)
- [ ] `agent/test/protocols/mqtt-adapter.test.ts`
- [ ] `agent/src/db/migrations/XXX_add_mqtt_protocol_support.sql`

**Modified Files**:
- [ ] `agent/src/protocols/protocol-manager.ts` (add MQTT init)
- [ ] `agent/src/types/target-state.ts` (add MQTT config type)
- [ ] `agent/src/discovery/discovery-service.ts` (add MQTT discovery call)
- [ ] `agent/src/sensor-publish/sensor-publish.ts` (handle MQTT data events)

### Step 7.3: Configuration Updates

**Cloud-side** (`api/src/services/provisioning.service.ts`):
- [ ] Add default MQTT config to new device target states
- [ ] Add MQTT to protocol options in API

**Agent-side**:
- [ ] Ensure Docker Compose includes Mosquitto service
- [ ] Configure network access between agent and Mosquitto containers

---

## Phase 8: Topic Structure Recommendations

### Recommended Pattern: Hierarchical with JSON

**Topic Structure**:
```
device/{deviceId}/sensors/{metric}
```

**Payload Format**:
```json
{
  "value": 23.5,
  "unit": "°C",
  "timestamp": 1640000000000
}
```

**Examples**:
```
device/sensor-01/sensors/temperature → {"value": 23.5, "unit": "°C"}
device/sensor-01/sensors/humidity → {"value": 65, "unit": "%"}
device/sensor-01/sensors/pressure → {"value": 1013.25, "unit": "hPa"}
device/sensor-01/$status → "online"
```

**Benefits**:
- Self-describing (unit included in payload)
- Flexible (supports additional metadata)
- Easy to parse device ID and metric from topic
- Compatible with time-series databases
- JSON payload allows future extensibility

### Alternative: Homie Convention

If using standardized IoT devices:

```
homie/{deviceId}/$homie → "4.0"
homie/{deviceId}/$name → "Sensor Device"
homie/{deviceId}/$state → "ready"
homie/{deviceId}/temperature/$name → "Temperature"
homie/{deviceId}/temperature/$datatype → "float"
homie/{deviceId}/temperature/$unit → "°C"
homie/{deviceId}/temperature → "23.5"
```

**Benefits**:
- Industry standard
- Self-discovery
- Device metadata included

---

## Summary

**Implementation Phases**:
1. ✅ Database schema (no changes needed - existing tables work)
2. 🔄 MQTT Adapter (connect, subscribe, emit data)
3. 🔄 MQTT Discovery (wildcard monitoring, endpoint creation)
4. 🔄 Protocol Manager integration
5. 🔄 Configuration updates
6. 🔄 Testing
7. 🔄 Deployment

**Key Advantages**:
- Reuses existing infrastructure (`endpoints`, `endpoint_outputs` tables)
- Same data flow as Modbus/OPC-UA (consistent patterns)
- Mosquitto already containerized
- Auto-discovery of topics
- Supports JSON and plain text payloads
- Resilient reconnection handling

**Next Steps**:
1. Create MQTT adapter implementation
2. Create discovery service
3. Integrate with protocol manager
4. Test with Mosquitto container
5. Deploy to production devices
