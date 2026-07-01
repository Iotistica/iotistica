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
import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import BACnet from 'bacstack';
import { LogComponents } from '../../logging/types';
import { BaseDiscovery } from '../base';
import { type DiscoveredDevice, type ValidationResult } from '../types';

import { pLimit } from '../../lib/p-limit.js';

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
	presentValue?: unknown;
  units?: string;
  description?: string;
}

interface BACnetValidatedObject {
	objectType: string;
	objectInstance: number;
	objectName: string;
	presentValue: unknown;
	units?: string;
}

interface BACnetArrayElement {
	value: unknown;
}

interface BACnetReadPropertyValue {
	values?: BACnetArrayElement[];
}

interface BACnetObjectReference {
	type: number;
	instance: number;
}

interface BACnetIAmDevice {
	deviceId: number;
	address: string;
	vendorId?: number;
	maxSegments?: number;
	maxApdu?: number;
}

interface BACnetTransportServerLike {
	send(buffer: Buffer, offset: number, length: number, port: number, receiver: string): void;
}

interface BACnetTransportLike {
	_server?: BACnetTransportServerLike;
	address?: { port?: number; family?: string };
	send?: (buffer: Buffer, offset: number, receiver: string) => void;
}

interface BACnetClientLike {
	_transport?: BACnetTransportLike;
	whoIs(options: { lowLimit: number; highLimit: number; address: string }): void;
	readProperty(
		address: string,
		objectId: { type: number; instance: number },
		propertyId: number,
		callback: (err: Error | null, value: BACnetReadPropertyValue) => void,
	): void;
	on(event: 'iAm', listener: (device: BACnetIAmDevice) => void): void;
	on(event: 'listening', listener: () => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	removeAllListeners(event: string): void;
	close(): void;
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

enum BacnetPropertyId {
	DESCRIPTION = 28,
	MODEL_NAME = 70,
	OBJECT_LIST = 76,
	OBJECT_NAME = 77,
	PRESENT_VALUE = 85,
	UNITS = 117,
	VENDOR_NAME = 121,
}

export class BACnetDiscovery extends BaseDiscovery {
	private client?: BACnetClientLike;  // Reuse same BACnet client across discovery and validation
	private readonly AGENT_PORT = 47809;  // Agent uses different port than devices (47808)
	private readonly AGENT_DEVICE_ID = 4190000;  // Gateway-style device ID
	private readonly logContext = {
		component: LogComponents.discovery,
		protocol: 'bacnet'
	} as const;
	private readonly validationConcurrency = 4;

	constructor(logger?: AgentLogger) {
		super('bacnet', logger);
	}

	generateFingerprint(ipAddress: string, deviceInstance: number): string {
		return createHash('sha256').update(`bacnet:${ipAddress}:${deviceInstance}`).digest('hex').substring(0, 32);
	}

	private asString(value: unknown): string | undefined {
		return typeof value === 'string' ? value : undefined;
	}

	private async wait(ms: number): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, ms));
	}

	private asObjectReferences(value: unknown): BACnetObjectReference[] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value.filter((item): item is BACnetObjectReference => {
			return typeof item === 'object' && item !== null
				&& typeof (item as { type?: unknown }).type === 'number'
				&& typeof (item as { instance?: unknown }).instance === 'number';
		});
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
		// Strip :port suffix if present (e.g. '172.22.0.20:47808' → '172.22.0.20')
		// Port is handled by the transport patch — bacstack whoIs() expects bare IP/hostname.
		const colonIdx = target.lastIndexOf(':');
		if (colonIdx !== -1 && /^\d+$/.test(target.slice(colonIdx + 1))) {
			target = target.slice(0, colonIdx);
		}

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
		// Must look like two dotted-decimal IPs separated by a single dash.
		// Plain hostnames like 'bacnet-sim-host.example.com' also contain dashes —
		// they fall through to the hostname branch below.
		const IP_RANGE_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}-\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
		if (IP_RANGE_RE.test(target)) {
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
			for (const addr of addrs) {
				if (addr.family === 'IPv4' && !addr.internal && addr.address !== '127.0.0.1') {
					// Skip /32 netmasks (Docker internal point-to-point interfaces)
					if (addr.netmask === '255.255.255.255') {
						this.logger?.debugSync('Skipping /32 interface (Docker internal)', {
							...this.logContext,
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
						...this.logContext,
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
			...this.logContext,
			broadcast: '255.255.255.255'
		});
		return '255.255.255.255';
	}

	/**
   * Get or create BACnet client with pre-derived broadcast address
   */
	private async getClient(options?: BACnetDiscoveryOptions): Promise<BACnetClientLike> {
		// Reuse existing client
		if (this.client) {
			this.logger?.debugSync('Reusing existing BACnet client', {
				...this.logContext
			});
			return this.client;
		}

		// Use pre-derived broadcast address (passed from discover())
		const broadcastAddress = options?.broadcastAddress || '255.255.255.255';
		const timeout = options?.timeout || 5000;

		this.logger?.debugSync('Creating new BACnet client', {
			...this.logContext,
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

		const client = this.client;
		if (!client) {
			throw new Error('Failed to initialize BACnet client');
		}

		this.patchTransportSendToDevicePort(client);

		this.logger?.debugSync('BACnet client created successfully', {
			...this.logContext,
			clientType: typeof client,
			hasWhoIs: typeof client.whoIs,
			hasOn: typeof client.on
		});

		client.on('listening', () => {
			const addr = client._transport?.address;
			this.logger?.infoSync('BACnet socket listening', {
				...this.logContext,
				address: addr,
				port: addr?.port,
				family: addr?.family
			});
		});

		client.on('error', (err: Error) => {
			this.logger?.errorSync('BACnet client error', err, {
				...this.logContext
			});
		});

		await new Promise(resolve => setTimeout(resolve, 100));

		this.logger?.debugSync('BACnet client initialization complete', {
			...this.logContext,
			transportReady: !!client._transport,
			socketAddress: client._transport?.address
		});

		return client;
	}

	private patchTransportSendToDevicePort(client: BACnetClientLike): void {
		const remotePort = 47808;
		const transport = client?._transport;
		if (transport && typeof transport._server?.send === 'function') {
			const server = transport._server;
			if (!server) {
				return;
			}
			transport.send = (buffer: Buffer, offset: number, receiver: string) => {
				server.send(buffer, 0, offset, remotePort, receiver);
			};
			this.logger?.debugSync('BACnet transport patched', {
				...this.logContext,
				localPort: this.AGENT_PORT,
				remotePort
			});
		}
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
			...this.logContext,
			phase: 'discovery'
		});

		const discoveryTargets = options?.discoveryTargets || [];
		const hasTargets = discoveryTargets.length > 0;
		const hasBroadcast = !!options?.broadcastAddress;
		const useUnicast = hasTargets;  // Prefer unicast if targets provided

		let broadcastAddress = options?.broadcastAddress;
		if (!useUnicast && !broadcastAddress) {
			broadcastAddress = this.deriveBroadcastAddress();
		}

		const port = options?.port || 47808;
		const timeout = options?.timeout || 5000;
		const maxDevices = options?.maxDevices || 100;
		const deviceIdRange = options?.deviceIdRange || [0, 4194303]; // Full BACnet range

		this.logger?.debugSync('BACnet discovery configuration', {
			...this.logContext,
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
			const client = await this.getClient({ ...options, broadcastAddress, timeout });
			const devices = new Map<number, BACnetDeviceInfo>();
			let iAmReceivedCount = 0;
			let iAmIgnoredCount = 0;
			let devicePropertyReadFailures = 0;

			// Map resolved IP → original target string so the iAm handler can
			// store the user-configured hostname instead of the raw UDP source IP.
			const resolvedIPToTarget = new Map<string, string>();

			this.logger?.debugSync('Attaching I-Am event listener', {
				...this.logContext,
				agentDeviceId: this.AGENT_DEVICE_ID,
				filterSelfIAm: true
			});

			client.removeAllListeners('iAm');

			client.on('iAm', (device: BACnetIAmDevice) => {
				iAmReceivedCount++;

				if (devices.size >= maxDevices) {
					iAmIgnoredCount++;
					return; // Stop accepting new devices
				}

				const deviceInstance = device.deviceId;

				if (deviceInstance === this.AGENT_DEVICE_ID) {
					iAmIgnoredCount++;
					return;
				}

				const addressParts = device.address.split(':');
				const ipAddress = addressParts[0];
				const devicePort = addressParts.length > 1 ? Number(addressParts[1]) : port;
				// Prefer the original hostname target over the raw IP (preserves FQDN in source config)
				const effectiveHost = resolvedIPToTarget.get(ipAddress) ?? ipAddress;

				devices.set(deviceInstance, {
					deviceInstance,
					ipAddress: effectiveHost,
					port: devicePort,
					vendorId: device.vendorId
				});
			});

			if (useUnicast) {
				this.logger?.debugSync('Sending BACnet Who-Is via unicast', {
					...this.logContext,
					targets: discoveryTargets,
					count: discoveryTargets.length
				});

				const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

				for (const target of discoveryTargets) {
					try {
						const targetIPs = this.expandDiscoveryTarget(target);

						// For a single-hostname target, resolve it so we can map
						// the I-Am source IP back to the original FQDN/hostname.
						if (targetIPs.length === 1 && !IP_RE.test(targetIPs[0])) {
							try {
								const { address } = await dnsLookup(targetIPs[0]);
								resolvedIPToTarget.set(address, targetIPs[0]);
							} catch {
								// DNS lookup failed — iAm will fall back to raw IP
							}
						}

						for (const targetIP of targetIPs) {
							this.logger?.debugSync('Sending Who-Is to unicast target', {
								...this.logContext,
								target: targetIP,
								port
							});

							client.whoIs({
								lowLimit: deviceIdRange[0],
								highLimit: deviceIdRange[1],
								address: targetIP
							});

							this.logger?.debugSync('Unicast Who-Is sent', {
								...this.logContext,
								target: targetIP
							});
						}
					} catch (err) {
						this.logger?.errorSync('Failed to send Who-Is to target', err instanceof Error ? err : new Error(String(err)), {
							...this.logContext,
							target
						});
					}
				}

				this.logger?.debugSync('Unicast Who-Is packets sent', {
					...this.logContext,
					targetCount: discoveryTargets.length
				});
			} else {
				this.logger?.debugSync('Sending BACnet Who-Is broadcast', {
					...this.logContext,
					broadcastAddress,
					port,
					method: 'whoIs'
				});

				try {
					client.whoIs({
						lowLimit: deviceIdRange[0],
						highLimit: deviceIdRange[1],
						address: broadcastAddress ?? '255.255.255.255'
					});
					this.logger?.debugSync('Who-Is broadcast sent successfully', {
						...this.logContext,
						lowLimit: deviceIdRange[0],
						highLimit: deviceIdRange[1],
						broadcast: broadcastAddress
					});
				} catch (whoIsError) {
					this.logger?.errorSync('Failed to send Who-Is broadcast', whoIsError instanceof Error ? whoIsError : new Error(String(whoIsError)), {
						...this.logContext
					});
				}
			}

			await new Promise(resolve => setTimeout(resolve, timeout));

			this.logger?.debugSync(`Received ${devices.size} I-Am responses`, {
				...this.logContext,
				deviceCount: devices.size
			});

			for (const [deviceInstance, deviceInfo] of devices.entries()) {
				try {
					const fullAddress = deviceInfo.ipAddress;
					const objectName = await this.readProperty(
						client,
						fullAddress,
						{ type: 8, instance: deviceInstance },
						BacnetPropertyId.OBJECT_NAME
					);

					const vendorName = await this.readProperty(
						client,
						fullAddress,
						{ type: 8, instance: deviceInstance },
						BacnetPropertyId.VENDOR_NAME
					);

					const modelName = await this.readProperty(
						client,
						fullAddress,
						{ type: 8, instance: deviceInstance },
						BacnetPropertyId.MODEL_NAME
					);

					const description = await this.readProperty(
						client,
						fullAddress,
						{ type: 8, instance: deviceInstance },
						BacnetPropertyId.DESCRIPTION
					);

					// Update device info
					deviceInfo.objectName = this.asString(objectName);
					deviceInfo.vendorName = this.asString(vendorName);
					deviceInfo.modelName = this.asString(modelName);
					deviceInfo.description = this.asString(description);

				} catch (error) {
					devicePropertyReadFailures++;
					this.logger?.debugSync(`Failed to read BACnet device properties`, {
						...this.logContext,
						deviceInstance,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}

			for (const [deviceInstance, deviceInfo] of devices.entries()) {
				const fingerprint = this.generateFingerprint(
					deviceInfo.ipAddress,
					deviceInstance
				);

				const deviceName = deviceInfo.objectName || `bacnet_device_${deviceInstance}`;
				const normalized = deviceName
					.toLowerCase()
					.replace(/[^a-z0-9_]/g, '_')
					.replace(/^iotistica_+/, '')  // Remove all leading iotistica_ prefixes
					.replace(/^_+/, '');            // Remove any leading underscores
				const baseName = normalized || 'unknown';
				const nameWithPrefix = baseName.startsWith('iotistica_') ? baseName : `iotistica_${baseName}`;

				const instanceSuffix = `_${deviceInstance}`;
				const uniqueEndpointName = nameWithPrefix.endsWith(instanceSuffix)
					? nameWithPrefix
					: `${nameWithPrefix}${instanceSuffix}`;
				discovered.push({
					name: uniqueEndpointName,
					protocol: 'bacnet',
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
						discoveryMethod: useUnicast ? 'who_is_unicast' : 'who_is_broadcast'
					}
				});
			}

			// Reuse the client for validation.

			if (iAmReceivedCount > 0 || iAmIgnoredCount > 0 || devicePropertyReadFailures > 0) {
				this.logger?.debugSync('BACnet discovery summary', {
					...this.logContext,
					iAmReceivedCount,
					iAmIgnoredCount,
					devicePropertyReadFailures,
					discoveredCount: discovered.length
				});
			}

		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('BACnet discovery failed', err, {
				...this.logContext
			});
		}

		this.logger?.debugSync(`BACnet discovery complete - found ${discovered.length} devices`, {
			...this.logContext,
			deviceCount: discovered.length
		});

		return discovered;
	}

	/**
   * Phase 2: Validate device (read object list and properties)
   */
	async validate(device: DiscoveredDevice, timeout = 10000): Promise<ValidationResult> {
		this.logger?.debugSync('Validating BACnet device', {
			...this.logContext,
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
			const client = await this.getClient({ timeout });

			const deviceInstance = device.connection.deviceInstance;
			const ipAddress = device.connection.host;
			const fullAddress = ipAddress;
			let objects: BACnetValidatedObject[] = [];
			let readableObjects = 0;
			let objectReadFailures = 0;

			try {
				const objectList = await this.readProperty(
					client,
					fullAddress,
					{ type: 8, instance: deviceInstance },
					BacnetPropertyId.OBJECT_LIST,
					timeout
				);
				const objectsToRead = this.asObjectReferences(objectList).slice(0, 50);
				const concurrency = Math.min(this.validationConcurrency, Math.max(1, objectsToRead.length));
				const limit = pLimit(concurrency);

				this.logger?.debugSync(`Device has ${objectsToRead.length} objects`, {
					...this.logContext,
					deviceInstance,
					objectCount: objectsToRead.length,
					validationConcurrency: concurrency
				});

				const objectResults: Array<BACnetValidatedObject | null> = await Promise.all(
					objectsToRead.map((obj, index) =>
						limit(async () => {
							await this.wait((index % concurrency) * 20);

							try {
								const objectType = obj.type;
								const objectInstance = obj.instance;
								const objectTypeName = BACNET_OBJECT_TYPES[objectType] || `type-${objectType}`;

								const objectName = await this.readProperty(
									client,
									fullAddress,
									{ type: objectType, instance: objectInstance },
									BacnetPropertyId.OBJECT_NAME,
									timeout
								);

								let presentValue: unknown;
								if ([0, 1, 2, 3, 4, 5, 13, 14, 19].includes(objectType)) {
									presentValue = await this.readProperty(
										client,
										fullAddress,
										{ type: objectType, instance: objectInstance },
										BacnetPropertyId.PRESENT_VALUE,
										timeout
									);
								}

								let units: string | undefined;
								if ([0, 1, 2].includes(objectType)) {
									units = this.asString(await this.readProperty(
										client,
										fullAddress,
										{ type: objectType, instance: objectInstance },
										BacnetPropertyId.UNITS,
										timeout
									));
								}

								return {
									objectType: objectTypeName,
									objectInstance,
									objectName: this.asString(objectName) || `${objectTypeName}_${objectInstance}`,
									presentValue,
									units
								};
							} catch (error) {
								this.logger?.debugSync('Failed to read BACnet object properties', {
									...this.logContext,
									objectType: obj.type,
									objectInstance: obj.instance,
									error: error instanceof Error ? error.message : String(error)
								});
								return null;
							}
						})
					)
				);

				objects = objectResults.filter((obj): obj is BACnetValidatedObject => obj !== null);
				readableObjects = objects.length;
				objectReadFailures = objectResults.length - objects.length;

			} catch (error) {
				this.logger?.warnSync('Failed to read object list', {
					...this.logContext,
					deviceInstance,
					error: error instanceof Error ? error.message : String(error)
				});
			}

			device.dataPoints = objects
				.filter((obj: BACnetValidatedObject) => obj.presentValue !== undefined)
				.map((obj: BACnetValidatedObject) => ({
					name: obj.objectName.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
					objectType: obj.objectType,
					objectInstance: obj.objectInstance,
					presentValue: obj.presentValue,
					units: obj.units,
					propertyId: BacnetPropertyId.PRESENT_VALUE
				}));

			device.validated = true;
			device.validationData = validationResult;

			validationResult.capabilities = Array.from(
				new Set(objects.map((o: BACnetValidatedObject) => o.objectType))
			);

			validationResult.deviceInfo = {
				totalObjects: objects.length,
				analogInputs: objects.filter((o: BACnetValidatedObject) => o.objectType === 'analog-input').length,
				analogOutputs: objects.filter((o: BACnetValidatedObject) => o.objectType === 'analog-output').length,
				binaryInputs: objects.filter((o: BACnetValidatedObject) => o.objectType === 'binary-input').length,
				binaryOutputs: objects.filter((o: BACnetValidatedObject) => o.objectType === 'binary-output').length
			};

			// Keep the client alive for future operations.

			this.logger?.debugSync('BACnet device validation complete', {
				...this.logContext,
				deviceInstance,
				objectCount: objects.length,
				capabilities: validationResult.capabilities,
				readableObjects,
				objectReadFailures
			});

		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync(`BACnet validation failed for device ${device.connection.deviceInstance}`, err, {
				...this.logContext
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
				...this.logContext,
				note: 'Install with: npm install bacstack'
			});
			return false;
		}
	}

	/**
   * Helper: Read BACnet property with timeout
   */
	private async readProperty(
		client: BACnetClientLike,
		address: string,
		objectId: { type: number; instance: number },
		propertyId: number,
		timeout = 5000
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('Property read timeout'));
			}, timeout);

			client.readProperty(
				address,
				objectId,
				propertyId,
				(err: Error | null, value: BACnetReadPropertyValue) => {
					clearTimeout(timer);
					if (err) {
						reject(err);
					} else {
						const values = value?.values?.map((v: BACnetArrayElement) => v.value);
						resolve(values?.length === 1 ? values[0] : values);
					}
				}
			);
		});
	}
}
