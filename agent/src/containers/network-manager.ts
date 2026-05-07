import * as constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import { unionBy } from '../lib/collection-utils';
import { isNotFoundError } from '../lib/errors';

import * as logger from '../logging';
import { Network } from './network';
import { ResourceRecreationAttemptError } from './errors';

/**
 * Acquire a lock for network operations using Docker container
 * CRITICAL for multi-agent scenarios:
 * - Systemd restart during OTA update
 * - Two agent instances briefly overlapping
 * - Manual operations + agent automation
 * 
 * @param lockName - Lock identifier (e.g., 'network-supervisor')
 * @param timeout - Max wait time in ms (default: 30000)
 * @returns Lock container ID if acquired, null if timeout
 */
async function acquireNetworkLock(
	lockName: string,
	timeout: number = 30000,
): Promise<string | null> {
	const containerName = `iotistic-lock-${lockName}`;
	const startTime = Date.now();
	
	while (Date.now() - startTime < timeout) {
		try {
			// Atomic operation: create container with specific name
			const container = await docker.createContainer({
				name: containerName,
				Image: 'busybox:latest',
				Cmd: ['sleep', '300'], // 5min max lock hold time
				Labels: {
					'iotistic.lock': 'true',
					'iotistic.lock-name': lockName,
					'iotistic.acquired-at': new Date().toISOString(),
				},
				HostConfig: {
					AutoRemove: false,
				},
			});
			
			await container.start();
			logger.logSystemEvent('networkLockAcquired', {
				lockName,
				containerId: container.id,
			});
			return container.id;
		} catch (err: any) {
			// 409 Conflict = lock already held
			if (err.statusCode === 409) {
				const elapsed = Date.now() - startTime;
				const backoff = Math.min(1000, 100 * Math.pow(2, Math.floor(elapsed / 1000)));
				await new Promise(resolve => setTimeout(resolve, backoff));
				continue;
			}
			
			logger.logSystemEvent('networkLockAcquireError', {
				lockName,
				error: err.message,
			});
			throw err;
		}
	}
	
	logger.logSystemEvent('networkLockTimeout', {
		lockName,
		timeout,
		message: 'Another agent may be stuck - check for zombie lock containers',
	});
	return null;
}

/**
 * Release network operation lock
 */
async function releaseNetworkLock(containerId: string): Promise<void> {
	try {
		const container = docker.getContainer(containerId);
		await container.stop({ t: 1 });
		await container.remove();
		logger.logSystemEvent('networkLockReleased', {
			containerId,
		});
	} catch (err: any) {
		if (err.statusCode !== 404) {
			logger.logSystemEvent('networkLockReleaseError', {
				containerId,
				error: err.message,
			});
		}
	}
}

/**
 * Check for IP/subnet collisions with existing networks
 * CRITICAL for edge devices:
 * - Weird routers with overlapping subnets
 * - VPN tunnels (10.8.0.0/24, etc.)
 * - Multiple Docker networks on same host
 * 
 * Fail early with clear error > silent broken routing
 * 
 * @param targetSubnet - Subnet to check (e.g., '172.17.0.0/16')
 * @param targetGateway - Gateway to check (e.g., '172.17.0.1')
 * @param excludeNetworkName - Network name to exclude from check (for recreation)
 * @throws Error if collision detected
 */
async function checkNetworkCollisions(
	targetSubnet: string,
	targetGateway: string,
	excludeNetworkName?: string,
): Promise<void> {
	const existingNetworks = await docker.listNetworks();
	
	for (const net of existingNetworks) {
		// Skip network being recreated
		if (excludeNetworkName && net.Name === excludeNetworkName) {
			continue;
		}
		
		// Skip networks without IPAM config (bridge without explicit subnet)
		if (!net.IPAM?.Config || net.IPAM.Config.length === 0) {
			continue;
		}
		
		for (const config of net.IPAM.Config) {
			// Check subnet collision
			if (config.Subnet === targetSubnet) {
				// Additional context: warn if conflicting network uses unsupported driver
				const driverWarning = net.Driver !== 'bridge' 
					? ` Note: Conflicting network uses '${net.Driver}' driver which is unsupported on edge devices.`
					: '';
				const error = new Error(
					`Network subnet collision detected: ${targetSubnet} already used by network '${net.Name}'. ` +
					`This will cause routing failures. Check VPN tunnels, existing Docker networks, or router config.${driverWarning}`
				);
				logger.logSystemEvent('networkSubnetCollision', {
					targetSubnet,
					conflictingNetwork: net.Name,
					conflictingSubnet: config.Subnet,
					conflictingDriver: net.Driver,
				});
				throw error;
			}
			
			// Check gateway collision
			if (config.Gateway === targetGateway) {
				const error = new Error(
					`Network gateway collision detected: ${targetGateway} already used by network '${net.Name}'. ` +
					`This will cause routing conflicts.`
				);
				logger.logSystemEvent('networkGatewayCollision', {
					targetGateway,
					conflictingNetwork: net.Name,
					conflictingGateway: config.Gateway,
				});
				throw error;
			}
		}
	}
}

export async function getAll(): Promise<Network[]> {
	const networks = await getWithBothLabels();
	return await Promise.all(
		networks.map(async (network: { Id: string }) => {
			const net = await docker.getNetwork(network.Id).inspect();
			return Network.fromDockerNetwork(net);
		}),
	);
}

async function get(network: {
	name: string;
	appUuid: string;
}): Promise<Network> {
	const dockerNet = await docker
		.getNetwork(Network.generateDockerName(network.appUuid, network.name))
		.inspect();
	return Network.fromDockerNetwork(dockerNet);
}

export async function create(network: Network) {
	try {
		const existing = await get({
			name: network.name,
			appUuid: network.appUuid!, // new networks will always have uuid
		});
		if (!network.isEqualConfig(existing)) {
			throw new ResourceRecreationAttemptError('network', network.name);
		}

		// We have a network with the same config and name
		// already created, we can skip this
	} catch (e: unknown) {
		if (!isNotFoundError(e)) {
			logger.logSystemEvent('createNetworkError', {
				network: { name: network.name, appUuid: network.appUuid },
				error: e,
			});
			throw e;
		}

		// If we got a not found error, create the network
		await network.create();
	}
}

export async function remove(network: Network) {
	// We simply forward this to the network object, but we
	// add this method to provide a consistent interface
	await network.remove();
}

const {
	agentNetworkInterface: iface,
	agentNetworkGateway: gateway,
	agentNetworkSubnet: subnet,
} = constants;

export async function agentNetworkReady(): Promise<boolean> {
	try {
		// The inspect may fail even if the interface exist due to docker corruption
		const network = await docker.getNetwork(iface).inspect();
		const result =
			network.Options['com.docker.network.bridge.name'] === iface &&
			network.IPAM.Config[0].Subnet === subnet &&
			network.IPAM.Config[0].Gateway === gateway;
		return result;
	} catch (e: unknown) {
		console.warn(
			`Failed to read docker configuration of network ${iface}:`,
			(e as Error).message,
		);
		return false;
	}
}

export async function ensureAgentNetwork(): Promise<void> {
	// CRITICAL: Acquire lock to prevent concurrent network recreation
	// Edge scenarios: systemd restart during OTA, two agent instances overlapping
	const lockId = await acquireNetworkLock('network-supervisor', 30000);
	if (!lockId) {
		logger.logSystemEvent('supervisorNetworkEnsureSkipped', {
			message: 'Could not acquire lock - another agent likely managing supervisor network',
		});
		return; // Skip, other agent will handle it
	}
	
	try {
		try {
			const net = await docker.getNetwork(iface).inspect();
			
			// CRITICAL: Enforce bridge driver on edge devices
			// overlay/macvlan/ipvlan can break on single-node setups, VPNs, weird routers
			if (net.Driver !== 'bridge') {
				logger.logSystemEvent('unsupportedNetworkDriver', {
					network: { name: iface },
					driver: net.Driver,
					message: 'Supervisor network must use bridge driver on edge devices',
				});
				throw new Error(
					`Unsupported network driver '${net.Driver}' detected on supervisor network. ` +
					`Edge devices require 'bridge' driver. overlay/macvlan/ipvlan not supported.`
				);
			}
			
			if (
				net.Options['com.docker.network.bridge.name'] !== iface ||
				net.IPAM.Config[0].Subnet !== subnet ||
				net.IPAM.Config[0].Gateway !== gateway
			) {
				// CRITICAL: Network config wrong - must recreate
				// But disconnecting containers can cause "device offline until reboot"
				// Must handle gracefully with reconnection
				
				logger.logSystemEvent('supervisorNetworkRecreating', {
					network: { name: iface },
					reason: 'Config mismatch - disconnecting containers for safe recreation',
				});
				
				// Step 1: List attached containers BEFORE removal
				const attachedContainers = Object.keys(net.Containers || {});
				
				// Step 2: Disconnect containers gracefully
				const network = docker.getNetwork(iface);
				for (const containerId of attachedContainers) {
					try {
						await network.disconnect({ 
							Container: containerId, 
							Force: true // Force needed if container not responding
						});
						logger.logSystemEvent('containerDisconnectedFromNetwork', {
							containerId: containerId.substring(0, 12),
							network: { name: iface },
						});
					} catch (err: unknown) {
						// Container may have stopped between inspect and disconnect
						logger.logSystemEvent('containerDisconnectError', {
							containerId: containerId.substring(0, 12),
							network: { name: iface },
							error: err,
						});
					}
				}
				
				// Step 3: Remove network (safe now - no containers attached)
				await network.remove();
				
				// Step 3.5: Check for IP/subnet collisions BEFORE recreation
				// Edge safety: VPN tunnels, weird routers, overlapping subnets
				await checkNetworkCollisions(subnet, gateway, iface);
				
				// Step 4: Recreate network with correct config
				logger.logSystemEvent('supervisorNetworkCreating', {
					network: { name: iface },
				});
				await docker.createNetwork({
					Name: iface,
					Options: {
						'com.docker.network.bridge.name': iface,
					},
					IPAM: {
						Driver: 'default',
						Config: [
							{
								Subnet: subnet,
								Gateway: gateway,
							},
						],
					},
					Labels: {
						'iotistic.managed': 'true',
						'iotistic.role': 'supervisor',
					},
					CheckDuplicate: true,
				});
				
				// Step 5: Reconnect containers to new network
				const newNetwork = docker.getNetwork(iface);
				for (const containerId of attachedContainers) {
					try {
						// Verify container still exists and is running
						const container = docker.getContainer(containerId);
						const containerInfo = await container.inspect();
						
						if (containerInfo.State.Running) {
							await newNetwork.connect({ Container: containerId });
							logger.logSystemEvent('containerReconnectedToNetwork', {
								containerId: containerId.substring(0, 12),
								network: { name: iface },
							});
						} else {
							logger.logSystemEvent('containerNotReconnected', {
								containerId: containerId.substring(0, 12),
								network: { name: iface },
								reason: 'Container not running',
							});
						}
					} catch (err: unknown) {
						// Container may have been removed during recreation
						logger.logSystemEvent('containerReconnectError', {
							containerId: containerId.substring(0, 12),
							network: { name: iface },
							error: err,
						});
					}
				}
				
				logger.logSystemEvent('supervisorNetworkRecreated', {
					network: { name: iface },
					reconnectedContainers: attachedContainers.length,
				});
				
				return;
			}
		} catch (e: unknown) {
			if (!isNotFoundError(e)) {
				return;
			}

			// Check for IP/subnet collisions BEFORE creation
			// Edge safety: VPN tunnels, weird routers, overlapping subnets
			await checkNetworkCollisions(subnet, gateway);

			console.debug(`Creating ${iface} network`);
			await docker.createNetwork({
				Name: iface,
				Options: {
					'com.docker.network.bridge.name': iface,
				},
				IPAM: {
					Driver: 'default',
					Config: [
						{
							Subnet: subnet,
							Gateway: gateway,
						},
					],
				},
				Labels: {
					'iotistic.managed': 'true',
					'iotistic.role': 'supervisor',
				},
				CheckDuplicate: true,
			});
		}
	} finally {
		// CRITICAL: Always release lock, even on error
		await releaseNetworkLock(lockId);
	}
}

async function getWithBothLabels() {
	const [legacyNetworks, currentNetworks] = await Promise.all([
		docker.listNetworks({
			filters: {
				label: ['io.balena.supervised'], // Legacy Balena Supervisor label
			},
		}),
		docker.listNetworks({
			filters: {
				label: ['iotistic.managed'], // Current Iotistic label
			},
		}),
	]);
	return unionBy('Id', currentNetworks, legacyNetworks);
}
