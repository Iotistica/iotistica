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
import type { ConfigManager } from '../../device-manager/config.js';

export interface OPCUADiscoveryOptions {
  discoveryUrls?: string[]; // e.g., ['opc.tcp://localhost:4840']
  scanForServers?: boolean; // Use LDS (Local Discovery Server)
}

export class OPCUADiscoveryPlugin extends BaseDiscoveryPlugin {
  private configManager?: ConfigManager;

  constructor(logger?: AgentLogger, configManager?: ConfigManager) {
    super('opcua', logger);
    this.configManager = configManager;
  }

  /**
   * Phase 1: Fast endpoint enumeration
   */
  async discover(options?: OPCUADiscoveryOptions): Promise<DiscoveredDevice[]> {
    const discovered: DiscoveredDevice[] = [];

    // Get discovery targets from endpoints (those with endpointUrl but no dataPoints)
    const discoveryTargets = this.configManager?.getDiscoveryTargets?.('opcua') || [];
    
		this.logger?.infoSync('=== OPC UA DISCOVERY PLUGIN: RECEIVED TARGETS ===', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			protocol: this.protocol,
			targetCount: discoveryTargets.length,
			targets: discoveryTargets.map((t: any) => ({
				uuid: t.uuid,
				name: t.name,
				protocol: t.protocol,
				connection: t.connection,
				dataPointsCount: t.dataPoints?.length || 0
			}))
		});
		
		if (discoveryTargets.length === 0) {
			this.logger?.warnSync('No OPC-UA discovery targets configured (need endpointUrl without dataPoints)', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				protocol: this.protocol
			});
			return [];
		}

		this.logger?.debugSync(`Starting OPC-UA discovery (${discoveryTargets.length} targets)`, {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			protocol: this.protocol,
			phase: 'discovery',
			targetCount: discoveryTargets.length
		});

		for (const endpoint of discoveryTargets) {
			const url = endpoint.connection?.endpointUrl;
			if (!url) continue;

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
								
								// Skip standard OPC UA system folders at root level (IEC 62541)
								// ServerInfo contains metadata like ProfileName, SensorCount which pollute data_points
								if (depth === 0 && ['Server', 'ServerInfo', 'Types', 'Views', 'Aliases'].includes(nodeName)) {
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
										// Extract semantic metric name from browseName prefix (OPC UA standard)
										// Format: "Temperature_Sensor1" → metric: "temperature"
										// If no underscore, use full browseName in lowercase
										const metricName = nodeName.includes('_') 
											? nodeName.split('_')[0].toLowerCase()
											: nodeName.toLowerCase();
										
										dataPoints.push({
											nodeId: childNodeId,
											name: metricName
										});
										
										this.logger?.debugSync(`Discovered variable: ${currentPath.join('/')}`, {
											component: LogComponents.discovery + "] [" + this.protocol as any,
											nodeId: childNodeId,
											browseName: nodeName,
											metricName,
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
				
				this.logger?.debugSync(`OPC UA recursive tree browsing complete: discovered ${dataPoints.length} nodes`, {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					url,
					dataPointCount: dataPoints.length
				});
				
				// Log sample of discovered nodes for verification
				if (dataPoints.length > 0) {
					this.logger?.infoSync(`OPC UA nodes discovered and ready to save`, {
						component: LogComponents.discovery + "] [" + this.protocol as any,
						endpointUrl: url,
						totalNodes: dataPoints.length,
						sampleNodes: dataPoints.slice(0, 5).map(dp => ({
							nodeId: dp.nodeId,
							name: dp.name
						}))
					});
				}
				
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

					this.logger?.debugSync(`Discovered OPC-UA endpoint at ${url}`, {
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
    this.logger?.debugSync('Validating OPC-UA server', {
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

