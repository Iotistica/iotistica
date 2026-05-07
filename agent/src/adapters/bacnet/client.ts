import { type BACnetDevice, type BACnetObject, BACnetProperty } from './types';
import { type Logger } from '../types';
import { pLimit } from '../../lib/p-limit.js';
import BACnet from 'bacstack';

interface BACnetReadResult {
  objectId: {
    type: number;
    instance: number;
  };
  values: Array<{
    propertyIdentifier: number;
    value: any;
  }>;
}

/**
 * BACnet Client wrapper for bacstack library
 * Handles connection, reads, and error handling for a single device
 */
export class BACnetClient {
	private config: BACnetDevice;
	private logger: Logger;
	private client: any;
	private connected: boolean = false;
	private lastError: string | null = null;

	constructor(config: BACnetDevice, bacnetPort: number, logger: Logger) {
		this.config = config;
		this.logger = logger;

		// Initialize bacstack client
		this.client = new BACnet({
			apduTimeout: config.connectionTimeoutMs,
			port: bacnetPort,
			broadcastAddress: '255.255.255.255', // Not used for unicast
			deviceId: 4190000 + Math.floor(Math.random() * 1000), // Unique device ID per client
		});

		this.logger.debug(`BACnet client initialized for ${config.name} (${config.ipAddress}:${config.port})`);
	}

	/**
   * Connect to the BACnet device
   */
	async connect(): Promise<void> {
		try {
			// bacstack doesn't have explicit connect - it uses UDP
			// Just verify device is reachable with a Who-Is
			this.connected = true;
			this.lastError = null;
			this.logger.debug(`BACnet client connected to ${this.config.name}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.lastError = errorMessage;
			this.connected = false;
			throw new Error(`Failed to connect to ${this.config.name}: ${errorMessage}`);
		}
	}

	/**
   * Disconnect from the BACnet device
   */
	async disconnect(): Promise<void> {
		try {
			if (this.client) {
				this.client.close();
			}
			this.connected = false;
			this.logger.debug(`BACnet client disconnected from ${this.config.name}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.warn(`Error disconnecting from ${this.config.name}: ${errorMessage}`);
		}
	}

	/**
   * Read the BACnet Device object's objectName property (BACnet property 77).
   * Returns the device's self-reported name, or null if unavailable.
   * Device object type is 8; instance is the device's deviceInstance number.
   */
	async readDeviceName(): Promise<string | null> {
		if (!this.connected || !this.config.deviceInstance) {
			return null;
		}

		const DEVICE_OBJECT_TYPE = 8;  // BACnet Device object type
		const PROP_OBJECT_NAME = 77;   // BACnet objectName property

		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(null), this.config.connectionTimeoutMs);

			try {
				this.client.readProperty(
					this.config.ipAddress,
					{ type: DEVICE_OBJECT_TYPE, instance: this.config.deviceInstance },
					PROP_OBJECT_NAME,
					(err: Error | null, value: any) => {
						clearTimeout(timeout);
						if (err) {
							resolve(null);
							return;
						}
						// bacstack returns objectName as a CharacterString in values[0].value[0].value
						const name = value?.values?.[0]?.value?.[0]?.value;
						resolve(typeof name === 'string' && name.trim() ? name.trim() : null);
					}
				);
			} catch {
				clearTimeout(timeout);
				resolve(null);
			}
		});
	}

	/**
   * Read a single object's present value
   */
	async readObject(object: BACnetObject): Promise<{ value: any; quality: 'GOOD' | 'BAD'; error?: string }> {
		if (!this.connected) {
			return {
				value: null,
				quality: 'BAD',
				error: 'Not connected'
			};
		}

		try {
			// Map object type string to bacstack type number
			const objectTypeMap: Record<string, number> = {
				'analog-input': 0,
				'analog-output': 1,
				'analog-value': 2,
				'binary-input': 3,
				'binary-output': 4,
				'binary-value': 5,
				'multi-state-input': 13,
				'multi-state-output': 14,
				'multi-state-value': 19,
			};

			const objectTypeNum = objectTypeMap[object.objectType];
			if (objectTypeNum === undefined) {
				throw new Error(`Unknown object type: ${object.objectType}`);
			}

			const result = await new Promise<BACnetReadResult>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error('Read timeout'));
				}, this.config.connectionTimeoutMs);

				this.client.readProperty(
					this.config.ipAddress,
					{
						type: objectTypeNum,
						instance: object.objectInstance
					},
					object.propertyId || BACnetProperty.PRESENT_VALUE,
					(err: Error | null, value: BACnetReadResult) => {
						clearTimeout(timeout);
						if (err) {
							reject(err);
						} else {
							resolve(value);
						}
					}
				);
			});

			// Extract present value from response
			const presentValue = result.values?.[0]?.value;

			return {
				value: presentValue,
				quality: 'GOOD'
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.lastError = errorMessage;
			this.logger.warn(`Error reading ${object.name} from ${this.config.name}: ${errorMessage}`);

			return {
				value: null,
				quality: 'BAD',
				error: errorMessage
			};
		}
	}

	/**
   * Read multiple objects in batch (sequential for now, can optimize with ReadPropertyMultiple later)
   */
	async readObjects(objects: BACnetObject[]): Promise<Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
		const results = new Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>();

		// Use maxConcurrentReads to limit concurrency
		const limit = pLimit(this.config.maxConcurrentReads);

		const readPromises = objects.map(obj =>
			limit(async () => {
				const result = await this.readObject(obj);
				results.set(obj.name, result);
			})
		);

		await Promise.all(readPromises);
		return results;
	}

	/**
   * Get device name
   */
	getDeviceName(): string {
		return this.config.name;
	}

	/**
   * Get connection status
   */
	isConnected(): boolean {
		return this.connected;
	}

	/**
   * Get last error
   */
	getLastError(): string | null {
		return this.lastError;
	}
}
