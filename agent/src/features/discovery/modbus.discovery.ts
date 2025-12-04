/**
 * Modbus Discovery Plugin
 * 
 * Discovers Modbus devices via slave ID scanning
 * Supports both serial (RTU) and TCP protocols
 * 
 * Industrial Best Practice:
 * - Opens connection ONCE per bus (not per slave ID)
 * - Cycles through slave IDs on same connection
 * - Tries device identification first (0x2B/0x0E)
 * - Falls back to register read (40001)
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import { generateModbusFingerprint } from './fingerprint';
import fs from 'fs';
import path from 'path';

export interface ModbusDiscoveryOptions {
  serialPort?: string; // e.g., '/dev/ttyUSB0' or 'COM3'
  tcpHost?: string;    // e.g., '192.168.1.100'
  tcpPort?: number;    // Default: 502
  slaveIdRange?: [number, number]; // Default: [1, 10]
  timeout?: number;    // ms per slave scan
  baudRate?: number;   // Serial baud rate (default: 9600)
}

interface ModbusConnection {
  type: 'serial' | 'tcp';
  client: any; // ModbusRTU client
  isOpen: boolean;
}

interface DataPoint {
  name: string;
  address: number;
  type: string;
  dataType: string;
}

interface VendorMap {
  [vendor: string]: { dataPoints: DataPoint[] };
}

const VENDOR_ENV = process.env.MODBUS_VENDOR || 'Generic';

// Flexible path resolution: env var > shared config file
// In development: resolve to workspace config/vendors
// In production (dist): resolve to dist/config/vendors (copied by npm build script)
const vendorFile = path.resolve(__dirname, '..', '..', '..', 'config', 'vendors', 'dataPoints.json');
const vendorMap: VendorMap = JSON.parse(fs.readFileSync(vendorFile, 'utf-8'));

export class ModbusDiscoveryPlugin extends BaseDiscoveryPlugin {
  private connection?: ModbusConnection;

  constructor(logger?: AgentLogger) {
    super('modbus', logger);
  }

  /**
   * Phase 1: Fast slave ID scanning
   * Opens connection ONCE, cycles through all slave IDs
   */
  async discover(options?: ModbusDiscoveryOptions): Promise<DiscoveredDevice[]> {

    const vendorKey = VENDOR_ENV;
    const dataPoints = vendorMap[vendorKey]?.dataPoints || vendorMap['Generic'].dataPoints;

    const discovered: DiscoveredDevice[] = [];

    this.logger?.infoSync('Starting Modbus discovery', {
      component: LogComponents.discovery,
      protocol: this.protocol,
      phase: 'discovery'
    });

    // Default options
    const slaveIdRange = options?.slaveIdRange || [1, 10];
    const timeout = options?.timeout || 100;

    // Detect connection type
    const isSerial = !!options?.serialPort;
    const isTCP = !!options?.tcpHost;

    if (!isSerial && !isTCP) {
      this.logger?.warnSync('No Modbus connection specified', {
        component: LogComponents.discovery
      });
      return [];
    }

    try {
      // CRITICAL: Open connection ONCE for all slave IDs
      await this.openConnection(options);

      if (!this.connection?.isOpen) {
        this.logger?.warnSync('Failed to open Modbus connection', {
          component: LogComponents.discovery
        });
        return [];
      }

      this.logger?.infoSync('Modbus connection established, scanning slave IDs', {
        component: LogComponents.discovery,
        range: slaveIdRange,
        type: this.connection.type
      });

      // Scan slave IDs on same connection
      for (let slaveId = slaveIdRange[0]; slaveId <= slaveIdRange[1]; slaveId++) {
        try {
          const deviceInfo = await this.testSlaveId(slaveId, timeout);

          if (deviceInfo) {
            // Generate cryptographic fingerprint (survives port/config changes)
            const fingerprint = generateModbusFingerprint(slaveId, deviceInfo.deviceId);

            discovered.push({
              name: deviceInfo.name || `modbus_slave_${slaveId}`,
              protocol: 'modbus' as const,
              fingerprint,
              connection: isSerial
                ? {
                    type: 'serial',
                    port: options!.serialPort,
                    baudRate: options?.baudRate || 9600,
                    slaveId
                  }
                : {
                    type: 'tcp',
                    host: options!.tcpHost,
                    port: options?.tcpPort || 502,
                    slaveId
                  },
              dataPoints,
              confidence: 'low',
              discoveredAt: new Date().toISOString(),
              validated: false,
              metadata: {
                slaveId,
                deviceId: deviceInfo.deviceId,
                discoveryMethod: deviceInfo.method
              }
            });

            this.logger?.infoSync(`Discovered Modbus slave ${slaveId}`, {
              component: LogComponents.discovery,
              phase: 'discovery',
              method: deviceInfo.method
            });
          }
        } catch (error) {
          this.logger?.debugSync(`No response from slave ${slaveId}`, {
            component: LogComponents.discovery,
            error: (error as Error).message
          });
        }
      }
    } finally {
      // CRITICAL: Always close connection
      await this.closeConnection();
    }

    return discovered;
  }

  /**
   * Phase 2: Validate device (read device identification)
   */
  async validate(device: DiscoveredDevice, timeout = 2000): Promise<any> {
    this.logger?.infoSync('Validating Modbus device', {
      component: LogComponents.discovery,
      slaveId: device.metadata?.slaveId,
      phase: 'validation'
    });

    // TODO: Implement Modbus device validation
    // - Read Device Identification (function code 0x2B/0x0E)
    // - Read manufacturer-specific info registers
    // - Parse manufacturer, model, firmware
    
    return null; // Placeholder
  }

  /**
   * Check if Modbus is available (serial ports or network)
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if modbus-serial library is available
      await import('modbus-serial');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open Modbus connection ONCE for entire scan
   * Industrial best practice: reuse connection across slave IDs
   */
  private async openConnection(options?: ModbusDiscoveryOptions): Promise<void> {
    try {
      // Dynamic import of modbus-serial (default export)
      // Note: Using 'any' because TypeScript has issues with dynamic import constructors
      const { default: ModbusRTU } = await import('modbus-serial') as any;
      const client = new ModbusRTU();

      const isSerial = !!options?.serialPort;
      const timeout = options?.timeout || 100;

      if (isSerial) {
        // Serial (RTU) connection
        await client.connectRTUBuffered(options!.serialPort!, {
          baudRate: options?.baudRate || 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none'
        });

        this.connection = {
          type: 'serial',
          client,
          isOpen: true
        };

        this.logger?.infoSync('Opened Modbus RTU connection', {
          component: LogComponents.agent,
          port: options!.serialPort,
          baudRate: options?.baudRate || 9600
        });
      } else {
        // TCP connection
        await client.connectTCP(options!.tcpHost!, {
          port: options?.tcpPort || 502
        });

        this.connection = {
          type: 'tcp',
          client,
          isOpen: true
        };

        this.logger?.infoSync('Opened Modbus TCP connection', {
          component: LogComponents.agent,
          host: options!.tcpHost,
          port: options?.tcpPort || 502
        });
      }

      // Set timeout
      client.setTimeout(timeout);
    } catch (error) {
      this.logger?.errorSync(
        'Failed to open Modbus connection',
        error as Error,
        { component: LogComponents.agent }
      );
      this.connection = undefined;
    }
  }

  /**
   * Close Modbus connection after scan
   */
  private async closeConnection(): Promise<void> {
    if (this.connection?.isOpen) {
      try {
        this.connection.client.close(() => {
          this.logger?.infoSync('Closed Modbus connection', {
            component: LogComponents.discovery,
            type: this.connection?.type
          });
        });
      } catch (error) {
        this.logger?.warnSync('Error closing Modbus connection', {
          component: LogComponents.discovery,
          error: (error as Error).message
        });
      } finally {
        this.connection = undefined;
      }
    }
  }

  /**
   * Test if a slave ID responds (on existing connection)
   * Industrial pattern:
   * 1. Try reading device identification (0x2B/0x0E) - proper way
   * 2. Fallback to holding register read (40001) - compatibility
   */
private async testSlaveId(
  slaveId: number,
  timeout: number
): Promise<{ name?: string; method: string; deviceId?: string } | null> {

  if (!this.connection?.isOpen) return null;
  const client = this.connection.client;

  client.setID(slaveId);
  client.setTimeout(timeout);

  //
  // METHOD 1 — MEI WITH HARD TIMEOUT
  //
  const meiResult = await Promise.race([
    client.readDeviceIdentification(1),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MEI timeout")), timeout)
    )
  ]).catch(err => {
    this.logger?.debugSync(
      `Slave ${slaveId}: MEI failed or timed out: ${String(err?.message || err)}`,
      { component: LogComponents.discovery }
    );
    return null;
  });

  if (meiResult && meiResult.Basic?.VendorName) {
    const vendor = meiResult.Basic.VendorName.toString();

    return {
      method: "device_identification",
      name: vendor,
      deviceId: vendor
    };
  }

  //
  // METHOD 2 — Guaranteed fallback (register)
  //
  try {
    const reg = await client.readHoldingRegisters(0, 1);

    if (reg?.data?.length) {
      return {
        method: "register_read",
        deviceId: reg.data[0].toString()
      };
    }

    return null;
  } catch (err: any) {
    this.logger?.debugSync(
      `Slave ${slaveId}: no response on fallback read: ${String(err?.message || err)}`,
      { component: LogComponents.discovery }
    );
    return null;
  }
}

}
