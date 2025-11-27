# SNMP Protocol Adapter - Architecture Analysis & Implementation Recommendation

## Executive Summary

Based on analysis of the existing protocol adapter architecture (Modbus, OPC-UA, CAN), I recommend implementing SNMP support following the **BaseProtocolAdapter pattern** with full integration into the discovery service, database models, and SensorsFeature orchestration.

**Estimated Implementation Effort**: 16-24 hours (2-3 days)

---

## Current Architecture Analysis

### 1. Protocol Adapter Hierarchy

The codebase implements a clean, extensible protocol adapter architecture:

```
BaseProtocolAdapter (abstract)
├── ModbusAdapter (extends base)
├── OPCUAAdapter (extends base)
├── CANAdapter (planned, discovery exists)
└── SNMPAdapter (NEW - recommended)
```

**Key Files**:
- `agent/src/features/endpoints/base.ts` - Abstract base class (450 lines)
- `agent/src/features/endpoints/modbus/adapter.ts` - Reference implementation (500 lines)
- `agent/src/features/endpoints/opcua/opcua-adapter.ts` - Complex implementation (1200 lines)
- `agent/src/features/endpoints/index.ts` - SensorsFeature orchestrator (400 lines)

### 2. BaseProtocolAdapter Pattern (Template Method)

**Abstract Methods** (must implement):
```typescript
abstract getProtocolName(): string;
abstract connectDevice(device: GenericDeviceConfig): Promise<any>;
abstract disconnectDevice(deviceName: string): Promise<void>;
abstract readDeviceData(deviceName: string, device: GenericDeviceConfig): Promise<SensorDataPoint[]>;
abstract validateDeviceConfig(device: GenericDeviceConfig): void;
```

**Provided Functionality** (inherited):
- ✅ Device lifecycle management (connect/disconnect/reconnect)
- ✅ Polling with configurable intervals
- ✅ Exponential backoff retry logic (1s → 60s max)
- ✅ Device status tracking (DeviceStatus interface)
- ✅ Performance metrics (poll success rate, response time, register updates)
- ✅ Event emission ('data', 'device-connected', 'device-disconnected', 'device-error')
- ✅ BAD quality data points for offline/error devices
- ✅ Communication quality calculation (good/degraded/poor/offline)
- ✅ Database loading helper (`loadDevicesFromDatabase()`)

### 3. Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ SensorsFeature (Orchestrator)                               │
├─────────────────────────────────────────────────────────────┤
│  1. Load config from database                               │
│  2. Create SocketServer (per protocol)                      │
│  3. Create ProtocolAdapter (socket-agnostic)                │
│  4. Wire adapter 'data' events → SocketServer.sendData()    │
│  5. Start adapter polling                                   │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Protocol Adapter (e.g., SNMPAdapter)                        │
├─────────────────────────────────────────────────────────────┤
│  - Connect to devices (SNMP agents)                         │
│  - Poll OIDs at configured intervals                        │
│  - Emit 'data' events with SensorDataPoint[]                │
│  - Emit 'device-connected', 'device-disconnected' events    │
│  - Handle errors, emit BAD quality data points              │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ SocketServer (Unix domain socket)                           │
├─────────────────────────────────────────────────────────────┤
│  - Format: JSON or CSV                                      │
│  - Path: /tmp/snmp-sensor.sock                              │
│  - Broadcasts SensorDataPoint[] to socket clients           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ SensorPublishFeature (Consumer)                             │
├─────────────────────────────────────────────────────────────┤
│  - Reads from socket                                        │
│  - Buffers data points                                      │
│  - Publishes to MQTT topics                                 │
│  - Handles data transformations                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Database Schema

**Table: `endpoints`** (protocol adapter devices - renamed from `sensors` for clarity)
```sql
CREATE TABLE endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,               -- Stable identifier for cloud/edge sync (survives name changes)
  name TEXT NOT NULL UNIQUE,      -- Human-readable name (e.g., "plc-001", "router-core")
  protocol TEXT NOT NULL,         -- 'modbus' | 'can' | 'opcua' | 'snmp' (NEW)
  enabled BOOLEAN NOT NULL DEFAULT 1,
  poll_interval INTEGER NOT NULL DEFAULT 5000, -- Polling interval in milliseconds
  connection TEXT NOT NULL,       -- JSON: protocol-specific connection config
  data_points TEXT,               -- JSON: protocol-specific data point definitions (OIDs, registers, nodes)
  metadata TEXT,                  -- JSON: optional metadata (manufacturer, model, fingerprint, etc.)
  lastSeenAt DATETIME,            -- Last seen during discovery (for stale device detection)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_endpoints_protocol ON endpoints(protocol);
CREATE INDEX idx_endpoints_enabled ON endpoints(enabled);
```

**Table: `sensor_outputs`** (socket configuration per protocol)
```sql
CREATE TABLE sensor_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL UNIQUE,  -- 'modbus' | 'opcua' | 'can' | 'snmp' (NEW)
  socket_path TEXT NOT NULL,      -- Unix domain socket or named pipe path
  data_format TEXT NOT NULL DEFAULT 'json', -- 'json' | 'csv'
  delimiter TEXT NOT NULL DEFAULT '\n',     -- Line delimiter for streaming
  include_timestamp BOOLEAN NOT NULL DEFAULT 1,
  include_device_name BOOLEAN NOT NULL DEFAULT 1,
  logging TEXT,                   -- JSON: logging configuration (optional)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Note**: The table was renamed from `sensors` → `endpoints` in migration `20251118120000_rename_sensors_to_endpoints.js` to better reflect that these represent protocol communication endpoints rather than physical sensors.

### 5. Discovery Service Integration

**Current Discovery Plugins**:
- ✅ `ModbusDiscoveryPlugin` - Active scan (TCP port 502)
- ✅ `OPCUADiscoveryPlugin` - Endpoint discovery + browse
- ✅ `CANDiscoveryPlugin` - Passive listener (CAN bus traffic)

**Discovery Flow**:
```typescript
// agent/src/features/discovery/discovery-service.ts
class DiscoveryService {
  async runDiscovery(options: DiscoveryOptions): Promise<void> {
    // 1. Load enabled protocols from database
    // 2. For each protocol, call plugin.discover()
    // 3. For each discovered device, call plugin.validate() (if validate=true)
    // 4. Insert/update devices in sensors table
    // 5. Emit 'discovery-complete' event
  }
}
```

**Discovery Triggers**:
- First boot: Full discovery with validation
- Manual trigger: Full discovery with validation
- Scheduled: Light discovery (ping only, no validation)
  - Light: Every 4 hours (default)
  - Full: Every 24 hours (default)

---

## SNMP Protocol Characteristics

### 1. SNMP Basics

**Versions**:
- SNMPv1: Cleartext, community strings (public/private)
- SNMPv2c: Improved performance, still community strings
- SNMPv3: Encryption, authentication (USM), privacy (DES/AES)

**Operations**:
- GET: Read single OID
- GET-NEXT: Walk MIB tree
- GET-BULK: Read multiple OIDs (v2c/v3)
- SET: Write OID value (less common for monitoring)
- TRAP: Async notifications (separate service)

**Transport**:
- UDP port 161 (SNMP agent)
- UDP port 162 (SNMP trap receiver)

### 2. SNMP MIB (Management Information Base)

**Standard OIDs** (RFC 1213 - MIB-II):
```
System Group:
  1.3.6.1.2.1.1.1.0   - sysDescr
  1.3.6.1.2.1.1.3.0   - sysUpTime
  1.3.6.1.2.1.1.5.0   - sysName
  1.3.6.1.2.1.1.6.0   - sysLocation

Interfaces Group:
  1.3.6.1.2.1.2.1.0   - ifNumber
  1.3.6.1.2.1.2.2.1.2 - ifDescr (table)
  1.3.6.1.2.1.2.2.1.5 - ifSpeed (table)
  1.3.6.1.2.1.2.2.1.8 - ifOperStatus (table)

IP Group:
  1.3.6.1.2.1.4.3.0   - ipInReceives
  1.3.6.1.2.1.4.10.0  - ipInDiscards
```

**Vendor-Specific OIDs**:
- Cisco: 1.3.6.1.4.1.9.*
- HP: 1.3.6.1.4.1.11.*
- APC UPS: 1.3.6.1.4.1.318.*
- Net-SNMP: 1.3.6.1.4.1.8072.*

### 3. NPM Libraries (Node.js)

**Option 1: `net-snmp`** (Most Popular)
- ✅ Supports SNMPv1, v2c, v3
- ✅ GET, GET-NEXT, GET-BULK, SET
- ✅ MIB parsing (optional)
- ✅ Trap receiver (separate)
- ✅ TypeScript types available (@types/net-snmp)
- 📦 `npm install net-snmp`

**Option 2: `snmp-native`**
- ⚠️ SNMPv1/v2c only (no v3)
- ✅ Lightweight, fast
- ❌ No TypeScript types

**Recommendation**: Use `net-snmp` for full SNMPv3 support.

---

## Recommended Implementation

### Phase 1: Core Adapter (8-12 hours)

**1.1 Create SNMP Adapter File Structure**
```
agent/src/features/endpoints/snmp/
├── adapter.ts           # SNMPAdapter class (extends BaseProtocolAdapter)
├── client.ts            # SNMPClient wrapper (net-snmp abstraction)
├── types.ts             # TypeScript interfaces
├── oid-registry.ts      # Common OID mappings (optional)
└── mib-parser.ts        # MIB file parser (optional, Phase 3)
```

**1.2 SNMPAdapter Implementation**

```typescript
// agent/src/features/endpoints/snmp/adapter.ts
import { BaseProtocolAdapter, GenericDeviceConfig } from '../base.js';
import { SNMPClient } from './client.js';
import { SensorDataPoint, Logger } from '../types.js';
import { ConsoleLogger } from '../common/logger.js';
import { SNMPDeviceConfig, SNMPConnection, SNMPDataPoint } from './types.js';

export class SNMPAdapter extends BaseProtocolAdapter {
  private clients: Map<string, SNMPClient> = new Map();

  constructor(devices: GenericDeviceConfig[], logger?: Logger) {
    // Use provided logger or create ConsoleLogger (matches Modbus pattern)
    super(devices, logger || new ConsoleLogger('info', false));
  }

  protected getProtocolName(): string {
    return 'SNMP';
  }

  protected async connectDevice(device: GenericDeviceConfig): Promise<any> {
    const config = device as SNMPDeviceConfig;
    
    // Create SNMP client
    const client = new SNMPClient(config, this.logger);
    await client.connect();
    
    this.clients.set(device.name, client);
    return client;
  }

  protected async disconnectDevice(deviceName: string): Promise<void> {
    const client = this.clients.get(deviceName);
    if (client) {
      await client.disconnect();
      this.clients.delete(deviceName);
    }
  }

  protected async readDeviceData(
    deviceName: string,
    device: GenericDeviceConfig
  ): Promise<SensorDataPoint[]> {
    const client = this.clients.get(deviceName);
    if (!client) {
      throw new Error(`SNMP client not found for device: ${deviceName}`);
    }

    const config = device as SNMPDeviceConfig;
    const dataPoints: SensorDataPoint[] = [];
    const timestamp = new Date().toISOString();

    // Read all OIDs using GET-BULK (v2c/v3) or GET (v1)
    for (const oid of config.dataPoints) {
      try {
        const value = await client.get(oid.oid);
        
        // Apply scaling/offset if configured
        let numericValue = this.parseSnmpValue(value, oid);
        if (oid.scalingFactor) {
          numericValue = numericValue * oid.scalingFactor;
        }
        if (oid.offset) {
          numericValue = numericValue + oid.offset;
        }

        dataPoints.push({
          deviceName,
          registerName: oid.name,
          value: numericValue,
          unit: oid.unit || '',
          timestamp,
          quality: 'GOOD',
          qualityCode: 'OK'
        });
      } catch (error) {
        // Send BAD quality for failed OID reads
        dataPoints.push({
          deviceName,
          registerName: oid.name,
          value: null,
          unit: oid.unit || '',
          timestamp,
          quality: 'BAD',
          qualityCode: 'READ_ERROR'
        });
      }
    }

    return dataPoints;
  }

  protected validateDeviceConfig(device: GenericDeviceConfig): void {
    const config = device as SNMPDeviceConfig;
    
    if (!config.connection.host) {
      throw new Error('SNMP device config missing host');
    }
    if (!config.connection.community && !config.connection.username) {
      throw new Error('SNMP device config missing community string or username');
    }
    if (!config.dataPoints || config.dataPoints.length === 0) {
      throw new Error('SNMP device config missing dataPoints (OIDs)');
    }
  }

  private parseSnmpValue(value: any, oid: SNMPDataPoint): number {
    // Handle SNMP data types
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseFloat(value);
    if (Buffer.isBuffer(value)) {
      // Handle Counter32, Counter64, Gauge32, TimeTicks
      return value.readUInt32BE(0);
    }
    return 0;
  }
}
```

**1.3 SNMPClient Wrapper**

```typescript
// agent/src/features/endpoints/snmp/client.ts
import * as snmp from 'net-snmp';
import { SNMPDeviceConfig } from './types.js';
import type { Logger } from '../types.js';

export class SNMPClient {
  private session?: snmp.Session;
  private config: SNMPDeviceConfig;
  private logger: Logger;
  private connected = false;

  constructor(config: SNMPDeviceConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    const options: snmp.SessionOptions = {
      host: this.config.connection.host,
      port: this.config.connection.port || 161,
      version: this.mapVersion(this.config.connection.version),
      timeout: this.config.connection.timeout || 5000,
      retries: this.config.connection.retries || 1,
    };

    if (this.config.connection.version === 'v3') {
      // SNMPv3 with authentication
      options.user = {
        name: this.config.connection.username!,
        level: this.mapSecurityLevel(this.config.connection.securityLevel),
        authProtocol: this.mapAuthProtocol(this.config.connection.authProtocol),
        authKey: this.config.connection.authKey,
        privProtocol: this.mapPrivProtocol(this.config.connection.privProtocol),
        privKey: this.config.connection.privKey,
      };
    } else {
      // SNMPv1/v2c with community string
      options.community = this.config.connection.community || 'public';
    }

    this.session = snmp.createSession(options);
    this.connected = true;
    
    this.logger.info(`SNMP session created for ${this.config.name}`);
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      this.session.close();
      this.session = undefined;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async get(oid: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.session) {
        return reject(new Error('SNMP session not initialized'));
      }

      this.session.get([oid], (error, varbinds) => {
        if (error) {
          return reject(error);
        }

        if (varbinds.length === 0) {
          return reject(new Error(`No data for OID: ${oid}`));
        }

        const varbind = varbinds[0];
        if (snmp.isVarbindError(varbind)) {
          return reject(new Error(snmp.varbindError(varbind)));
        }

        resolve(varbind.value);
      });
    });
  }

  async getBulk(oids: string[], maxRepetitions = 10): Promise<Map<string, any>> {
    return new Promise((resolve, reject) => {
      if (!this.session) {
        return reject(new Error('SNMP session not initialized'));
      }

      this.session.getBulk(oids, 0, maxRepetitions, (error, varbinds) => {
        if (error) {
          return reject(error);
        }

        const results = new Map<string, any>();
        for (const varbind of varbinds) {
          if (!snmp.isVarbindError(varbind)) {
            results.set(varbind.oid, varbind.value);
          }
        }

        resolve(results);
      });
    });
  }

  private mapVersion(version: string): snmp.Version {
    switch (version) {
      case 'v1': return snmp.Version1;
      case 'v2c': return snmp.Version2c;
      case 'v3': return snmp.Version3;
      default: return snmp.Version2c;
    }
  }

  private mapSecurityLevel(level?: string): snmp.SecurityLevel {
    switch (level) {
      case 'noAuthNoPriv': return snmp.SecurityLevel.noAuthNoPriv;
      case 'authNoPriv': return snmp.SecurityLevel.authNoPriv;
      case 'authPriv': return snmp.SecurityLevel.authPriv;
      default: return snmp.SecurityLevel.noAuthNoPriv;
    }
  }

  private mapAuthProtocol(protocol?: string): snmp.AuthProtocol {
    switch (protocol) {
      case 'md5': return snmp.AuthProtocols.md5;
      case 'sha': return snmp.AuthProtocols.sha;
      default: return snmp.AuthProtocols.md5;
    }
  }

  private mapPrivProtocol(protocol?: string): snmp.PrivProtocol {
    switch (protocol) {
      case 'des': return snmp.PrivProtocols.des;
      case 'aes': return snmp.PrivProtocols.aes;
      default: return snmp.PrivProtocols.des;
    }
  }
}
```

**1.4 TypeScript Interfaces**

```typescript
// agent/src/features/endpoints/snmp/types.ts
import { GenericDeviceConfig } from '../base.js';

export interface SNMPConnection {
  host: string;
  port?: number; // Default: 161
  version: 'v1' | 'v2c' | 'v3'; // SNMP version
  
  // v1/v2c authentication
  community?: string; // Default: 'public'
  
  // v3 authentication
  username?: string;
  securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authProtocol?: 'md5' | 'sha';
  authKey?: string;
  privProtocol?: 'des' | 'aes';
  privKey?: string;
  
  // Connection settings
  timeout?: number; // ms (default: 5000)
  retries?: number; // Default: 1
  retryDelay?: number; // ms (default: 5000)
}

export interface SNMPDataPoint {
  name: string; // Human-readable name (e.g., 'cpu_usage')
  oid: string; // SNMP OID (e.g., '1.3.6.1.4.1.2021.11.9.0')
  unit?: string; // Unit of measurement (e.g., '%', 'bytes', 'packets')
  dataType?: 'integer' | 'counter32' | 'counter64' | 'gauge' | 'timeticks' | 'string';
  scalingFactor?: number; // Multiply by this value
  offset?: number; // Add this value
}

export interface SNMPDeviceConfig extends GenericDeviceConfig {
  protocol: 'snmp';
  connection: SNMPConnection;
  dataPoints: SNMPDataPoint[];
}
```

**1.5 Update SensorsFeature Orchestrator**

```typescript
// agent/src/features/endpoints/index.ts

// Add import
import { SNMPAdapter } from './snmp/adapter.js';

// Update SensorConfig interface
export interface SensorConfig extends FeatureConfig {
  modbus?: { enabled: boolean; config?: ModbusAdapterConfig };
  can?: { enabled: boolean };
  opcua?: { enabled: boolean; config?: OPCUAAdapterConfig };
  snmp?: { enabled: boolean }; // NEW
}

// Add to onStart() method
protected async onStart(): Promise<void> {
  // ... existing code ...

  // Start SNMP adapter if enabled
  if ((this.config as SensorConfig).snmp?.enabled) {
    await this.startSNMPAdapter();
  }
}

// Add new method
private async startSNMPAdapter(): Promise<void> {
  try {
    // Load devices from database
    const dbDevices = await DeviceSensorModel.getEnabled('snmp');
    
    // Create config
    const snmpDevices = dbDevices.map(d => ({
      name: d.name,
      protocol: 'snmp',
      enabled: d.enabled,
      connection: d.connection as any,
      pollInterval: d.poll_interval,
      dataPoints: (d.data_points || []).map((dp: any) => ({
        name: dp.name,
        oid: dp.oid,
        unit: dp.unit || '',
        dataType: dp.dataType || 'integer',
        scalingFactor: dp.scalingFactor || dp.scale || 1,
        offset: dp.offset || 0
      }))
    }));

      // Load output config from database
      const dbOutput = await SensorOutputModel.getOutput('snmp');
      if (!dbOutput) {
        throw new Error('SNMP output configuration not found in database');
      }
      outputConfig = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server
      const snmpSocket = new SocketServer(outputConfig, this.logger);
      await snmpSocket.start();
      this.socketServers.set('snmp', snmpSocket);
      this.logger.info(`SNMP socket server started at: ${outputConfig.socketPath}`);    // Create adapter
    const snmpAdapter = new SNMPAdapter(snmpDevices, this.logger);
    this.adapters.set('snmp', snmpAdapter);

    // Wire up events
    snmpAdapter.on('started', () => {
      this.logger.info('SNMP adapter started');
    });
    snmpAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
      snmpSocket.sendData(dataPoints);
    });
    snmpAdapter.on('device-connected', (deviceName: string) => {
      this.logger.info(`SNMP device connected: ${deviceName}`);
    });
    snmpAdapter.on('device-disconnected', (deviceName: string) => {
      this.logger.warn(`SNMP device disconnected: ${deviceName}`);
    });
    snmpAdapter.on('device-error', (deviceName: string, error: Error) => {
      this.logger.error(`SNMP device error [${deviceName}]: ${error.message}`);
    });

    // Start adapter
    await snmpAdapter.start();
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.error(`Failed to start SNMP adapter: ${errorMessage}`);
    throw error;
  }
}
```

---

### Phase 2: Discovery Plugin (4-6 hours)

**2.1 SNMP Discovery Plugin**

```typescript
// agent/src/features/discovery/snmp.discovery.ts
import { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import type { Logger } from '../../logging/types';
import * as snmp from 'net-snmp';

export interface SNMPDiscoveryOptions {
  ipRanges?: string[]; // CIDR notation (e.g., '192.168.1.0/24')
  communities?: string[]; // Try multiple community strings
  port?: number; // Default: 161
  timeout?: number; // ms per device (default: 2000)
  concurrency?: number; // Parallel scans (default: 10)
}

export class SNMPDiscoveryPlugin extends BaseDiscoveryPlugin {
  protected protocol = 'snmp';

  constructor(logger?: Logger) {
    super(logger);
  }

  /**
   * Phase 1: Quick discovery - ping SNMP agents
   */
  async discover(options?: SNMPDiscoveryOptions): Promise<DiscoveredDevice[]> {
    const ipRanges = options?.ipRanges || this.getDefaultIpRanges();
    const communities = options?.communities || ['public', 'private'];
    const port = options?.port || 161;
    const timeout = options?.timeout || 2000;
    const concurrency = options?.concurrency || 10;

    this.logger?.infoSync('Starting SNMP discovery', {
      component: 'SNMPDiscoveryPlugin',
      ipRanges,
      communities: communities.length,
      port,
      phase: 'discovery'
    });

    const devices: DiscoveredDevice[] = [];
    const ipAddresses = this.expandIpRanges(ipRanges);

    // Scan in batches for performance
    for (let i = 0; i < ipAddresses.length; i += concurrency) {
      const batch = ipAddresses.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(ip => this.pingSnmpDevice(ip, port, communities, timeout))
      );

      for (const result of results) {
        if (result) {
          devices.push(result);
        }
      }
    }

    this.logger?.infoSync('SNMP discovery completed', {
      component: 'SNMPDiscoveryPlugin',
      devicesFound: devices.length,
      phase: 'discovery'
    });

    return devices;
  }

  /**
   * Phase 2: Validate device - read system OIDs
   */
  async validate(device: DiscoveredDevice): Promise<boolean> {
    try {
      const connection = device.connection as any;
      const session = snmp.createSession(connection.host, connection.community || 'public');

      // Read standard system OIDs
      const systemOids = [
        '1.3.6.1.2.1.1.1.0', // sysDescr
        '1.3.6.1.2.1.1.5.0', // sysName
        '1.3.6.1.2.1.1.6.0', // sysLocation
      ];

      const results = await this.getOids(session, systemOids);
      session.close();

      // Device is valid if we can read at least sysDescr
      return results.has('1.3.6.1.2.1.1.1.0');

    } catch (error) {
      this.logger?.debugSync('SNMP validation failed', {
        component: 'SNMPDiscoveryPlugin',
        device: device.name,
        error: error instanceof Error ? error.message : String(error),
        phase: 'validation'
      });
      return false;
    }
  }

  /**
   * Ping SNMP device to check if it responds
   */
  private async pingSnmpDevice(
    ip: string,
    port: number,
    communities: string[],
    timeout: number
  ): Promise<DiscoveredDevice | null> {
    // Try each community string
    for (const community of communities) {
      try {
        const session = snmp.createSession(ip, community, { timeout, port });
        
        // Quick read of sysDescr OID
        const sysDescr = await this.getSingleOid(session, '1.3.6.1.2.1.1.1.0');
        session.close();

        if (sysDescr) {
          return {
            name: `snmp-${ip.replace(/\./g, '-')}`,
            protocol: 'snmp',
            connection: {
              host: ip,
              port,
              version: 'v2c',
              community
            },
            dataPoints: [],
            metadata: {
              sysDescr,
              discoveryMethod: 'network_scan',
              discoveredAt: new Date().toISOString()
            }
          };
        }
      } catch (error) {
        // Try next community string
        continue;
      }
    }

    return null;
  }

  /**
   * Get single OID value
   */
  private getSingleOid(session: snmp.Session, oid: string): Promise<string | null> {
    return new Promise((resolve) => {
      session.get([oid], (error, varbinds) => {
        if (error || varbinds.length === 0) {
          return resolve(null);
        }
        const varbind = varbinds[0];
        if (snmp.isVarbindError(varbind)) {
          return resolve(null);
        }
        resolve(varbind.value.toString());
      });
    });
  }

  /**
   * Get multiple OIDs
   */
  private getOids(session: snmp.Session, oids: string[]): Promise<Map<string, any>> {
    return new Promise((resolve, reject) => {
      session.get(oids, (error, varbinds) => {
        if (error) {
          return reject(error);
        }

        const results = new Map<string, any>();
        for (const varbind of varbinds) {
          if (!snmp.isVarbindError(varbind)) {
            results.set(varbind.oid, varbind.value);
          }
        }
        resolve(results);
      });
    });
  }

  /**
   * Expand CIDR IP ranges to individual IPs
   */
  private expandIpRanges(ranges: string[]): string[] {
    const ips: string[] = [];
    
    for (const range of ranges) {
      if (range.includes('/')) {
        // CIDR notation (e.g., '192.168.1.0/24')
        const [base, bits] = range.split('/');
        const maskBits = parseInt(bits, 10);
        const hostBits = 32 - maskBits;
        const numHosts = Math.pow(2, hostBits) - 2; // Exclude network and broadcast

        const baseParts = base.split('.').map(Number);
        const baseInt = (baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3];

        for (let i = 1; i <= numHosts; i++) {
          const ip = baseInt + i;
          const ipStr = [
            (ip >>> 24) & 0xff,
            (ip >>> 16) & 0xff,
            (ip >>> 8) & 0xff,
            ip & 0xff
          ].join('.');
          ips.push(ipStr);
        }
      } else {
        // Single IP
        ips.push(range);
      }
    }

    return ips;
  }

  /**
   * Get default IP ranges from environment or use local network
   */
  private getDefaultIpRanges(): string[] {
    const envRanges = process.env.SNMP_DISCOVERY_IP_RANGES;
    if (envRanges) {
      return envRanges.split(',').map(r => r.trim());
    }
    
    // Default: scan local /24 network
    return ['192.168.1.0/24'];
  }
}
```

**2.2 Register Discovery Plugin**

```typescript
// agent/src/features/discovery/discovery-service.ts

// Add import
import { SNMPDiscoveryPlugin } from './snmp.discovery';

// Update DiscoveryProtocol type
export type DiscoveryProtocol = 'modbus' | 'opcua' | 'can' | 'snmp';

// Update initializePlugins() method
private initializePlugins(): Map<DiscoveryProtocol, BaseDiscoveryPlugin> {
  const plugins = new Map<DiscoveryProtocol, BaseDiscoveryPlugin>();
  
  plugins.set('modbus', new ModbusDiscoveryPlugin(this.logger));
  plugins.set('opcua', new OPCUADiscoveryPlugin(this.logger));
  plugins.set('can', new CANDiscoveryPlugin(this.logger));
  plugins.set('snmp', new SNMPDiscoveryPlugin(this.logger)); // NEW
  
  return plugins;
}

// Update getDiscoveryOptions() method
private getDiscoveryOptions(protocol: DiscoveryProtocol): any {
  switch (protocol) {
    case 'modbus': return this.getModbusOptions();
    case 'opcua': return this.getOPCUAOptions();
    case 'can': return this.getCANOptions();
    case 'snmp': return this.getSNMPOptions(); // NEW
  }
}

// Add new method
private getSNMPOptions(): SNMPDiscoveryOptions | undefined {
  const ipRanges = process.env.SNMP_DISCOVERY_IP_RANGES?.split(',');
  const communities = process.env.SNMP_COMMUNITIES?.split(',') || ['public'];
  
  return {
    ipRanges,
    communities,
    port: parseInt(process.env.SNMP_PORT || '161', 10),
    timeout: parseInt(process.env.SNMP_DISCOVERY_TIMEOUT || '2000', 10),
    concurrency: parseInt(process.env.SNMP_DISCOVERY_CONCURRENCY || '10', 10)
  };
}
```

---

### Phase 3: Database Integration (2-3 hours)

**3.1 Update Database Models**

```typescript
// agent/src/db/models/sensors.model.ts

// Update DeviceSensor type
export interface DeviceSensor {
  id?: number;
  uuid?: string; // Stable identifier for cloud/edge sync
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp'; // Add 'snmp'
  enabled: boolean;
  poll_interval: number;
  connection: Record<string, any>;
  data_points?: any[];
  metadata?: Record<string, any>;
  lastSeenAt?: Date;
  created_at?: Date;
  updated_at?: Date;
}

// Note: The table name is 'endpoints' (not 'sensors')
// Model class queries 'endpoints' table via: private static table = 'endpoints';
```

**3.2 Add SNMP to TypeScript Protocol Union**

```typescript
// Update interface in sensors.model.ts
protocol: 'modbus' | 'can' | 'opcua' | 'snmp'

// Update interface in sensor-outputs.model.ts
protocol: 'modbus' | 'can' | 'opcua' | 'snmp'
```

**3.3 Database Migration**

**CRITICAL PREREQUISITE**: The `sensor_outputs` entry **MUST** be added before the protocol adapter can start. The SensorsFeature will fail to initialize if the output configuration is missing.

**Migration 1: SNMP Socket Output Configuration**

File: `agent/src/db/migrations/20251127000000_add_snmp_sensor_output.js`

This migration **MUST run FIRST** to create the socket configuration before the adapter can start:

```javascript
/**
 * Migration: Add SNMP sensor output configuration
 * Inserts default output config for SNMP protocol
 * This allows the SNMP adapter to start without manual configuration
 */

exports.up = async function(knex) {
  // Detect platform for socket paths
  const isWindows = process.platform === 'win32';
  
  // Insert default output configuration for SNMP
  await knex('sensor_outputs').insert({
    protocol: 'snmp',
    socket_path: isWindows ? '\\\\.\\pipe\\snmp' : '/tmp/snmp.sock',
    data_format: 'json',
    delimiter: '\n',
    include_timestamp: true,
    include_device_name: true,
    logging: JSON.stringify({ level: 'info' })
  });
};

exports.down = async function(knex) {
  // Remove SNMP configuration
  await knex('sensor_outputs').where('protocol', 'snmp').del();
};
```

**Migration 2: SNMP Device Endpoints (Optional)**

File: `agent/src/db/migrations/20251127000001_add_snmp_devices.js`

This migration runs **AFTER** the socket output configuration exists. It adds example SNMP devices (optional - devices can also be added via discovery or API):

```javascript
/**
 * Migration: Add SNMP device endpoints
 * Creates endpoint records for discovered SNMP devices
 * Requires: 20251127000000_add_snmp_sensor_output.js
 */

exports.up = async function(knex) {
  // Add example SNMP device (disabled by default for safety)
  // Users should enable and configure their own devices
  await knex('endpoints').insert({
    uuid: knex.raw("lower(hex(randomblob(16)))"), // Generate UUID in SQLite
    name: 'router-192-168-1-1',
    protocol: 'snmp',
    enabled: 0, // Disabled by default - user must explicitly enable
    poll_interval: 10000, // Poll every 10 seconds
    connection: JSON.stringify({
      host: '192.168.1.1',
      port: 161,
      version: 'v2c',
      community: 'public',
      timeout: 5000,
      retries: 1
    }),
    data_points: JSON.stringify([
      {
        name: 'sysDescr',
        oid: '1.3.6.1.2.1.1.1.0',
        unit: '',
        dataType: 'string'
      },
      {
        name: 'sysUpTime',
        oid: '1.3.6.1.2.1.1.3.0',
        unit: 'timeticks',
        dataType: 'timeticks'
      },
      {
        name: 'ifInOctets',
        oid: '1.3.6.1.2.1.2.2.1.10.1',
        unit: 'bytes',
        dataType: 'counter32'
      },
      {
        name: 'ifOutOctets',
        oid: '1.3.6.1.2.1.2.2.1.16.1',
        unit: 'bytes',
        dataType: 'counter32'
      }
    ]),
    metadata: JSON.stringify({
      deviceType: 'router',
      manufacturer: 'Cisco',
      model: 'Unknown'
    })
  }).onConflict('name').ignore(); // Skip if already exists
};

exports.down = async function(knex) {
  // Remove SNMP devices
  await knex('endpoints').where('protocol', 'snmp').del();
};
```

**Migration Order & Pattern**:
1. **20251127000000_add_snmp_sensor_output.js** - Socket configuration (REQUIRED)
2. **20251127000001_add_snmp_devices.js** - Example devices (OPTIONAL)

This follows the same pattern as `20251117000000_add_default_sensor_outputs.js` which initialized outputs for Modbus, CAN, and OPC-UA protocols.

**3.3 Update FeatureInitializer**

```typescript
// agent/src/bootstrap/feature-initializer.ts

private async initProtocolAdapters(): Promise<void> {
  try {
    const logger = this.context.logger;
    const configFeatures = this.context.configFeatures;

    const adapterConfig = {
      enabled: true,
      ...configFeatures.protocolAdapters,
      // Enable SNMP by default if ENABLE_PROTOCOL_ADAPTERS is set
      snmp: {
        enabled: process.env.ENABLE_PROTOCOL_ADAPTERS === 'true' || configFeatures.protocolAdapters?.snmp?.enabled
      }
    };

    // ... existing code ...
  }
}
```

---

### Phase 4: Testing & Documentation (2-4 hours)

**4.1 Unit Tests** (Following Modbus Test Pattern)

```typescript
// agent/test/unit/features/endpoints/snmp-adapter.unit.spec.ts
import { SNMPAdapter } from '../../../../src/features/endpoints/snmp/adapter';
import { SNMPDeviceConfig } from '../../../../src/features/endpoints/snmp/types';
import { SensorDataPoint } from '../../../../src/features/endpoints/types';

describe('SNMPAdapter', () => {
  let mockLogger: any;
  let devices: SNMPDeviceConfig[];

  beforeEach(() => {
    // Mock logger (matches existing pattern from modbus-adapter.unit.spec.ts)
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    // Test device configuration
    devices = [{
      name: 'test-router',
      protocol: 'snmp',
      enabled: true,
      pollInterval: 5000,
      connection: {
        host: '192.168.1.1',
        port: 161,
        version: 'v2c',
        community: 'public',
        timeout: 5000,
        retries: 1
      },
      dataPoints: [
        {
          name: 'sysDescr',
          oid: '1.3.6.1.2.1.1.1.0',
          unit: '',
          dataType: 'string'
        },
        {
          name: 'sysUpTime',
          oid: '1.3.6.1.2.1.1.3.0',
          unit: 'timeticks',
          dataType: 'timeticks'
        }
      ],
      metadata: {
        deviceType: 'router',
        manufacturer: 'Cisco'
      }
    }];
  });

  afterEach(async () => {
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create adapter instance', () => {
      const adapter = new SNMPAdapter(devices, mockLogger);
      expect(adapter).toBeDefined();
      expect(adapter.isRunning()).toBe(false);
    });

    it('should initialize with empty devices', () => {
      const adapter = new SNMPAdapter([], mockLogger);
      expect(adapter).toBeDefined();
      expect(adapter.getDeviceStatuses()).toEqual([]);
    });
  });

  describe('Lifecycle', () => {
    it('should start with no devices', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      await adapter.start();
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SNMP adapter started')
      );
      expect(adapter.isRunning()).toBe(true);
    });

    it('should emit started event', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      const startedSpy = jest.fn();
      adapter.on('started', startedSpy);
      
      await adapter.start();
      
      expect(startedSpy).toHaveBeenCalled();
    });

    it('should stop adapter', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      await adapter.start();
      await adapter.stop();
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('SNMP adapter stopped')
      );
      expect(adapter.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      await adapter.start();
      await adapter.start();
      
      const startedCalls = mockLogger.info.mock.calls.filter(
        (call: any[]) => call[0].includes('started')
      );
      expect(startedCalls.length).toBe(1);
    });

    it('should emit stopped event', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      const stoppedSpy = jest.fn();
      adapter.on('stopped', stoppedSpy);
      
      await adapter.start();
      await adapter.stop();
      
      expect(stoppedSpy).toHaveBeenCalled();
    });
  });

  describe('Device Status', () => {
    it('should return empty device statuses when no devices', () => {
      const adapter = new SNMPAdapter([], mockLogger);
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toEqual([]);
    });

    it('should initialize device statuses', () => {
      const adapter = new SNMPAdapter(devices, mockLogger);
      const statuses = adapter.getDeviceStatuses();
      
      expect(statuses).toHaveLength(1);
      expect(statuses[0].deviceName).toBe('test-router');
      expect(statuses[0].connected).toBe(false);
      expect(statuses[0].communicationQuality).toBe('offline');
    });
  });

  describe('Configuration Validation', () => {
    it('should validate device config with missing host', () => {
      const invalidDevices = [{
        ...devices[0],
        connection: { ...devices[0].connection, host: '' }
      }];
      
      const adapter = new SNMPAdapter(invalidDevices, mockLogger);
      expect(() => adapter.start()).rejects.toThrow('missing host');
    });

    it('should validate device config with missing community/username', () => {
      const invalidDevices = [{
        ...devices[0],
        connection: { 
          host: '192.168.1.1',
          version: 'v2c' as const
          // Missing community
        }
      }];
      
      const adapter = new SNMPAdapter(invalidDevices as any, mockLogger);
      expect(() => adapter.start()).rejects.toThrow('missing community');
    });

    it('should validate device config with missing dataPoints', () => {
      const invalidDevices = [{
        ...devices[0],
        dataPoints: []
      }];
      
      const adapter = new SNMPAdapter(invalidDevices, mockLogger);
      expect(() => adapter.start()).rejects.toThrow('missing dataPoints');
    });
  });

  describe('Event Emission', () => {
    it('should emit data event with GOOD quality', async () => {
      const adapter = new SNMPAdapter([], mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);
      
      // Test will require mocking SNMPClient
      // Implementation details depend on how you mock SNMP library
    });

    it('should emit data event with BAD quality on error', async () => {
      // Test offline device scenario
      // Should emit BAD quality data points
    });

    it('should emit device-connected event', async () => {
      const adapter = new SNMPAdapter(devices, mockLogger);
      const connectedSpy = jest.fn();
      adapter.on('device-connected', connectedSpy);
      
      // Mock successful connection
      // await adapter.start();
      // expect(connectedSpy).toHaveBeenCalledWith('test-router');
    });

    it('should emit device-error event on failure', async () => {
      const adapter = new SNMPAdapter(devices, mockLogger);
      const errorSpy = jest.fn();
      adapter.on('device-error', errorSpy);
      
      // Mock connection failure
      // await adapter.start();
      // expect(errorSpy).toHaveBeenCalledWith('test-router', expect.any(Error));
    });
  });
});
```

**4.2 Integration Tests** (Requires snmpsim)

```bash
# Install SNMP simulator for testing
pip install snmpsim

# Start simulator on non-standard port (avoid conflicts)
snmpsim-command-responder \
  --data-dir=/usr/share/snmpsim/data \
  --agent-udpv4-endpoint=127.0.0.1:11161 \
  --process-user=nobody \
  --process-group=nobody
```

```typescript
// agent/test/integration/snmp-adapter.integration.spec.ts
import { SNMPAdapter } from '../../src/features/endpoints/snmp/adapter';
import { SNMPDeviceConfig } from '../../src/features/endpoints/snmp/types';
import { ConsoleLogger } from '../../src/features/endpoints/common/logger';

describe('SNMPAdapter Integration Tests', () => {
  let adapter: SNMPAdapter;
  let logger: ConsoleLogger;

  beforeAll(() => {
    // Verify snmpsim is running
    // Skip tests if not available
  });

  beforeEach(() => {
    logger = new ConsoleLogger('error', false);
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
  });

  it('should connect to snmpsim and read sysDescr', async () => {
    const devices: SNMPDeviceConfig[] = [{
      name: 'snmpsim-device',
      protocol: 'snmp',
      enabled: true,
      pollInterval: 5000,
      connection: {
        host: '127.0.0.1',
        port: 11161,
        version: 'v2c',
        community: 'public',
        timeout: 5000,
        retries: 1
      },
      dataPoints: [
        {
          name: 'sysDescr',
          oid: '1.3.6.1.2.1.1.1.0',
          unit: '',
          dataType: 'string'
        }
      ]
    }];

    adapter = new SNMPAdapter(devices, logger);
    
    const dataPromise = new Promise((resolve) => {
      adapter.once('data', resolve);
    });

    await adapter.start();
    
    const data = await dataPromise;
    expect(data).toBeDefined();
    expect(data[0].deviceName).toBe('snmpsim-device');
    expect(data[0].quality).toBe('GOOD');
  }, 10000);

  it('should handle connection timeout', async () => {
    const devices: SNMPDeviceConfig[] = [{
      name: 'offline-device',
      protocol: 'snmp',
      enabled: true,
      pollInterval: 5000,
      connection: {
        host: '192.0.2.1', // TEST-NET-1 (unreachable)
        port: 161,
        version: 'v2c',
        community: 'public',
        timeout: 2000,
        retries: 1
      },
      dataPoints: [
        {
          name: 'sysDescr',
          oid: '1.3.6.1.2.1.1.1.0',
          unit: '',
          dataType: 'string'
        }
      ]
    }];

    adapter = new SNMPAdapter(devices, logger);
    
    const errorPromise = new Promise((resolve) => {
      adapter.once('device-error', resolve);
    });

    await adapter.start();
    
    const [deviceName, error] = await errorPromise;
    expect(deviceName).toBe('offline-device');
    expect(error.message).toContain('timeout');
  }, 15000);

  it('should emit BAD quality data for offline devices', async () => {
    const devices: SNMPDeviceConfig[] = [{
      name: 'offline-device',
      protocol: 'snmp',
      enabled: true,
      pollInterval: 2000,
      connection: {
        host: '192.0.2.1',
        port: 161,
        version: 'v2c',
        community: 'public',
        timeout: 1000,
        retries: 0
      },
      dataPoints: [
        {
          name: 'sysDescr',
          oid: '1.3.6.1.2.1.1.1.0',
          unit: '',
          dataType: 'string'
        }
      ]
    }];

    adapter = new SNMPAdapter(devices, logger);
    
    const dataPromise = new Promise((resolve) => {
      adapter.once('data', resolve);
    });

    await adapter.start();
    
    const data = await dataPromise;
    expect(data[0].quality).toBe('BAD');
    expect(data[0].qualityCode).toBe('TIMEOUT');
    expect(data[0].value).toBeNull();
  }, 10000);
});
```

**Running Integration Tests**:
```bash
# Start snmpsim first
docker run -d -p 11161:161/udp \
  --name snmpsim \
  tandrup/snmpsim

# Run integration tests
cd agent
npm run test:integration -- snmp-adapter.integration.spec.ts

# Cleanup
docker stop snmpsim && docker rm snmpsim
```

**4.3 Documentation**

```markdown
# docs/SNMP-ADAPTER-GUIDE.md
- Configuration examples
- Common OID mappings
- Troubleshooting guide
- Security best practices (SNMPv3)
```

---

## Environment Variables

```bash
# SNMP Adapter
ENABLE_PROTOCOL_ADAPTERS=true  # Enable all adapters (including SNMP)

# SNMP Discovery
SNMP_DISCOVERY_IP_RANGES=192.168.1.0/24,10.0.0.0/24  # CIDR ranges
SNMP_COMMUNITIES=public,private,community123          # Community strings to try
SNMP_PORT=161                                         # Default: 161
SNMP_DISCOVERY_TIMEOUT=2000                           # ms per device
SNMP_DISCOVERY_CONCURRENCY=10                         # Parallel scans

# Discovery Schedule
DISCOVERY_FULL_INTERVAL_MS=86400000   # 24 hours (full scan with validation)
DISCOVERY_LIGHT_INTERVAL_MS=14400000  # 4 hours (light scan - ping only)
```

---

## Example Device Configuration (SQLite)

**Simple SNMP v2c Device** (Router):
```json
{
  "name": "router-core",
  "protocol": "snmp",
  "enabled": true,
  "pollInterval": 10000,
  "connection": {
    "host": "192.168.1.1",
    "port": 161,
    "version": "v2c",
    "community": "public",
    "timeout": 5000,
    "retries": 1
  },
  "dataPoints": [
    {
      "name": "interface_inbound_traffic",
      "oid": "1.3.6.1.2.1.2.2.1.10.1",
      "unit": "bytes",
      "dataType": "counter32",
      "scalingFactor": 1
    },
    {
      "name": "interface_outbound_traffic",
      "oid": "1.3.6.1.2.1.2.2.1.16.1",
      "unit": "bytes",
      "dataType": "counter32",
      "scalingFactor": 1
    },
    {
      "name": "cpu_usage",
      "oid": "1.3.6.1.4.1.9.2.1.56.0",
      "unit": "%",
      "dataType": "integer",
      "scalingFactor": 1
    }
  ],
  "metadata": {
    "deviceType": "router",
    "manufacturer": "Cisco"
  }
}
```

**Secure SNMP v3 Device** (Server):
```json
{
  "name": "server-prod-01",
  "protocol": "snmp",
  "enabled": true,
  "pollInterval": 5000,
  "connection": {
    "host": "10.0.1.100",
    "port": 161,
    "version": "v3",
    "username": "monitor_user",
    "securityLevel": "authPriv",
    "authProtocol": "sha",
    "authKey": "authenticationPassword123",
    "privProtocol": "aes",
    "privKey": "privacyPassword456",
    "timeout": 5000,
    "retries": 1
  },
  "dataPoints": [
    {
      "name": "cpu_load_1min",
      "oid": "1.3.6.1.4.1.2021.10.1.3.1",
      "unit": "",
      "dataType": "integer",
      "scalingFactor": 0.01
    },
    {
      "name": "memory_available",
      "oid": "1.3.6.1.4.1.2021.4.6.0",
      "unit": "KB",
      "dataType": "integer"
    },
    {
      "name": "disk_usage_root",
      "oid": "1.3.6.1.4.1.2021.9.1.9.1",
      "unit": "%",
      "dataType": "integer"
    }
  ]
}
```

---

## Implementation Checklist

### Phase 1: Core Adapter (8-12 hours)
- [ ] Create `agent/src/features/endpoints/snmp/` directory
- [ ] Implement `adapter.ts` (SNMPAdapter class)
- [ ] Implement `client.ts` (SNMPClient wrapper)
- [ ] Implement `types.ts` (TypeScript interfaces)
- [ ] Update `agent/src/features/endpoints/index.ts` (add startSNMPAdapter)
- [ ] Update `agent/src/features/endpoints/types.ts` (add SNMP to SensorConfig)
- [ ] Install npm dependencies: `npm install net-snmp @types/net-snmp`
- [ ] Test with local SNMP simulator

### Phase 2: Discovery Plugin (4-6 hours)
- [ ] Create `agent/src/features/discovery/snmp.discovery.ts`
- [ ] Implement discovery logic (IP range scanning)
- [ ] Implement validation logic (read system OIDs)
- [ ] Update `agent/src/features/discovery/discovery-service.ts`
- [ ] Add SNMP environment variables
- [ ] Test discovery with local network

### Phase 3: Database Integration (2-3 hours)
- [ ] Update `agent/src/db/models/sensors.model.ts` (add 'snmp' to protocol union type)
- [ ] Update `agent/src/db/models/sensor-outputs.model.ts` (add 'snmp' to protocol union type)
- [ ] Create database migrations:
  - [ ] `20251127000000_add_snmp_sensor_output.js` (socket config - REQUIRED FIRST)
  - [ ] `20251127000001_add_snmp_devices.js` (example devices - OPTIONAL)
- [ ] **CRITICAL**: Socket output migration MUST run BEFORE device migration or adapter start
- [ ] Update `agent/src/bootstrap/feature-initializer.ts`
- [ ] Run migrations: `cd agent && npx knex migrate:latest`
- [ ] Verify output config exists: `sqlite3 data/iotistic.db "SELECT * FROM sensor_outputs WHERE protocol='snmp'"`
- [ ] Test database loading with `DeviceSensorModel.getEnabled('snmp')`

### Phase 4: Testing & Documentation (2-4 hours)

**4.1 SNMP Simulator Setup**

First, ensure the SNMP simulator is available for testing. The simulator is located at `sensors/snmp-simulator/` and provides:

- **MIB-II Standard OIDs** (System, Interface, IP, TCP, UDP groups)
- **Host Resources MIB** (Memory, CPU, Storage)
- **Custom Enterprise OIDs** for industrial sensors
- **Dynamic data generation** with realistic patterns

```bash
# Start SNMP simulator
docker-compose up -d snmp-simulator

# Verify simulator is running
docker logs -f iotistic-snmp-sim

# Test with snmpwalk
snmpwalk -v2c -c public localhost:161

# Test specific OIDs
snmpget -v2c -c public localhost 1.3.6.1.2.1.1.5.0  # sysName
snmpget -v2c -c public localhost 1.3.6.1.4.1.99999.1.1.0  # Temperature
```

**Available Simulator OIDs**:
- System: `1.3.6.1.2.1.1.x` (sysName, sysUpTime, sysDescr)
- Interface: `1.3.6.1.2.1.2.2.1.x` (ifInOctets, ifOutOctets)
- CPU Load: `1.3.6.1.2.1.25.3.3.1.2.1`
- Custom Sensors: `1.3.6.1.4.1.99999.1.x` (temperature, humidity, pressure, power)

**4.2 Unit Tests - SNMPAdapter** (following `modbus-adapter.unit.spec.ts` pattern)
- [ ] Constructor and initialization
- [ ] Lifecycle (start/stop/isRunning)
- [ ] Event emission (started, stopped, data, device-connected, device-error)
- [ ] Device status tracking
- [ ] Configuration validation
- [ ] Mock logger usage (debug, info, warn, error)

**4.3 Unit Tests - SNMPClient**
- [ ] Connection handling (v1, v2c, v3)
- [ ] GET operations
- [ ] GET-BULK operations (v2c/v3)
- [ ] Error handling (timeouts, invalid OIDs)
- [ ] Session cleanup

**4.4 Integration Tests** (uses SNMP simulator)
```typescript
// Example integration test
describe('SNMPAdapter Integration', () => {
  beforeAll(async () => {
    // Ensure snmp-simulator container is running
    // docker-compose up -d snmp-simulator
  });

  it('should read data from SNMP simulator', async () => {
    const device: SNMPDeviceConfig = {
      name: 'test-snmp-device',
      protocol: 'snmp',
      enabled: true,
      connection: {
        host: 'localhost',
        port: 161,
        version: 'v2c',
        community: 'public',
        timeout: 5000,
        retries: 1
      },
      data_points: [
        { name: 'sysName', oid: '1.3.6.1.2.1.1.5.0', dataType: 'string' },
        { name: 'temperature', oid: '1.3.6.1.4.1.99999.1.1.0', dataType: 'integer', scale: 0.1, unit: '°C' }
      ]
    };

    const adapter = new SNMPAdapter([device]);
    const dataPoints: SensorDataPoint[] = [];
    
    adapter.on('data', (data) => dataPoints.push(...data));
    
    await adapter.start();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    expect(dataPoints.length).toBeGreaterThan(0);
    expect(dataPoints[0].quality).toBe('GOOD');
    expect(dataPoints[0].deviceName).toBe('test-snmp-device');
    
    await adapter.stop();
  });

  it('should handle unreachable SNMP hosts', async () => {
    // Use TEST-NET-1 (192.0.2.0/24) - reserved for documentation, never routed
    const device: SNMPDeviceConfig = {
      name: 'unreachable-device',
      protocol: 'snmp',
      enabled: true,
      connection: {
        host: '192.0.2.1',  // Unreachable address
        port: 161,
        version: 'v2c',
        community: 'public',
        timeout: 1000,
        retries: 1
      },
      data_points: [
        { name: 'sysName', oid: '1.3.6.1.2.1.1.5.0', dataType: 'string' }
      ]
    };

    const adapter = new SNMPAdapter([device]);
    const badDataPoints: SensorDataPoint[] = [];
    
    adapter.on('data', (data) => {
      badDataPoints.push(...data.filter(d => d.quality === 'BAD'));
    });
    
    await adapter.start();
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(badDataPoints.length).toBeGreaterThan(0);
    expect(badDataPoints[0].quality).toBe('BAD');
    
    await adapter.stop();
  });
});
```

**4.5 Architecture Alignment Verification**
  - [ ] Logger interface matches existing pattern (debug/info/warn/error)
  - [ ] ConsoleLogger used as fallback (same as Modbus)
  - [ ] BaseProtocolAdapter methods properly implemented
  - [ ] SensorDataPoint interface compliance (quality codes)
  - [ ] DeviceStatus interface compliance
  - [ ] Event naming conventions match existing adapters
- [ ] **Documentation**
  - [ ] Create SNMP adapter guide (`docs/SNMP-ADAPTER-GUIDE.md`)
  - [ ] Update main README with SNMP support
  - [ ] Add troubleshooting section
  - [ ] Document common OIDs (MIB-II reference)
  - [ ] SNMPv3 security configuration examples

### Phase 5: Optional Enhancements (Future)
- [ ] MIB file parser (convert MIB to OID mappings)
- [ ] OID registry with common OIDs (Cisco, Net-SNMP, etc.)
- [ ] SNMP trap receiver (async notifications)
- [ ] SNMP table walker (bulk read table OIDs)
- [ ] Dashboard integration (SNMP device health)

---

## Comparison with Existing Adapters

| Feature | Modbus | OPC-UA | CAN | SNMP (Proposed) |
|---------|--------|--------|-----|-----------------|
| **Transport** | TCP/RTU | TCP | CAN bus | UDP |
| **Port** | 502 | 4840 | N/A | 161 |
| **Auth** | None | User/Cert | None | Community/v3 |
| **Data Model** | Registers | Nodes | Messages | OIDs |
| **Discovery** | ✅ Network scan | ✅ Browse + LDS | ✅ Passive | ✅ Network scan |
| **Complexity** | Low | High | Medium | Low-Medium |
| **NPM Library** | jsmodbus | node-opcua-client | socketcan | net-snmp |
| **Lines of Code** | ~500 | ~1200 | ~400 | ~600 (est.) |

---

## Advantages of SNMP Adapter

1. **Ubiquitous Protocol**: SNMP is built into most network devices (routers, switches, servers, printers, UPS, environmental sensors)
2. **Standard OIDs**: MIB-II provides common metrics across all devices
3. **Low Overhead**: UDP-based, minimal resource usage
4. **Security**: SNMPv3 provides encryption and authentication
5. **Mature Ecosystem**: Well-documented, many tools available
6. **Fits Existing Architecture**: Perfectly aligns with BaseProtocolAdapter pattern

---

## Recommendations

### Priority 1 (Must Have)
1. ✅ Implement BaseProtocolAdapter pattern (reuse infrastructure)
2. ✅ Support SNMPv1, v2c, v3 (use `net-snmp` library)
3. ✅ Basic discovery (IP range scanning + community strings)
4. ✅ Database integration (sensors + sensor_outputs tables)
5. ✅ Socket-based data output (JSON format)

### Priority 2 (Should Have)
1. ✅ Common OID registry (MIB-II standard OIDs)
2. ✅ Validation phase (read sysDescr, sysName)
3. ✅ Error handling with BAD quality data points
4. ✅ Performance metrics (poll success rate, response time)

### Priority 3 (Nice to Have)
1. ⏳ MIB file parser (convert MIB definitions to OID mappings)
2. ⏳ SNMP table walker (bulk read interface tables, disk tables)
3. ⏳ SNMP trap receiver (async event notifications)
4. ⏳ Dashboard UI for SNMP device management

---

## Testing Strategy

### 1. Local Testing (snmpsim)
```bash
# Install SNMP simulator
pip install snmpsim

# Run simulator (emulate Cisco router)
snmpsim-command-responder \
  --data-dir=/usr/share/snmpsim/data \
  --agent-udpv4-endpoint=127.0.0.1:1161

# Test with agent
export SNMP_DISCOVERY_IP_RANGES=127.0.0.1
npm run test:integration
```

### 2. Real Device Testing
- Test with actual network devices (router, switch)
- Test SNMPv1, v2c, v3 authentication
- Test different community strings
- Test error scenarios (timeout, invalid OID, access denied)

### 3. Performance Testing
- Scan 254 IPs (/24 network) - should complete in < 30 seconds
- Poll 10 devices with 10 OIDs each - should handle without errors
- Memory leak testing (run for 24 hours)

---

## Conclusion

**Recommendation**: Implement SNMP adapter using BaseProtocolAdapter pattern.

**Rationale**:
1. ✅ **Architectural Fit**: Perfect alignment with existing Modbus/OPC-UA patterns
2. ✅ **Low Risk**: Reuse proven infrastructure (BaseProtocolAdapter, SensorsFeature, SocketServer)
3. ✅ **High Value**: Unlocks monitoring for thousands of network devices
4. ✅ **Maintainable**: Clean separation of concerns, well-documented patterns
5. ✅ **Extensible**: Easy to add MIB parsing, trap receiver, table walkers later

**Estimated Timeline**:
- Core Adapter: 8-12 hours
- Discovery Plugin: 4-6 hours
- Database Integration: 2-3 hours
- Testing & Documentation: 2-4 hours
- **Total**: 16-24 hours (2-3 days)

**Next Steps**:
1. Review this analysis with team
2. Install `net-snmp` npm package
3. Create SNMP adapter directory structure
4. Implement SNMPAdapter and SNMPClient
5. Add database migration
6. Test with snmpsim
7. Document configuration examples

---

## References

- **SNMP RFCs**: RFC 1157 (v1), RFC 1901-1908 (v2c), RFC 3410-3418 (v3)
- **MIB-II**: RFC 1213 (Standard OIDs)
- **net-snmp Library**: https://github.com/markabrahams/node-net-snmp
- **BaseProtocolAdapter**: `agent/src/features/endpoints/base.ts`
- **Modbus Reference**: `agent/src/features/endpoints/modbus/adapter.ts`
- **OPC-UA Reference**: `agent/src/features/endpoints/opcua/opcua-adapter.ts`
