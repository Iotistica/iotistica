/**
 * SNMP Discovery Plugin
 * 
 * Discovers SNMP devices via network scanning
 * Supports SNMPv1, v2c, and v3
 * 
 * Discovery Strategy:
 * - IP range scanning with SNMP Get requests
 * - sysDescr (1.3.6.1.2.1.1.1.0) as primary detection
 * - Validation reads additional OIDs for device identification
 * 
 * Industrial Best Practice:
 * - Concurrent scanning with rate limiting
 * - Respect network bandwidth (avoid broadcast storms)
 * - Standard MIB-II OIDs for maximum compatibility
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice, ValidationResult } from './base.discovery';
import { generateSNMPFingerprint } from './fingerprint';
import * as net from 'net';

export interface SNMPDiscoveryOptions {
  ipRanges?: string[];          // e.g., ['192.168.1.0/24', '10.0.0.1-10.0.0.50']
  port?: number;                // Default: 161
  community?: string;           // SNMPv1/v2c community (default: 'public')
  version?: 'v1' | 'v2c' | 'v3'; // SNMP version (default: 'v2c')
  timeout?: number;             // ms per device scan (default: 2000)
  retries?: number;             // Retry count (default: 1)
  concurrency?: number;         // Concurrent scans (default: 10)
  // SNMPv3 options (if version='v3')
  v3Username?: string;
  v3AuthProtocol?: 'MD5' | 'SHA';
  v3AuthKey?: string;
  v3PrivProtocol?: 'DES' | 'AES';
  v3PrivKey?: string;
}

interface SNMPDeviceInfo {
  sysDescr: string;
  sysObjectID?: string;
  sysName?: string;
  sysLocation?: string;
  sysContact?: string;
  sysUpTime?: number;
}

export class SNMPDiscoveryPlugin extends BaseDiscoveryPlugin {
  constructor(logger?: AgentLogger) {
    super('snmp', logger);
  }

  /**
   * Phase 1: Fast IP range scanning for SNMP responders
   */
  async discover(options?: SNMPDiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    this.logger?.infoSync('Starting SNMP discovery', {
      component: LogComponents.discovery,
      protocol: this.protocol,
      phase: 'discovery'
    });

    // Default options
    const ipRanges = options?.ipRanges || this.getDefaultIPRanges();
    const port = options?.port || 161;
    const community = options?.community || 'public';
    const version = options?.version || 'v2c';
    const timeout = options?.timeout || 2000;
    const retries = options?.retries || 1;
    const concurrency = options?.concurrency || 10;

    if (ipRanges.length === 0) {
      this.logger?.warnSync('No IP ranges specified for SNMP discovery', {
        component: LogComponents.discovery
      });
      return [];
    }

    this.logger?.infoSync('SNMP discovery configuration', {
      component: LogComponents.discovery,
      ipRanges,
      port,
      version,
      concurrency
    });

    // Expand IP ranges to individual IPs
    let ips = this.expandIPRanges(ipRanges);

    // --- skip gateway IPs ---
    const gatewayIPs = ips.filter(ip => ip.endsWith('.1'));
    if (gatewayIPs.length) {
      this.logger?.infoSync(`Skipping gateway IPs: ${gatewayIPs.join(', ')}`, {
        component: LogComponents.discovery
      });
      ips = ips.filter(ip => !ip.endsWith('.1'));
    }
 

    this.logger?.infoSync(`Scanning ${ips.length} IP addresses for SNMP devices`, {
      component: LogComponents.discovery,
      totalIPs: ips.length
    });

    // Concurrent scanning with rate limiting
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(concurrency);

    const scanResults = await Promise.allSettled(
      ips.map(ip =>
        limit(async () => {
          try {
            const deviceInfo = await this.testSNMPDevice(
              ip,
              port,
              community,
              version,
              timeout,
              retries
            );

            if (deviceInfo) {
              // Generate cryptographic fingerprint
              const fingerprint = generateSNMPFingerprint(ip, deviceInfo.sysObjectID || deviceInfo.sysDescr);

              const device: DiscoveredDevice = {
                name: this.generateDeviceName(ip, deviceInfo),
                protocol: 'snmp' as any, // Will be fixed in base interface
                fingerprint,
                connection: {
                  host: ip,
                  port,
                  version,
                  community: version === 'v3' ? undefined : community,
                  timeout,
                  retries,
                  // SNMPv3 auth (if configured)
                  ...(version === 'v3' && options?.v3Username && {
                    username: options.v3Username,
                    authProtocol: options.v3AuthProtocol,
                    authKey: options.v3AuthKey,
                    privProtocol: options.v3PrivProtocol,
                    privKey: options.v3PrivKey
                  })
                },
                dataPoints: this.generateDefaultDataPoints(deviceInfo),
                confidence: 'medium',
                discoveredAt: new Date().toISOString(),
                validated: false,
                metadata: {
                  ipAddress: ip,
                  port,
                  version,
                  sysDescr: deviceInfo.sysDescr,
                  sysObjectID: deviceInfo.sysObjectID,
                  discoveryMethod: 'sysDescr-read'
                }
              };

              this.logger?.infoSync(`Discovered SNMP device at ${ip}`, {
                component: LogComponents.discovery,
                phase: 'discovery',
                sysDescr: deviceInfo.sysDescr?.substring(0, 50) + '...'
              });

              return device;
            }

            return null;
          } catch (error) {
            this.logger?.debugSync(`No SNMP response from ${ip}`, {
              component: LogComponents.discovery,
              error: (error as Error).message
            });
            return null;
          }
        })
      )
    );

    // Collect successful discoveries
    for (const result of scanResults) {
      if (result.status === 'fulfilled' && result.value) {
        discovered.push(result.value);
      }
    }

    this.logger?.infoSync(`SNMP discovery complete: ${discovered.length} devices found`, {
      component: LogComponents.discovery,
      totalScanned: ips.length,
      discovered: discovered.length
    });

    return discovered;
  }

  /**
   * Phase 2: Validate device (read additional OIDs for identification)
   */
  async validate(device: DiscoveredDevice, timeout = 5000): Promise<ValidationResult | null> {
    this.logger?.infoSync('Validating SNMP device', {
      component: LogComponents.discovery,
      host: device.connection.host,
      phase: 'validation'
    });

    try {
      const snmp = await this.createSNMPSession(device.connection);
      
      // Read additional system info OIDs
      const oids = [
        '1.3.6.1.2.1.1.1.0',  // sysDescr
        '1.3.6.1.2.1.1.2.0',  // sysObjectID
        '1.3.6.1.2.1.1.4.0',  // sysContact
        '1.3.6.1.2.1.1.5.0',  // sysName
        '1.3.6.1.2.1.1.6.0',  // sysLocation
        '1.3.6.1.2.1.1.7.0'   // sysServices
      ];

      const varbinds = await this.snmpGet(snmp, oids, timeout);
      
      // Parse results
      const sysDescr = varbinds[0]?.value?.toString() || '';
      const sysObjectID = varbinds[1]?.value?.toString() || '';
      const sysContact = varbinds[2]?.value?.toString() || '';
      const sysName = varbinds[3]?.value?.toString() || '';
      const sysLocation = varbinds[4]?.value?.toString() || '';
      const sysServices = varbinds[5]?.value || 0;

      // Extract manufacturer and model from sysDescr
      const { manufacturer, modelNumber } = this.parseSysDescr(sysDescr);

      const validationResult: ValidationResult = {
        manufacturer,
        modelNumber,
        firmwareVersion: this.extractFirmwareVersion(sysDescr),
        capabilities: this.parseCapabilities(sysServices as number),
        deviceInfo: {
          sysDescr,
          sysObjectID,
          sysContact,
          sysName,
          sysLocation,
          sysServices
        }
      };

      this.logger?.infoSync('SNMP device validated', {
        component: LogComponents.discovery,
        host: device.connection.host,
        manufacturer,
        model: modelNumber,
        phase: 'validation'
      });

      snmp.close();
      return validationResult;

    } catch (error) {
      this.logger?.warnSync('SNMP validation failed', {
        component: LogComponents.discovery,
        host: device.connection.host,
        error: (error as Error).message
      });
      return null;
    }
  }

  /**
   * Check if SNMP is available (net-snmp library)
   */
  async isAvailable(): Promise<boolean> {
    try {
      await import('net-snmp');
      return true;
    } catch {
      this.logger?.debugSync('net-snmp library not available', {
        component: LogComponents.discovery
      });
      return false;
    }
  }

  /**
   * Test single IP for SNMP response
   */
  private async testSNMPDevice(
    ip: string,
    port: number,
    community: string,
    version: string,
    timeout: number,
    retries: number
  ): Promise<SNMPDeviceInfo | null> {
    try {
      const snmp = await import('net-snmp');
      
      // Create SNMP session
      let session: any;
      if (version === 'v3') {
        // SNMPv3 requires user object - skip for now in discovery
        // Would need v3Username, authKey, etc. from options
        return null;
      } else {
        session = snmp.createSession(ip, community, {
          port,
          retries,
          timeout
        });
      }

      // Read sysDescr (1.3.6.1.2.1.1.1.0) as primary detection
      const oid = '1.3.6.1.2.1.1.1.0';
      
      return new Promise((resolve, reject) => {
        session.get([oid], (error: Error | null, varbinds: any[]) => {
          session.close();
          
          if (error) {
            reject(error);
            return;
          }

          if (varbinds && varbinds.length > 0 && !snmp.isVarbindError(varbinds[0])) {
            const sysDescr = varbinds[0].value.toString();
            resolve({
              sysDescr
            });
          } else {
            resolve(null);
          }
        });
      });

    } catch (error) {
      return null;
    }
  }

  /**
   * Create SNMP session with full configuration
   */
  private async createSNMPSession(connection: any): Promise<any> {
    const snmp = await import('net-snmp');
    
    if (connection.version === 'v3') {
      const user = {
        name: connection.username,
        level: snmp.SecurityLevel.authPriv,
        authProtocol: connection.authProtocol === 'SHA' 
          ? snmp.AuthProtocols.sha 
          : snmp.AuthProtocols.md5,
        authKey: connection.authKey,
        privProtocol: connection.privProtocol === 'AES'
          ? snmp.PrivProtocols.aes
          : snmp.PrivProtocols.des,
        privKey: connection.privKey
      };
      
      return snmp.createV3Session(connection.host, user, {
        port: connection.port,
        retries: connection.retries,
        timeout: connection.timeout
      });
    } else {
      return snmp.createSession(connection.host, connection.community, {
        port: connection.port,
        retries: connection.retries,
        timeout: connection.timeout,
        version: connection.version === 'v1' ? snmp.Version1 : snmp.Version2c
      });
    }
  }

  /**
   * Perform SNMP GET request
   */
  private async snmpGet(session: any, oids: string[], timeout: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.close();
        reject(new Error('SNMP GET timeout'));
      }, timeout);

      session.get(oids, (error: Error | null, varbinds: any[]) => {
        clearTimeout(timer);
        
        if (error) {
          reject(error);
        } else {
          resolve(varbinds || []);
        }
      });
    });
  }

  /**
   * Get default IP ranges from environment or local network
   */
  private getDefaultIPRanges(): string[] {
    const envRanges = process.env.SNMP_IP_RANGES;
    if (envRanges) {
      return envRanges.split(',').map(r => r.trim());
    }

    // Auto-detect local network (192.168.x.0/24)
    // In production, this should be more sophisticated
    return ['192.168.1.0/24'];
  }

  /**
   * Expand IP ranges to individual IPs
   * Supports CIDR notation (192.168.1.0/24) and ranges (192.168.1.1-192.168.1.50)
   */
  private expandIPRanges(ranges: string[]): string[] {
    const ips: string[] = [];

    for (const range of ranges) {
      if (range.includes('/')) {
        // CIDR notation
        ips.push(...this.expandCIDR(range));
      } else if (range.includes('-')) {
        // IP range
        ips.push(...this.expandRange(range));
      } else {
        // Single IP
        ips.push(range);
      }
    }

    return ips;
  }

  /**
   * Expand CIDR notation to IP list
   */
  private expandCIDR(cidr: string): string[] {
    const [network, maskBits] = cidr.split('/');
    const mask = parseInt(maskBits, 10);
    
    if (mask < 16 || mask > 32) {
      this.logger?.warnSync(`Skipping CIDR ${cidr}: mask must be /16 to /32`, {
        component: LogComponents.discovery
      });
      return [];
    }

    const ips: string[] = [];
    const parts = network.split('.').map(Number);
    const hostCount = Math.pow(2, 32 - mask);
    
    // Limit to reasonable scan size (max 1024 IPs)
    const maxIPs = Math.min(hostCount - 2, 1024); // -2 for network and broadcast
    
    const baseIP = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
    
    for (let i = 1; i <= maxIPs; i++) {
      const ip = baseIP + i;
      const ipStr = [
        (ip >>> 24) & 255,
        (ip >>> 16) & 255,
        (ip >>> 8) & 255,
        ip & 255
      ].join('.');
      ips.push(ipStr);
    }

    return ips;
  }

  /**
   * Expand IP range to IP list (e.g., 192.168.1.1-192.168.1.50)
   */
  private expandRange(range: string): string[] {
    const [start, end] = range.split('-').map(s => s.trim());
    const startParts = start.split('.').map(Number);
    const endParts = end.split('.').map(Number);

    const ips: string[] = [];
    const startIP = (startParts[0] << 24) + (startParts[1] << 16) + (startParts[2] << 8) + startParts[3];
    const endIP = (endParts[0] << 24) + (endParts[1] << 16) + (endParts[2] << 8) + endParts[3];

    // Limit to reasonable scan size
    const count = Math.min(endIP - startIP + 1, 1024);
    
    for (let i = 0; i < count; i++) {
      const ip = startIP + i;
      const ipStr = [
        (ip >>> 24) & 255,
        (ip >>> 16) & 255,
        (ip >>> 8) & 255,
        ip & 255
      ].join('.');
      ips.push(ipStr);
    }

    return ips;
  }

  /**
   * Generate device name from IP and device info
   */
  private generateDeviceName(ip: string, info: SNMPDeviceInfo): string {
    if (info.sysName) {
      return info.sysName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    }
    
    // Use last octet of IP
    const lastOctet = ip.split('.').pop();
    return `snmp_device_${lastOctet}`;
  }

  /**
   * Generate default data points from device info
   */
  private generateDefaultDataPoints(info: SNMPDeviceInfo): any[] {
    return [
      {
        name: 'sysName',
        oid: '1.3.6.1.2.1.1.5.0',
        unit: '',
        dataType: 'string'
      },
      {
        name: 'sysUpTime',
        oid: '1.3.6.1.2.1.1.3.0',
        unit: 'timeticks',
        dataType: 'timeticks'
      }
    ];
  }

  /**
   * Parse manufacturer and model from sysDescr
   */
  private parseSysDescr(sysDescr: string): { manufacturer?: string; modelNumber?: string } {
    // Common patterns in sysDescr:
    // "Cisco IOS Software, C2960 Software..."
    // "Linux hostname 4.19.0-17-amd64..."
    // "HP ProCurve Switch 2824..."
    
    const patterns = [
      /^(\w+)\s+(.+?)\s+(?:Software|Switch)/i, // Cisco, HP, etc.
      /^(Linux|Windows|FreeBSD)/i,              // OS-based
      /^(.+?)\s+Version/i                       // Generic "Product Version"
    ];

    for (const pattern of patterns) {
      const match = sysDescr.match(pattern);
      if (match) {
        return {
          manufacturer: match[1],
          modelNumber: match[2]
        };
      }
    }

    return {};
  }

  /**
   * Extract firmware version from sysDescr
   */
  private extractFirmwareVersion(sysDescr: string): string | undefined {
    const versionMatch = sysDescr.match(/Version\s+([0-9.]+)/i);
    return versionMatch ? versionMatch[1] : undefined;
  }

  /**
   * Parse capabilities from sysServices integer
   */
  private parseCapabilities(sysServices: number): string[] {
    const capabilities: string[] = [];
    
    if (sysServices & 1) capabilities.push('physical');
    if (sysServices & 2) capabilities.push('datalink');
    if (sysServices & 4) capabilities.push('internet');
    if (sysServices & 8) capabilities.push('end-to-end');
    if (sysServices & 64) capabilities.push('application');
    
    return capabilities;
  }
}
