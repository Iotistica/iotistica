import { BaseProtocolAdapter, type GenericDeviceConfig } from '../base.js';
import { type ModbusAdapterConfig } from './types';
import { type ModbusDevice } from './types';
import { ModbusClient } from './client';
import { type DeviceDataPoint, type IDeviceStatus, type Logger } from '../types.js';
import { DeviceMetrics, type MetricsSummary } from '../metrics.js';
import { EndpointModel } from '../../db/models/endpoint.model.js';
import { DeviceModel } from '../../db/models/device.model.js';
import { pLimit } from '../../lib/p-limit.js';

/**
 * Main Modbus Adapter class that coordinates Modbus devices
 * 
 * Architecture: This adapter is socket-agnostic. It polls Modbus devices and emits
 * 'data' events with device readings. The parent AdapterManager manages SocketServer
 * and routes data to the appropriate socket based on protocol.
 * 
 * Events:
 * - 'started': Adapter started successfully
 * - 'stopped': Adapter stopped
 * - 'data': Emitted with deviceDataPoint[] when data is collected
 * - 'device-connected': Emitted when a device connects
 * - 'device-disconnected': Emitted when a device disconnects
 * - 'device-error': Emitted when a device encounters an error
 */
export class ModbusAdapter extends BaseProtocolAdapter{
	private config: ModbusAdapterConfig;
	private clients: Map<string, ModbusClient> = new Map();
	private deviceMetrics: Map<string, DeviceMetrics> = new Map(); // Time-series metrics
	private pollLoopRunning = false;

	// Human-readable display names from device config (Modbus has no server-side name discovery).
	// Populated from device.displayName if set; otherwise the entry is absent (fall back to device.name).
	private resolvedDeviceNames: Map<string, string> = new Map();
  
	// Backpressure tracking
	private pollsSkippedBackpressure = 0;
	private lastBackpressureLog = 0;
  
	// Performance tracking
	private lastValues: Map<string, Map<string, any>> = new Map(); // Track last register values for change detection
	private lastPollTimes: Map<string, number> = new Map(); // Track last poll timestamp per device
	private retryAttempts: Map<string, number> = new Map(); // Track retry attempts per device
	private readonly POLL_TICK_INTERVAL = 1000; // Global poll loop tick interval (1 second)
	private readonly POLL_CONCURRENCY = 20; // Max concurrent device polls
	private readonly MAX_RETRY_DELAY = 30000; // Max retry delay: 30 seconds

	constructor(config: ModbusAdapterConfig, logger: Logger) {
		super(config.devices as unknown as GenericDeviceConfig[], logger);
		this.config = config;
    
		this.initializeModbusDeviceStatuses();
	}

	/**
   * Start the Modbus adapter
   */
	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		try {
			// Parallelize device initialization with concurrency control
			// At scale (50-100 devices), sequential init blocks startup
			const limit = pLimit(10); // Max 10 concurrent device initializations
      
			const enabledDevices = this.config.devices.filter(d => d.enabled);
      
			this.logger.debug(`Initializing ${enabledDevices.length} Modbus devices...`);
      
			// Use allSettled to ensure one device failure doesn't block others
			const results = await Promise.allSettled(
				enabledDevices.map(deviceConfig => 
					limit(() => this.initializeModbusDevice(deviceConfig))
				)
			);
      
			// Log initialization summary
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
      
			if (failed > 0) {
				this.logger.warn(`Modbus device initialization: ${successful} succeeded, ${failed} failed`);
			} else {
				this.logger.debug(`All ${successful} Modbus devices initialized successfully`);
			}

			this.running = true;
      
			// Start global poll loop
			this.startGlobalPollLoop();
      
			this.emit('started');

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start Modbus Adapter: ${errorMessage}`);
			await this.stop();
			throw error;
		}
	}

	/**
   * Stop the Modbus adapter
   */
	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			this.logger.debug('Stopping Modbus Adapter...');

			// Stop global poll loop
			this.pollLoopRunning = false;

			// Disconnect all devices
			const disconnectPromises = Array.from(this.clients.values()).map(client => 
				client.disconnect().catch(error => 
					this.logger.warn(`Error disconnecting Modbus device: ${error}`)
				)
			);
			await Promise.all(disconnectPromises);
			this.clients.clear();

			this.running = false;
			this.logger.debug('Modbus Adapter stopped successfully');
			this.emit('stopped');

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Error stopping Modbus Adapter: ${errorMessage}`);
		}
	}

	/**
   * Get status of all devices
   */
	getDeviceStatuses(): IDeviceStatus[] {
		return Array.from(this.deviceStatuses.values());
	}

	/**
   * Get status of a specific device
   */
	getDeviceStatus(deviceName: string): IDeviceStatus | undefined {
		return this.deviceStatuses.get(deviceName);
	}

	/**
   * Enable a device
   */
	async enableDevice(deviceName: string): Promise<void> {
		const deviceConfig = this.config.devices.find(d => d.name === deviceName);
		if (!deviceConfig) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		if (deviceConfig.enabled) {
			this.logger.warn(`Device ${deviceName} is already enabled`);
			return;
		}

		deviceConfig.enabled = true;
    
		if (this.running) {
			await this.initializeModbusDevice(deviceConfig);
		}

		this.logger.debug(`Device ${deviceName} enabled`);
		this.emit('device-enabled', deviceName);
	}

	/**
   * Disable a device
   */
	async disableDevice(deviceName: string): Promise<void> {
		const deviceConfig = this.config.devices.find(d => d.name === deviceName);
		if (!deviceConfig) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		if (!deviceConfig.enabled) {
			this.logger.warn(`Device ${deviceName} is already disabled`);
			return;
		}

    
		if (this.running) {
			await this.cleanupDevice(deviceName);
		}

		this.logger.debug(`Device ${deviceName} disabled`);
		this.emit('device-disabled', deviceName);
	}

	/**
   * Check if adapter is running
   */
	isRunning(): boolean {
		return this.running;
	}

	async writeRegister(deviceName: string, registerName: string, value: number | boolean | string): Promise<void> {
		const client = this.clients.get(deviceName);
		if (!client) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		if (!client.isConnected()) {
			throw new Error(`Device ${deviceName} is not connected`);
		}

		await client.writeRegister(registerName, value);
	}
  
	/**
   * Get metrics summary for a specific device
   * Provides P95/P99 latency, success rate, error analysis
   */
	getDeviceMetricsSummary(deviceName: string): MetricsSummary | null {
		const metrics = this.deviceMetrics.get(deviceName);
		return metrics ? metrics.getSummary() : null;
	}
  
	/**
   * Get metrics summaries for all devices
   */
	getAllDeviceMetrics(): Map<string, MetricsSummary> {
		const summaries = new Map<string, MetricsSummary>();
    
		for (const [deviceName, metrics] of this.deviceMetrics) {
			summaries.set(deviceName, metrics.getSummary());
		}
    
		return summaries;
	}
  
	/**
   * Get enriched device status with metrics
   * Merges existing DeviceStatus with time-series metrics
   */
	getEnrichedDeviceStatus(deviceName: string): IDeviceStatus | null {
		const status = this.deviceStatuses.get(deviceName);
		if (!status) return null;
    
		const metrics = this.deviceMetrics.get(deviceName);
		if (metrics) {
			status.metrics = metrics.toDeviceStatusMetrics();
		}
    
		return status;
	}

	/**
   * Initialize device statuses
   */
	private initializeModbusDeviceStatuses(): void {
		for (const device of this.config.devices) {
			this.deviceStatuses.set(device.name, {
				deviceName: device.name,
				connected: false,
				lastPoll: null,
				lastSeen: null,
				errorCount: 0,
				lastError: null,
				responseTimeMs: null,
				pollSuccessRate: 1.0, // Start optimistic
				registersUpdated: 0,
				communicationQuality: 'offline'
			});
      
			// Initialize poll history, last values tracking, and retry attempts
			this.pollHistory.set(device.name, []);
			this.lastValues.set(device.name, new Map());
			this.retryAttempts.set(device.name, 0);
      
			// Initialize advanced metrics
			this.deviceMetrics.set(device.name, new DeviceMetrics(device.name));
		}
	}

	/**
   * Initialize and start polling for a device
   */
	private async initializeModbusDevice(deviceConfig: ModbusDevice): Promise<void> {
		try {
			this.logger.debug(`Initializing Modbus device: ${deviceConfig.name}`);

			// Create Modbus client
			const client = new ModbusClient(deviceConfig, this.logger);
			this.clients.set(deviceConfig.name, client);

			// Connect to device
			await client.connect();

			// Store config displayName if provided (Modbus has no server-side name discovery)
			if (deviceConfig.displayName?.trim()) {
				this.resolvedDeviceNames.set(deviceConfig.name, deviceConfig.displayName.trim());
			}

			// Update device status
			const status = this.deviceStatuses.get(deviceConfig.name)!;
			status.connected = true;
			status.lastError = null;
      
			// Reset retry attempts on successful connection
			this.retryAttempts.set(deviceConfig.name, 0);

			// Global poll loop will handle polling automatically

			this.logger.debug(`Modbus device ${deviceConfig.name} initialized successfully`);
			this.emit('device-connected', deviceConfig.name);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to initialize Modbus device ${deviceConfig.name}: ${errorMessage}`);

			// Update device status
			const status = this.deviceStatuses.get(deviceConfig.name)!;
			status.connected = false;
			status.errorCount++;
			status.lastError = errorMessage;

			this.emit('device-error', deviceConfig.name, error);
      
			// Global poll loop will handle polling and retry automatically
		}
	}

	/**
   * Cleanup device resources
   */
	private async cleanupDevice(deviceName: string): Promise<void> {
		// Remove last poll time tracking
		this.lastPollTimes.delete(deviceName);
    
		// Reset retry attempts
		this.retryAttempts.set(deviceName, 0);

		// Disconnect client
		const client = this.clients.get(deviceName);
		if (client) {
			await client.disconnect();
			this.clients.delete(deviceName);
		}

		// Update device status
		const status = this.deviceStatuses.get(deviceName);
		if (status) {
			status.connected = false;
			status.lastPoll = null;
		}

		this.emit('device-disconnected', deviceName);
	}

	/**
   * Start global poll loop (single async loop for all devices)
   * Benefits:
   * - Single loop = predictable timing
   * - Controlled concurrency via p-limit
   * - Avoids timer storms (100+ devices = 100+ timers)
   * - Drift compensation
   */
	private startGlobalPollLoop(): void {
		this.pollLoopRunning = true;
    
		const pollLoop = async () => {
			// Create limiter once and reuse across ticks — concurrency limit is constant
			const limit = pLimit(this.POLL_CONCURRENCY);
			while (this.pollLoopRunning) {
				const tickStart = Date.now();
        
				try {
					// Get devices that need polling (enabled + interval elapsed)
					const devicesToPoll = this.getDevicesDueForPoll();
          
					if (devicesToPoll.length > 0) {
						const pollPromises = devicesToPoll.map(deviceConfig => 
							limit(() => this.pollDevice(deviceConfig))
						);
            
						// Wait for all polls to complete (or fail)
						await Promise.allSettled(pollPromises);
					}
          
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					this.logger.error(`Error in global poll loop: ${errorMessage}`);
				}
        
				// Calculate drift and sleep until next tick
				const elapsed = Date.now() - tickStart;
				const nextTick = Math.max(this.POLL_TICK_INTERVAL - elapsed, 0);
        
				await new Promise(resolve => setTimeout(resolve, nextTick));
			}
      
			this.logger.debug('Global poll loop stopped');
		};
    
		// Start the loop
		pollLoop().catch(error => {
			this.logger.error(`Fatal error in poll loop: ${error}`);
			this.pollLoopRunning = false;
		});
	}
  
	/**
   * Get devices that are due for polling based on their poll interval
   */
	private getDevicesDueForPoll(): ModbusDevice[] {
		const now = Date.now();
		const devicesDue: ModbusDevice[] = [];
    
		for (const deviceConfig of this.config.devices) {
			if (!deviceConfig.enabled) continue;
      
			const lastPoll = this.lastPollTimes.get(deviceConfig.name) || 0;
			const timeSinceLastPoll = now - lastPoll;
      
			// Check if poll interval has elapsed
			if (timeSinceLastPoll >= deviceConfig.pollInterval) {
				devicesDue.push(deviceConfig);
			}
		}
    
		return devicesDue;
	}
  
	/**
   * Poll a single device (extracted from old startPolling)
   */
	private async pollDevice(deviceConfig: ModbusDevice): Promise<void> {
		const startTime = Date.now();
    
		// BACKPRESSURE CHECK: Skip polling if socket server is overwhelmed
		// This prevents OOM from generating data faster than it can be consumed
		const socketServer = (this as any)._socketServer;
		if (socketServer && typeof socketServer.isBackpressureActive === 'function') {
			if (socketServer.isBackpressureActive()) {
				this.pollsSkippedBackpressure++;
        
				// Log once per second to avoid spam
				const now = Date.now();
				if (now - this.lastBackpressureLog > 1000) {
					this.logger.warn(
						`[BACKPRESSURE] Skipping polls - socket server overwhelmed`,
						{
							skippedPolls: this.pollsSkippedBackpressure,
							deviceName: deviceConfig.name,
							socketStats: socketServer.getStats()
						}
					);
					this.lastBackpressureLog = now;
				}
				return; // Skip this poll cycle
			}
		}
    
		// Update last poll time
		this.lastPollTimes.set(deviceConfig.name, startTime);
    
		try {
			const client = this.clients.get(deviceConfig.name);
			if (!client) {
				this.logger.warn(`No client found for Modbus device ${deviceConfig.name}`);
				return;
			}

			// Helper: attach resolvedDisplayName to data points (no-op if no override configured)
			const resolvedDisplayName = this.resolvedDeviceNames.get(deviceConfig.name);
			const enrich = (pts: DeviceDataPoint[]): DeviceDataPoint[] =>
				resolvedDisplayName ? pts.map(p => ({ ...p, resolvedDisplayName })) : pts;
      
			const isConnected = client.isConnected();
      
			if (!isConnected) {
				// Record failed poll
				this.recordModbusPollResult(deviceConfig.name, false);
        
				// CRITICAL: Call readAllRegisters even when disconnected
				// This triggers tryEnsureConnected() which schedules reconnection
				const dataPoints = enrich(await client.read());
        
				if (dataPoints.length > 0) {
					this.emit('data', dataPoints);
				}
			} else {
				const dataPoints = enrich(await client.read());
				const responseTime = Date.now() - startTime;

				// Track register changes
				const registersUpdated = this.trackRegisterChanges(deviceConfig.name, dataPoints);
        
				// Record successful poll with metrics
				this.recordModbusPollResult(deviceConfig.name, true, responseTime, registersUpdated);
        
				// Reset retry attempts on successful poll
				this.retryAttempts.set(deviceConfig.name, 0);
        
				// Record advanced metrics
				const metrics = this.deviceMetrics.get(deviceConfig.name);
				if (metrics) {
					metrics.recordPoll(responseTime, true, registersUpdated);
				}

				// Emit data event with device readings
				if (dataPoints.length > 0) {
					this.emit('data', dataPoints);
					this.emit('data-received', deviceConfig.name, dataPoints);
				}
			}

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.warn(`Error polling Modbus device ${deviceConfig.name}: ${errorMessage}`);
      
			const pollTime = Date.now() - startTime;

			// Update device status
			const status = this.deviceStatuses.get(deviceConfig.name)!;
			status.connected = false;
			status.errorCount++;
			status.lastError = errorMessage;
      
			// Extract quality code for metrics and data points
			const qualityCode = this.extractModbusQualityCode(errorMessage);
      
			// Record failed poll in metrics
			const metrics = this.deviceMetrics.get(deviceConfig.name);
			if (metrics) {
				metrics.recordPoll(pollTime, false, 0);
				metrics.recordError(qualityCode, errorMessage);
			}

			this.emit('device-error', deviceConfig.name, error);
      
			// Send BAD quality data points with error code
			const timestamp = new Date().toISOString();
			const resolvedDisplayName = this.resolvedDeviceNames.get(deviceConfig.name);
			const badDataPoints = deviceConfig.registers.map(register => ({
				deviceName: deviceConfig.name,
				metric: register.name,
				value: null,
				unit: register.unit || '',
				timestamp: timestamp,
				quality: 'BAD' as const,
				qualityCode: qualityCode,
				...(resolvedDisplayName && { resolvedDisplayName }),
			}));
      
			if (badDataPoints.length > 0) {
				this.emit('data', badDataPoints);
			}
      
			// Try to reconnect
			this.scheduleModbusDeviceRetry(deviceConfig);
		}
	}

	/**
   * Extract quality code from error message
   */
	private extractModbusQualityCode(errorMessage: string): string {
		if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
			return 'TIMEOUT';
		}
		if (errorMessage.includes('ECONNREFUSED')) {
			return 'CONNECTION_REFUSED';
		}
		if (errorMessage.includes('ENOTFOUND')) {
			return 'HOST_NOT_FOUND';
		}
		if (errorMessage.includes('not open')) {
			return 'DEVICE_OFFLINE';
		}
		return 'UNKNOWN_ERROR';
	}

	/**
   * Track register changes for a device
   */
	private trackRegisterChanges(deviceName: string, dataPoints: DeviceDataPoint[]): number {
		const lastValues = this.lastValues.get(deviceName);
		if (!lastValues) return 0;
    
		let changedCount = 0;
    
		for (const point of dataPoints) {
			if (point.quality !== 'GOOD') continue; // Only count good quality data
      
			const key = point.metric;
			const lastValue = lastValues.get(key);
      
			// Check if value changed
			if (lastValue !== point.value) {
				changedCount++;
				lastValues.set(key, point.value);
			}
		}
    
		return changedCount;
	}

	/**
   * Record poll result and update metrics
   */
	private recordModbusPollResult(
		deviceName: string,
		success: boolean,
		responseTimeMs?: number,
		registersUpdated?: number
	): void {
		const status = this.deviceStatuses.get(deviceName);
		if (!status) return;

		const now = new Date();
		status.lastPoll = now;

		// Update success/failure tracking
		const history = this.pollHistory.get(deviceName) || [];
		history.push(success);

		// Keep only last N results
		if (history.length > this.pollHistorySize) {
			history.shift();
		}
		this.pollHistory.set(deviceName, history);

		// Calculate success rate
		const successCount = history.filter((r) => r).length;
		status.pollSuccessRate = history.length > 0 ? successCount / history.length : 1.0;

		if (success) {
			status.lastSeen = now;
			status.responseTimeMs = responseTimeMs ?? null;
			status.registersUpdated = registersUpdated ?? 0;
			status.errorCount = 0; // Reset on success
			status.lastError = null;
			status.connected = true;
      
			// Persist lastSeen to database (async, fire-and-forget)
			// Uses name-based lookup since cloud-synced devices don't have fingerprints
			EndpointModel.updateLastSeenByName(deviceName).catch(err => {
				this.logger.warn(`Failed to update lastSeen for ${deviceName}: ${err.message}`);
			});
			DeviceModel.updateLastSeenByEndpointName(deviceName).catch(err => {
				this.logger.warn(`Failed to update device lastSeenAt for ${deviceName}: ${err.message}`);
			});
		} else {
			status.errorCount++;
		}

		// Update communication quality based on success rate and connection state
		status.communicationQuality = this.calculateModbusCommunicationQuality(status);
	}

	/**
   * Calculate communication quality based on metrics
   */
	private calculateModbusCommunicationQuality(
		status: IDeviceStatus
	): 'good' | 'degraded' | 'poor' | 'offline' {
		if (!status.connected) {
			return 'offline';
		}

		const successRate = status.pollSuccessRate;

		if (successRate >= 0.95) {
			return 'good';
		} else if (successRate >= 0.75) {
			return 'degraded';
		} else {
			return 'poor';
		}
	}

	/**
   * Schedule device retry with exponential backoff and jitter
   * 
   * Benefits:
   * - Prevents retry storms when many devices fail simultaneously
   * - Handles persistent failures gracefully with increasing delays
   * - Adds random jitter to avoid thundering herd problem
   * - Respects max retry attempts from device config
   */
	private scheduleModbusDeviceRetry(deviceConfig: ModbusDevice): void {
		// Get current retry attempt (increment for this retry)
		const currentAttempt = (this.retryAttempts.get(deviceConfig.name) || 0) + 1;
		this.retryAttempts.set(deviceConfig.name, currentAttempt);
    
		// Check if we've exceeded max retry attempts
		const maxAttempts = deviceConfig.connection.retryAttempts || 3;
		if (currentAttempt > maxAttempts) {
			this.logger.warn(
				`Device ${deviceConfig.name} exceeded max retry attempts (${maxAttempts}). ` +
        `Will retry on next poll cycle.`
			);
			// Don't schedule more retries - global poll loop will handle eventual recovery
			return;
		}
    
		// Exponential backoff: delay = baseDelay * 2^(attempt-1)
		const baseDelay = deviceConfig.connection.retryDelay || 5000;
		const exponentialDelay = baseDelay * Math.pow(2, currentAttempt - 1);
    
		// Cap at max delay
		const cappedDelay = Math.min(exponentialDelay, this.MAX_RETRY_DELAY);
    
		// Add random jitter (0-1000ms) to prevent thundering herd
		const jitter = Math.random() * 1000;
		const finalDelay = cappedDelay + jitter;
    
		this.logger.debug(
			`Scheduling retry for ${deviceConfig.name}: attempt ${currentAttempt}/${maxAttempts}, ` +
      `delay ${Math.round(finalDelay)}ms (base: ${baseDelay}ms, backoff: ${Math.round(exponentialDelay)}ms)`
		);
    
		setTimeout(async () => {
			if (!this.running || !deviceConfig.enabled) {
				this.logger.debug(`Skipping retry for ${deviceConfig.name} (adapter stopped or device disabled)`);
				return;
			}
      
			this.logger.debug(`Retrying connection to device: ${deviceConfig.name} (attempt ${currentAttempt})`);
      
			try {
				await this.cleanupDevice(deviceConfig.name);
				await this.initializeModbusDevice(deviceConfig);
        
				// Check if connection succeeded
				const status = this.deviceStatuses.get(deviceConfig.name);
				if (status && !status.connected) {
					// Still failed - scheduleDeviceRetry will be called again from initializeDevice
					this.logger.debug(`Retry ${currentAttempt} failed for ${deviceConfig.name}`);
				} else {
					this.logger.info(`Device ${deviceConfig.name} reconnected successfully after ${currentAttempt} attempts`);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.error(`Error during retry for ${deviceConfig.name}: ${errorMessage}`);
			}
		}, finalDelay);
	}
}
