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
import os from 'os';
import BACnet from 'bacstack';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice, ValidationResult } from '../types';
import { generateBACnetFingerprint } from '../fingerprint';

export interface BACnetDiscoveryOptions {
  /**
   * Discovery targets for unicast mode (recommended for Docker/containers)
   * 
   * Supports:
   * - Single IP: '192.168.65.4'
   * - Multiple IPs: ['192.168.65.4', '192.168.65.5']
   * - CIDR subnet: '192.168.65.0/24'
   * - IP range: '192.168.65.1-192.168.65.10'
   * - Hostname: 'bacnet-device.local'
   * 
   * If empty: Falls back to broadcast mode
   */
  discoveryTargets?: string[];
  networkInterfaces?: string[]; // Network interfaces to scan (e.g., ['eth0', 'wlan0'])
  broadcastAddress?: string;    // Broadcast address for legacy mode (default: 255.255.255.255)
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
   * Expand discovery target into individual IP addresses
   * 
   * Supports:
   * - Single IP: '192.168.65.4' → ['192.168.65.4']
   * - CIDR: '192.168.65.0/24' → ['192.168.65.1', ..., '192.168.65.254']
   * - Range: '192.168.65.1-192.168.65.5' → ['192.168.65.1', ..., '192.168.65.5']
   * - Hostname: 'bacnet-sim' → ['192.168.65.3'] (resolved via DNS)
   */
  private expandDiscoveryTarget(target: string): string[] {
    // CIDR notation (e.g., 192.168.65.0/24)
    if (target.includes('/')) {
      const [baseIP, prefixStr] = target.split('/');
      const prefix = parseInt(prefixStr, 10);
      const [a, b, c, _d] = baseIP.split('.').map(Number);
      const ips: string[] = [];
      
      // Simple /24 subnet expansion (192.168.x.1-254)
      if (prefix === 24) {
        for (let i = 1; i <= 254; i++) {
          ips.push(`${a}.${b}.${c}.${i}`);
        }
      }
      return ips;
    }

    // IP range (e.g., 192.168.65.1-192.168.65.10)
    if (target.includes('-')) {
      const [startIP, endIP] = target.split('-').map(s => s.trim());
      const startParts = startIP.split('.').map(Number);
      const endParts = endIP.split('.').map(Number);
      const ips: string[] = [];
      
      // Simple range within same /24 subnet
      if (startParts[0] === endParts[0] && startParts[1] === endParts[1] && startParts[2] === endParts[2]) {
        for (let i = startParts[3]; i <= endParts[3]; i++) {
          ips.push(`${startParts[0]}.${startParts[1]}.${startParts[2]}.${i}`);
        }
      }
      return ips;
    }

    // Single IP or hostname - return as-is (DNS resolution handled by bacstack)
    return [target];
  }

  /**
   * Derive subnet broadcast address from network interfaces
   */
  private deriveBroadcastAddress(): string {
    const ifaces = os.networkInterfaces();
    
    // Find first non-loopback IPv4 interface that's NOT a /32 (point-to-point)
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue;
      for (const addr of addrs as any[]) {
        if (addr.family === 'IPv4' && !addr.internal && addr.address !== '127.0.0.1') {
          // Skip /32 netmasks (Docker internal point-to-point interfaces)
          if (addr.netmask === '255.255.255.255') {
            this.logger?.debugSync('Skipping /32 interface (Docker internal)', {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              interface: name,
              ip: addr.address,
              netmask: addr.netmask
            });
            continue;
          }
          
          // Derive subnet broadcast (e.g., 192.168.56.1/24 -> 192.168.56.255)
          const ip = addr.address.split('.');
          const netmask = addr.netmask.split('.');
          const broadcast = ip.map((octet: string, i: number) => 
            (parseInt(octet) | (~parseInt(netmask[i]) & 255)).toString()
          ).join('.');
          
          this.logger?.debugSync('Derived subnet broadcast from interface', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            interface: name,
            ip: addr.address,
            netmask: addr.netmask,
            broadcast
          });
          
          return broadcast;
        }
      }
    }
    
    // Final fallback (but log warning - this rarely works in Docker)
    this.logger?.warnSync('Using global broadcast (may not work in Docker)', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      broadcast: '255.255.255.255'
    });
    return '255.255.255.255';
  }

  /**
   * Get or create BACnet client with pre-derived broadcast address
   */
  private async getClient(options?: BACnetDiscoveryOptions): Promise<any> {
    // Reuse existing client
    if (this.client) {
      this.logger?.debugSync('Reusing existing BACnet client', {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
      return this.client;
    }

    // Use pre-derived broadcast address (passed from discover())
    const broadcastAddress = options?.broadcastAddress || '255.255.255.255';
    const timeout = options?.timeout || 5000;

    this.logger?.debugSync('Creating new BACnet client', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      port: this.AGENT_PORT,
      broadcastAddress,
      timeout,
      deviceId: this.AGENT_DEVICE_ID
    });

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
   * Phase 1: BACnet device discovery (supports unicast and broadcast modes)
   * 
   * Mode Selection (smart switching):
   *   - If discoveryTargets provided and non-empty → Unicast mode
   *   - Else if broadcastAddress provided → Broadcast mode (explicit)
   *   - Else → Broadcast mode (auto-detect broadcast address)
   * 
   * Unicast mode (recommended for Docker/containers):
   *   - Sends Who-Is to specific IP addresses from discoveryTargets
   *   - Bypasses UDP broadcast limitations in Docker Desktop
   *   - More reliable in containerized environments
   * 
   * Broadcast mode:
   *   - Sends Who-Is to broadcast address
   *   - May not work in Docker Desktop (use unicast instead)
   */
  async discover(options?: BACnetDiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    this.logger?.debugSync('Starting BACnet discovery', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      protocol: this.protocol,
      phase: 'discovery'
    });

    // Smart mode selection based on configuration
    const discoveryTargets = options?.discoveryTargets || [];
    const hasTargets = discoveryTargets.length > 0;
    const hasBroadcast = !!options?.broadcastAddress;
    const useUnicast = hasTargets;  // Prefer unicast if targets provided

    // Determine broadcast address
    let broadcastAddress = options?.broadcastAddress;
    if (!useUnicast && !broadcastAddress) {
      // Auto-detect broadcast if neither unicast nor explicit broadcast configured
      broadcastAddress = this.deriveBroadcastAddress();
    }

    // Default options
    const port = options?.port || 47808;
    const timeout = options?.timeout || 5000;
    const maxDevices = options?.maxDevices || 100;
    const deviceIdRange = options?.deviceIdRange || [0, 4194303]; // Full BACnet range

    this.logger?.debugSync('BACnet discovery configuration', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      mode: useUnicast ? 'unicast' : 'broadcast',
      modeReason: useUnicast 
        ? 'discoveryTargets provided' 
        : (hasBroadcast ? 'broadcastAddress explicit' : 'broadcastAddress auto-detected'),
      ...(useUnicast ? { discoveryTargets } : { broadcastAddress }),
      port,
      timeout,
      maxDevices
    });

    try {
      // Get reusable BACnet client (waits for socket to bind)
      const client = await this.getClient({ ...options, broadcastAddress, timeout });
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

      // Send Who-Is (unicast or broadcast mode)
      if (useUnicast) {
        // Unicast mode: Send Who-Is to each discovery target
        // NOTE: bacstack v0.0.1-beta.14 ignores receiver parameter, so we create
        // a separate client for each target with that IP as broadcastAddress
        this.logger?.debugSync('Sending BACnet Who-Is via unicast', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          targets: discoveryTargets,
          count: discoveryTargets.length
        });

        for (const target of discoveryTargets) {
          try {
            // Expand CIDR ranges or IP ranges to individual IPs
            const targetIPs = this.expandDiscoveryTarget(target);
            
            for (const targetIP of targetIPs) {
              this.logger?.debugSync('Sending Who-Is to unicast target', {
                component: LogComponents.discovery + "] [" + this.protocol as any,
                target: targetIP,
                port
              });

              // Create temporary client with target IP as broadcast address
              // Use random port (undefined) to avoid conflict with main client
              const unicastClient = new BACnet({
                apduTimeout: timeout,
                // port: undefined,  // Let OS assign random port
                broadcastAddress: targetIP,  // Use target as "broadcast" to force unicast
                deviceId: this.AGENT_DEVICE_ID + 1  // Different device ID
              });

              // Attach I-Am listener to this client to receive responses
              unicastClient.on('iAm', (device: any) => {
                client.emit('iAm', device);  // Forward to main client's listener
              });

              unicastClient.whoIs({
                lowLimit: deviceIdRange[0],
                highLimit: deviceIdRange[1]
              });
              
              this.logger?.debugSync('Created unicast client and sent Who-Is', {
                component: LogComponents.discovery + "] [" + this.protocol as any,
                target: targetIP
              });
              
              // Clean up temporary client after timeout
              setTimeout(() => {
                try {
                  unicastClient.close();
                } catch (_err) {
                  // Ignore cleanup errors
                }
              }, timeout + 1000);
            }
          } catch (err) {
            this.logger?.errorSync('Failed to send Who-Is to target', err instanceof Error ? err : new Error(String(err)), {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              target
            });
          }
        }

        this.logger?.debugSync('Unicast Who-Is packets sent', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          targetCount: discoveryTargets.length
        });
      } else {
        // Broadcast mode: Send Who-Is to broadcast address (legacy)
        this.logger?.debugSync('Sending BACnet Who-Is broadcast', {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          broadcastAddress,
          port,
          method: 'whoIs'
        });

        try {
          client.whoIs({
            lowLimit: deviceIdRange[0],
            highLimit: deviceIdRange[1],
            receiver: { address: broadcastAddress!, port: 47808 }  // Explicit broadcast target
          });
          this.logger?.debugSync('Who-Is broadcast sent successfully', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            lowLimit: deviceIdRange[0],
            highLimit: deviceIdRange[1],
            broadcast: broadcastAddress
          });
        } catch (whoIsError) {
          this.logger?.errorSync('Failed to send Who-Is broadcast', whoIsError instanceof Error ? whoIsError : new Error(String(whoIsError)), {
            component: LogComponents.discovery + "] [" + this.protocol as any
          });
        }
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
