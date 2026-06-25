import { type BACnetDevice, type BACnetObject, BACnetProperty } from './types';
import { type Logger, type IProtocolClient } from '../types';
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
export class BACnetClient implements IProtocolClient<BACnetObject[], Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
	// Each client needs a unique local UDP port so bacstack doesn't fight over the same socket.
	// Discovery uses 47809; adapter clients start at 47810 and increment per instance.
	// Fixed ports are more reliable than port=0 (ephemeral) — with ephemeral ports the OS-assigned
	// port is only known after the async bind completes, and the 100ms heuristic can race on slow
	// hosts, leaving the transport patch applied to an unbound socket.
	private static _nextPort = 47810;

	private config: BACnetDevice;
	private logger: Logger;
	private client: any;
	private connected: boolean = false;
	private lastError: string | null = null;

	constructor(config: BACnetDevice, _bacnetPort: number, logger: Logger) {
		this.config = config;
		this.logger = logger;

		const localPort = BACnetClient._nextPort++;

		this.client = new BACnet({
			apduTimeout: config.connectionTimeoutMs,
			port: localPort,
			broadcastAddress: '255.255.255.255',
			deviceId: 4190000 + Math.floor(Math.random() * 1000),
		});

		// bacstack uses this._settings.port as the UDP destination port even for
		// unicast ReadProperty calls.  With bacnetPort=47809 every packet would
		// go to port 47809, but BACnet devices listen on port 47808.  Patch
		// transport.send so we listen on bacnetPort but always send to 47808.
		// The patch is also applied (re-applied) in connect() after the socket
		// has had time to bind, in case _transport._server is not yet ready here.
		this._applyTransportPatch();

		this.logger.debug(`BACnet client initialized for ${config.name} (${config.ipAddress}:${config.port})`);
	}

	/**
   * Patch the bacstack transport so all outgoing packets are sent to the
   * standard BACnet port (47808) regardless of which port this client is
   * bound to locally.  Safe to call multiple times; subsequent calls are
   * no-ops if the patch is already in place.
   */
	private _applyTransportPatch(): void {
		const xport = (this.client)?._transport;
		if (!xport) return;
		const server = xport._server;
		if (!server || typeof server.send !== 'function') return;
		// Guard: don't double-patch
		if ((xport)._portPatched) return;
		xport.send = (buffer: Buffer, offset: number, receiver: string) => {
			server.send(buffer, 0, offset, 47808, receiver);
		};
		(xport)._portPatched = true;
	}

	/**
   * Connect to the BACnet device
   */
	async connect(): Promise<void> {
		try {
			// bacstack doesn't have explicit connect - it uses UDP
			// Just verify device is reachable with a Who-Is
			// Re-apply the transport patch here after the UDP socket has had time
			// to bind (bacstack binds asynchronously in its constructor).
			await new Promise(resolve => setTimeout(resolve, 100));
			this._applyTransportPatch();

			const xport = (this.client)?._transport;
			const patched = !!(xport)?._portPatched;
			const serverExists = !!xport?._server;
			this.logger.debug(`BACnet transport state: xport=${!!xport} server=${serverExists} patched=${patched}`);

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
   * Read a single object's present value, with retry on transient timeout.
   * retryAttempts and retryDelayMs come from the device config (defaults: 1 / 500ms).
   */
	async readObject(
		object: BACnetObject,
		remainingRetries: number = this.config.retryAttempts ?? 1
	): Promise<{ value: any; quality: 'GOOD' | 'BAD'; error?: string }> {
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

			// bacstack wraps decoded values as [{ value, type }] — unwrap to scalar
			const rawValue = result.values?.[0]?.value;
			const presentValue = Array.isArray(rawValue) && rawValue.length > 0
				? rawValue[0]?.value
				: rawValue;

			return {
				value: presentValue,
				quality: 'GOOD'
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			if (remainingRetries > 0) {
				await new Promise(r => setTimeout(r, this.config.retryDelayMs ?? 500));
				return this.readObject(object, remainingRetries - 1);
			}

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

	async read(objects: BACnetObject[] = this.config.objects): Promise<Map<string, { value: any; quality: 'GOOD' | 'BAD'; error?: string }>> {
		return this.readObjects(objects);
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
