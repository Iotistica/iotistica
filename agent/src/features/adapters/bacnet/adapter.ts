import { EventEmitter } from 'events';
import { BACnetAdapterConfig, BACnetDevice } from './types';
import { BACnetClient } from './client';
import { DeviceDataPoint, DeviceStatus, Logger } from '../types.js';
import { DeviceMetrics } from '../metrics.js';
import { DeviceModel } from '../../../db/models/device.model.js';

/**
 * Main BACnet Adapter class that coordinates BACnet devices
 * 
 * Architecture: This adapter is socket-agnostic. It polls BACnet devices and emits
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
export class BACnetAdapter extends EventEmitter {
  private config: BACnetAdapterConfig;
  private logger: Logger;
  private clients: Map<string, BACnetClient> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private deviceMetrics: Map<string, DeviceMetrics> = new Map();
  private running = false;
  private pollLoopRunning = false;

  // Human-readable names resolved from BACnet Device objectName at init time.
  // Priority: device.displayName (config override) > BACnet objectName property > (unset)
  private resolvedDeviceNames: Map<string, string> = new Map();
  
  // Performance tracking
  private pollHistory: Map<string, boolean[]> = new Map();
  private lastValues: Map<string, Map<string, any>> = new Map();
  private lastPollTimes: Map<string, number> = new Map();
  private retryAttempts: Map<string, number> = new Map();
  private readonly pollHistorySize = 100;
  private readonly POLL_TICK_INTERVAL = 1000; // 1 second tick
  private readonly MAX_RETRY_DELAY = 30000; // 30 seconds max retry delay

  constructor(config: BACnetAdapterConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    this.initializeDeviceStatuses();
  }

  /**
   * Start the BACnet adapter
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      const enabledDevices = this.config.devices.filter(d => d.enabled);
      
      this.logger.debug(`Initializing ${enabledDevices.length} BACnet devices...`);
      
      // Initialize devices in parallel with concurrency limit
      const { default: pLimit } = await import('p-limit');
      const limit = pLimit(this.config.maxConcurrentDevices);
      
      const results = await Promise.allSettled(
        enabledDevices.map(deviceConfig => 
          limit(() => this.initializeDevice(deviceConfig))
        )
      );
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      if (failed > 0) {
        this.logger.warn(`BACnet device initialization: ${successful} succeeded, ${failed} failed`);
      } else {
        this.logger.debug(`All ${successful} BACnet devices initialized successfully`);
      }

      this.running = true;
      this.startGlobalPollLoop();
      this.emit('started');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start BACnet Adapter: ${errorMessage}`);
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the BACnet adapter
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      this.logger.debug('Stopping BACnet Adapter...');
      this.pollLoopRunning = false;

      // Disconnect all devices
      const disconnectPromises = Array.from(this.clients.values()).map(client => 
        client.disconnect().catch(error => 
          this.logger.warn(`Error disconnecting BACnet device: ${error}`)
        )
      );
      await Promise.all(disconnectPromises);
      this.clients.clear();

      this.running = false;
      this.logger.debug('BACnet Adapter stopped successfully');
      this.emit('stopped');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error stopping BACnet Adapter: ${errorMessage}`);
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
   * Get metrics summary for all devices
   */
  getMetricsSummary() {
    const metrics = {
      totalDevices: this.deviceStatuses.size,
      connectedDevices: 0,
      disconnectedDevices: 0,
      averageResponseTime: 0,
      totalDataPoints: 0,
    };

    let totalResponseTime = 0;
    let deviceCount = 0;

    for (const status of this.deviceStatuses.values()) {
      if (status.connected) {
        metrics.connectedDevices++;
      } else {
        metrics.disconnectedDevices++;
      }

      if (status.responseTimeMs !== null) {
        totalResponseTime += status.responseTimeMs;
        deviceCount++;
      }

      metrics.totalDataPoints += status.registersUpdated;
    }

    if (deviceCount > 0) {
      metrics.averageResponseTime = Math.round(totalResponseTime / deviceCount);
    }

    return metrics;
  }

  /**
   * Check if adapter is running
   */
  isRunning(): boolean {
    return this.running;
  }

  // ==================== Private Methods ====================

  /**
   * Initialize device statuses for all configured devices
   */
  private initializeDeviceStatuses(): void {
    for (const deviceConfig of this.config.devices) {
      this.deviceStatuses.set(deviceConfig.name, {
        deviceName: deviceConfig.name,
        connected: false,
        lastPoll: null,
        lastSeen: null,
        errorCount: 0,
        lastError: null,
        responseTimeMs: null,
        pollSuccessRate: 0,
        registersUpdated: 0,
        communicationQuality: 'offline',
      });

      // Initialize poll history
      this.pollHistory.set(deviceConfig.name, []);
      this.lastValues.set(deviceConfig.name, new Map());
      this.retryAttempts.set(deviceConfig.name, 0);
    }
  }

  /**
   * Initialize a single BACnet device
   */
  private async initializeDevice(deviceConfig: BACnetDevice): Promise<void> {
    try {
      const client = new BACnetClient(
        deviceConfig,
        this.config.port || 47809,
        this.logger
      );

      await client.connect();
      this.clients.set(deviceConfig.name, client);

      // Resolve human-readable display name.
      // Priority: device.displayName (config) > BACnet objectName property > (unset)
      if (deviceConfig.displayName && deviceConfig.displayName.trim()) {
        this.resolvedDeviceNames.set(deviceConfig.name, deviceConfig.displayName.trim());
      } else {
        const objectName = await client.readDeviceName();
        if (objectName) {
          this.resolvedDeviceNames.set(deviceConfig.name, objectName);
          this.logger.debug(`Resolved BACnet objectName for ${deviceConfig.name}: "${objectName}"`);
        }
      }

      this.updateDeviceStatus(deviceConfig.name, {
        connected: true,
        lastError: null,
        errorCount: 0,
      });

      this.emit('device-connected', deviceConfig.name);
      this.logger.debug(`BACnet device ${deviceConfig.name} initialized`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to initialize BACnet device ${deviceConfig.name}: ${errorMessage}`);
      
      this.updateDeviceStatus(deviceConfig.name, {
        connected: false,
        lastError: errorMessage,
        errorCount: 1,
      });

      throw error;
    }
  }

  /**
   * Global poll loop - ticks every second and polls devices based on their intervals
   */
  private startGlobalPollLoop(): void {
    this.pollLoopRunning = true;

    const pollTick = async () => {
      if (!this.pollLoopRunning) {
        return;
      }

      const now = Date.now();

      // Determine which devices need polling
      const devicesToPoll: BACnetDevice[] = [];

      for (const deviceConfig of this.config.devices) {
        if (!deviceConfig.enabled) {
          continue;
        }

        const lastPollTime = this.lastPollTimes.get(deviceConfig.name) || 0;
        const pollInterval = deviceConfig.pollIntervalMs || this.config.globalPollIntervalMs;

        if (now - lastPollTime >= pollInterval) {
          devicesToPoll.push(deviceConfig);
        }
      }

      if (devicesToPoll.length > 0) {
        // Poll devices in parallel with concurrency limit
        const { default: pLimit } = await import('p-limit');
        const limit = pLimit(this.config.maxConcurrentDevices);

        await Promise.all(
          devicesToPoll.map(deviceConfig =>
            limit(() => this.pollDevice(deviceConfig))
          )
        );
      }

      // Schedule next tick
      setTimeout(pollTick, this.POLL_TICK_INTERVAL);
    };

    // Start the loop
    pollTick().catch(error => {
      this.logger.error(`Error in BACnet poll loop: ${error}`);
    });
  }

  /**
   * Poll a single device
   */
  private async pollDevice(deviceConfig: BACnetDevice): Promise<void> {
    const deviceName = deviceConfig.name;
    const client = this.clients.get(deviceName);

    if (!client) {
      this.logger.warn(`No client found for BACnet device ${deviceName}`);
      return;
    }

    const startTime = Date.now();
    this.lastPollTimes.set(deviceName, startTime);

    this.updateDeviceStatus(deviceName, {
      lastPoll: new Date(),
    });

    try {
      // Read all enabled objects
      const enabledObjects = deviceConfig.objects.filter(obj => obj.enabled);
      const results = await client.readObjects(enabledObjects);

      // Convert results to SensorDataPoint[]
      const dataPoints: DeviceDataPoint[] = [];
      let updatedCount = 0;

      const lastValuesMap = this.lastValues.get(deviceName) || new Map();
      const resolvedDisplayName = this.resolvedDeviceNames.get(deviceName);

      for (const object of enabledObjects) {
        const result = results.get(object.name);
        if (!result) continue;

        const lastValue = lastValuesMap.get(object.name);
        const valueChanged = lastValue !== result.value;

        if (valueChanged) {
          updatedCount++;
          lastValuesMap.set(object.name, result.value);
        }

        dataPoints.push({
          deviceName,
          metric: object.name,
          value: result.value,
          unit: object.unit,
          timestamp: new Date().toISOString(),
          quality: result.quality,
          qualityCode: result.error,
          protocol: 'bacnet',
          ...(resolvedDisplayName && { resolvedDisplayName }),
        });
      }

      this.lastValues.set(deviceName, lastValuesMap);

      const responseTime = Date.now() - startTime;

      // Update device status
      this.updateDeviceStatus(deviceName, {
        connected: true,
        lastSeen: new Date(),
        responseTimeMs: responseTime,
        registersUpdated: updatedCount,
        errorCount: 0,
        lastError: null,
      });

      // Track poll success
      this.recordPollResult(deviceName, true);
      this.retryAttempts.set(deviceName, 0);

      // Emit data event
      if (dataPoints.length > 0) {
        this.emit('data', dataPoints);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCount = (this.deviceStatuses.get(deviceName)?.errorCount || 0) + 1;

      this.updateDeviceStatus(deviceName, {
        connected: false,
        lastError: errorMessage,
        errorCount,
      });

      this.recordPollResult(deviceName, false);
      this.emit('device-error', { deviceName, error: errorMessage });

      this.logger.warn(`Error polling BACnet device ${deviceName}: ${errorMessage}`);
    }
  }

  /**
   * Record poll result for success rate calculation
   */
  private recordPollResult(deviceName: string, success: boolean): void {
    const history = this.pollHistory.get(deviceName) || [];
    history.push(success);

    if (history.length > this.pollHistorySize) {
      history.shift();
    }

    this.pollHistory.set(deviceName, history);

    // Calculate success rate
    const successCount = history.filter(s => s).length;
    const successRate = history.length > 0 ? successCount / history.length : 0;

    this.updateDeviceStatus(deviceName, {
      pollSuccessRate: successRate,
    });

    if (success) {
      DeviceModel.updateLastSeenByEndpointName(deviceName).catch(err => {
        this.logger.warn(`Failed to update device lastSeenAt for ${deviceName}: ${err.message}`);
      });
    }
  }

  /**
   * Update device status
   */
  private updateDeviceStatus(deviceName: string, updates: Partial<DeviceStatus>): void {
    const currentStatus = this.deviceStatuses.get(deviceName);
    if (!currentStatus) {
      return;
    }

    const newStatus = { ...currentStatus, ...updates };
    
    // Calculate communication quality based on connection state and success rate
    newStatus.communicationQuality = this.calculateCommunicationQuality(
      newStatus.connected,
      newStatus.pollSuccessRate,
      newStatus.errorCount
    );
    
    this.deviceStatuses.set(deviceName, newStatus);
  }

  /**
   * Calculate communication quality indicator
   */
  private calculateCommunicationQuality(
    connected: boolean,
    successRate: number,
    errorCount: number
  ): 'good' | 'degraded' | 'poor' | 'offline' {
    if (!connected) {
      return 'offline';
    }
    
    if (successRate >= 0.95 && errorCount === 0) {
      return 'good';
    } else if (successRate >= 0.8) {
      return 'degraded';
    } else if (successRate >= 0.5) {
      return 'poor';
    } else {
      return 'offline';
    }
  }
}
