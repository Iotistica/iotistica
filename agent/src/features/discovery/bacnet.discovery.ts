/**
 * BACnet Discovery Plugin
 * 
 * Discovers BACnet devices via network scanning
 * Supports BACnet/IP (UDP port 47808)
 * 
 * Discovery Strategy:
 * - Who-Is broadcast to discover all devices on network
 * - Read device properties for identification
 * - Validation reads object list and properties
 * 
 * Industrial Best Practice:
 * - Use BACnet broadcast for maximum compatibility
 * - Standard BACnet services (Who-Is, I-Am, Read-Property)
 * - Discover all objects (analog, binary, multi-state)
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice, ValidationResult } from './base.discovery';
import { generateBACnetFingerprint } from './fingerprint';
import * as dgram from 'dgram';
import { promisify } from 'util';

export interface BACnetDiscoveryOptions {
  networkInterfaces?: string[]; // Network interfaces to scan (e.g., ['eth0', 'wlan0'])
  broadcastAddress?: string;    // Broadcast address (default: 255.255.255.255)
  port?: number;                // BACnet/IP port (default: 47808)
  timeout?: number;             // ms to wait for responses (default: 5000)
  maxDevices?: number;          // Max devices to discover (default: 100)
  deviceIdRange?: [number, number]; // Device instance range to scan (default: [0, 4194303])
}

interface BACnetDeviceInfo {
  deviceInstance: number;
  objectName?: string;
  modelName?: string;
  vendorName?: string;
  vendorId?: number;
  description?: string;
  location?: string;
  applicationSoftwareVersion?: string;
  protocolVersion?: number;
  protocolRevision?: number;
  firmwareRevision?: string;
  macAddress?: string;
  ipAddress: string;
  port: number;
}

interface BACnetObject {
  objectType: string;
  objectInstance: number;
  objectName: string;
  presentValue?: any;
  units?: string;
  description?: string;
}

// BACnet object type enumeration (subset of most common types)
const BACNET_OBJECT_TYPES: Record<number, string> = {
  0: 'analog-input',
  1: 'analog-output',
  2: 'analog-value',
  3: 'binary-input',
  4: 'binary-output',
  5: 'binary-value',
  8: 'device',
  13: 'multi-state-input',
  14: 'multi-state-output',
  19: 'multi-state-value',
};

export class BACnetDiscoveryPlugin extends BaseDiscoveryPlugin {
  private client?: any;  // Reuse same BACnet client across discovery and validation
  private readonly AGENT_PORT = 47809;  // Agent uses different port than devices (47808)
  private readonly AGENT_DEVICE_ID = 4190000;  // Gateway-style device ID

  constructor(logger?: AgentLogger) {
    super('bacnet', logger);
  }

  /**
   * Get or create BACnet client (reused across discovery and validation)
   */
  private async getClient(options?: BACnetDiscoveryOptions): Promise<any> {
    if (this.client) {
      this.logger?.debugSync('Reusing existing BACnet client', {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
      return this.client;
    }

    // Fix #2: Prefer subnet broadcast over global broadcast (more reliable)
    let broadcastAddress = options?.broadcastAddress || '255.255.255.255';
    
    // If network interface specified, try to derive subnet broadcast
    if (options?.networkInterfaces?.[0] && broadcastAddress === '255.255.255.255') {
      // Try to get local IP and derive broadcast (e.g., 192.168.1.10 -> 192.168.1.255)
      try {
        const os = require('os');
        const ifaces = os.networkInterfaces();
        const ifaceName = options.networkInterfaces[0];
        const ifaceAddrs = ifaces[ifaceName];
        
        if (ifaceAddrs) {
          const ipv4 = ifaceAddrs.find((addr: any) => addr.family === 'IPv4' && !addr.internal);
          if (ipv4?.address) {
            broadcastAddress = ipv4.address.replace(/\.\d+$/, '.255');
            this.logger?.debugSync('Derived subnet broadcast from interface', {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              interface: ifaceName,
              ip: ipv4.address,
              broadcast: broadcastAddress
            });
          }
        }
      } catch (err) {
        // Fall back to global broadcast
        this.logger?.debugSync('Failed to derive subnet broadcast, using global', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const timeout = options?.timeout || 5000;

    this.logger?.debugSync('Creating new BACnet client', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      port: this.AGENT_PORT,
      broadcastAddress,
      timeout,
      deviceId: this.AGENT_DEVICE_ID
    });

    // @ts-ignore - bacstack has no type definitions
    const BACnet = require('bacstack');
    
    this.client = new BACnet({ 
      apduTimeout: timeout,
      port: this.AGENT_PORT,  // Use different port to avoid collision with devices
      broadcastAddress: broadcastAddress,
      deviceId: this.AGENT_DEVICE_ID,  // Stable gateway identity
      vendorId: 999  // Generic vendor ID
    });

    this.logger?.debugSync('BACnet client created successfully', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      clientType: typeof this.client,
      hasWhoIs: typeof this.client?.whoIs,
      hasOn: typeof this.client?.on
    });

    // Add listening event (debug actual bound port)
    this.client.on('listening', () => {
      const addr = this.client._transport?.address;
      this.logger?.infoSync('BACnet socket listening', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        address: addr,
        port: addr?.port,
        family: addr?.family
      });
    });

    // Add error listener
    this.client.on('error', (err: Error) => {
      this.logger?.errorSync('BACnet client error', err, {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
    });

    // Give socket time to bind (bacstack binds asynchronously)
    await new Promise(resolve => setTimeout(resolve, 100));

    this.logger?.debugSync('BACnet client initialization complete', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      transportReady: !!this.client._transport,
      socketAddress: this.client._transport?.address
    });

    return this.client;
  }

  /**
   * Close BACnet client (call during shutdown)
   */
  close(): void {
    if (this.client) {
      this.client.close();
      this.client = undefined;
    }
  }

  /**
   * Phase 1: Fast Who-Is broadcast for BACnet device discovery
   */
  async discover(options?: BACnetDiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    this.logger?.debugSync('Starting BACnet discovery', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      protocol: this.protocol,
      phase: 'discovery'
    });

    // Default options
    const broadcastAddress = options?.broadcastAddress || '255.255.255.255';
    const port = options?.port || 47808;
    const timeout = options?.timeout || 5000;
    const maxDevices = options?.maxDevices || 100;
    const deviceIdRange = options?.deviceIdRange || [0, 4194303]; // Full BACnet range

    this.logger?.debugSync('BACnet discovery configuration', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      broadcastAddress,
      port,
      timeout,
      maxDevices
    });

    try {
      // Get reusable BACnet client (waits for socket to bind)
      const client = await this.getClient(options);
      const devices = new Map<number, BACnetDeviceInfo>();

      this.logger?.debugSync('Attaching I-Am event listener', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        agentDeviceId: this.AGENT_DEVICE_ID,
        filterSelfIAm: true
      });

      // Remove existing listeners to prevent duplicates (memory leak prevention)
      client.removeAllListeners('iAm');

      // Listen for I-Am responses
      client.on('iAm', (device: any) => {
        this.logger?.debugSync('Received I-Am response (raw)', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          device: JSON.stringify(device),
          deviceId: device?.deviceId,
          address: device?.address,
          currentDeviceCount: devices.size
        });

        if (devices.size >= maxDevices) {
          this.logger?.debugSync('Max devices reached, ignoring I-Am', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            maxDevices
          });
          return; // Stop accepting new devices
        }

        const deviceInstance = device.deviceId;
        
        // Filter self I-Am (agent's own device ID)
        if (deviceInstance === this.AGENT_DEVICE_ID) {
          this.logger?.debugSync('Filtering self I-Am response', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            deviceInstance: this.AGENT_DEVICE_ID
          });
          return;
        }

        // Parse IP:port from address (bacstack returns "IP:PORT")
        const addressParts = device.address.split(':');
        const ipAddress = addressParts[0];
        const devicePort = addressParts.length > 1 ? Number(addressParts[1]) : port;

        this.logger?.debugSync(`Discovered BACnet device via I-Am`, {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          deviceInstance,
          ipAddress,
          port: devicePort,
          maxSegments: device.maxSegments,
          maxApdu: device.maxApdu
        });

        devices.set(deviceInstance, {
          deviceInstance,
          ipAddress,
          port: devicePort,  // Store actual port from I-Am response
          vendorId: device.vendorId
        });
      });

      // Send Who-Is broadcast
      this.logger?.debugSync('Sending BACnet Who-Is broadcast', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        broadcastAddress,
        port,
        method: 'whoIs'
      });

      try {
        // Use device ID range if specified (required for large BACnet systems)
        client.whoIs({
          lowLimit: deviceIdRange[0],
          highLimit: deviceIdRange[1]
        });
        this.logger?.debugSync('Who-Is broadcast sent successfully', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          lowLimit: deviceIdRange[0],
          highLimit: deviceIdRange[1]
        });
      } catch (whoIsError) {
        this.logger?.errorSync('Failed to send Who-Is broadcast', whoIsError instanceof Error ? whoIsError : new Error(String(whoIsError)), {
          component: LogComponents.discovery + "] [" + this.protocol as any
        });
      }

      // Wait for responses
      await new Promise(resolve => setTimeout(resolve, timeout));

      this.logger?.debugSync(`Received ${devices.size} I-Am responses`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        deviceCount: devices.size
      });

      // Read device properties for each discovered device
      for (const [deviceInstance, deviceInfo] of devices.entries()) {
        try {
          // Construct full address with port for unicast reads
          const fullAddress = `${deviceInfo.ipAddress}:${deviceInfo.port}`;
          
          // Read device object properties (property ID 77 = Object-Name)
          const objectName = await this.readProperty(
            client,
            fullAddress,
            { type: 8, instance: deviceInstance }, // Device object
            77 // Object-Name
          );

          // Read vendor name (property ID 121 = Vendor-Name)
          const vendorName = await this.readProperty(
            client,
            fullAddress,
            { type: 8, instance: deviceInstance },
            121
          );

          // Read model name (property ID 70 = Model-Name)
          const modelName = await this.readProperty(
            client,
            fullAddress,
            { type: 8, instance: deviceInstance },
            70
          );

          // Read description (property ID 28 = Description)
          const description = await this.readProperty(
            client,
            fullAddress,
            { type: 8, instance: deviceInstance },
            28
          );

          // Update device info
          deviceInfo.objectName = objectName;
          deviceInfo.vendorName = vendorName;
          deviceInfo.modelName = modelName;
          deviceInfo.description = description;

          this.logger?.debugSync(`Read device properties`, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            deviceInstance,
            objectName,
            vendorName,
            modelName
          });

        } catch (error) {
          this.logger?.debugSync(`Failed to read device properties`, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            deviceInstance,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Convert discovered devices to DiscoveredDevice format
      for (const [deviceInstance, deviceInfo] of devices.entries()) {
        // Generate cryptographic fingerprint
        const fingerprint = generateBACnetFingerprint(
          deviceInfo.ipAddress,
          deviceInstance
        );

        const deviceName = deviceInfo.objectName || 
                          `bacnet_device_${deviceInstance}`;

        discovered.push({
          name: deviceName.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          protocol: 'bacnet' as any,
          fingerprint,
          connection: {
            host: deviceInfo.ipAddress,
            port: deviceInfo.port,  // Use actual device port, not default
            deviceInstance,
            maxApdu: 1476, // Default max APDU size
            interface: options?.networkInterfaces?.[0]
          },
          dataPoints: [], // Populated during validation
          confidence: deviceInfo.objectName ? 'high' : 'medium',
          discoveredAt: new Date().toISOString(),
          validated: false,
          metadata: {
            deviceInstance,
            objectName: deviceInfo.objectName,
            vendorName: deviceInfo.vendorName,
            vendorId: deviceInfo.vendorId,
            modelName: deviceInfo.modelName,
            description: deviceInfo.description,
            discoveryMethod: 'who_is_broadcast'
          }
        });
      }

      // Don't close client - reuse for validation phase

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger?.errorSync('BACnet discovery failed', err, {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
    }

    this.logger?.debugSync(`BACnet discovery complete - found ${discovered.length} devices`, {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      deviceCount: discovered.length
    });

    return discovered;
  }

  /**
   * Phase 2: Validate device (read object list and properties)
   */
  async validate(device: DiscoveredDevice, timeout = 10000): Promise<ValidationResult> {
    this.logger?.debugSync('Validating BACnet device', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      deviceInstance: device.connection.deviceInstance,
      phase: 'validation'
    });

    const validationResult: ValidationResult = {
      deviceInfo: {},
      manufacturer: device.metadata?.vendorName,
      modelNumber: device.metadata?.modelName,
      capabilities: []
    };

    try {
      // Reuse existing BACnet client (same port, avoids state issues)
      const client = await this.getClient({ timeout });

      const deviceInstance = device.connection.deviceInstance;
      const ipAddress = device.connection.host;
      const devicePort = device.connection.port;
      const fullAddress = `${ipAddress}:${devicePort}`;
      const objects: BACnetObject[] = [];

      // Read object list (property ID 76 = Object-List)
      try {
        const objectList = await this.readProperty(
          client,
          fullAddress,
          { type: 8, instance: deviceInstance },
          76,
          timeout
        );

        this.logger?.debugSync(`Device has ${objectList?.length || 0} objects`, {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          deviceInstance,
          objectCount: objectList?.length || 0
        });

        // Read properties for each object (limit to first 50 to avoid timeout)
        const objectsToRead = objectList?.slice(0, 50) || [];
        
        for (const obj of objectsToRead) {
          try {
            // Throttle requests to prevent flooding device (20-50ms delay)
            await new Promise(r => setTimeout(r, 20));
            
            const objectType = obj.type;
            const objectInstance = obj.instance;
            const objectTypeName = BACNET_OBJECT_TYPES[objectType] || `type-${objectType}`;

            // Read object name (property ID 77)
            const objectName = await this.readProperty(
              client,
              fullAddress,
              { type: objectType, instance: objectInstance },
              77,
              timeout
            );

            // Read present value (property ID 85) for I/O objects
            let presentValue: any;
            if ([0, 1, 2, 3, 4, 5, 13, 14, 19].includes(objectType)) {
              presentValue = await this.readProperty(
                client,
                fullAddress,
                { type: objectType, instance: objectInstance },
                85,
                timeout
              );
            }

            // Read units (property ID 117) for analog objects
            let units: string | undefined;
            if ([0, 1, 2].includes(objectType)) {
              units = await this.readProperty(
                client,
                fullAddress,
                { type: objectType, instance: objectInstance },
                117,
                timeout
              );
            }

            objects.push({
              objectType: objectTypeName,
              objectInstance,
              objectName: objectName || `${objectTypeName}_${objectInstance}`,
              presentValue,
              units
            });

            this.logger?.debugSync(`Read object properties`, {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              objectType: objectTypeName,
              objectInstance,
              objectName,
              presentValue
            });

          } catch (error) {
            // Skip objects that fail to read
            this.logger?.debugSync(`Failed to read object properties`, {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              objectType: obj.type,
              objectInstance: obj.instance,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

      } catch (error) {
        this.logger?.warnSync('Failed to read object list', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          deviceInstance,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Update device with discovered data points
      device.dataPoints = objects.map(obj => ({
        name: obj.objectName.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        objectType: obj.objectType,
        objectInstance: obj.objectInstance,
        presentValue: obj.presentValue,
        units: obj.units,
        propertyId: 85 // Present-Value
      }));

      device.validated = true;
      device.validationData = validationResult;

      validationResult.capabilities = Array.from(
        new Set(objects.map(o => o.objectType))
      );

      validationResult.deviceInfo = {
        totalObjects: objects.length,
        analogInputs: objects.filter(o => o.objectType === 'analog-input').length,
        analogOutputs: objects.filter(o => o.objectType === 'analog-output').length,
        binaryInputs: objects.filter(o => o.objectType === 'binary-input').length,
        binaryOutputs: objects.filter(o => o.objectType === 'binary-output').length
      };

      // Don't close client - keep it alive for future operations

      this.logger?.debugSync('BACnet device validation complete', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        deviceInstance,
        objectCount: objects.length,
        capabilities: validationResult.capabilities
      });

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger?.errorSync(`BACnet validation failed for device ${device.connection.deviceInstance}`, err, {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
    }

    return validationResult;
  }

  /**
   * Check if BACnet client is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // @ts-ignore - bacstack has no type definitions
      await import('bacstack');
      return true;
    } catch {
      this.logger?.warnSync('BACnet client (bacstack) not available', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        note: 'Install with: npm install bacstack'
      });
      return false;
    }
  }

  /**
   * Helper: Read BACnet property with timeout
   */
  private async readProperty(
    client: any,
    address: string,
    objectId: { type: number; instance: number },
    propertyId: number,
    timeout = 5000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Property read timeout'));
      }, timeout);

      client.readProperty(
        address,
        objectId,
        propertyId,
        (err: Error, value: any) => {
          clearTimeout(timer);
          if (err) {
            reject(err);
          } else {
            // Handle multi-value properties (arrays, enumerations, etc.)
            const values = value?.values?.map((v: any) => v.value);
            resolve(values?.length === 1 ? values[0] : values);
          }
        }
      );
    });
  }
}
