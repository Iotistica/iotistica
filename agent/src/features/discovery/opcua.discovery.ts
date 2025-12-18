/**
 * OPC-UA Discovery Plugin
 * 
 * Discovers OPC-UA servers via endpoint discovery
 * Uses OPC-UA's built-in discovery mechanism
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import { generateOPCUAFingerprint } from './fingerprint';

export interface OPCUADiscoveryOptions {
  discoveryUrls?: string[]; // e.g., ['opc.tcp://localhost:4840']
  scanForServers?: boolean; // Use LDS (Local Discovery Server)
}

export class OPCUADiscoveryPlugin extends BaseDiscoveryPlugin {
  constructor(logger?: AgentLogger) {
    super('opcua', logger);
  }

  /**
   * Phase 1: Fast endpoint enumeration
   */
  async discover(options?: OPCUADiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    // Default discovery URLs (empty array = skip discovery)
    const discoveryUrls = options?.discoveryUrls || [
      'opc.tcp://localhost:4840',
      'opc.tcp://localhost:48010'
    ];

    // Skip if no URLs configured
    if (discoveryUrls.length === 0) {
      this.logger?.debugSync('OPC-UA discovery skipped - no URLs configured', {
        component: LogComponents.discovery,
        protocol: this.protocol
      });
      return [];
    }

    this.logger?.infoSync('Starting OPC-UA discovery', {
      component: LogComponents.discovery,
      protocol: this.protocol,
      phase: 'discovery'
    });

    for (const url of discoveryUrls) {
      try {
        const { OPCUAClient } = await import('node-opcua-client');

        const client = OPCUAClient.create({
          applicationName: 'Iotistic Sensor Agent',
          applicationUri: 'urn:iotistic:sensor-agent',
          endpointMustExist : false,
          connectionStrategy: {
            maxRetry: 1,
            initialDelay: 100,
            maxDelay: 1000
          }
        });

        await client.connect(url);
        const endpoints = await client.getEndpoints();
        await client.disconnect();

        if (endpoints.length > 0) {
          const endpoint = endpoints[0];
          
          // Extract ApplicationUri from endpoint (most stable OPC-UA identifier)
          const applicationUri = endpoint.server?.applicationUri || `urn:${new URL(url).hostname}:unknown`;
          
          // Generate cryptographic fingerprint
          const fingerprint = generateOPCUAFingerprint(applicationUri);
          
          const certThumbprint = endpoint.serverCertificate 
            ? endpoint.serverCertificate.toString('hex').substring(0, 16)
            : 'nocert';

          discovered.push({
            name: `opcua_${new URL(url).hostname}_${new URL(url).port}`,
            protocol: 'opcua' as const,
            fingerprint,
            connection: {
              endpointUrl: url,
              securityMode: 'None',
              securityPolicy: 'None'
            },
            dataPoints: [{
              nodeId: 'ns=2;s=MyVariable',
              name: 'example_node'
            }],
            confidence: 'medium',
            discoveredAt: new Date().toISOString(),
            validated: false,
            metadata: {
              endpointUrl: url,
              applicationUri,
              availableEndpoints: endpoints.length,
              serverCertificateThumbprint: certThumbprint,
              discoveryMethod: 'endpoint_discovery'
            }
          });

          this.logger?.infoSync(`Discovered OPC-UA endpoint at ${url}`, {
            component: LogComponents.discovery,
            endpoints: endpoints.length,
            phase: 'discovery'
          });
        }
      } catch (error) {
        this.logger?.debugSync(`No OPC-UA server at ${url}`, {
          component: LogComponents.discovery
        });
      }
    }

    return discovered;
  }

  /**
   * Phase 2: Validate server (read ServerInfo)
   */
  async validate(device: DiscoveredDevice, timeout = 5000): Promise<any> {
    this.logger?.infoSync('Validating OPC-UA server', {
      component: LogComponents.discovery,
      endpoint: device.connection.endpointUrl,
      phase: 'validation'
    });

    // TODO: Implement OPC-UA server validation
    // - Read Server_ServerStatus node
    // - Read Server_ServerArray
    // - Read manufacturer info from namespace 0
    
    return null; // Placeholder
  }

  /**
   * Check if OPC-UA client is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await import('node-opcua-client');
      return true;
    } catch {
      return false;
    }
  }
}
