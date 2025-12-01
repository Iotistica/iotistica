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

  constructor(context: FeatureContext) {
    this.context = context;
  }

  /**
   * Initialize optional features (can run in parallel)
   * Jobs, SensorPublish, and Protocol Adapters are independent
   */
  async initializeOptionalFeatures(): Promise<void> {
    await Promise.all([
      this.initJobs(),
      this.initSensorPublish(),
      this.initProtocolAdapters()
    ]);
  }

  /**
   * Initialize supporting features (can run in parallel)
   * Updater, Firewall, and Config Handler depend on optional features being initialized
   */
  async initializeSupportingFeatures(): Promise<void> {
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
      
      const sensorOutputs = await EndpointOutputModel.getAll();

      if (sensorOutputs.length === 0) {
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
      const sensors = sensorOutputs
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

      if (sensors.length === 0) {
        logger.warnSync('No pipes to read from (no enabled protocols)', {
          component: LogComponents.agent,
          enabledProtocols: Array.from(enabledEndpoints)
        });
        return;
      }

      const sensorConfig = {
        enabled: true,
        sensors,
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
          sensorCount: sensors.length
        });
      }

      await this.features.sensorPublish.start();

      logger.infoSync('Sensor Publish Feature initialized', {
        component: LogComponents.agent,
        pipeCount: sensors.length,
        enabledProtocols: Array.from(enabledEndpoints),
        pipes: sensors.map(s => s.addr),
        mqttTopicPattern: 'iot/device/{deviceUuid}/sensor/{topic}'
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
    const { logger, deviceInfo, configFeatures } = this.context;

    try {
      const sensorsConfig: SensorConfig = {
        enabled: true,
        ...configFeatures.protocolAdapters,
      };

      // Enable Modbus by default if ENABLE_PROTOCOL_ADAPTERS is set
      if (process.env.ENABLE_PROTOCOL_ADAPTERS === 'true') {
        sensorsConfig.modbus = {
          enabled: true,
          ...(sensorsConfig.modbus || {})
        };
        logger.debugSync('Enabled Modbus protocol adapter from ENABLE_PROTOCOL_ADAPTERS', {
          component: LogComponents.agent
        });
      }

      // Enable SNMP by default if ENABLE_PROTOCOL_ADAPTERS is set
      if (process.env.ENABLE_PROTOCOL_ADAPTERS === 'true') {
        sensorsConfig.snmp = {
          enabled: true,
          ...(sensorsConfig.snmp || {})
        };
        logger.debugSync('Enabled SNMP protocol adapter from ENABLE_PROTOCOL_ADAPTERS', {
          component: LogComponents.agent
        });
      }

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

      this.features.sensors = new SensorsFeature(
        sensorsConfig,
        logger,
        deviceInfo.uuid
      );

      await this.features.sensors.start();

      logger.infoSync('Protocol Adapters initialized', {
        component: LogComponents.agent
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Protocol Adapters', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Protocol Adapters'
      });
      this.features.sensors = undefined;
    }
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

    // Get firewall configuration from config or environment
    const firewallMode = 
      configSettings.firewallMode || 
      process.env.FIREWALL_MODE || 
      'auto';
    
    // Check if firewall is enabled
    if (firewallMode === 'disabled' || process.env.FIREWALL_ENABLED === 'false') {
      logger.infoSync('Firewall disabled by configuration', {
        component: LogComponents.agent,
      });
      return;
    }
    
    // Check if running as root (required for iptables)
    const hasGetuid = typeof process.getuid === 'function';
    
    if (!hasGetuid) {
      logger.warnSync('Firewall disabled - cannot detect root privileges', {
        component: LogComponents.agent,
        note: 'Set FIREWALL_ENABLED=false to suppress this warning',
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
