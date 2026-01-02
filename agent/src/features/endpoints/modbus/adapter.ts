import { EventEmitter } from 'events';
import { ModbusAdapterConfig } from './types';
import { ModbusDevice } from './types';
import { ModbusClient } from './client';
import { SensorDataPoint, DeviceStatus, Logger } from '../types.js';

/**
 * Main Modbus Adapter class that coordinates Modbus devices
 * 
 * Architecture: This adapter is socket-agnostic. It polls Modbus devices and emits
 * 'data' events with sensor readings. The parent SensorsFeature manages SocketServer
 * and routes data to the appropriate socket based on protocol.
 * 
 * Events:
 * - 'started': Adapter started successfully
 * - 'stopped': Adapter stopped
 * - 'data': Emitted with SensorDataPoint[] when data is collected
 * - 'device-connected': Emitted when a device connects
 * - 'device-disconnected': Emitted when a device disconnects
 * - 'device-error': Emitted when a device encounters an error
 */
export class ModbusAdapter extends EventEmitter {
  private config: ModbusAdapterConfig;
  private logger: Logger;
  private clients: Map<string, ModbusClient> = new Map();
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private running = false;
  
  // Performance tracking
  private pollHistory: Map<string, boolean[]> = new Map(); // Track last N poll results
  private lastValues: Map<string, Map<string, any>> = new Map(); // Track last register values for change detection
  private readonly pollHistorySize = 100; // Track last 100 polls for success rate

  constructor(config: ModbusAdapterConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    this.initializeDeviceStatuses();
  }

  /**
   * Start the Modbus adapter
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      // Initialize and connect all enabled devices
      for (const deviceConfig of this.config.devices) {
        if (deviceConfig.enabled) {
          await this.initializeDevice(deviceConfig);
        }
      }

      this.running = true;
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

      // Stop all polling timers
      for (const [deviceName, timer] of this.pollTimers) {
        clearTimeout(timer);
        this.pollTimers.delete(deviceName);
      }

      // Disconnect all devices
      const disconnectPromises = Array.from(this.clients.values()).map(client => 
        client.disconnect().catch(error => 
          this.logger.warn(`Error disconnecting device: ${error}`)
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
  getDeviceStatuses(): DeviceStatus[] {
    return Array.from(this.deviceStatuses.values());
  }

  /**
   * Get status of a specific device
   */
  getDeviceStatus(deviceName: string): DeviceStatus | undefined {
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
      await this.initializeDevice(deviceConfig);
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

  /**
   * Initialize device statuses
   */
  private initializeDeviceStatuses(): void {
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
      
      // Initialize poll history and last values tracking
      this.pollHistory.set(device.name, []);
      this.lastValues.set(device.name, new Map());
    }
  }

  /**
   * Initialize and start polling for a device
   */
  private async initializeDevice(deviceConfig: ModbusDevice): Promise<void> {
    try {
      this.logger.debug(`Initializing device: ${deviceConfig.name}`);

      // Create Modbus client
      const client = new ModbusClient(deviceConfig, this.logger);
      this.clients.set(deviceConfig.name, client);

      // Connect to device
      await client.connect();

      // Update device status
      const status = this.deviceStatuses.get(deviceConfig.name)!;
      status.connected = true;
      status.lastError = null;

      // Start polling
      this.startPolling(deviceConfig);

      this.logger.debug(`Device ${deviceConfig.name} initialized successfully`);
      this.emit('device-connected', deviceConfig.name);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to initialize device ${deviceConfig.name}: ${errorMessage}`);

      // Update device status
      const status = this.deviceStatuses.get(deviceConfig.name)!;
      status.connected = false;
      status.errorCount++;
      status.lastError = errorMessage;

      this.emit('device-error', deviceConfig.name, error);
      
      // ✅ Start polling even when disconnected (to send BAD quality data)
      this.startPolling(deviceConfig);
      
      // Schedule retry
      this.scheduleDeviceRetry(deviceConfig);
    }
  }

  /**
   * Cleanup device resources
   */
  private async cleanupDevice(deviceName: string): Promise<void> {
    // Stop polling timer
    const timer = this.pollTimers.get(deviceName);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(deviceName);
    }

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
   * Start polling for a device
   */
  private startPolling(deviceConfig: ModbusDevice): void {
    const pollDevice = async () => {
      const startTime = Date.now();
      
      this.logger.debug(
        `[RECOVERY] Poll cycle starting for ${deviceConfig.name}`
      );
      
      try {
        const client = this.clients.get(deviceConfig.name);
        if (!client) {
          this.logger.error(`[RECOVERY] No client found for ${deviceConfig.name}`);
          // Don't return - schedule next poll
        } else {
          const isConnected = client.isConnected();
          this.logger.debug(
            `[RECOVERY] Device ${deviceConfig.name} isConnected()=${isConnected}`
          );
          
          if (!isConnected) {
            this.logger.debug(`[RECOVERY] Device ${deviceConfig.name} offline, attempting read (will auto-reconnect)`);
            
            // Record failed poll
            this.recordPollResult(deviceConfig.name, false);
            
            // CRITICAL: Call readAllRegisters even when disconnected
            // This triggers tryEnsureConnected() which schedules reconnection
            const dataPoints = await client.readAllRegisters();
            
            if (dataPoints.length > 0) {
              this.emit('data', dataPoints);
            }
            
            // Don't return - schedule next poll
          } else {
            // Read all registers (measure time)
            this.logger.debug(
              `[RECOVERY] Device ${deviceConfig.name} connected, calling readAllRegisters()`
            );
            const dataPoints = await client.readAllRegisters();
            const responseTime = Date.now() - startTime;

            this.logger.debug(
              `[RECOVERY] ✅ Device ${deviceConfig.name} read succeeded! Got ${dataPoints.length} data points in ${responseTime}ms`
            );

            // Track register changes
            const registersUpdated = this.trackRegisterChanges(deviceConfig.name, dataPoints);
            
            // Record successful poll with metrics
            this.recordPollResult(deviceConfig.name, true, responseTime, registersUpdated);

            // Emit data event with sensor readings
            if (dataPoints.length > 0) {
              this.emit('data', dataPoints);
              this.emit('data-received', deviceConfig.name, dataPoints);
            }
          }
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error polling device ${deviceConfig.name}: ${errorMessage}`);

        // Update device status
        const status = this.deviceStatuses.get(deviceConfig.name)!;
        status.connected = false;
        status.errorCount++;
        status.lastError = errorMessage;

        this.emit('device-error', deviceConfig.name, error);
        
        // Send BAD quality data points with error code
        const timestamp = new Date().toISOString();
        const qualityCode = this.extractQualityCode(errorMessage);
        const badDataPoints = deviceConfig.registers.map(register => ({
          deviceName: deviceConfig.name,
          registerName: register.name,
          value: null,
          unit: register.unit || '',
          timestamp: timestamp,
          quality: 'BAD' as const,
          qualityCode: qualityCode
        }));
        
        if (badDataPoints.length > 0) {
          this.emit('data', badDataPoints);
        }
        
        // Try to reconnect
        this.scheduleDeviceRetry(deviceConfig);
      }

      // CRITICAL: Always schedule next poll, even after errors
      // This ensures continuous BAD quality data emission and auto-recovery when device comes back
      const timer = setTimeout(pollDevice, deviceConfig.pollInterval);
      this.pollTimers.set(deviceConfig.name, timer);
    };

    // Start first poll immediately
    setTimeout(pollDevice, 100);
  }

  /**
   * Extract quality code from error message
   */
  private extractQualityCode(errorMessage: string): string {
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
  private trackRegisterChanges(deviceName: string, dataPoints: SensorDataPoint[]): number {
    const lastValues = this.lastValues.get(deviceName);
    if (!lastValues) return 0;
    
    let changedCount = 0;
    
    for (const point of dataPoints) {
      if (point.quality !== 'GOOD') continue; // Only count good quality data
      
      const key = point.registerName;
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
  private recordPollResult(
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
    } else {
      status.errorCount++;
    }

    // Update communication quality based on success rate and connection state
    status.communicationQuality = this.calculateCommunicationQuality(status);
  }

  /**
   * Calculate communication quality based on metrics
   */
  private calculateCommunicationQuality(
    status: DeviceStatus
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
   * Schedule device retry
   */
  private scheduleDeviceRetry(deviceConfig: ModbusDevice): void {
    const retryDelay = deviceConfig.connection.retryDelay || 5000;
    
    setTimeout(async () => {
      if (this.running && deviceConfig.enabled) {
        this.logger.debug(`Retrying connection to device: ${deviceConfig.name}`);
        await this.cleanupDevice(deviceConfig.name);
        await this.initializeDevice(deviceConfig);
      }
    }, retryDelay);
  }
}
