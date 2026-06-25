import ModbusRTU from 'modbus-serial';
import {
	type ModbusDevice,
	type ModbusRegister,
	ModbusConnectionType,
	ModbusFunctionCode,
	ModbusDataType,
	ByteOrder,
	Endianness
} from './types';
import { type DeviceDataPoint, type Logger, type IProtocolClient } from '../types.js';

/**
 * Modbus Client wrapper that handles different connection types and data reading
 */
export class ModbusClient implements IProtocolClient<void, DeviceDataPoint[]> {
	private client: ModbusRTU;
	private device: ModbusDevice;
	private logger: Logger;
	private connected = false;
	private reconnectTimer?: NodeJS.Timeout;
  
	// Concurrency control: modbus-serial does NOT support concurrent requests
	// Multiple simultaneous reads will corrupt frames and return bad data
	private queue: Promise<any> = Promise.resolve();
  
	// Generation counter to discard stale results after client reset
	// Prevents out-of-order state updates when mid-flight requests resolve after forceResetClient()
	private generation = 0;
  
	// Batch optimization constants
	private readonly MAX_BATCH_SIZE = 125; // Modbus protocol limit
	private readonly GAP_TOLERANCE: number; // Configurable gap tolerance (default: 2)
  
	// Precomputed batches (computed once, reused every poll)
	private precomputedBatches: Map<number, any[][]> = new Map();

	private readonly stableDeviceId: string;
  
	// Exponential backoff for reconnection attempts
	private currentRetryDelay: number;
	private readonly MIN_RETRY_DELAY = 5000;   // Start at 5s
	private readonly MAX_RETRY_DELAY = 60000;  // Cap at 60s
	private consecutiveFailures = 0;
  
	// Health tracking
	private lastSuccessfulRead = Date.now(); // Last successful register read
	private lastConnectionSuccess = Date.now(); // Last successful connection

	// Event handlers bound in constructor (NOT anonymous lambdas)
	// CRITICAL: Prevents strong references that leak when client is replaced
	private errorHandler: (error: unknown) => void;
	private closeHandler: () => void;

	constructor(device: ModbusDevice, logger: Logger) {
		this.device = device;
		this.logger = logger;
		this.client = new ModbusRTU();
		this.currentRetryDelay = this.MIN_RETRY_DELAY;
		this.stableDeviceId = this.buildStableDeviceId();
    
		// Initialize gap tolerance (configurable per device, default: 2)
		this.GAP_TOLERANCE = (device as any).gapTolerance ?? 2;
    
		// Bind event handlers to instance (allows proper cleanup)
		this.errorHandler = this.handleError.bind(this);
		this.closeHandler = this.handleClose.bind(this);
    
		this.setupErrorHandlers();
    
		// Precompute register batches (do this once, reuse every poll)
		this.precomputeBatches();
	}

	private buildStableDeviceId(): string {
		const slaveId = this.device.slaveId;
		const connection = this.device.connection;

		if (connection.type === ModbusConnectionType.TCP) {
			const host = connection.host || 'unknown-host';
			const port = connection.port || 502;
			return `modbus:tcp:${host}:${port}:slave:${slaveId}`;
		}

		const serialPort = connection.serialPort || 'unknown-port';
		return `modbus:serial:${serialPort}:slave:${slaveId}`;
	}
  
	/**
   * Handle socket error event
   * Bound in constructor to allow proper removeListener() cleanup
   */
	private handleError(error: unknown): void {
		const errorMessage = this.extractErrorMessage(error);
		this.logger.error(
			`[RECOVERY] Socket error for device ${this.device.name}: ${errorMessage}`
		);
		// Note: client.isOpen will be false after error, this.connected is redundant
		this.connected = false;
		this.consecutiveFailures++; // Explicit failure count for error event
		this.logger.debug(
			`[RECOVERY] Socket error, client.isOpen=${this.client.isOpen}, scheduling reconnect (failures: ${this.consecutiveFailures})`
		);
		this.scheduleReconnect();
	}
  
	/**
   * Handle socket close event
   * Bound in constructor to allow proper removeListener() cleanup
   */
	private handleClose(): void {
		this.logger.debug(
			`[RECOVERY] Socket closed for device ${this.device.name}`
		);
		// Note: client.isOpen will be false after close, this.connected is redundant
		this.connected = false;
		this.consecutiveFailures++; // Explicit failure count for close event
		this.logger.debug(
			`[RECOVERY] Socket closed, client.isOpen=${this.client.isOpen}, scheduling reconnect (failures: ${this.consecutiveFailures})`
		);
		this.scheduleReconnect();
	}
  
	/**
   * Mutex lock for serializing Modbus requests
   * CRITICAL: modbus-serial library does not support concurrent requests
   * Without this, concurrent reads will corrupt frames and return bad data
   */
	private async lock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {}); // Prevent unhandled rejection
		return result;
	}
  
	/**
   * Wrap a promise with an external timeout
   * Needed because modbus-serial sometimes hangs indefinitely on serial port issues
   */
	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
		let timeoutHandle: NodeJS.Timeout;
    
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new Error(`Operation '${operation}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
    
		try {
			const result = await Promise.race([promise, timeoutPromise]);
			clearTimeout(timeoutHandle!);
			return result;
		} catch (error) {
			clearTimeout(timeoutHandle!);
			throw error;
		}
	}

	/**
   * Cleanup event listeners from current client instance
   * CRITICAL: Prevents memory leak from accumulated event listeners during reconnections
   * Each reconnection adds 2 new listeners (error + close), but old listeners remain
   * attached to the event emitter, preventing garbage collection of old client instances
   */
	private cleanupEventListeners(): void {
		if (!this.client) {
			return;
		}

		try {
			// STEP 1: Close client connection first (breaks socket references)
			if (this.client.isOpen) {
				this.client.close(() => {
					// Callback intentionally empty - we're destroying this instance
				});
			}

			// STEP 2: Remove event listeners (breaks EventEmitter references)
			// modbus-serial extends EventEmitter, but TypeScript doesn't expose the methods
			// Use type assertion to access EventEmitter methods
			// CRITICAL: Use off() instead of removeAllListeners() to avoid removing
			// modbus-serial's internal listeners (which could break internal state tracking)
			const emitter = this.client as any;
			if (typeof emitter.off === 'function') {
				emitter.off('error', this.errorHandler);
				emitter.off('close', this.closeHandler);
				this.logger.debug(`Closed connection and removed event listeners for ${this.device.name}`);
			} else if (typeof emitter.removeListener === 'function') {
				// Fallback for older Node/EventEmitter implementations
				emitter.removeListener('error', this.errorHandler);
				emitter.removeListener('close', this.closeHandler);
				this.logger.debug(`Closed connection and removed event listeners via removeListener for ${this.device.name}`);
			} else {
				// Fallback: Log warning if neither off() nor removeListener() are available
				this.logger.warn(
					`EventEmitter cleanup API not available on modbus-serial client for ${this.device.name}. ` +
          `Event listeners may accumulate (memory leak risk).`
				);
			}

			// Instrumentation: log handler counts after cleanup
			if (typeof emitter.listenerCount === 'function') {
				const errCount = emitter.listenerCount('error');
				const closeCount = emitter.listenerCount('close');
				this.logger.debug(
					`[RECOVERY] Handler counts after cleanup for ${this.device.name}: error=${errCount}, close=${closeCount}`
				);
			}
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			this.logger.debug(`Error during client cleanup: ${errorMessage}`);
		}
	}

	/**
   * Force reset the Modbus client instance
   * CRITICAL: modbus-serial does not recover cleanly on the same client instance
   * after connection failures. We must destroy and recreate the client completely.
   */
	private async forceResetClient(): Promise<void> {
		this.logger.debug(`Force resetting Modbus client for device ${this.device.name}`);
    
		// CRITICAL: Clear any pending reconnect timer to prevent timer leak
		// Leaked timers hold references to closures, preventing GC of old client instances
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
			this.logger.debug(`Cleared reconnect timer for ${this.device.name}`);
		}

		// CRITICAL: Close connection and remove event listeners BEFORE creating new instance
		// This prevents memory leak from accumulated listeners (2 per reconnection)
		// Without this, 100 reconnections = 200 leaked listeners + 100 leaked client instances (~40-60 MB)
		this.cleanupEventListeners();

		// CRITICAL: Reset the queue to break promise chain that references old client
		// In-flight reads may still reference old client/closures until they resolve/timeout
		this.queue = Promise.resolve();
    
		// Increment generation to discard any stale in-flight requests that resolve later
		// This prevents out-of-order metrics/logs when requests complete after reset
		this.generation++;
		this.logger.debug(`Incremented generation to ${this.generation} for ${this.device.name}`);

		// CRITICAL: discard client instance completely
		// This removes poisoned socket state and broken serial port handles
		this.logger.debug(`Creating new ModbusRTU instance for ${this.device.name}`);
		this.client = new ModbusRTU();
		this.setupErrorHandlers();
		this.logger.debug(`Client reset complete for ${this.device.name}`);
	}

	/**
   * Connect to the Modbus device
   */
	async connect(): Promise<void> {
		try {
			this.logger.debug(
				`Connecting to Modbus device: ${this.device.name} (${this.device.connection.type}://${this.device.connection.host || this.device.connection.serialPort})`
			);
      
			const { connection } = this.device;
      
			switch (connection.type) {
				case ModbusConnectionType.TCP:
					if (!connection.host) {
						throw new Error('TCP connection requires host');
					}
					await this.client.connectTCP(connection.host, { port: connection.port });

					break;
          
				case ModbusConnectionType.RTU:
					if (!connection.serialPort) {
						throw new Error('RTU connection requires serialPort');
					}
					await this.client.connectRTUBuffered(connection.serialPort, {
						baudRate: connection.baudRate,
						dataBits: connection.dataBits,
						stopBits: connection.stopBits,
						parity: connection.parity
					});
					break;
          
				case ModbusConnectionType.ASCII:
					if (!connection.serialPort) {
						throw new Error('ASCII connection requires serialPort');
					}
					await this.client.connectAsciiSerial(connection.serialPort, {
						baudRate: connection.baudRate,
						dataBits: connection.dataBits,
						stopBits: connection.stopBits,
						parity: connection.parity
					});
					break;
          
				default:
					throw new Error(`Unsupported connection type: ${connection.type}`);
			}

			// Set slave ID
			this.client.setID(this.device.slaveId);
      
			// Set timeout (default 5000ms if not specified)
			const timeout = connection.timeout ?? 5000;
			this.client.setTimeout(timeout);
      
			this.connected = true;
      
			// CRITICAL: Clear reconnect timer on successful connection
			// Prevents timer leak if connection succeeds before scheduled reconnection
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
				this.logger.debug(`Cleared reconnect timer after successful connection to ${this.device.name}`);
			}
      
			// Reset backoff on successful connection
			this.currentRetryDelay = this.MIN_RETRY_DELAY;
			this.consecutiveFailures = 0;
			this.lastConnectionSuccess = Date.now();
      
			this.logger.debug(
				`[RECOVERY] Connected to ${this.device.name} (slave ${this.device.slaveId}, timeout ${timeout}ms, client.isOpen=${this.client.isOpen})`
			);

			// Log successful connection with register info
			this.logger.info(
				`Connected to device: ${this.device.name} | Registers: ${this.device.registers.length} | ` +
        `Function codes: ${Array.from(this.precomputedBatches.keys()).join(',')} | ` +
        `Batches: ${Array.from(this.precomputedBatches.values()).flat().length}`
			);
      
		} catch (error) {
			this.connected = false;
			const errorMessage = this.extractErrorMessage(error);
			this.logger.error(`Failed to connect to Modbus device ${this.device.name}: ${errorMessage}`);
			throw error;
		}
	}

	/**
   * Disconnect from the Modbus device
   */
	async disconnect(): Promise<void> {
		try {
			// Clear reconnect timer
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
				this.logger.debug(`Cleared reconnect timer during disconnect for ${this.device.name}`);
			}
      
			// Cleanup event listeners to prevent memory leak
			// This also closes the client connection
			this.cleanupEventListeners();
      
			this.connected = false;
			this.logger.debug(`Disconnected from Modbus device: ${this.device.name}`);
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			this.logger.error(`Error disconnecting from Modbus device ${this.device.name}: ${errorMessage}`);
		}
	}

	/**
   * Read all configured registers and return device data points
   * Optimizes by batching contiguous register reads when possible
   */
	async readAllRegisters(): Promise<DeviceDataPoint[]> {
		if (!this.isConnected()) {
			// Device not connected - trigger reconnect and return BAD quality for this iteration
			// Next poll cycle will likely succeed since reconnect will be in progress
			this.logger.debug(
				`[RECOVERY] readAllRegisters: Device ${this.device.name} not connected (client.isOpen=${this.client.isOpen}), triggering reconnect`
			);
			await this.tryEnsureConnected();
			return this.createBadQualityDataPoints('DEVICE_OFFLINE');
		}

		this.logger.debug(
			`[RECOVERY] readAllRegisters: Device ${this.device.name} connected (client.isOpen=${this.client.isOpen}), proceeding with reads`
		);

		const pollStart = Date.now();
		const dataPoints: DeviceDataPoint[] = [];
		const timestamp = new Date().toISOString();
    
		// Capture generation at start of poll to detect mid-poll client resets
		const generation = this.generation;

		// Use precomputed batches (computed once in constructor)
		for (const [_functionCode, batches] of this.precomputedBatches) {
      
			for (const batch of batches) {
				if (batch.length === 1) {
					// Single register - read individually
					const register = batch[0];
					try {
						const value = await this.readRegisterWithRetry(register);
            
						// Track successful read
						this.lastSuccessfulRead = Date.now();
						if (this.consecutiveFailures > 0) {
							this.logger.debug(
								`[RECOVERY] Device ${this.device.name} recovered! Read succeeded after ${this.consecutiveFailures} failures`
							);
						}
						this.consecutiveFailures = 0; // Reset failure counter on success
            
						// Log successful individual read
						this.logger.debug(
							`[MODBUS] Device ${this.device.name} read ${register.name}: ${value} ${register.unit || ''}`
						);
            
						dataPoints.push({
							deviceName: this.device.name,
							deviceId: this.stableDeviceId,
							metric: register.name,
							value: value,
							unit: register.unit || '',
							timestamp: timestamp,
							quality: 'GOOD',
							protocol: 'modbus'
						});
					} catch (error) {
						dataPoints.push(this.createBadDataPoint(register, timestamp, error));
					}
				} else {
					// Batch read - multiple contiguous registers
					try {
						// Use retry-enabled batch read (handles DEVICE_BUSY/ACKNOWLEDGE)
						const batchResults = await this.readRegisterBatchWithRetry(batch);
            
						// Track successful batch read
						this.lastSuccessfulRead = Date.now();
						this.consecutiveFailures = 0; // Reset failure counter on success
            
						// Log batch read summary
						const batchSummary = batchResults
							.map(r => `${r.register.name}=${r.value}${r.register.unit ? ' ' + r.register.unit : ''}`)
							.join(', ');
						this.logger.debug(
							`[MODBUS BATCH] Device ${this.device.name}: ${batchResults.length} registers read | ${batchSummary}`
						);
            
						for (const result of batchResults) {
							dataPoints.push({
								deviceName: this.device.name,
								deviceId: this.stableDeviceId,
								metric: result.register.name,
								value: result.value,
								unit: result.register.unit || '',
								timestamp: timestamp,
								quality: 'GOOD',
								protocol: 'modbus'
							});
						}
					} catch (error) {
						// Batch read failed - use smart binary-search fallback
						// This splits batch in half recursively instead of reading all individually
						this.logger.warn(`Batch read failed, using smart fallback: ${error}`);
            
						const fallbackResults = await this.readBatchSmartFallback(batch, timestamp);
						dataPoints.push(...fallbackResults);
					}
				}
			}
		}

		// Check if client was reset during this poll (generation changed)
		// If so, discard results to prevent out-of-order state updates
		if (generation !== this.generation) {
			this.logger.debug(
				`[RACE] Discarding stale poll results for ${this.device.name} (gen ${generation} -> ${this.generation})`
			);
			return this.createBadQualityDataPoints('CLIENT_RESET_DURING_POLL');
		}
    
		const pollTime = Date.now() - pollStart;
    
		// Count GOOD vs BAD data points
		const goodCount = dataPoints.filter(dp => dp.quality === 'GOOD').length;
		const badCount = dataPoints.filter(dp => dp.quality === 'BAD').length;
    
		// Log poll summary
		if (goodCount > 0 || badCount > 0) {
			const statusEmoji = badCount === 0 ? '✓' : badCount === dataPoints.length ? '✗' : '⚠';
			this.logger.debug(
				`[MODBUS POLL] Device ${this.device.name}: ${statusEmoji} ${goodCount} good, ${badCount} bad (${pollTime}ms)`
			);
		}
    
		this.logger.debug(
			`[PERF] ${this.device.name} poll completed in ${pollTime}ms (${dataPoints.length} data points, ${this.precomputedBatches.size} function codes)`
		);

		return dataPoints;
	}

	async read(): Promise<DeviceDataPoint[]> {
		return this.readAllRegisters();
	}

	async writeRegister(registerName: string, value: number | boolean | string): Promise<void> {
		const register = this.device.registers.find((r) => r.name === registerName);
		if (!register) {
			throw new Error(`Register not found: ${registerName}`);
		}

		if (!this.isConnected()) {
			throw new Error(`Device ${this.device.name} is not connected`);
		}

		const timeout = this.device.connection.timeout || 5000;

		try {
			await this.withTimeout(
				this.lock(async () => {
					await this.writeRawRegister(register, value);
				}),
				timeout,
				`write register ${registerName}`
			);
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			this.logger.error(
				`Failed to write register ${registerName} on device ${this.device.name}: ${errorMessage}`
			);
			throw error;
		}
	}
  
	/**
   * Precompute register batches once (called in constructor)
   * Registers rarely change, so compute batches once and reuse every poll
   * Performance: Eliminates sorting/grouping overhead on every poll cycle
   */
	private precomputeBatches(): void {
		const registersByFunction = this.groupRegistersByFunction();
    
		for (const [functionCode, registers] of Object.entries(registersByFunction)) {
			const batches = this.optimizeBatches(registers);
			this.precomputedBatches.set(Number(functionCode), batches);
		}
    
		this.logger.debug(
			`[BATCH PRECOMPUTE] Device ${this.device.name}: Precomputed batches for ${this.precomputedBatches.size} function codes`
		);
	}
  
	/**
   * Group registers by function code
   */
	private groupRegistersByFunction(): Record<number, any[]> {
		const groups: Record<number, any[]> = {};
    
		for (const register of this.device.registers) {
			const fc = register.functionCode;
			if (!groups[fc]) {
				groups[fc] = [];
			}
			groups[fc].push(register);
		}
    
		return groups;
	}
  
	/**
   * Optimize register reads by batching contiguous addresses
   * Groups registers that can be read in a single request
   * 
   * Performance Impact:
   * - 10 individual reads: ~500ms (50ms each)
   * - 1 batched read: ~50ms (10x faster!)
   */
	private optimizeBatches(registers: any[]): any[][] {
		if (registers.length === 0) return [];
    
		// Sort by address
		const sorted = [...registers].sort((a, b) => a.address - b.address);
    
		const batches: any[][] = [];
		let currentBatch: any[] = [sorted[0]];
		let currentEnd = sorted[0].address + (sorted[0].count || 1);
    
		for (let i = 1; i < sorted.length; i++) {
			const reg = sorted[i];
			const gap = reg.address - currentEnd;
			const regCount = reg.count || 1;
      
			// Calculate total size if we add this register to current batch
			const batchStart = currentBatch[0].address;
			const potentialEnd = reg.address + regCount;
			const potentialBatchSize = potentialEnd - batchStart;
      
			// Check if we can batch this register:
			// 1. Register allows batching (noBatch flag for vendor-specific restrictions)
			// 2. Gap is within tolerance (contiguous or small gap)
			// 3. Total batch size doesn't exceed Modbus limit
			const registerAllowsBatch = !(reg).noBatch && !(currentBatch[0]).noBatch;
			const withinGapTolerance = gap <= this.GAP_TOLERANCE;
			const withinSizeLimit = potentialBatchSize <= this.MAX_BATCH_SIZE;
			const canBatch = registerAllowsBatch && withinGapTolerance && withinSizeLimit;
      
			if (canBatch) {
				currentBatch.push(reg);
				currentEnd = reg.address + regCount;
			} else {
				// Start new batch
				batches.push(currentBatch);
				currentBatch = [reg];
				currentEnd = reg.address + regCount;
			}
		}
    
		// Add final batch
		batches.push(currentBatch);
    
		// Log batch optimization results
		const totalRegisters = sorted.length;
		const batchCount = batches.length;
		const reductionPercent = Math.round((1 - batchCount / totalRegisters) * 100);
    
		if (batchCount < totalRegisters) {
			this.logger.debug(
				`[BATCH OPTIMIZATION] Device ${this.device.name}: ${totalRegisters} registers → ${batchCount} batches (${reductionPercent}% reduction in requests)`
			);
      
			// Log details of each batch
			batches.forEach((batch, idx) => {
				const start = batch[0].address;
				const end = batch[batch.length - 1].address + (batch[batch.length - 1].count || 1);
				const size = end - start;
				this.logger.debug(
					`  Batch ${idx + 1}: ${batch.length} registers (addr ${start}-${end - 1}, size ${size})`
				);
			});
		}
    
		return batches;
	}
  
	/**
   * Read a batch with automatic retry on DEVICE_BUSY/ACKNOWLEDGE
   * This prevents unnecessary fallback to individual reads on transient errors
   * Performance: Can reduce load by 3-5x on busy PLCs
   */
	private async readRegisterBatchWithRetry(
		registers: any[],
		retryCount = 0
	): Promise<Array<{ register: any; value: number | boolean | string }>> {
		const maxRetries = 2;
		const retryDelay = 100; // 100ms delay for device busy

		try {
			return await this.readRegisterBatch(registers);
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			const qualityCode = this.extractQualityCode(errorMessage);

			// Auto-retry on DEVICE_BUSY or ACKNOWLEDGE (device processing previous request)
			if ((qualityCode === 'DEVICE_BUSY' || qualityCode === 'ACKNOWLEDGE') && retryCount < maxRetries) {
				this.logger.debug(
					`Batch read for device ${this.device.name} busy, retrying (attempt ${retryCount + 1}/${maxRetries})`
				);

				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, retryDelay));

				// Recursive retry
				return this.readRegisterBatchWithRetry(registers, retryCount + 1);
			}

			// Not retryable or max retries exceeded
			throw error;
		}
	}
  
	/**
   * Read a batch of contiguous registers in a single request
   * Performance: 5-10x faster than individual reads
   */
	private async readRegisterBatch(registers: any[]): Promise<Array<{ register: any; value: number | boolean | string }>> {
		if (registers.length === 0) return [];
    
		// Calculate batch read parameters
		const firstReg = registers[0];
		const lastReg = registers[registers.length - 1];
		const startAddress = firstReg.address;
		const endAddress = lastReg.address + (lastReg.count || 1);
		const totalCount = endAddress - startAddress;
    
		this.logger.debug(
			`[BATCH READ] Device ${this.device.name}: Reading ${registers.length} registers in single request ` +
      `(addr ${startAddress}-${endAddress - 1}, total size ${totalCount})`
		);
    
		const batchStart = Date.now();
    
		// Perform batch read with timeout and mutex
		const timeout = this.device.connection.timeout || 5000;
		const rawData = await this.withTimeout(
			this.lock(() => this.readBatchRaw(firstReg.functionCode, startAddress, totalCount)),
			timeout,
			`batch read ${registers.length} registers`
		);
    
		const batchTime = Date.now() - batchStart;
		this.logger.debug(
			`[BATCH READ] Completed in ${batchTime}ms (${Math.round(batchTime / registers.length)}ms per register average)`
		);
    
		// Parse individual register values from batch result
		const results: Array<{ register: any; value: number | boolean | string }> = [];
    
		for (const register of registers) {
			const offset = register.address - startAddress;
			const registerData = {
				data: rawData.data.slice(offset, offset + (register.count || 1))
			};
      
			let value: number | boolean | string;
      
			if (register.functionCode === ModbusFunctionCode.READ_COILS || 
          register.functionCode === ModbusFunctionCode.READ_DISCRETE_INPUTS) {
				value = this.parseCoilData(registerData, register);
			} else {
				value = this.parseRegisterData(registerData, register);
			}
      
			results.push({ register, value });
		}
    
		return results;
	}
  
	/**
   * Smart fallback using binary search to isolate bad registers
   * Instead of reading all registers individually, split batch in half recursively
   * 
   * Example: 1 bad register in 50
   * - Old approach: 50 individual reads
   * - New approach: ~log2(50) ≈ 6 reads
   * 
   * Performance: Massive win for sparse failures
   */
	private async readBatchSmartFallback(
		batch: any[],
		timestamp: string
	): Promise<DeviceDataPoint[]> {
		// Base case: single register - read individually
		if (batch.length === 1) {
			const register = batch[0];
			try {
				const value = await this.readRegisterWithRetry(register);
				this.lastSuccessfulRead = Date.now();
				this.consecutiveFailures = 0;
        
				return [{
					deviceName: this.device.name,
					deviceId: this.stableDeviceId,
					metric: register.name,
					value: value,
					unit: register.unit || '',
					timestamp: timestamp,
					quality: 'GOOD',
					protocol: 'modbus'
				}];
			} catch (error) {
				return [this.createBadDataPoint(register, timestamp, error)];
			}
		}
    
		// Recursive case: split batch in half and try each half
		try {
			// Try reading entire batch first
			const batchResults = await this.readRegisterBatchWithRetry(batch);
      
			this.lastSuccessfulRead = Date.now();
			this.consecutiveFailures = 0;
      
			return batchResults.map(result => ({
				deviceName: this.device.name,
				deviceId: this.stableDeviceId,
				metric: result.register.name,
				value: result.value,
				unit: result.register.unit || '',
				timestamp: timestamp,
				quality: 'GOOD',
				protocol: 'modbus'
			}));
		} catch (_error) {
			// Batch failed - split in half and recurse
			const mid = Math.floor(batch.length / 2);
			const leftHalf = batch.slice(0, mid);
			const rightHalf = batch.slice(mid);
      
			this.logger.debug(
				`[SMART FALLBACK] Batch of ${batch.length} failed, splitting: ` +
        `${leftHalf.length} + ${rightHalf.length}`
			);
      
			// Recursively process each half
			// NOTE: Promise.all() provides logical parallelism (faster failure isolation)
			// but actual Modbus reads still serialize through lock() mutex
			// This is correct behavior - Modbus does not support concurrent requests
			const [leftResults, rightResults] = await Promise.all([
				this.readBatchSmartFallback(leftHalf, timestamp),
				this.readBatchSmartFallback(rightHalf, timestamp)
			]);
      
			return [...leftResults, ...rightResults];
		}
	}
  
	/**
   * Extract readable error message from error object
   * Handles cases where error is malformed, has undefined message, or is not an Error instance
   * @param error Unknown error object
   * @returns Readable error message string
   */
	private extractErrorMessage(error: unknown): string {
		// If it's an Error object with a message
		if (error instanceof Error) {
			if (error.message && error.message !== 'undefined') {
				return error.message;
			}
			// Fall back to stack trace first line if message is empty
			if (error.stack) {
				return error.stack.split('\n')[0];
			}
			// Fall back to error name
			if (error.name) {
				return error.name;
			}
		}

		// If it's an object with a message property
		if (error && typeof error === 'object' && 'message' in error) {
			const msg = (error as any).message;
			if (msg && typeof msg === 'string' && msg !== 'undefined') {
				return msg;
			}
		}

		// Try to stringify (won't be [object Object] if there are actual properties)
		const stringified = String(error);
		if (stringified !== '[object Object]') {
			return stringified;
		}

		// Last resort: try JSON.stringify to extract properties
		try {
			const jsonStr = JSON.stringify(error);
			if (jsonStr && jsonStr !== '{}') {
				return jsonStr;
			}
		} catch {
			// JSON.stringify failed, continue to fallback
		}

		// Final fallback
		return 'Unknown error (no message available)';
	}

	/**
   * Perform raw batch read (not wrapped in retry logic)
   */
	private async readBatchRaw(functionCode: number, address: number, count: number): Promise<any> {
		try {
			let result: any;
      
			switch (functionCode) {
				case ModbusFunctionCode.READ_COILS:
					result = await this.client.readCoils(address, count);
					break;
				case ModbusFunctionCode.READ_DISCRETE_INPUTS:
					result = await this.client.readDiscreteInputs(address, count);
					break;
				case ModbusFunctionCode.READ_HOLDING_REGISTERS:
					result = await this.client.readHoldingRegisters(address, count);
					break;
				case ModbusFunctionCode.READ_INPUT_REGISTERS:
					result = await this.client.readInputRegisters(address, count);
					break;
				default:
					throw new Error(`Unsupported function code for batch read: ${functionCode}`);
			}
      
			// Log successful read
			const fcName = {1: 'READ_COILS', 2: 'READ_DISCRETE_INPUTS', 3: 'READ_HOLDING', 4: 'READ_INPUT'}[functionCode] || `FC${functionCode}`;
			this.logger.debug(
				`[MODBUS RAW] Device ${this.device.name} slave=${this.device.slaveId} ${fcName} addr=${address} count=${count}: ✓ Retrieved ${result.data?.length || 0} values`
			);
      
			return result;
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			this.logger.error(`[MODBUS READ EXCEPTION] Device ${this.device.name} slave=${this.device.slaveId} FC${functionCode} addr=${address}: ${errorMessage}`);
			throw error;
		}
	}
  
	/**
   * Create BAD quality data point from error
   */
	private createBadDataPoint(register: any, timestamp: string, error: unknown): DeviceDataPoint {
		const errorMessage = this.extractErrorMessage(error);
		this.logger.warn(`Failed to read register ${register.name} from device ${this.device.name}: ${errorMessage}`);
    
		const qualityCode = this.extractQualityCode(errorMessage);
    
		return {
			deviceName: this.device.name,
			deviceId: this.stableDeviceId,
			metric: register.name,
			value: null,
			unit: register.unit || '',
			timestamp: timestamp,
			quality: 'BAD',
			qualityCode: qualityCode
		};
	}
  
	/**
   * Read register with automatic retry on DEVICE_BUSY (Exception 6)
   */
	private async readRegisterWithRetry(register: any, retryCount = 0): Promise<number | boolean | string> {
		const maxRetries = 3;
		const retryDelay = 100; // 100ms delay for device busy
    
		try {
			// Wrap read with external timeout to prevent indefinite hangs
			const timeout = this.device.connection.timeout || 5000;
			return await this.withTimeout(
				this.readRegister(register),
				timeout,
				`read register ${register.name}`
			);
		} catch (error) {
			const errorMessage = this.extractErrorMessage(error);
			const qualityCode = this.extractQualityCode(errorMessage);
      
			// Check for fatal serial port errors - trigger immediate reconnect
			if (this.isFatalSerialError(errorMessage)) {
				this.logger.error(
					`Fatal serial error detected for device ${this.device.name}: ${errorMessage}`
				);
				this.connected = false;
				this.scheduleReconnect();
				throw error;
			}
      
			// Auto-retry on DEVICE_BUSY or ACKNOWLEDGE (device processing previous request)
			if ((qualityCode === 'DEVICE_BUSY' || qualityCode === 'ACKNOWLEDGE') && retryCount < maxRetries) {
				this.logger.debug(
					`Device ${this.device.name} busy, retrying register ${register.name} (attempt ${retryCount + 1}/${maxRetries})`
				);
        
				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, retryDelay));
        
				// Recursive retry
				return this.readRegisterWithRetry(register, retryCount + 1);
			}
      
			// Track read failure - may trigger reconnect if too many consecutive failures
			// This catches timeouts (ETIMEDOUT) that don't close sockets
			await this.onReadFailure(errorMessage);
      
			// Not retryable or max retries exceeded
			throw error;
		}
	}
  
	/**
   * Check if error is a fatal serial port error requiring immediate reconnection
   */
	private isFatalSerialError(errorMessage: string): boolean {
		return (
			errorMessage.includes('EPIPE') ||      // Broken pipe - device disconnected
      errorMessage.includes('EIO') ||        // I/O error - serial port disappeared
      errorMessage.includes('ENXIO') ||      // Device not configured
      errorMessage.includes('ENODEV') ||     // No such device
      errorMessage.includes('Port is not open') ||
      errorMessage.includes('Port is opening')
		);
	}

	/**
   * Handle read failure and escalate to reconnect if too many consecutive failures
   * CRITICAL: Modbus timeouts (ETIMEDOUT) don't close sockets or emit error events,
   * so we must track consecutive failures and force reconnect after threshold
   */
	private async onReadFailure(errorMessage: string): Promise<void> {
		this.consecutiveFailures++;
    
		this.logger.debug(
			`[RECOVERY] Read failure #${this.consecutiveFailures} for ${this.device.name}: ${errorMessage.substring(0, 100)}`
		);

		// After 3 consecutive failures, assume device is offline and force reconnect
		// This catches timeouts that don't trigger socket close events
		if (this.consecutiveFailures >= 3) {
			this.logger.debug(
				`[RECOVERY] ⚠️ Too many consecutive failures (${this.consecutiveFailures}) for ${this.device.name}, forcing reconnect`
			);
			this.logger.debug(
				`[RECOVERY] client.isOpen=${this.client.isOpen}, calling forceResetClient`
			);
			// Note: this.connected is redundant - client.isOpen is the source of truth
			this.connected = false;
			await this.forceResetClient();
			// Don't increment consecutiveFailures in scheduleReconnect since we already did it here
			this.scheduleReconnectInternal(false);
		}
	}

	/**
   * Create BAD quality data points for all registers when device is offline
   */
	private createBadQualityDataPoints(qualityCode: string): DeviceDataPoint[] {
		const timestamp = new Date().toISOString();
		return this.device.registers.map(register => ({
			deviceName: this.device.name,
			deviceId: this.stableDeviceId,
			metric: register.name,
			value: null,
			unit: register.unit || '',
			timestamp: timestamp,
			quality: 'BAD' as const,
			qualityCode: qualityCode
		}));
	}

	/**
   * Extract quality code from error message
   */
	private extractQualityCode(errorMessage: string): string {
		// Fatal serial port errors (immediate reconnect needed)
		if (errorMessage.includes('EPIPE')) return 'BROKEN_PIPE';
		if (errorMessage.includes('EIO')) return 'IO_ERROR';
		if (errorMessage.includes('ENXIO')) return 'DEVICE_NOT_CONFIGURED';
		if (errorMessage.includes('ENODEV')) return 'NO_SUCH_DEVICE';
		if (errorMessage.includes('Port is not open') || errorMessage.includes('Port is opening')) {
			return 'PORT_NOT_OPEN';
		}
    
		// Modbus-specific exception codes (more specific than generic errors)
		if (errorMessage.includes('Exception Code: 1') || errorMessage.includes('Exception 1')) {
			return 'ILLEGAL_FUNCTION';
		}
		if (errorMessage.includes('Exception Code: 2') || errorMessage.includes('Exception 2')) {
			return 'ILLEGAL_ADDRESS';
		}
		if (errorMessage.includes('Exception Code: 3') || errorMessage.includes('Exception 3')) {
			return 'ILLEGAL_VALUE';
		}
		if (errorMessage.includes('Exception Code: 4') || errorMessage.includes('Exception 4')) {
			return 'DEVICE_FAILURE';
		}
		if (errorMessage.includes('Exception Code: 5') || errorMessage.includes('Exception 5')) {
			return 'ACKNOWLEDGE';
		}
		if (errorMessage.includes('Exception Code: 6') || errorMessage.includes('Exception 6')) {
			return 'DEVICE_BUSY';
		}
		if (errorMessage.includes('Exception Code: 7') || errorMessage.includes('Exception 7')) {
			return 'NEGATIVE_ACK';
		}
		if (errorMessage.includes('Exception Code: 8') || errorMessage.includes('Exception 8')) {
			return 'MEMORY_ERROR';
		}
    
		// Common network errors
		if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
			return 'TIMEOUT';
		}
		if (errorMessage.includes('ECONNREFUSED')) {
			return 'CONNECTION_REFUSED';
		}
		if (errorMessage.includes('EHOSTUNREACH')) {
			return 'HOST_UNREACHABLE';
		}
		if (errorMessage.includes('ECONNRESET')) {
			return 'CONNECTION_RESET';
		}
		if (errorMessage.includes('File not found') || errorMessage.includes('ENOENT')) {
			return 'PORT_NOT_FOUND';
		}
		if (errorMessage.includes('Exception')) {
			return 'MODBUS_EXCEPTION';
		}
    
		// Default
		return 'READ_ERROR';
	}

	/**
   * Read a single register
   * CRITICAL: Wrapped with mutex lock to prevent concurrent requests
   */
	private async readRegister(register: any): Promise<number | boolean | string> {
		return this.lock(async () => {
			let rawData: any;

			try {
				switch (register.functionCode) {
					case ModbusFunctionCode.READ_COILS:
						rawData = await this.client.readCoils(register.address, register.count);
						return this.parseCoilData(rawData, register);

					case ModbusFunctionCode.READ_DISCRETE_INPUTS:
						rawData = await this.client.readDiscreteInputs(register.address, register.count);
						return this.parseCoilData(rawData, register);

					case ModbusFunctionCode.READ_HOLDING_REGISTERS:
						rawData = await this.client.readHoldingRegisters(register.address, register.count);
						return this.parseRegisterData(rawData, register);

					case ModbusFunctionCode.READ_INPUT_REGISTERS:
						rawData = await this.client.readInputRegisters(register.address, register.count);
						return this.parseRegisterData(rawData, register);

					default:
						throw new Error(`Unsupported function code: ${register.functionCode}`);
				}
			} catch (error) {
				const errorMessage = this.extractErrorMessage(error);
				this.logger.error(`Device ${this.device.name} slave=${this.device.slaveId} ${register.name}: ${errorMessage}`);
				throw error;
			}
		});
	}

	/**
   * Parse coil/discrete input data
   */
	private parseCoilData(data: any, register: any): boolean {
		if (register.dataType === ModbusDataType.BOOLEAN) {
			return data.data[0] || false;
		}
		throw new Error(`Invalid data type ${register.dataType} for coil/discrete input`);
	}

	/**
   * Parse register data based on data type
   */
	private parseRegisterData(data: any, register: any): number | string {
		// Determine byte order (support both new byteOrder and legacy endianness)
		let byteOrder = register.byteOrder || ByteOrder.ABCD;
    
		// Legacy compatibility: map endianness to byteOrder
		if (!register.byteOrder && register.endianness) {
			byteOrder = register.endianness === Endianness.BIG ? ByteOrder.ABCD : ByteOrder.CDAB;
		}
    
		const buffer = Buffer.alloc(register.count * 2);
    
		// For 16-bit values (1 register), byte order doesn't matter - Modbus is always big-endian per register
		if (register.count === 1) {
			buffer.writeUInt16BE(data.data[0], 0);
		} else {
			// For 32-bit values (2 registers), apply byte order
			this.applyByteOrder(buffer, data.data, byteOrder, register.count);
		}

		let value: number;

		switch (register.dataType) {
			case ModbusDataType.INT16:
				value = buffer.readInt16BE(0);
				break;
			case ModbusDataType.UINT16:
				value = buffer.readUInt16BE(0);
				break;
			case ModbusDataType.INT32:
				value = buffer.readInt32BE(0);
				break;
			case ModbusDataType.UINT32:
				value = buffer.readUInt32BE(0);
				break;
			case ModbusDataType.FLOAT32:
				value = buffer.readFloatBE(0);
				break;
			case ModbusDataType.STRING: {
				// Use configurable encoding (default: ascii)
				const encoding = (register.encoding || 'ascii') as BufferEncoding;
				let str = buffer.toString(encoding);
        
				// Remove null terminators and trim whitespace
				// Some devices pad with nulls, others with spaces
				str = str.replace(/\0/g, '').trim();
        
				return str;
			}
			default:
				throw new Error(`Unsupported data type: ${register.dataType}`);
		}

		// Apply scaling and offset
		return (value * register.scale) + register.offset;
	}

	private async writeRawRegister(register: ModbusRegister, value: number | boolean | string): Promise<void> {
		const writeFunctionCode = this.resolveWriteFunctionCode(register);

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (writeFunctionCode) {
			case ModbusFunctionCode.WRITE_SINGLE_COIL: {
				const coilValue = this.serializeBooleanValue(register, value);
				await this.client.writeCoil(register.address, coilValue);
				break;
			}

			case ModbusFunctionCode.WRITE_SINGLE_REGISTER: {
				const registerValue = this.serializeSingleRegisterValue(register, value);
				await this.client.writeRegister(register.address, registerValue);
				break;
			}

			case ModbusFunctionCode.WRITE_MULTIPLE_COILS: {
				throw new Error(
					`Register ${register.name} requires multiple coil values, but API accepts a single primitive value`
				);
			}

			case ModbusFunctionCode.WRITE_MULTIPLE_REGISTERS: {
				const registerValues = this.serializeMultiRegisterValues(register, value);
				await this.client.writeRegisters(register.address, registerValues);
				break;
			}

			default:
				throw new Error(`Unsupported write function code: ${writeFunctionCode}`);
		}
	}

	private resolveWriteFunctionCode(register: ModbusRegister): ModbusFunctionCode {
		switch (register.functionCode) {
			case ModbusFunctionCode.WRITE_SINGLE_COIL:
			case ModbusFunctionCode.WRITE_SINGLE_REGISTER:
			case ModbusFunctionCode.WRITE_MULTIPLE_COILS:
			case ModbusFunctionCode.WRITE_MULTIPLE_REGISTERS:
				return register.functionCode;

			case ModbusFunctionCode.READ_COILS:
				return (register.count || 1) > 1
					? ModbusFunctionCode.WRITE_MULTIPLE_COILS
					: ModbusFunctionCode.WRITE_SINGLE_COIL;

			case ModbusFunctionCode.READ_HOLDING_REGISTERS:
				return (register.count || 1) > 1
					? ModbusFunctionCode.WRITE_MULTIPLE_REGISTERS
					: ModbusFunctionCode.WRITE_SINGLE_REGISTER;

			case ModbusFunctionCode.READ_DISCRETE_INPUTS:
			case ModbusFunctionCode.READ_INPUT_REGISTERS:
				throw new Error(`Register ${register.name} is read-only (function code ${register.functionCode})`);

			default:
				throw new Error(`Unsupported function code for write: ${register.functionCode}`);
		}
	}

	private serializeBooleanValue(register: ModbusRegister, value: number | boolean | string): boolean {
		if (typeof value === 'boolean') {
			return value;
		}

		if (typeof value === 'number') {
			if (value === 0) return false;
			if (value === 1) return true;
			throw new Error(`Boolean register ${register.name} only accepts 0 or 1 as numeric values`);
		}

		if (typeof value === 'string') {
			const normalized = value.trim().toLowerCase();
			if (normalized === 'true' || normalized === '1') return true;
			if (normalized === 'false' || normalized === '0') return false;
		}

		throw new Error(`Invalid boolean value for register ${register.name}: ${String(value)}`);
	}

	private serializeSingleRegisterValue(register: ModbusRegister, value: number | boolean | string): number {
		const rawValue = this.toUnscaledNumeric(register, value);

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (register.dataType) {
			case ModbusDataType.INT16:
				this.ensureInteger(register.name, rawValue);
				this.ensureRange(register.name, rawValue, -32768, 32767);
				return rawValue & 0xffff;

			case ModbusDataType.UINT16:
				this.ensureInteger(register.name, rawValue);
				this.ensureRange(register.name, rawValue, 0, 65535);
				return rawValue;

			default:
				throw new Error(
					`Register ${register.name} uses data type ${register.dataType} and requires multi-register write`
				);
		}
	}

	private serializeMultiRegisterValues(register: ModbusRegister, value: number | boolean | string): number[] {
		const registerCount = register.count || 1;
		const byteLength = registerCount * 2;
		const buffer = Buffer.alloc(byteLength);

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (register.dataType) {
			case ModbusDataType.INT32: {
				const rawValue = this.toUnscaledNumeric(register, value);
				this.ensureInteger(register.name, rawValue);
				this.ensureRange(register.name, rawValue, -2147483648, 2147483647);
				if (byteLength < 4) {
					throw new Error(`Register ${register.name} requires at least 2 registers for int32`);
				}
				buffer.writeInt32BE(rawValue, 0);
				break;
			}

			case ModbusDataType.UINT32: {
				const rawValue = this.toUnscaledNumeric(register, value);
				this.ensureInteger(register.name, rawValue);
				this.ensureRange(register.name, rawValue, 0, 4294967295);
				if (byteLength < 4) {
					throw new Error(`Register ${register.name} requires at least 2 registers for uint32`);
				}
				buffer.writeUInt32BE(rawValue, 0);
				break;
			}

			case ModbusDataType.FLOAT32: {
				const rawValue = this.toUnscaledFloat(register, value);
				if (byteLength < 4) {
					throw new Error(`Register ${register.name} requires at least 2 registers for float32`);
				}
				buffer.writeFloatBE(rawValue, 0);
				break;
			}

			case ModbusDataType.STRING: {
				const encoding = (register.encoding || 'ascii') as BufferEncoding;
				const stringValue = typeof value === 'string' ? value : String(value);
				const encoded = Buffer.from(stringValue, encoding);
				encoded.copy(buffer, 0, 0, Math.min(encoded.length, buffer.length));
				break;
			}

			default:
				throw new Error(`Unsupported multi-register data type for write: ${register.dataType}`);
		}

		let byteOrder = register.byteOrder || ByteOrder.ABCD;
		if (!register.byteOrder && register.endianness) {
			byteOrder = register.endianness === Endianness.BIG ? ByteOrder.ABCD : ByteOrder.CDAB;
		}

		return this.packBufferToRegisters(buffer, byteOrder, registerCount);
	}

	private toUnscaledNumeric(register: ModbusRegister, value: number | boolean | string): number {
		const parsed = this.toNumber(register.name, value);
		const scale = register.scale ?? 1;
		const offset = register.offset ?? 0;
		const raw = (parsed - offset) / scale;
		return Math.round(raw);
	}

	private toUnscaledFloat(register: ModbusRegister, value: number | boolean | string): number {
		const parsed = this.toNumber(register.name, value);
		const scale = register.scale ?? 1;
		const offset = register.offset ?? 0;
		return (parsed - offset) / scale;
	}

	private toNumber(registerName: string, value: number | boolean | string): number {
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) {
				throw new Error(`Value for register ${registerName} must be a finite number`);
			}
			return value;
		}

		if (typeof value === 'string') {
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) {
				throw new Error(`Value for register ${registerName} is not a valid number: ${value}`);
			}
			return parsed;
		}

		throw new Error(`Value for register ${registerName} must be numeric`);
	}

	private ensureInteger(registerName: string, value: number): void {
		if (!Number.isInteger(value)) {
			throw new Error(`Value for register ${registerName} must be an integer`);
		}
	}

	private ensureRange(registerName: string, value: number, min: number, max: number): void {
		if (value < min || value > max) {
			throw new Error(`Value for register ${registerName} out of range (${min} to ${max})`);
		}
	}

	private packBufferToRegisters(buffer: Buffer, byteOrder: ByteOrder, count: number): number[] {
		const registers = new Array<number>(count);

		switch (byteOrder) {
			case ByteOrder.ABCD:
				for (let i = 0; i < count; i++) {
					registers[i] = buffer.readUInt16BE(i * 2);
				}
				break;

			case ByteOrder.CDAB:
				for (let i = 0; i < count; i++) {
					registers[count - 1 - i] = buffer.readUInt16BE(i * 2);
				}
				break;

			case ByteOrder.BADC:
				for (let i = 0; i < count; i++) {
					registers[i] = buffer.readUInt16LE(i * 2);
				}
				break;

			case ByteOrder.DCBA:
				for (let i = 0; i < count; i++) {
					registers[count - 1 - i] = buffer.readUInt16LE(i * 2);
				}
				break;

			default:
				throw new Error(`Unsupported byte order: ${byteOrder}`);
		}

		return registers;
	}

	/**
   * Apply byte order to buffer based on ABCD notation
   * Modbus registers are always read as big-endian 16-bit values,
   * but the order of those registers for 32-bit values varies
   */
	private applyByteOrder(buffer: Buffer, registers: number[], byteOrder: ByteOrder, count: number): void {
		switch (byteOrder) {
			case ByteOrder.ABCD: // Big-endian (standard Modbus)
				// reg0 = AB (high word), reg1 = CD (low word)
				for (let i = 0; i < count; i++) {
					buffer.writeUInt16BE(registers[i], i * 2);
				}
				break;
        
			case ByteOrder.CDAB: // Word-swapped (common in devices)
				// reg0 = CD (low word), reg1 = AB (high word)
				for (let i = 0; i < count; i++) {
					buffer.writeUInt16BE(registers[count - 1 - i], i * 2);
				}
				break;
        
			case ByteOrder.BADC: // Byte-swapped within words
				// reg0 = BA, reg1 = DC
				for (let i = 0; i < count; i++) {
					buffer.writeUInt16LE(registers[i], i * 2);
				}
				break;
        
			case ByteOrder.DCBA: // Full little-endian
				// reg0 = DC, reg1 = BA
				for (let i = 0; i < count; i++) {
					buffer.writeUInt16LE(registers[count - 1 - i], i * 2);
				}
				break;
        
			default:
				throw new Error(`Unsupported byte order: ${byteOrder}`);
		}
	}

	/**
   * Check if client is connected
   */
	isConnected(): boolean {
		// Trust the underlying socket state - this.connected may be stale
		return this.client.isOpen;
	}
  
	/**
   * Ensure connection or schedule reconnect if needed
   * Called by readAllRegisters() to actively recover from disconnections
   */
	private async tryEnsureConnected(): Promise<void> {
		if (this.client.isOpen) {
			this.logger.debug(
				`[RECOVERY] tryEnsureConnected: Device ${this.device.name} already connected (client.isOpen=true), skipping`
			);
			return;
		}
		if (this.reconnectTimer) {
			this.logger.debug(
				`[RECOVERY] tryEnsureConnected: Device ${this.device.name} reconnect already scheduled, skipping duplicate`
			);
			return;
		}

		this.logger.debug(
			`[RECOVERY] tryEnsureConnected: Device ${this.device.name} disconnected (client.isOpen=false), forcing reconnect (failures=${this.consecutiveFailures})`
		);
		this.scheduleReconnect();
	}
  
	/**
   * Get health statistics
   */
	getHealthStats(): {
    connected: boolean;
    lastSuccessfulRead: Date;
    lastConnectionSuccess: Date;
    secondsSinceLastRead: number;
    secondsSinceLastConnection: number;
    consecutiveFailures: number;
    currentRetryDelay: number;
    } {
		const now = Date.now();
		return {
			connected: this.connected,
			lastSuccessfulRead: new Date(this.lastSuccessfulRead),
			lastConnectionSuccess: new Date(this.lastConnectionSuccess),
			secondsSinceLastRead: Math.floor((now - this.lastSuccessfulRead) / 1000),
			secondsSinceLastConnection: Math.floor((now - this.lastConnectionSuccess) / 1000),
			consecutiveFailures: this.consecutiveFailures,
			currentRetryDelay: this.currentRetryDelay
		};
	}

	/**
   * Setup error handlers
   * CRITICAL: Uses stored handler fields (not anonymous lambdas) to prevent strong references
   * This allows proper cleanup via removeAllListeners() without leaking closures
   */
	private setupErrorHandlers(): void {
		this.client.on('error', this.errorHandler);
		this.client.on('close', this.closeHandler);

		// Instrumentation: log handler counts after attach
		const emitter = this.client as any;
		if (typeof emitter.listenerCount === 'function') {
			const errCount = emitter.listenerCount('error');
			const closeCount = emitter.listenerCount('close');
			this.logger.debug(
				`[RECOVERY] Handler counts after attach for ${this.device.name}: error=${errCount}, close=${closeCount}`
			);
		}
	}

	/**
   * Schedule automatic reconnection with exponential backoff
   * Prevents log spam and CPU spikes when device is offline for extended periods
   * NOTE: Caller is responsible for incrementing consecutiveFailures before calling this
   */
	private scheduleReconnect(): void {
		this.scheduleReconnectInternal(false);
	}

	/**
   * Internal reconnect scheduling with control over failure counting
   */
	private scheduleReconnectInternal(incrementFailures: boolean): void {
		if (this.reconnectTimer) {
			this.logger.debug(
				`Reconnect timer already exists for ${this.device.name}, skipping duplicate scheduling`
			);
			return;
		}

		if (incrementFailures) {
			this.consecutiveFailures++;
		}
    
		// Exponential backoff: 5s → 10s → 20s → 40s → 60s (max)
		this.currentRetryDelay = Math.min(
			this.currentRetryDelay * 2,
			this.MAX_RETRY_DELAY
		);
    
		this.logger.debug(
			`[RECOVERY] Scheduling reconnect for ${this.device.name} in ${this.currentRetryDelay / 1000}s ` +
      `(failures=${this.consecutiveFailures}, connected=${this.connected}, client.isOpen=${this.client.isOpen})`
		);
    
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.logger.debug(`[RECOVERY] 🔄 Reconnect timer fired for ${this.device.name}`);
      
			// Execute reconnection attempt
			(async () => {
				try {
					this.logger.debug(
						`[RECOVERY] Attempting reconnection for ${this.device.name} (failures=${this.consecutiveFailures})...`
					);
          
					// CRITICAL: Must fully reset client before reconnecting
					// Reusing the same ModbusRTU instance after failures leads to corrupted state
					await this.forceResetClient();
					await this.connect();
          
					this.logger.debug(
						`[RECOVERY] Reconnection completed for ${this.device.name}. Next poll will verify slave response.`
					);
				} catch (error) {
					const errorMessage = this.extractErrorMessage(error);
					this.logger.debug(
						`[RECOVERY] ❌ Reconnection failed for ${this.device.name}: ${errorMessage}`
					);
					this.logger.debug(`[RECOVERY] Will reschedule another reconnection attempt`);
          
					// CRITICAL: Always reschedule on failure for indefinite reconnection
					this.scheduleReconnect();
				}
			})().catch(err => {
				// Safety net: catch any unhandled promise rejections
				const errorMessage = err instanceof Error ? err.message : String(err);
				this.logger.error(
					`Unhandled error in reconnection callback for device ${this.device.name}: ${errorMessage}`
				);
				this.logger.debug(`Rescheduling reconnect after unhandled error`);
				this.scheduleReconnect();
			});
		}, this.currentRetryDelay);
    
		this.logger.debug(`Reconnect timer created (delay: ${this.currentRetryDelay}ms)`);
	}
}
