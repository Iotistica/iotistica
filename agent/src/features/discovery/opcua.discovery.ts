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
      'opc.tcp://10.0.0.60:4840',
      'opc.tcp://10.0.0.60:48010'
    ];

    // Skip if no URLs configured
    if (discoveryUrls.length === 0) {
      this.logger?.debugSync('OPC-UA discovery skipped - no URLs configured', {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        protocol: this.protocol
      });
      return [];
    }

    this.logger?.infoSync('Starting OPC-UA discovery', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
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
        
        // Create session to browse the node tree
        const session = await client.createSession();
        const dataPoints: Array<{ nodeId: string; name: string }> = [];
        
        try {
          // Recursive tree browsing function
          const browseRecursive = async (
            nodeId: string,
            pathSegments: string[] = [],
            depth: number = 0,
            maxDepth: number = 10
          ): Promise<void> => {
            // Protection against infinite loops
            if (depth > maxDepth) {
              this.logger?.warnSync(`Max depth ${maxDepth} reached, stopping recursion`, {
                component: LogComponents.discovery + "] [" + this.protocol as any,
                path: pathSegments.join('/')
              });
              return;
            }
            
            try {
              const browseResult = await session.browse(nodeId);
              
              for (const ref of browseResult.references || []) {
                const nodeName = ref.browseName?.name || '';
                const childNodeId = ref.nodeId.toString();
                const currentPath = [...pathSegments, nodeName];
                
                // Skip standard OPC UA system folders at root level
                if (depth === 0 && ['Server', 'Types', 'Views', 'Aliases'].includes(nodeName)) {
                  continue;
                }
                
                // NodeClass: 1 = Object/Folder, 2 = Variable
                // Verify the actual NodeClass by reading node attributes
                try {
                  const nodeClass = await session.read({
                    nodeId: childNodeId,
                    attributeId: 2 // NodeClass attribute
                  });
                  
                  const actualNodeClass = nodeClass.value.value;
                  
                  if (actualNodeClass === 2) {
                    // Verified variable - add to data points
                    const variableName = currentPath.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '_');
                    
                    dataPoints.push({
                      nodeId: childNodeId,
                      name: variableName
                    });
                    
                    this.logger?.debugSync(`Discovered variable: ${currentPath.join('/')}`, {
                      component: LogComponents.discovery + "] [" + this.protocol as any,
                      nodeId: childNodeId,
                      depth
                    });
                  } else if (actualNodeClass === 1) {
                    // Verified folder - recurse into it
                    this.logger?.debugSync(`Browsing into folder: ${currentPath.join('/')}`, {
                      component: LogComponents.discovery + "] [" + this.protocol as any,
                      nodeId: childNodeId,
                      depth
                    });
                    
                    await browseRecursive(childNodeId, currentPath, depth + 1, maxDepth);
                  }
                } catch (readError) {
                  // If we can't read NodeClass, skip this node
                  this.logger?.debugSync(`Skipping node (cannot read NodeClass): ${currentPath.join('/')}`, {
                    component: LogComponents.discovery + "] [" + this.protocol as any,
                    nodeId: childNodeId,
                    error: readError instanceof Error ? readError.message : String(readError)
                  });
                }
              }
            } catch (browseError) {
              this.logger?.debugSync(`Failed to browse node: ${pathSegments.join('/')}`, {
                component: LogComponents.discovery + "] [" + this.protocol as any,
                error: browseError instanceof Error ? browseError.message : String(browseError),
                depth
              });
            }
          };
          
          // Start recursive browsing from Objects folder
          const ObjectsNodeId = 'ns=0;i=85'; // Standard Objects folder
          await browseRecursive(ObjectsNodeId, [], 0);
        } catch (browseError) {
          this.logger?.warnSync('Failed to browse OPC UA tree recursively, using default node', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            error: browseError instanceof Error ? browseError.message : String(browseError)
          });
          
          // Fallback to example node if browsing fails
          if (dataPoints.length === 0) {
            dataPoints.push({
              nodeId: 'ns=2;s=MyVariable',
              name: 'example_node'
            });
          }
        } finally {
          await session.close();
        }
        
        this.logger?.infoSync(`OPC UA recursive tree browsing complete: discovered ${dataPoints.length} nodes`, {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          url,
          dataPointCount: dataPoints.length
        });
        
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
            dataPoints: dataPoints.length > 0 ? dataPoints : [{
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
            component: LogComponents.discovery + "] [" + this.protocol as any,
            endpoints: endpoints.length,
            phase: 'discovery'
          });
        }
      } catch (error) {
        this.logger?.debugSync(`No OPC-UA server at ${url}`, {
          component: LogComponents.discovery + "] [" + this.protocol as any
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
      component: LogComponents.discovery + "] [" + this.protocol as any,
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

