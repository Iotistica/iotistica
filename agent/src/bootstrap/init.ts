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
}

export interface InitializedFeatures {
  jobs?: JobsFeature;
  sensorPublish?: SensorPublishFeature;
  sensors?: SensorsFeature;
  sensorConfigHandler?: SensorConfigHandler;
  updater?: AgentUpdater;
  firewall?: AgentFirewall;
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
    
    // Store current protocols BEFORE setting up listener to prevent duplicate initialization
    const protocols = this.context.stateReconciler.getTargetState()?.config?.protocols || {};
    this.currentProtocols = this.deepClone(protocols);
    
    // Set up event-driven protocol adapter initialization for future changes
    this.setupProtocolAdapterListener();
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

      logger.infoSync('Jobs Feature initialized', {
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
      // Load sensor output configurations from database
      const { EndpointOutputModel: EndpointOutputModel } = await import('../db/models/endpoint-outputs.model.js');
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      
      const endpointOutputs = await EndpointOutputModel.getAll();

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
      const endpoints = endpointOutputs
        .filter(output => enabledEndpoints.has(output.protocol))
        .map((output) => ({
          name: `${output.protocol}-pipe`,
          addr: output.socket_path,
          eomDelimiter: output.delimiter || '\n',
          mqttTopic: output.protocol,
          bufferCapacity: 4096,
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

        logger.infoSync('Configured edge AI anomaly detection for sensor data', {
          component: LogComponents.agent,
          sensorCount: endpoints.length
        });
      }

      await this.features.sensorPublish.start();

      logger.infoSync('Sensor Publish Feature initialized', {
        component: LogComponents.agent,
        pipeCount: endpoints.length,
        enabledProtocols: Array.from(enabledEndpoints),
        pipes: endpoints.map(s => s.addr),
        mqttTopicPattern: 'iot/device/{deviceUuid}/endpoints/{topic}'
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Sensor Publish Feature', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Sensor Publish'
      });
      this.features.sensorPublish = undefined;
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
      
      for (const protocol of ['modbus', 'opcua', 'snmp', 'can']) {
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
        logger.infoSync('No protocols enabled, skipping Protocol Adapters initialization', {
          component: LogComponents.agent
        });
        return;
      }

      logger.infoSync('Initializing Protocol Adapters', {
        component: LogComponents.agent,
        enabledProtocols
      });

      this.features.sensors = new SensorsFeature(
        sensorsConfig,
        logger,
        deviceInfo.uuid
      );

      await this.features.sensors.start();

      logger.infoSync('Protocol Adapters initialized', {
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
    await this.initProtocolAdapters();

    // Reinitialize sensor_publish since protocol adapters changed
    // Sensor outputs (Unix sockets) are now available
    if (this.features.sensors) {
      logger.infoSync('Reinitializing Sensor Publish after protocol adapter changes', {
        component: LogComponents.agent
      });

      // Stop existing sensor publish if running
      if (this.features.sensorPublish) {
        try {
          await this.features.sensorPublish.stop();
        } catch (error) {
          logger.warnSync('Error stopping sensor publish', {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.features.sensorPublish = undefined;
      }

      // Restart sensor publish with new endpoints
      await this.initSensorPublish();
    }

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

    logger.infoSync('Initializing Sensor Config Handler', {
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

      logger.infoSync('Sensor Config Handler initialized', {
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
      const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
      
      this.features.updater = new AgentUpdater({
        deviceUuid: deviceInfo.uuid,
        currentVersion,
        logger
      });

      await this.features.updater.initialize();

      logger.infoSync('Agent Updater initialized', {
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
      logger.infoSync('Firewall disabled by environment variable', {
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

    logger.infoSync('Firewall initialized', {
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
      logger.infoSync('Sensor Publish stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Protocol Adapters
    if (this.features.sensors) {
      await this.features.sensors.stop();
      logger.infoSync('Protocol Adapters stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Sensor Config Handler
    if (this.features.sensorConfigHandler) {
      // No explicit stop method, just clear reference
      logger.infoSync('Sensor Config Handler cleanup', {
        component: LogComponents.agent,
      });
    }

    // Stop Jobs Feature
    if (this.features.jobs) {
      await this.features.jobs.stop();
      logger.infoSync('Jobs Feature stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop Agent Updater
    if (this.features.updater) {
      // No explicit stop method
      logger.infoSync('Agent Updater cleanup', {
        component: LogComponents.agent,
      });
    }

    // Stop Firewall
    if (this.features.firewall) {
      // Firewall has no explicit cleanup method
      logger.infoSync('Firewall cleanup', {
        component: LogComponents.agent,
      });
    }
  }
}
