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
import { createHash } from 'crypto';
import { LogComponents } from '../../logging/types';
import { BaseDiscovery } from '../base';
import { type DiscoveredDevice, type ValidationResult } from '../types';
import type { ConfigManager } from '../../core/config.js';

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
  safe?: boolean; // Default true - false for control registers that trigger actions
}

interface _ProfileMap {
  [profile: string]: { dataPoints: DataPoint[] };
}


export class ModbusDiscovery extends BaseDiscovery {
	private configManager?: ConfigManager;

	constructor(logger?: AgentLogger, configManager?: ConfigManager) {
		super('modbus', logger);
		this.configManager = configManager;
	}

	generateFingerprint(busId: string, slaveId: number, deviceIdValue?: string): string {
		const identity = deviceIdValue ? `${busId}:${slaveId}:${deviceIdValue}` : `${busId}:${slaveId}`;
		return createHash('sha256').update(`modbus:${identity}`).digest('hex').substring(0, 32);
	}

	/**
   * Phase 1: Fast slave ID scanning
   * Opens connection ONCE, cycles through all slave IDs
   */
	async discover(_options?: ModbusDiscoveryOptions): Promise<DiscoveredDevice[]> {

		// Get discovery targets from endpoints (those with slaveRange or slaveId)
		const discoveryTargets = this.configManager?.getDiscoveryTargets?.('modbus') || [];
    
		if (discoveryTargets.length === 0) {
			this.logger?.debugSync('No Modbus discovery targets configured (need slaveRange or slaveId)', {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});
			return [];
		}

		this.logger?.debugSync(`Starting Modbus discovery (${discoveryTargets.length} target(s))`, {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			targetCount: discoveryTargets.length
		});

		const allDiscovered: DiscoveredDevice[] = [];

		// Separate TCP and serial connections (TCP can be parallel, RTU must be sequential)
		const tcpConnections = discoveryTargets.filter((t: any) => t.connection?.type === 'tcp');
		const serialConnections = discoveryTargets.filter((t: any) => t.connection?.type === 'rtu');

		// Parallel TCP scanning (controlled concurrency to avoid overwhelming network)
		if (tcpConnections.length > 0) {
			this.logger?.debugSync(`Scanning ${tcpConnections.length} TCP targets (max 3 parallel)`, {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});

			const MAX_PARALLEL = 3;
			const chunks: typeof tcpConnections[] = [];
			for (let i = 0; i < tcpConnections.length; i += MAX_PARALLEL) {
				chunks.push(tcpConnections.slice(i, i + MAX_PARALLEL));
			}

			for (const chunk of chunks) {
				const results = await Promise.all(
					chunk.map(async (endpoint: any) => {
						// Determine slave ID range: slaveRange (multi-slave scan) or slaveId (single slave)
						let slaveIdRange: [number, number];
						if (endpoint.connection.slaveRange) {
							slaveIdRange = [endpoint.connection.slaveRange.start, endpoint.connection.slaveRange.end];
						} else if (endpoint.connection.slaveId !== undefined) {
							// Single slave: scan only that slave ID
							slaveIdRange = [endpoint.connection.slaveId, endpoint.connection.slaveId];
						} else {
							// Fallback: scan common range
							slaveIdRange = [1, 247];
						}

						const connOptions: ModbusDiscoveryOptions = {
							tcpHost: endpoint.connection.host,
							tcpPort: endpoint.connection.port || 502,
							timeout: endpoint.connection.timeout || 5000,
							slaveIdRange
						};

						// Discovery targets may have sample dataPoints to test read
						const dataPoints = endpoint.dataPoints || [];

						this.logger?.debugSync(`Scanning TCP target '${endpoint.name}' (${dataPoints.length} test data points)`, {
							component: LogComponents.discovery + "] [" + this.protocol as any,
							name: endpoint.name,
							host: endpoint.connection.host,
							port: endpoint.connection.port,
							slaveRange: `${slaveIdRange[0]}-${slaveIdRange[1]}`
						});

						return await this.discoverOnBus(connOptions, dataPoints, endpoint.name);
					})
				);

				results.forEach(discovered => allDiscovered.push(...discovered));
			}
		}

		// Sequential serial scanning (RTU bus requires sequential access)
		if (serialConnections.length > 0) {
			this.logger?.debugSync(`Scanning ${serialConnections.length} serial targets (sequential - shared bus)`, {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});

			for (const endpoint of serialConnections) {
				// Determine slave ID range: slaveRange (multi-slave scan) or slaveId (single slave)
				let slaveIdRange: [number, number];
				if (endpoint.connection.slaveRange) {
					slaveIdRange = [endpoint.connection.slaveRange.start, endpoint.connection.slaveRange.end];
				} else if (endpoint.connection.slaveId !== undefined) {
					// Single slave: scan only that slave ID
					slaveIdRange = [endpoint.connection.slaveId, endpoint.connection.slaveId];
				} else {
					// Fallback: scan common range
					slaveIdRange = [1, 247];
				}

				const connOptions: ModbusDiscoveryOptions = {
					serialPort: endpoint.connection.serialPort,
					baudRate: endpoint.connection.baudRate || 9600,
					timeout: endpoint.connection.timeout || 5000,
					slaveIdRange
				};

				// Discovery targets may have sample dataPoints to test read
				const dataPoints = endpoint.dataPoints || [];

				this.logger?.debugSync(`Scanning serial target '${endpoint.name}' (${dataPoints.length} test data points)`, {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					name: endpoint.name,
					port: endpoint.connection.serialPort,
					slaveRange: `${slaveIdRange[0]}-${slaveIdRange[1]}`
				});

				const discovered = await this.discoverOnBus(connOptions, dataPoints, endpoint.name);
				allDiscovered.push(...discovered);
			}
		}

		this.logger?.debugSync(`Modbus discovery complete: ${allDiscovered.length} devices across ${discoveryTargets.length} targets`, {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			totalDevices: allDiscovered.length,
			targetCount: discoveryTargets.length,
			tcpCount: tcpConnections.length,
			serialCount: serialConnections.length
		});

		return allDiscovered;
	}

	/**
   * Discovery helper: Scan slave IDs on a single Modbus connection
   * Extracted for reuse in both single and multi-connection modes
   */
	private async discoverOnBus(
		options: ModbusDiscoveryOptions,
		dataPoints: DataPoint[],
		connectionName?: string
	): Promise<DiscoveredDevice[]> {
    
		if (dataPoints.length === 0) {
			this.logger?.debugSync(`No data points in config`, {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});
		} else {
			this.logger?.debugSync(`Using ${dataPoints.length} data points`, {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});
		}

		const discovered: DiscoveredDevice[] = [];

		this.logger?.debugSync('Starting Modbus discovery on bus', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			connectionName
		});

		// Default options
		const slaveIdRange = options?.slaveIdRange || [1, 10];
		const timeout = options?.timeout || 2000;  // 2-second timeout per slave ID (100ms was too short)

		// Detect connection type
		const isSerial = !!options?.serialPort;
		const isTCP = !!options?.tcpHost;

		if (!isSerial && !isTCP) {
			this.logger?.warnSync('No Modbus connection specified', {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});
			return [];
		}

		// CRITICAL: Open connection ONCE for all slave IDs (bus-scoped)
		const connection = await this.openConnection(options);
    
		if (!connection?.isOpen) {
			this.logger?.warnSync('Failed to open Modbus connection', {
				component: LogComponents.discovery + "] [" + this.protocol as any
			});
			return [];
		}

		try {
			// Generate bus identifier for logging
			const busId = isSerial 
				? options.serialPort! 
				: `${options.tcpHost}:${options.tcpPort || 502}`;
      
			this.logger?.debugSync('Modbus connection established, scanning slave IDs', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				connection: connectionName,
				bus: busId,
				range: slaveIdRange,
				type: connection.type
			});

			// Scan slave IDs on same connection
			for (let slaveId = slaveIdRange[0]; slaveId <= slaveIdRange[1]; slaveId++) {
				try {
					const deviceInfo = await this.testSlaveId(connection, slaveId, timeout);

					if (deviceInfo) {
						// Generate bus identifier for unique fingerprinting
						const busId = isSerial
							? options.serialPort!
							: `${options.tcpHost}:${options.tcpPort || 502}`;
            
						// Generate cryptographic fingerprint (unique per bus + slave ID)
						// CRITICAL: Don't include deviceInfo.deviceId - it's unreliable (MEI timeouts)
						// Fingerprint must be stable across discovery runs regardless of MEI success
						const fingerprint = this.generateFingerprint(busId, slaveId);

						// Device naming: Use connection name if provided (multi-connection mode)
						const deviceName = connectionName 
							? `${connectionName}_slave_${slaveId}`
							: deviceInfo.name || `modbus_slave_${slaveId}`;

						discovered.push({
							name: deviceName,
							protocol: 'modbus' as const,
							fingerprint,
							connection: isSerial
								? {
									type: 'serial',
									port: options.serialPort,
									baudRate: options?.baudRate || 9600,
									slaveId
								}
								: {
									type: 'tcp',
									host: options.tcpHost,
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
								discoveryMethod: deviceInfo.method,
								connectionName  // Track connection association
							}
						});

						this.logger?.debugSync(`Discovered Modbus slave ${slaveId}`, {
							component: LogComponents.discovery + "] [" + this.protocol as any,
							phase: 'discovery',
							method: deviceInfo.method,
							connectionName
						});
					}
				} catch (error) {
					this.logger?.warnSync(`No response from slave ${slaveId} (offline or not configured)`, {
						component: LogComponents.discovery + "] [" + this.protocol as any,
						slaveId,
						error: (error as Error).message
					});
				}
			}
		} finally {
			// CRITICAL: Always close connection
			await this.closeConnection(connection);
		}

		this.logger?.debugSync(`Modbus discovery complete on bus: ${discovered.length} devices`, {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			deviceCount: discovered.length,
			connectionName
		});

		return discovered;
	}

	/**
   * Phase 2: Validate device and profile hypothesis
   * Tests if configured profile data points are readable
   */
	async validate(device: DiscoveredDevice, timeout = 2000): Promise<ValidationResult> {
		this.logger?.debugSync('Validating Modbus device and profile config', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			slaveId: device.metadata?.slaveId,
			phase: 'validation',
			dataPointsCount: device.dataPoints?.length || 0
		});

		// Try to get MEI device identification for cross-reference
		let meiVendor: string | undefined;
		let meiModel: string | undefined;

		const dataPoints = device.dataPoints || [];
    
		if (dataPoints.length === 0) {
			return {
				dataPointValidation: {
					result: 'unknown',
					state: 'unknown',
					responseConfidence: 0,
					dataConfidence: 0,
					readableCount: 0,
					errorCount: 0,
					zeroCount: 0,
					totalPoints: 0,
					details: 'No profile data points configured'
				}
			};
		}

		let readableCount = 0;
		let errorCount = 0;
		let zeroCount = 0;
		const total = dataPoints.length;

		// Filter to safe data points only (avoid control registers)
		// Industrial safety: never probe registers that might trigger actions
		const safePoints = dataPoints.filter(p => p.safe !== false);
    
		if (safePoints.length === 0) {
			this.logger?.warnSync('No safe data points to validate', {
				component: LogComponents.discovery + "] [" + this.protocol as any,
				slaveId: device.metadata?.slaveId,
				totalPoints: total,
				note: 'All data points marked unsafe or no safe flag set'
			});
			return {
				dataPointValidation: {
					result: 'unknown',
					state: 'unknown',
					responseConfidence: 0,
					dataConfidence: 0,
					readableCount: 0,
					errorCount: 0,
					zeroCount: 0,
					totalPoints: total,
					details: 'No safe data points available for validation'
				}
			};
		}

		// Sample first few safe data points for speed
		const sampleSize = Math.min(5, safePoints.length);
		const sampled = safePoints.slice(0, sampleSize);

		try {
			await this.withValidationClient(device, timeout, async (client) => {
				// Try MEI device identification first (provides vendor/model for cross-reference)
				try {
					const meiResult = await Promise.race([
						client.readDeviceIdentification(1),
						new Promise((_, reject) => setTimeout(() => reject(new Error('MEI timeout')), 500))
					]);
					if (meiResult?.Basic?.VendorName) {
						meiVendor = meiResult.Basic.VendorName.toString();
						meiModel = meiResult.Basic?.ProductName?.toString();
					}
				} catch {
					// MEI not supported - not an error
				}

				for (const point of sampled) {
					try {
						// Only test holding registers for now (most common)
						if (point.type === 'holding') {
							// Normalize address (40001-style → zero-based)
							const addr = this.normalizeAddress(point.address);
							const result = await client.readHoldingRegisters(addr, 1);
              
							if (result?.data?.length) {
								readableCount++;
								if (result.data[0] === 0) {
									zeroCount++;
								}
							} else {
								errorCount++;
							}
						}
					} catch (error) {
						errorCount++;
						this.logger?.debugSync(`Failed to read ${point.name} at address ${point.address}`, {
							component: LogComponents.discovery + "] [" + this.protocol as any,
							error: (error as Error).message
						});
					}
				}
			});
		} catch (error) {
			// Connection failed
			return {
				dataPointValidation: {
					result: 'unknown',
					state: 'unknown',
					responseConfidence: 0,
					dataConfidence: 0,
					readableCount: 0,
					errorCount: 0,
					zeroCount: 0,
					totalPoints: dataPoints.length,
					details: `Failed to open connection: ${(error as Error).message}`
				}
			};
		}

		// Calculate ratios for pattern analysis
		const readableRatio = readableCount / sampleSize;
		const errorRatio = errorCount / sampleSize;
		const zeroRatio = readableCount > 0 ? zeroCount / readableCount : 0;

		// Determine result based on error pattern (NOT zero values)
		let result: 'config_match' | 'config_mismatch' | 'degraded' | 'unknown';
		let state: 'idle' | 'active' | 'unknown';
		let responseConfidence: number;  // Addresses respond correctly
		let dataConfidence: number;      // Data is meaningful (not all zeros)
		let details: string;
		let guidance: string | undefined;

		// Determine device state from zero pattern
		if (readableCount === 0) {
			state = 'unknown';
		} else if (zeroRatio === 1.0) {
			state = 'idle';  // All zeros - device idle, startup, or devices at rest
		} else if (zeroRatio < 0.2) {
			state = 'active';  // <20% zeros - device actively running
		} else {
			state = 'active';  // Some variance - device is active
		}

		if (errorRatio > 0.8) {
			// STRONG INDICATOR: Most addresses don't respond - likely wrong data point config
			result = 'config_mismatch';
			responseConfidence = 1 - errorRatio;  // Low - addresses don't work
			dataConfidence = 0;  // No meaningful data
			details = `${errorCount}/${sampleSize} addresses unreadable - likely wrong data point config`;
			guidance = meiVendor 
				? `Device reports vendor '${meiVendor}' via MEI - verify configured data points match device`
				: 'Check data point configuration in dashboard';
		} else if (readableRatio > 0.7) {
			// Addresses respond - data point config is likely correct
			responseConfidence = readableRatio;  // High - addresses work
			dataConfidence = 1 - zeroRatio;      // 0.0 for all zeros, 1.0 for all variance
			result = 'config_match';
      
			if (zeroRatio === 1.0) {
				// All zeros - common in idle/startup, but note it
				details = `${readableCount}/${sampleSize} addresses readable (all zeros)`;
				if (meiVendor) {
					guidance = `Device idle or at startup. MEI reports: ${meiVendor}${meiModel ? ` ${meiModel}` : ''}`;
				} else {
					guidance = 'All values zero - device may be idle, at startup, or verify data point config';
				}
			} else if (dataConfidence > 0.5) {
				// Good variance - strong match
				details = `${readableCount}/${sampleSize} addresses readable with good variance`;
				if (meiVendor) {
					guidance = `Strong match. Device: ${meiVendor}${meiModel ? ` ${meiModel}` : ''}`;
				}
			} else {
				// Some variance - acceptable
				details = `${readableCount}/${sampleSize} addresses readable with limited variance`;
			}
		} else {
			// Mixed results - some work, some don't
			result = 'degraded';
			responseConfidence = readableRatio;  // Partial
			dataConfidence = 1 - zeroRatio;      // Based on variance
			details = `Mixed results: ${readableCount} readable, ${errorCount} errors`;
			guidance = 'Partial address accessibility - wrong model variant or bus issues';
		}

		this.logger?.debugSync('Data point configuration validation complete', {
			component: LogComponents.discovery + "] [" + this.protocol as any,
			slaveId: device.metadata?.slaveId,
			result,
			state,  // idle | active | unknown
			responseConfidence: responseConfidence.toFixed(2),
			dataConfidence: dataConfidence.toFixed(2),
			readableRatio: readableRatio.toFixed(2),
			errorRatio: errorRatio.toFixed(2),
			zeroRatio: zeroRatio.toFixed(2),
			readableCount,
			errorCount,
			zeroCount,
			totalSampled: sampleSize,
			guidance,
			meiVendor,
			meiModel
		});

		return {
			dataPointValidation: {
				result,
				state,
				responseConfidence,
				dataConfidence,
				readableCount,
				errorCount,
				zeroCount,
				totalPoints: total,
				details,
				guidance,
				meiVendor,
				meiModel
			}
		};
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
   * Execute validation logic with a dedicated client connection
   * Avoids corrupting discovery state and ensures proper cleanup
   */
	private async withValidationClient(
		device: DiscoveredDevice,
		timeout: number,
		fn: (client: any) => Promise<void>
	): Promise<void> {
		const { default: ModbusRTU } = await import('modbus-serial') as any;
		const client = new ModbusRTU();

		try {
			// Connect based on device connection type
			if (device.connection.type === 'serial') {
				await client.connectRTUBuffered(device.connection.port, {
					baudRate: device.connection.baudRate || 9600,
					dataBits: 8,
					stopBits: 1,
					parity: 'none'
				});
			} else {
				await client.connectTCP(device.connection.host, {
					port: device.connection.port || 502
				});
			}

			// Configure client for this specific slave
			client.setID(device.metadata?.slaveId || 1);
			client.setTimeout(timeout);

			// Execute validation logic
			await fn(client);
		} finally {
			// Always cleanup, even on error
			try {
				client.close();
			} catch (closeError) {
				this.logger?.debugSync('Error closing validation client', {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					error: (closeError as Error).message
				});
			}
		}
	}

	/**
   * Normalize Modbus address notation
   * 
   * Vendor maps often use 40001-style notation (1-based with offset),
   * but modbus-serial expects zero-based offsets.
   * 
   * Examples:
   *   40001 → 0 (holding register 0)
   *   40100 → 99 (holding register 99)
   *   0 → 0 (already zero-based)
   *   99 → 99 (already zero-based)
   */
	private normalizeAddress(address: number): number {
		// Holding registers: 40001-49999 → 0-9998
		if (address >= 40001 && address <= 49999) {
			return address - 40001;
		}
		// Input registers: 30001-39999 → 0-9998
		if (address >= 30001 && address <= 39999) {
			return address - 30001;
		}
		// Already zero-based or other types
		return address;
	}

	/**
   * Open Modbus connection ONCE for entire scan
   * Industrial best practice: reuse connection across slave IDs
   * 
   * Returns connection object (bus-scoped, not shared)
   */
	private async openConnection(options?: ModbusDiscoveryOptions): Promise<ModbusConnection | undefined> {
		try {
			// Dynamic import of modbus-serial (default export)
			// Note: Using 'any' because TypeScript has issues with dynamic import constructors
			const { default: ModbusRTU } = await import('modbus-serial') as any;
			const client = new ModbusRTU();

			const isSerial = !!options?.serialPort;
			const timeout = options?.timeout || 100;

			if (isSerial) {
				// Serial (RTU) connection
				await client.connectRTUBuffered(options.serialPort!, {
					baudRate: options?.baudRate || 9600,
					dataBits: 8,
					stopBits: 1,
					parity: 'none'
				});

				this.logger?.debugSync('Opened Modbus RTU connection', {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					phase: 'discovery',
					port: options.serialPort,
					baudRate: options?.baudRate || 9600
				});

				// Set timeout
				client.setTimeout(timeout);
        
				return {
					type: 'serial',
					client,
					isOpen: true
				};
			} else {
				// TCP connection
				await client.connectTCP(options!.tcpHost!, {
					port: options?.tcpPort || 502
				});

				// Set timeout
				client.setTimeout(timeout);
        
				return {
					type: 'tcp',
					client,
					isOpen: true
				};
			}
		} catch (error) {
			this.logger?.errorSync(
				'Failed to open Modbus connection',
        error as Error,
        { component: LogComponents.agent }
			);
			return undefined;
		}
	}

	/**
   * Close Modbus connection after scan
   */
	private async closeConnection(connection?: ModbusConnection): Promise<void> {
		if (connection?.isOpen) {
			try {
				// Wrap callback-based close() in Promise to await completion
				// This prevents closure accumulation in survivor space
				await new Promise<void>((resolve, reject) => {
					connection.client.close((err?: Error) => {
						if (err) {
							reject(err);
						} else {
							this.logger?.debugSync('Closed Modbus connection', {
								component: LogComponents.discovery + "] [" + this.protocol as any,
								phase: 'discovery',
								type: connection?.type
							});
							resolve();
						}
					});
				});
			} catch (error) {
				this.logger?.warnSync('Error closing Modbus connection', {
					component: LogComponents.discovery + "] [" + this.protocol as any,
					error: (error as Error).message
				});
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
		connection: ModbusConnection,
		slaveId: number,
		timeout: number
	): Promise<{ name?: string; method: string; deviceId?: string } | null> {

		if (!connection?.isOpen) return null;
		const client = connection.client;

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
				{ component: LogComponents.discovery + "] [" + this.protocol as any }
			);
			return null;
		});

		if (meiResult?.Basic?.VendorName) {
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
				// Don't include register value in deviceId - it changes dynamically!
				// Only use slave ID for fingerprint stability
				return {
					method: "register_read"
					// deviceId intentionally omitted - fingerprint uses only slaveId
				};
			}

			return null;
		} catch (err: any) {
			this.logger?.debugSync(
				`Slave ${slaveId}: no response on fallback read: ${String(err?.message || err)}`,
				{ component: LogComponents.discovery + "] [" + this.protocol as any }
			);
			return null;
		}
	}

}

