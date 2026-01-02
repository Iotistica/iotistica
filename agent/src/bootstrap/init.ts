/**
 * Feature Initializer
 * 
 * Handles initialization of optional agent features in a clean, modular way.
 * Separates feature orchestration from the main agent class.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { DeviceInfo } from '../device-manager/types.js';
import { LogComponents } from '../logging/types';
import { JobsFeature } from '../features/jobs/src/monitor.js';
import { SensorPublishFeature } from '../features/sensor-publish/index.js';
import { SensorsFeature, type SensorConfig } from '../features/endpoints/index.js';
import { SensorConfigHandler } from '../features/sensor-publish/config-handler.js';
import { AgentUpdater } from '../updater.js';
import { AgentFirewall } from '../network/firewall.js';
import { MqttManager } from '../mqtt/manager.js';
import { StateReconciler } from '../device-manager/reconciler.js';
import { getPackageVersion } from '../utils/api-utils.js';

export interface FeatureContext {
  logger: AgentLogger;
  deviceInfo: DeviceInfo;
  mqttManager: MqttManager;
  containerManager: any;
  deviceManager: any;
  stateReconciler: StateReconciler;
  configSettings: Record<string, any>;
  configFeatures: Record<string, any>;
  configProtocols?: Record<string, any>; // New: protocols section from target state
  cloudApiEndpoint: string;
  deviceApiPort: number;
  anomalyService?: any;
  discoveryService?: any; // Discovery service for endpoint auto-reload
}

export interface InitializedFeatures {
  jobs?: JobsFeature;
  sensorPublish?: SensorPublishFeature;
  sensors?: SensorsFeature;
  sensorConfigHandler?: SensorConfigHandler;
  updater?: AgentUpdater;
  firewall?: AgentFirewall;
  discoveryService?: any; // Discovery service (passed from Agent)
}

/**
 * FeatureInitializer - Orchestrates optional feature initialization
 * 
 * Responsibilities:
 * - Initialize optional features (jobs, sensor-publish, protocol adapters)
 * - Initialize supporting features (updater, firewall, sensor config handler)
 * - Handle errors gracefully (feature failures don't crash agent)
 * - Provide unified cleanup interface
 */
export class FeatureInitializer {
  private context: FeatureContext;
  private features: InitializedFeatures = {};
  private currentProtocols: Record<string, any> | null = null;

  constructor(context: FeatureContext) {
    this.context = context;
  }

  /**
   * Initialize sensor features (can run in parallel)
   * - Protocol Adapters: Create Unix sockets for data output (Modbus, OPC-UA, etc.)
   * - SensorPublish: Connect to Unix sockets and publish to MQTT
   */
  async initSensorFeatures(): Promise<void> {
    // Initialize protocol adapters FIRST (they create the Unix sockets)
    await this.initProtocolAdapters();
    
    // Initialize sensor publish (connects to sockets created by protocol adapters)
    await this.initSensorPublish();
    
    // Store discoveryService reference if available
    if (this.context.discoveryService) {
      this.features.discoveryService = this.context.discoveryService;
    }
    
    // Store current protocols BEFORE setting up listener to prevent duplicate initialization
    const protocols = this.context.stateReconciler.getTargetState()?.config?.protocols || {};
    this.currentProtocols = this.deepClone(protocols);
    
    // Set up event-driven protocol adapter initialization for future changes
    this.setupProtocolAdapterListener();
    
    // Watch for new enabled endpoints from discovery (auto-reload Sensor Publish)
    this.setupEndpointAutoReloadListener();
  }

  /**
   * Initialize jobs feature (cloud job polling and execution)
   */
  async initJobsFeature(): Promise<void> {
    await this.initJobs();
  }

  /**
   * Initialize supporting features (can run in parallel)
   * Updater, Firewall, and Config Handler depend on optional features being initialized
   */
  async initSupportingFeatures(): Promise<void> {
    await Promise.all([
      this.initAgentUpdater(),
      this.initFirewall(),
      this.initSensorConfigHandler()
    ]);
  }

  /**
   * Get initialized features
   */
  getFeatures(): InitializedFeatures {
    return this.features;
  }

  // ============================================================================
  // PRIVATE INITIALIZATION METHODS
  // ============================================================================

  private async initJobs(): Promise<void> {
    const { logger, deviceInfo, configSettings, cloudApiEndpoint } = this.context;

    try {
      const cloudApiUrl = process.env.CLOUD_API_URL || cloudApiEndpoint;
      const pollingIntervalMs =
        configSettings.cloudJobsPollingIntervalMs ||
        parseInt(process.env.CLOUD_JOBS_POLLING_INTERVAL || "30000", 10);

      this.features.jobs = new JobsFeature(
        {
          enabled: true,
          cloudApiUrl,
          deviceApiKey: deviceInfo.apiKey,
          pollingIntervalMs,
          maxRetries: 3,
          handlerDirectory: process.env.JOB_HANDLER_DIR || "/app/data/job-handlers",
          maxConcurrentJobs: 1,
          defaultHandlerTimeout: 60000,
        },
        logger,
        deviceInfo.uuid
      );

      await this.features.jobs.start();

      logger.debugSync('Jobs Feature initialized', {
        component: LogComponents.agent,
        mode: this.features.jobs.getCurrentMode(),
        mqttActive: this.features.jobs.isMqttActive(),
        httpActive: this.features.jobs.isHttpActive(),
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Jobs Feature', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Jobs'
      });
      this.features.jobs = undefined;
    }
  }

  private async initSensorPublish(): Promise<void> {
    const { logger, deviceInfo, anomalyService } = this.context;

    logger.infoSync('Initializing Sensor Publish Feature', {
      component: LogComponents.agent
    });

    try {
      const mem1 = process.memoryUsage();
      logger.debugSync('Memory before imports', {
        component: LogComponents.agent,
        heapUsed: `${Math.round(mem1.heapUsed / 1024 / 1024)}MB`
      });
      
      // Load sensor output configurations from database
      const { EndpointOutputModel: EndpointOutputModel } = await import('../db/models/endpoint-outputs.model.js');
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      
      const mem2 = process.memoryUsage();
      logger.debugSync('Memory after imports', {
        component: LogComponents.agent,
        heapUsed: `${Math.round(mem2.heapUsed / 1024 / 1024)}MB`
      });
      
      // Apply buffer capacities from target state to endpoint_outputs table
      await this.applyBufferCapacitiesFromTargetState(EndpointOutputModel, logger);
      
      const mem3 = process.memoryUsage();
      logger.debugSync('Memory after applyBufferCapacities', {
        component: LogComponents.agent,
        heapUsed: `${Math.round(mem3.heapUsed / 1024 / 1024)}MB`
      });
      
      const endpointOutputs = await EndpointOutputModel.getAll();

      const mem4 = process.memoryUsage();
      logger.debugSync('Memory after getAll()', {
        component: LogComponents.agent,
        heapUsed: `${Math.round(mem4.heapUsed / 1024 / 1024)}MB`,
        outputCount: endpointOutputs.length
      });

      if (endpointOutputs.length === 0) {
        logger.warnSync('No sensor outputs configured in database', {
          component: LogComponents.agent,
          note: 'Run migrations to create default endpoint_outputs entries'
        });
        return;
      }

      // Get all enabled protocols
      const allEndpoints = await DeviceEndpointModel.getAll();
      const enabledEndpoints = new Set(
        allEndpoints.filter((s: any) => s.enabled).map((s: any) => s.protocol)
      );

      if (enabledEndpoints.size === 0) {
        logger.warnSync('No enabled protocol adapters found', {
          component: LogComponents.agent,
          note: 'Enable endpoints in database before starting Sensor Publish'
        });
        return;
      }

      // Build sensor configs only for enabled protocols
      // bufferCapacity is configured per-protocol in endpoint_outputs table:
      // - OPC UA: 1MB (large discovery messages with many nodes)
      // - Modbus: 128KB (standard register responses)
      // - CAN: 64KB (bus messages)
      // - SNMP: 128KB (trap messages)
      const endpoints = endpointOutputs
        .filter(output => enabledEndpoints.has(output.protocol))
        .map((output) => ({
          name: `${output.protocol}-pipe`,
          addr: output.socket_path,
          eomDelimiter: output.delimiter || '\n',
          mqttTopic: output.protocol,
          bufferCapacity: output.buffer_capacity || 1024 * 1024, // Default 1MB, configurable per protocol
          bufferSize: 12,
          bufferTimeMs: 60000,
          enabled: true,
        }));

      if (endpoints.length === 0) {
        logger.warnSync('No pipes to read from', {
          component: LogComponents.agent,
          enabledProtocols: Array.from(enabledEndpoints)
        });
        return;
      }

      const sensorConfig = {
        enabled: true,
        endpoints,
      };

      this.features.sensorPublish = new SensorPublishFeature(
        sensorConfig as any,
        logger,
        deviceInfo.uuid
      );

      // Configure edge AI anomaly detection if enabled
      if (anomalyService) {
        const { configureAnomalyFeed } = await import('../features/sensor-publish/sensor.js');
        configureAnomalyFeed(anomalyService);

        logger.debugSync('Configured edge AI anomaly detection for sensor data', {
          component: LogComponents.agent,
          sensorCount: endpoints.length
        });
      }

      await this.features.sensorPublish.start();

      const memUsage = process.memoryUsage();
      logger.debugSync('Sensor Publish Feature initialized', {
        component: LogComponents.agent,
        pipeCount: endpoints.length,
        enabledProtocols: Array.from(enabledEndpoints),
        pipes: endpoints.map(s => s.addr),
        mqttTopicPattern: 'iot/device/{deviceUuid}/endpoints/{topic}',
        memoryUsage: {
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
        }
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Sensor Publish Feature', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Sensor Publish'
      });
      this.features.sensorPublish = undefined;
    }
  }

  /**
   * Apply buffer capacities from target state to endpoint_outputs table
   */
  private async applyBufferCapacitiesFromTargetState(
    EndpointOutputModel: any,
    logger: AgentLogger
  ): Promise<void> {
    // Import models for direct query
    const { models } = await import('../db/connection.js');

    try {
      // Memory checkpoint 1: Before accessing configProtocols
      const mem1 = process.memoryUsage();
      logger.debugSync('Memory at start of applyBufferCapacities', {
        component: LogComponents.agent,
        heapUsed: `${(mem1.heapUsed / 1024 / 1024).toFixed(0)}MB`
      });

      const protocols = this.context.configProtocols || {};
      
      // Memory checkpoint 2: After accessing configProtocols
      const mem2 = process.memoryUsage();
      logger.debugSync('Memory after accessing configProtocols', {
        component: LogComponents.agent,
        heapUsed: `${(mem2.heapUsed / 1024 / 1024).toFixed(0)}MB`,
        protocolKeys: Object.keys(protocols),
        protocolsSize: JSON.stringify(protocols).length
      });
      
      // Map of protocol names to buffer capacities from target state
      const bufferCapacities: Record<string, number | undefined> = {
        'opcua': protocols.opcua?.bufferCapacity,
        'modbus': protocols.modbus?.bufferCapacity,
        'can': protocols.can?.bufferCapacity,
        'snmp': protocols.snmp?.bufferCapacity,
      };

      // Memory checkpoint 3: After creating bufferCapacities map
      const mem3 = process.memoryUsage();
      logger.debugSync('Memory after creating bufferCapacities map', {
        component: LogComponents.agent,
        heapUsed: `${(mem3.heapUsed / 1024 / 1024).toFixed(0)}MB`
      });

      // Update each protocol's buffer capacity if specified in target state
      for (const [protocol, bufferCapacity] of Object.entries(bufferCapacities)) {
        if (bufferCapacity !== undefined) {
          // Memory checkpoint 4: Before getOutput
          const mem4 = process.memoryUsage();
          logger.debugSync(`Memory before getOutput for ${protocol}`, {
            component: LogComponents.agent,
            protocol,
            heapUsed: `${(mem4.heapUsed / 1024 / 1024).toFixed(0)}MB`
          });

          // CRITICAL FIX: Only select needed columns to avoid loading massive logging field
          const output = await models('endpoint_outputs')
            .where('protocol', protocol)
            .select('protocol', 'buffer_capacity')
            .first();
          
          // Memory checkpoint 5: After getOutput
          const mem5 = process.memoryUsage();
          logger.debugSync(`Memory after getOutput for ${protocol}`, {
            component: LogComponents.agent,
            protocol,
            heapUsed: `${(mem5.heapUsed / 1024 / 1024).toFixed(0)}MB`,
            hasOutput: !!output
          });

          if (output) {
            await models('endpoint_outputs')
              .where('protocol', protocol)
              .update({
                buffer_capacity: bufferCapacity,
                updated_at: new Date()
              });
            
            logger.debugSync(`Updated buffer capacity for ${protocol}`, {
              component: LogComponents.agent,
              protocol,
              bufferCapacity,
              bufferCapacityMB: (bufferCapacity / 1024 / 1024).toFixed(2)
            });
          }
        }
      }
    } catch (error) {
      logger.warnSync('Failed to apply buffer capacities from target state', {
        component: LogComponents.agent,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async initProtocolAdapters(): Promise<void> {
    const { logger, deviceInfo, configFeatures, configProtocols } = this.context;

    try {
      // Protocols is now the single source of truth (includes both enabled flag and config)
      const protocols = configProtocols || {};
      const legacyAdapters = configFeatures.protocolAdapters || {}; // Backward compatibility
      
      // Build sensor config with backward compatibility
      // Priority: config.protocols.* (all fields) → config.protocolAdapters.* (legacy fallback)
      const sensorsConfig: SensorConfig = {
        enabled: true,
        modbus: {
          enabled: protocols.modbus?.enabled ?? legacyAdapters.modbus?.enabled ?? false,
          // Merge config: protocols takes priority, then legacy protocolAdapters
          ...(legacyAdapters.modbus || {}),
          ...(protocols.modbus || {})
        },
        opcua: {
          enabled: protocols.opcua?.enabled ?? legacyAdapters.opcua?.enabled ?? false,
          ...(legacyAdapters.opcua || {}),
          ...(protocols.opcua || {})
        },
        snmp: {
          enabled: protocols.snmp?.enabled ?? legacyAdapters.snmp?.enabled ?? false,
          ...(legacyAdapters.snmp || {}),
          ...(protocols.snmp || {})
        },
        can: {
          enabled: protocols.can?.enabled ?? legacyAdapters.can?.enabled ?? false,
          ...(protocols.can || {})
        },
        comap: {
          enabled: protocols.comap?.enabled ?? legacyAdapters.comap?.enabled ?? false,
          ...(protocols.comap || {})
        },
        mqtt: {
          enabled: protocols.mqtt?.enabled ?? legacyAdapters.mqtt?.enabled ?? false,
          ...(legacyAdapters.mqtt || {}),
          ...(protocols.mqtt || {})
        }
      };

      // Check environment variable for config override
      const envConfigStr = process.env.PROTOCOL_ADAPTERS_CONFIG;
      if (envConfigStr) {
        try {
          const envConfig = JSON.parse(envConfigStr);
          Object.assign(sensorsConfig, envConfig);
          logger.debugSync('Loaded protocol adapters config from PROTOCOL_ADAPTERS_CONFIG', {
            component: LogComponents.agent
          });
        } catch (error) {
          logger.warnSync('Failed to parse PROTOCOL_ADAPTERS_CONFIG, using target state config', {
            component: LogComponents.agent
          });
        }
      }

      // Log enabled protocols from config
      const configEnabledProtocols = Object.entries(sensorsConfig)
        .filter(([key, value]) => key !== 'enabled' && typeof value === 'object' && value?.enabled)
        .map(([key]) => key);

      // Check database for enabled devices (even if config doesn't enable the protocol)
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      const dbProtocolsWithDevices: string[] = [];
      
      // ✅ Include 'mqtt' in protocol check
      for (const protocol of ['modbus', 'opcua', 'snmp', 'can', 'mqtt']) {
        const devices = await DeviceEndpointModel.getEnabled(protocol);
        if (devices.length > 0) {
          dbProtocolsWithDevices.push(protocol);
          // Enable the protocol in config if it has database devices
          if (!sensorsConfig[protocol]?.enabled) {
            if (!sensorsConfig[protocol]) {
              sensorsConfig[protocol] = { enabled: true };
            } else {
              sensorsConfig[protocol].enabled = true;
            }
          }
        }
      }

      const enabledProtocols = [...new Set([...configEnabledProtocols, ...dbProtocolsWithDevices])];
      
      if (enabledProtocols.length === 0) {
        logger.debugSync('No protocols enabled, skipping Protocol Adapters initialization', {
          component: LogComponents.agent
        });
        return;
      }


      this.features.sensors = new SensorsFeature(
        sensorsConfig,
        logger,
        deviceInfo.uuid
      );

      await this.features.sensors.start();

      logger.debugSync('Protocol Adapters initialized', {
        component: LogComponents.agent,
        enabledProtocols
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Protocol Adapters', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Protocol Adapters'
      });
      this.features.sensors = undefined;
    }
  }

  /**
   * Set up event-driven protocol adapter initialization
   * Listens for target-state-changed events and reinitializes protocol adapters when config changes
   */
  private setupProtocolAdapterListener(): void {
    const { logger, stateReconciler } = this.context;

    logger.infoSync('Setting up protocol adapter event listener', {
      component: LogComponents.agent
    });

    stateReconciler.on('target-state-changed', async (state: any) => {
      try {
        const protocols = state.config?.protocols || {};
        await this.handleProtocolConfigChange(protocols);
      } catch (error) {
        logger.errorSync('Failed to handle protocol config change', error as Error, {
          component: LogComponents.agent
        });
      }
    });
  }

  /**
   * Setup listener for endpoint-enabled events from discovery
   * Automatically reloads Sensor Publish when new enabled endpoints are discovered
   */
  private setupEndpointAutoReloadListener(): void {
    const { logger } = this.context;
    
    if (!this.features.discoveryService) {
      logger.debugSync('Discovery service not available, skipping endpoint auto-reload setup', {
        component: LogComponents.agent
      });
      return;
    }

    // Listen for individual endpoint-enabled events (real-time updates)
    this.features.discoveryService.on('endpoint-enabled', async (data: any) => {
      // Skip individual reloads during batch discovery - discovery-complete handler will reload everything
      if (data.isBatchDiscovery) {
        logger.debugSync('Skipping individual reload during batch discovery', {
          component: LogComponents.agent,
          protocol: data.protocol,
          endpoint: data.endpoint.name,
          note: 'Will reload after discovery completes'
        });
        return;
      }

      logger.infoSync('New enabled endpoint discovered, reloading Sensor Publish', {
        component: LogComponents.agent,
        protocol: data.protocol,
        endpoint: data.endpoint.name
      });

      try {
        // Stop existing Sensor Publish
        if (this.features.sensorPublish) {
          await this.features.sensorPublish.stop();
          logger.debugSync('Stopped Sensor Publish for reload', {
            component: LogComponents.agent
          });
          this.features.sensorPublish = undefined;
        }

        // Reinitialize with new endpoints
        await this.initSensorPublish();

        logger.infoSync('Sensor Publish reloaded successfully', {
          component: LogComponents.agent,
          newEndpoint: data.endpoint.name
        });
      } catch (error) {
        logger.errorSync('Failed to reload Sensor Publish', error as Error, {
          component: LogComponents.agent,
          endpoint: data.endpoint.name
        });
      }
    });

    // Listen for discovery-complete events (batch reload after full discovery)
    this.features.discoveryService.on('discovery-complete', async (data: any) => {
      logger.infoSync('Discovery completed, checking if adapters need to be reloaded', {
        component: LogComponents.agent,
        trigger: data.trigger,
        deviceCount: data.deviceCount,
        savedCount: data.savedCount,
        skippedCount: data.skippedCount
      });

      // Only reload protocol adapters if NEW devices were discovered
      // Skip reload if all devices were skipped (already exist)
      if (data.savedCount > 0) {
        try {
          logger.infoSync('Reloading protocol adapters after discovery', {
            component: LogComponents.agent,
            savedCount: data.savedCount,
            skippedCount: data.skippedCount
          });

          // Stop protocol adapters
          if (this.features.sensors) {
            await this.features.sensors.stop();
            this.features.sensors = undefined;
          }

          // Reinitialize protocol adapters (will read discovered devices from database)
          await this.initProtocolAdapters();

          // On first boot, ALWAYS reload Sensor Publish to pick up new endpoints from database
          // After first boot, Sensor Publish will auto-reconnect (no reload needed)
          if (data.trigger === 'first_boot') {
            logger.infoSync('Reloading Sensor Publish for first boot discovery', {
              component: LogComponents.agent,
              deviceCount: data.deviceCount
            });

            if (this.features.sensorPublish) {
              await this.features.sensorPublish.stop();
              this.features.sensorPublish = undefined;
            }
            
            await this.initSensorPublish();
          }

          logger.infoSync('Protocol adapters reloaded after discovery', {
            component: LogComponents.agent,
            trigger: data.trigger,
            deviceCount: data.deviceCount,
            sensorPublishReloaded: data.trigger === 'first_boot'
          });
        } catch (error) {
          logger.errorSync('Failed to reload protocol adapters after discovery', error as Error, {
            component: LogComponents.agent
          });
        }
      }
    });

    logger.infoSync('Endpoint auto-reload watcher initialized', {
      component: LogComponents.agent,
      note: 'Sensor Publish will reload automatically when discovery finds new enabled endpoints'
    });
  }

  /**
   * Handle protocol configuration changes
   * Compares new config with current, stops existing adapters if needed, reinitializes with new config
   */
  private async handleProtocolConfigChange(protocols: Record<string, any>): Promise<void> {
    const { logger } = this.context;

    // Check if protocols actually changed
    const changed = this.hasProtocolConfigChanges(protocols);

    if (!changed) {
      return; // No changes, skip reinitialization
    }

    logger.infoSync('Protocol configuration changed, reinitializing', {
      component: LogComponents.agent,
      protocols
    });

    // CRITICAL: Stop Sensor Publish FIRST to avoid reconnect errors when socket is deleted
    if (this.features.sensorPublish) {
      try {
        await this.features.sensorPublish.stop();
        logger.debugSync('Stopped Sensor Publish before protocol adapter restart', {
          component: LogComponents.agent
        });
      } catch (error) {
        logger.warnSync('Error stopping sensor publish', {
          component: LogComponents.agent,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.features.sensorPublish = undefined;
    }

    // Stop existing protocol adapters if running
    if (this.features.sensors) {
      try {
        await this.features.sensors.stop();
        logger.infoSync('Stopped existing protocol adapters', {
          component: LogComponents.agent
        });
      } catch (error) {
        logger.warnSync('Error stopping protocol adapters', {
          component: LogComponents.agent,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Update context with new protocols config
    this.context.configProtocols = protocols;

    // Always reinitialize protocol adapters (will check database even if config is empty)
    // Sensor Publish will auto-reconnect to new sockets (no manual reload needed)
    await this.initProtocolAdapters();

    logger.infoSync('Protocol adapters reloaded, Sensor Publish will auto-reconnect', {
      component: LogComponents.agent
    });

    // Store for next comparison
    this.currentProtocols = this.deepClone(protocols);

  }

  /**
   * Check if protocol configuration has changed
   */
  private hasProtocolConfigChanges(newProtocols: Record<string, any>): boolean {
    // First time, always initialize
    if (!this.currentProtocols) {
      // Always return true on first call - let initProtocolAdapters check database
      return true;
    }

    // Check for enabled status changes
    const protocolKeys = ['modbus', 'opcua', 'snmp', 'can', 'comap'];
    for (const key of protocolKeys) {
      const oldEnabled = this.currentProtocols[key]?.enabled ?? false;
      const newEnabled = newProtocols[key]?.enabled ?? false;
      if (oldEnabled !== newEnabled) {
        return true;
      }
    }

    // Check for config value changes (deep comparison)
    return !this.deepEqual(newProtocols, this.currentProtocols);
  }

  /**
   * Deep equality check for objects
   */
  private deepEqual(obj1: any, obj2: any): boolean {
    if (obj1 === obj2) return true;
    if (obj1 == null || obj2 == null) return false;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return obj1 === obj2;

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
      if (!keys2.includes(key)) return false;
      if (!this.deepEqual(obj1[key], obj2[key])) return false;
    }

    return true;
  }

  /**
   * Deep clone an object
   */
  private deepClone(obj: any): any {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this.deepClone(item));
    
    const cloned: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = this.deepClone(obj[key]);
      }
    }
    return cloned;
  }

  private async initSensorConfigHandler(): Promise<void> {
    const { logger } = this.context;

    // Only initialize if Sensor Publish is enabled
    if (!this.features.sensorPublish) {
      return;
    }

    logger.debugSync('Initializing Sensor Config Handler', {
      component: LogComponents.agent
    });

    try {
      this.features.sensorConfigHandler = new SensorConfigHandler(
        this.features.sensorPublish,
        logger as any
      );

      this.features.sensorConfigHandler.start();

      // Report initial sensor state
      try {
        const sensors = this.features.sensorPublish.getSensors();
        const sensorStates: Record<string, any> = {};

        // Add sensor-publish sensors
        sensors.forEach((sensor) => {
          sensorStates[sensor.name] = {
            enabled: sensor.enabled,
            addr: sensor.addr,
            publishInterval: sensor.publishInterval,
          };
        });

        // Add protocol adapter device statuses
        if (this.features.sensors) {
          const allDeviceStatuses = await this.features.sensors.getAllDeviceStatuses();

          Object.entries(allDeviceStatuses).forEach(([deviceName, device]) => {
            sensorStates[deviceName] = {
              type: device.protocol || 'unknown',
              deviceName: device.name || deviceName,
              connected: device.status === 'online',
              lastPoll: device.lastSeenAt || null,
              errorCount: 0,
              lastError: null,
            };
          });
        }
      } catch (error) {
        logger.errorSync('Failed to report initial sensor state', error as Error, {
          component: LogComponents.agent
        });
      }

      logger.debugSync('Sensor Config Handler initialized', {
        component: LogComponents.agent
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Sensor Config Handler', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without remote sensor configuration'
      });
      this.features.sensorConfigHandler = undefined;
    }
  }

  private async initAgentUpdater(): Promise<void> {
    const { logger, deviceInfo } = this.context;

    try {
      this.features.updater = new AgentUpdater({
        deviceUuid: deviceInfo.uuid,
        logger
      });

      await this.features.updater.initialize();

      logger.debugSync('Agent Updater initialized', {
        component: LogComponents.agent
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Agent Updater', error as Error, {
        component: LogComponents.agent,
        note: 'Remote agent updates will not be available'
      });
      this.features.updater = undefined;
    }
  }

  private async initFirewall(): Promise<void> {
    const { logger, configSettings, deviceApiPort } = this.context;

    // Check if firewall is disabled via environment variable
    // Firewall is infrastructure security, controlled at deployment time only
    if (process.env.FIREWALL_ENABLED === 'false') {
      logger.debugSync('Firewall disabled by environment variable', {
        component: LogComponents.agent,
      });
      return;
    }

    // Get firewall configuration from config or environment
    const firewallMode = 
      configSettings.firewallMode || 
      process.env.FIREWALL_MODE || 
      'auto';
    
    // Check if running as root (required for iptables)
    const hasGetuid = typeof process.getuid === 'function';
    
    if (!hasGetuid) {
      logger.warnSync('Firewall disabled - cannot detect root privileges', {
        component: LogComponents.agent,
        note: 'Firewall requires root privileges to manage iptables',
      });
      return;
    }
    
    const uid = process.getuid!();
    if (uid !== 0) {
      logger.warnSync('Firewall disabled - requires root privileges', {
        component: LogComponents.agent,
        note: 'Run container with --privileged or set FIREWALL_ENABLED=false',
        uid,
      });
      return;
    }

    // Determine MQTT port (if Mosquitto is running locally)
    const mqttPort = process.env.MQTT_LOCAL_PORT 
      ? parseInt(process.env.MQTT_LOCAL_PORT) 
      : undefined;

    this.features.firewall = new AgentFirewall(
      {
        enabled: true,
        mode: firewallMode as 'on' | 'off' | 'auto',
        deviceApiPort,
        mqttPort,
      },
      logger
    );

    await this.features.firewall.initialize();

    logger.debugSync('Firewall initialized', {
      component: LogComponents.agent,
      mode: firewallMode
    });
  }

  /**
   * Cleanup all initialized features
   */
  async cleanup(): Promise<void> {
    const { logger } = this.context;

    // Stop Sensor Publish
    if (this.features.sensorPublish) {
      await this.features.sensorPublish.stop();
      logger.debugSync('Sensor Publish stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Protocol Adapters
    if (this.features.sensors) {
      await this.features.sensors.stop();
      logger.debugSync('Protocol Adapters stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Sensor Config Handler
    if (this.features.sensorConfigHandler) {
      // No explicit stop method, just clear reference
      logger.debugSync('Sensor Config Handler cleanup', {
        component: LogComponents.agent,
      });
    }

    // Stop Jobs Feature
    if (this.features.jobs) {
      await this.features.jobs.stop();
      logger.debugSync('Jobs Feature stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Agent Updater
    if (this.features.updater) {
      // No explicit stop method
      logger.debugSync('Agent Updater cleanup', {
        component: LogComponents.agent,
      });
    }

    // Stop Firewall
    if (this.features.firewall) {
      // Firewall has no explicit cleanup method
      logger.debugSync('Firewall cleanup', {
        component: LogComponents.agent,
      });
    }
  }
}
