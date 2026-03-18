// agent/src/features/endpoints/snmp/adapter.ts
import { BaseProtocolAdapter, GenericDeviceConfig } from '../base.js';
import { SNMPClient } from './client.js';
import { SensorDataPoint, Logger } from '../types.js';
import { ConsoleLogger } from '../common/logger.js';
import { SNMPDeviceConfig, SNMPDataPoint } from './types.js';

export class SNMPAdapter extends BaseProtocolAdapter {
  private clients: Map<string, SNMPClient> = new Map();

  // Human-readable names resolved from the SNMP device at connect time.
  // Priority: metadata.displayName (config override) > SNMP sysName OID > (unset, fall back to device.name)
  private resolvedDeviceNames: Map<string, string> = new Map();

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

    // Resolve human-readable display name.
    // Priority: metadata.displayName (config) > SNMP sysName (1.3.6.1.2.1.1.5.0) > (unset)
    const configDisplayName = device.metadata?.displayName as string | undefined;
    if (configDisplayName && configDisplayName.trim()) {
      this.resolvedDeviceNames.set(device.name, configDisplayName.trim());
    } else {
      try {
        const rawName = await client.get('1.3.6.1.2.1.1.5.0'); // sysName OID
        const sysName = Buffer.isBuffer(rawName)
          ? rawName.toString('utf8').trim()
          : typeof rawName === 'string' ? rawName.trim() : null;
        if (sysName) {
          this.resolvedDeviceNames.set(device.name, sysName);
          this.logger.debug(`Resolved SNMP sysName for ${device.name}: "${sysName}"`);
        }
      } catch {
        // Non-fatal: resolved name remains unset; enrichWithEndpointUuid falls back to device.name
      }
    }

    return client;
  }

  protected async disconnectDevice(deviceName: string): Promise<void> {
    const client = this.clients.get(deviceName);
    if (client) {
      await client.disconnect();
      this.clients.delete(deviceName);
    }
    this.resolvedDeviceNames.delete(deviceName);
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
    const resolvedDisplayName = this.resolvedDeviceNames.get(deviceName);

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
          metric: oid.name,
          value: numericValue,
          unit: oid.unit || '',
          timestamp,
          quality: 'GOOD',
          protocol: 'snmp',  // For enum namespacing
          ...(resolvedDisplayName && { resolvedDisplayName }),
        });
      } catch (error) {
        this.logger.warn(`Failed to read OID ${oid.oid} from ${deviceName}: ${error}`);
        
        // Send BAD quality for failed OID reads
        dataPoints.push({
          deviceName,
          metric: oid.name,
          value: null,
          unit: oid.unit || '',
          timestamp,
          quality: 'BAD',
          qualityCode: 'READ_ERROR',
          protocol: 'snmp',
          ...(resolvedDisplayName && { resolvedDisplayName }),
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
    
    // Validate OID format (basic check)
    for (const oid of config.dataPoints) {
      if (!oid.oid || !oid.oid.match(/^[\d.]+$/)) {
        throw new Error(`Invalid OID format for ${oid.name}: ${oid.oid}`);
      }
    }
  }

  private parseSnmpValue(value: any, oid: SNMPDataPoint): number {
    // Handle SNMP data types
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? 0 : parsed;
    }
    if (Buffer.isBuffer(value)) {
      // Handle Counter32, Counter64, Gauge32, TimeTicks
      if (value.length >= 4) {
        return value.readUInt32BE(0);
      }
      return 0;
    }
    return 0;
  }
}
