/**
 * Feature Initializer
 * 
 * Handles initialization of optional agent features in a clean, modular way.
 * Separates feature orchestration from the main agent class.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { DeviceInfo } from '../managers/types.js';
import type { AgentInitContext } from './context.js';
import { LogComponents } from '../logging/types';
import { JobsFeature } from '../features/jobs/monitor.js';
import { DiscoveryService } from '../features/adapters/discovery-service.js';

import { DevicePublishFeature } from '../features/publish/index.js';
import { SensorsFeature, type SensorConfig } from '../features/adapters/index.js';
import type { PipelineService } from '../features/pipeline/index.js';
import { AgentUpdater } from '../updater.js';
import { AgentFirewall } from '../network/firewall.js';
import { MqttManager } from '../mqtt/manager.js';
import { MQTT_TOPIC_PATTERNS } from '../mqtt/topics.js';
import { StateManager } from '../managers/state.js';
import { getPackageVersion } from '../utils/api-utils.js';

export interface FeatureContext {
  logger: AgentLogger;
  deviceInfo: DeviceInfo;
  mqttManager: MqttManager;
  httpClient: any; // Shared HTTP client with connection pooling (singleton pattern)
  containerManager: any;
  deviceManager: any;
  stateReconciler: StateManager;
  configSettings: Record<string, any>;
  configFeatures: Record<string, any>;
  configProtocols?: Record<string, any>; // New: protocols section from target state
  cloudApiEndpoint: string;
  deviceApiPort: number;
  anomalyService?: any;
  discoveryService?: any; // Discovery service for endpoint auto-reload
  dictionaryManager?: any; // Dictionary manager for MQTT message key compaction
  pipelineService?: PipelineService; // Node-RED payload transform pipeline (optional)
  liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];
}

export interface InitializedFeatures {
  jobs?: JobsFeature;
  sensorPublish?: DevicePublishFeature;
  sensors?: SensorsFeature;
  updater?: AgentUpdater;
  firewall?: AgentFirewall;
  shellHandler?: any; // Shell handler for remote terminal access
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
  private cloudSync?: any; // CloudSync reference for updating endpoints after auto-reload

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
    await this.initDevicePublish();
    
    // Store discoveryService reference if available
    if (this.context.discoveryService) {
      this.features.discoveryService = this.context.discoveryService;
    }
    
    // Watch for new enabled endpoints from discovery (auto-reload Sensor Publish)
    // Protocol enablement is now driven by endpoints, not config.protocols
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
      this.initShellHandler(),
      this.initFirewall()
    ]);
  }

  /**
   * Get initialized features
   */
  getFeatures(): InitializedFeatures {
    return this.features;
  }

  public setAnomalyService(anomalyService?: any): void {
    this.context.anomalyService = anomalyService;
    this.features.sensorPublish?.setAnomalyService?.(anomalyService);
  }

  public setPipelineService(pipeline?: PipelineService): void {
    this.context.pipelineService = pipeline;
    this.features.sensorPublish?.setPipelineService?.(pipeline);
  }

  public setLiveDataInterceptor(interceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[]): void {
    this.context.liveDataInterceptor = interceptor;
    this.features.sensorPublish?.setLiveDataInterceptor?.(interceptor);
  }

  private isDevicePublishEnabled(): boolean {
    const dynamicFeatures = this.context.stateReconciler?.getConfigManager?.().getFeatures?.();
    if (dynamicFeatures && typeof dynamicFeatures.enableDeviceSensorPublish === 'boolean') {
      return dynamicFeatures.enableDeviceSensorPublish;
    }

    return this.context.configFeatures?.enableDeviceSensorPublish
      ?? this.context.configFeatures?.enableSensorPublish
      ?? false;
  }

  private isDeviceRemoteAccessEnabled(): boolean {
    const dynamicFeatures = this.context.stateReconciler?.getConfigManager?.().getFeatures?.();
    if (dynamicFeatures && typeof dynamicFeatures.enableDeviceRemoteAccess === 'boolean') {
      return dynamicFeatures.enableDeviceRemoteAccess;
    }

    return this.context.configFeatures?.enableDeviceRemoteAccess ?? true;
  }

  /**
   * Set CloudSync reference for updating endpoints after auto-reload
   * Called from agent.ts after CloudSync creation
   */
  setCloudSync(cloudSync: any): void {
    this.cloudSync = cloudSync;
  }

  // ============================================================================
  // PRIVATE INITIALIZATION METHODS
  // ============================================================================

  private async initJobs(): Promise<void> {
    const { logger, deviceInfo, configSettings, cloudApiEndpoint, configFeatures } = this.context;

    const deviceJobsEnabled = configFeatures?.enableDeviceJobs !== false;

    if (!deviceJobsEnabled) {
      logger.infoSync('Jobs Feature skipped by feature toggle', {
        component: LogComponents.agent,
        enableDeviceJobs: deviceJobsEnabled,
      });
      this.features.jobs = undefined;
      return;
    }

    try {
      const cloudApiUrl = process.env.CLOUD_API_URL || cloudApiEndpoint;
      const pollingIntervalMs =
        configSettings.cloudJobsPollingIntervalMs ||
        parseInt(process.env.CLOUD_JOBS_POLLING_INTERVAL || "30000", 10);

      this.features.jobs = new JobsFeature(
        {
          enabled: deviceJobsEnabled,
          cloudApiUrl,
          deviceApiKey: deviceInfo.apiKey,
          pollingIntervalMs,
          maxRetries: 3,
          handlerDirectory: process.env.JOB_HANDLER_DIR || `${process.env.DATA_DIR || '/app/data'}/job-handlers`,
          maxConcurrentJobs: 1,
          defaultHandlerTimeout: 60000,
        },
        logger,
        deviceInfo.uuid,
        this.context.httpClient // Use shared HTTP client for connection pooling
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

  /**
   * Initialize sensor publish feature (lightweight reload)
   * Reads endpoint configuration from database and starts Sensor Publish
   */
  async initDevicePublish(): Promise<void> {
    const { logger, deviceInfo, anomalyService } = this.context;

    const devicePublishEnabled = this.isDevicePublishEnabled();
    if (!devicePublishEnabled) {
      const wasRunning = !!this.features.sensorPublish;
      if (wasRunning) {
        try {
          await this.features.sensorPublish!.stop();
        } catch (error) {
          logger.warnSync('Failed to stop Device Publish while disabled by feature toggle', {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        this.features.sensorPublish = undefined;
        // Dynamic runtime disable — log at INFO so operators know it was explicitly turned off
        logger.infoSync('Device Publish Feature disabled by feature toggle', {
          component: LogComponents.agent,
          enableDeviceSensorPublish: devicePublishEnabled,
        });
      } else {
        // Feature is disabled in local state before cloud sync has delivered the real
        // target state — this fires on every startup and resolves after reconciliation.
        // Log at DEBUG only to avoid misleading the operator.
        logger.debugSync('Device Publish Feature skipped (disabled in current state, pending cloud sync)', {
          component: LogComponents.agent,
          enableDeviceSensorPublish: devicePublishEnabled,
        });
      }
      return;
    }


    try {
      // Load sensor output configurations from database
      const { EndpointOutputModel: DeviceOutputModel } = await import('../db/models/endpoint-outputs.model.js');
      const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
      
      const deviceOutputs = await DeviceOutputModel.getAll();

      if (deviceOutputs.length === 0) {
        logger.infoSync('No device outputs configured in database', {
          component: LogComponents.agent,
          note: 'Run migrations to create default endpoint_outputs entries'
        });
        return;
      }

      // Get all enabled protocols
      const allDevices = await EndpointModel.getAll();
      const validDevices = allDevices.filter((s: any) => !!s.uuid);
      const invalidDevices = allDevices.length - validDevices.length;

      if (invalidDevices > 0) {
        logger.warnSync('Ignoring endpoints without UUID during Device Publish initialization', {
          component: LogComponents.agent,
          invalidCount: invalidDevices,
          totalCount: allDevices.length
        });
      }

      const enabledDevices = new Set(
        validDevices.filter((s: any) => s.enabled).map((s: any) => s.protocol)
      );

      if (enabledDevices.size === 0) {
        logger.infoSync('No enabled devices found', {
          component: LogComponents.agent,
          note: 'Enable devices in database before starting Device Publish'
        });
        return;
      }

      // Build sensor configs only for enabled protocols
      // bufferCapacity is configured per-protocol in endpoint_outputs table:
      // - OPC UA: 1MB (large discovery messages with many nodes)
      // - Modbus: 128KB (standard register responses)
      // - CAN: 64KB (bus messages)
      // - SNMP: 128KB (trap messages)
      const devices = deviceOutputs
        .filter(output => enabledDevices.has(output.protocol))
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

      if (devices.length === 0) {
        logger.infoSync('No pipes to read from', {
          component: LogComponents.agent,
          enabledProtocols: Array.from(enabledDevices)
        });
        return;
      }

      const sensorConfig = {
        enabled: true,
        endpoints: devices,
      };

      // Read compression flags from environment (configured at agent startup)
      const useMsgpackPoc = process.env.USE_MSGPACK_POC === 'true';
      const useKeyCompactionPoc = process.env.USE_KEY_COMPACTION_POC === 'true';
      const useDeflatePoc = process.env.USE_DEFLATE_COMPRESSION === 'true';

      this.features.sensorPublish = new DevicePublishFeature(
        sensorConfig as any,
        logger,
        deviceInfo.uuid,
        this.context.dictionaryManager,
        useMsgpackPoc,
        useKeyCompactionPoc,
        useDeflatePoc,
        anomalyService,
      );

      if (this.context.pipelineService) {
        this.features.sensorPublish.setPipelineService(this.context.pipelineService);
      }

      if (this.context.liveDataInterceptor) {
        this.features.sensorPublish.setLiveDataInterceptor(this.context.liveDataInterceptor);
      }

      await this.features.sensorPublish.start();

      logger.debugSync('Device Publish Feature initialized', {
        component: LogComponents.agent,
        pipeCount: devices.length,
        enabledProtocols: Array.from(enabledDevices),
        pipes: devices.map(s => s.addr),
        mqttTopicPattern: MQTT_TOPIC_PATTERNS.tenantScopedEndpoints
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Device Publish Feature', error as Error, {
        component: LogComponents.agent,
        note: 'Continuing without Sensor Publish'
      });
      this.features.sensorPublish = undefined;
    }
  }

  private async initProtocolAdapters(): Promise<void> {
    const { logger, deviceInfo } = this.context;

    try {
      // Protocol enablement is now database-driven (based on config.endpoints)
      // No more config.protocols or config.protocolAdapters - endpoints determine which protocols are enabled
      
      // Initialize base config with all protocols disabled
      const devicesConfig: SensorConfig = {
        enabled: true,
        modbus: { enabled: false },
        opcua: { enabled: false },
        snmp: { enabled: false },
        can: { enabled: false },
        comap: { enabled: false },
        mqtt: { enabled: false }
      };

  
      // Check database for enabled endpoints - this enables the protocol adapter
      const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
      const enabledProtocols: string[] = [];
      
      for (const protocol of ['modbus', 'opcua', 'snmp', 'can', 'mqtt']) {
        const devices = await EndpointModel.getEnabled(protocol);
        const validDevices = devices.filter((d: any) => !!d.uuid);

        if (validDevices.length > 0) {
          enabledProtocols.push(protocol);
          // Enable the protocol adapter since we have enabled endpoints
          if (!devicesConfig[protocol]) {
            devicesConfig[protocol] = { enabled: true };
          } else {
            devicesConfig[protocol].enabled = true;
          }
        } else if (devices.length > 0) {
          logger.warnSync('Ignoring enabled endpoints without UUID for protocol startup', {
            component: LogComponents.agent,
            protocol,
            invalidCount: devices.length
          });
        }
      }

      // MQTT adapter starts whenever MQTT_BROKER_URL is set, even with zero DB endpoints.
      // It connects as a superuser to mosquitto-agent for device data collection and discovery.
      // The startMQTTAdapter() implementation already handles the zero-devices case gracefully.
      if (!enabledProtocols.includes('mqtt') && process.env.MQTT_BROKER_URL) {
        enabledProtocols.push('mqtt');
        devicesConfig.mqtt = { enabled: true };
        logger.infoSync('Enabling MQTT adapter via MQTT_BROKER_URL (no DB endpoints required)', {
          component: LogComponents.agent,
          brokerUrl: process.env.MQTT_BROKER_URL
        });
      }
      
      // ALWAYS create SensorsFeature even if no protocols are enabled initially
      // This ensures health reporting works when endpoints are discovered later
      this.features.sensors = new SensorsFeature(
        devicesConfig,
        logger,
        deviceInfo.uuid
      );

      if (enabledProtocols.length === 0) {
        logger.debugSync('No protocols enabled initially, SensorsFeature created but not started', {
          component: LogComponents.agent,
          note: 'Will be started when endpoints are enabled via discovery or config'
        });
        // Don't return - we still need to set up listeners and make feature available
      } else {
        await this.features.sensors.start();
      }
      
      // Make sensors feature available to device API
      const { setSensorsFeature } = await import('../api/actions.js');
      setSensorsFeature(this.features.sensors);

      // Wire up rediscovery-needed listener on each new SensorsFeature instance.
      // When the OPC-UA server switches profiles (e.g., simulator hot-reload), all stored
      // NodeIDs become invalid. The adapter detects the high failure rate and emits this
      // event so we can re-browse the server and update the database with fresh nodes.
      // Calling runDiscovery() directly bypasses pre-discovery, so sensorPublish keeps running.
      // If savedCount > 0, discovery-complete fires and handles the full adapter reload.
      // If savedCount = 0 (server still mid-reload), the adapter retries via its own backoff
      // and will re-emit rediscovery-needed after the 30-second cooldown.
      if (this.features.discoveryService) {
        this.features.sensors.on('rediscovery-needed', async (data: { deviceName: string; endpointUrl: string }) => {
          logger.warnSync('OPC-UA adapter detected stale NodeIDs - triggering targeted rediscovery', {
            component: LogComponents.agent,
            deviceName: data.deviceName,
            endpointUrl: data.endpointUrl,
            note: 'Server may have switched profiles; will re-browse after brief stabilization delay'
          });
          try {
            // Short delay to let the server finish reloading after a profile switch
            await new Promise<void>(resolve => setTimeout(resolve, 3000));
            await this.features.discoveryService!.runDiscovery({
              trigger: 'manual',
              protocols: ['opcua'],
              validate: true,
              forceRun: true
            });
          } catch (error) {
            logger.errorSync('Rediscovery triggered by OPC-UA adapter failed', error as Error, {
              component: LogComponents.agent,
              deviceName: data.deviceName
            });
          }
        });
      }

      logger.debugSync('Protocol Adapters initialized (database-driven)', {
        component: LogComponents.agent,
        enabledProtocols,
        source: 'config.endpoints'
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

    // Listen for pre-discovery event (stops features before discovery runs)
    // This frees up IPC connection slots to prevent "max clients reached" errors
    this.features.discoveryService.on('pre-discovery', async (data: any) => {
      logger.infoSync('Preparing for discovery - stopping Sensor Publish to free connection slots', {
        component: LogComponents.agent,
        protocols: data.protocols,
        trigger: data.trigger
      });

      try {
        if (this.features.sensorPublish) {
          await this.features.sensorPublish.stop();
          logger.debugSync('Stopped Sensor Publish before discovery', {
            component: LogComponents.agent
          });
          this.features.sensorPublish = undefined;
        }
      } catch (error) {
        logger.errorSync('Failed to stop Sensor Publish before discovery', error as Error, {
          component: LogComponents.agent
        });
      }
    });

    // Listen for individual endpoint-enabled events (real-time updates from discovery)
    this.features.discoveryService.on('endpoint-enabled', async (data: any) => {
      // Skip individual reloads during batch discovery - discovery-complete handler will reload everything
      if (data.isBatchDiscovery) {
        logger.debugSync('Skipping individual reload during batch discovery', {
          component: LogComponents.agent,
          protocol: data.protocol,
          endpoint: data.name,
          note: 'Will reload after discovery completes'
        });
        return;
      }

      logger.infoSync('New enabled endpoint discovered, reloading Sensor Publish', {
        component: LogComponents.agent,
        protocol: data.protocol,
        endpoint: data.name,
        source: data.source
      });

      try {
        // Stop existing Sensor Publish if not already stopped (e.g., direct-connection endpoints)
        // Note: For discovery targets, pre-discovery event already stopped it
        if (this.features.sensorPublish) {
          await this.features.sensorPublish.stop();
          logger.debugSync('Stopped Sensor Publish for reload', {
            component: LogComponents.agent
          });
          this.features.sensorPublish = undefined;
        }

        // Reinitialize with new endpoints (DB already synced before event emission)
        await this.initDevicePublish();

        logger.infoSync('Sensor Publish reloaded successfully', {
          component: LogComponents.agent,
          newEndpoint: data.name
        });
      } catch (error) {
        logger.errorSync('Failed to reload Sensor Publish', error as Error, {
          component: LogComponents.agent,
          endpoint: data.name
        });
      }
    });

    // Listen for discovery-complete events (batch reload after discovery OR direct-connection endpoints)
    // This event is emitted by:
    // 1. Discovery service after scanning for devices with slaveRange
    // 2. ConfigManager after direct-connection endpoints (slaveId only) are added
    this.features.discoveryService.on('discovery-complete', async (data: any) => {

      // Reload whenever discovery actually wrote data to the database.
      // For config-change: reconciliation-complete fires first (before discovery finishes),
      // so adapters get started with empty data_points. discovery-complete fires AFTER
      // discovery writes the real data_points — this is the only correct moment to reload.
      const shouldReload = data.savedCount > 0;
      
      if (shouldReload) {
        try {
          logger.infoSync('Reloading protocol adapters and Sensor Publish after endpoint changes', {
            component: LogComponents.agent,
            trigger: data.trigger,
            savedCount: data.savedCount,
            skippedCount: data.skippedCount,
            reason: data.trigger === 'config-change' ? 'DB already synced by reconcile' : 'new devices discovered'
          });

          // Stop protocol adapters
          if (this.features.sensors) {
            await this.features.sensors.stop();
            this.features.sensors = undefined;
          }

          // Stop Sensor Publish
          if (this.features.sensorPublish) {
            await this.features.sensorPublish.stop();
            this.features.sensorPublish = undefined;
          }

          // Reinitialize protocol adapters (will read endpoints from database)
          await this.initProtocolAdapters();

          // Reinitialize Sensor Publish (will read endpoints from database)
          await this.initDevicePublish();

          // CRITICAL: Update CloudSync's endpoints reference to new SensorsFeature instance
          // Without this, CloudSync tries to collect health from the old (stopped) instance
          if (this.cloudSync && this.features.sensors) {
            this.cloudSync.setDevices(this.features.sensors);
          }

        } catch (error) {
          logger.errorSync('Failed to reload protocol adapters after discovery', error as Error, {
            component: LogComponents.agent
          });
        }
      } else {
        logger.debugSync('Skipping reload - no new devices discovered', {
          component: LogComponents.agent,
          trigger: data.trigger,
          savedCount: data.savedCount,
          skippedCount: data.skippedCount
        });
      }
    });

    logger.infoSync('Endpoint auto-reload watcher initialized', {
      component: LogComponents.agent,
      note: 'Sensor Publish will reload automatically when discovery finds new enabled endpoints'
    });

    // Listen for reconciliation-complete to reload after config changes.
    // IMPORTANT: If discovery is currently running (e.g., a new OPC-UA device was just added),
    // we must NOT reload here — the DB still has empty data_points at this point.
    // discovery-complete will fire once discovery writes the real data_points and will
    // handle the reload at that point.
    if (this.context.stateReconciler) {
      this.context.stateReconciler.on('reconciliation-complete', async () => {
        if (this.features.discoveryService?.isDiscoveryRunning()) {
          logger.infoSync('Skipping adapter reload on reconciliation-complete — discovery in progress; will reload on discovery-complete', {
            component: LogComponents.agent
          });
          return;
        }

        try {
          logger.infoSync('Reloading protocol adapters after reconciliation complete', {
            component: LogComponents.agent,
            trigger: 'reconciliation-complete'
          });

          // Stop protocol adapters
          if (this.features.sensors) {
            await this.features.sensors.stop();
            this.features.sensors = undefined;
          }

          // Stop Sensor Publish
          if (this.features.sensorPublish) {
            await this.features.sensorPublish.stop();
            this.features.sensorPublish = undefined;
          }

          // Reinitialize protocol adapters (will read endpoints from database)
          await this.initProtocolAdapters();

          // Reinitialize Sensor Publish (will read endpoints from database)
          await this.initDevicePublish();

          // Update CloudSync's endpoints reference
          if (this.cloudSync && this.features.sensors) {
            this.cloudSync.setDevices(this.features.sensors);
            logger.infoSync('Updated CloudSync endpoints reference after reload', {
              component: LogComponents.agent
            });
          }

          logger.infoSync('Protocol adapters reloaded after reconciliation', {
            component: LogComponents.agent
          });
        } catch (error) {
          logger.errorSync('Failed to reload after reconciliation', error as Error, {
            component: LogComponents.agent
          });
        }
      });

      logger.infoSync('Reconciliation reload watcher initialized', {
        component: LogComponents.agent,
        note: 'Protocol adapters reload after reconciliation completes (not during discovery)'
      });
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

  async initShellHandler(): Promise<void> {
    const { logger, deviceInfo, mqttManager } = this.context;

    const deviceRemoteAccessEnabled = this.isDeviceRemoteAccessEnabled();
    if (!deviceRemoteAccessEnabled) {
      if (this.features.shellHandler) {
        try {
          await this.features.shellHandler.cleanup();
        } catch (error) {
          logger.warnSync('Failed to stop Shell Handler while disabled by feature toggle', {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      this.features.shellHandler = undefined;
      logger.infoSync('Shell handler skipped by feature toggle', {
        component: LogComponents.agent,
        enableDeviceRemoteAccess: deviceRemoteAccessEnabled,
      });
      return;
    }

    try {
      const { ShellHandler } = await import('../features/remote-access/shell-handler.js');
      
      this.features.shellHandler = new ShellHandler(
        deviceInfo.uuid,
        mqttManager,
        logger
      );

      await this.features.shellHandler.initialize();

      logger.infoSync('Shell handler initialized (remote terminal access enabled)', {
        component: LogComponents.agent
      });
    } catch (error) {
      logger.errorSync('Failed to initialize Shell Handler', error as Error, {
        component: LogComponents.agent,
        note: 'Remote terminal access will not be available'
      });
      this.features.shellHandler = undefined;
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
  /**
   * Cleanup all features
   * @param preserveShell - If true, skip shell handler cleanup (for restarts)
   */
  async cleanup(preserveShell: boolean = false): Promise<void> {
    const { logger } = this.context;

    // Stop Sensor Publish
    if (this.features.sensorPublish) {
      await this.features.sensorPublish.stop();
      logger.debugSync('Sensor Publish stopped', {
        component: LogComponents.agent,
      });
    }

    // Stop pipeline (after sensorPublish so no in-flight transforms at shutdown)
    if (this.context.pipelineService) {
      await this.context.pipelineService.stop();
      logger.debugSync('Pipeline stopped', {
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

    // Stop Shell Handler (skip during restart to preserve remote sessions)
    if (this.features.shellHandler && !preserveShell) {
      await this.features.shellHandler.cleanup();
      logger.debugSync('Shell Handler stopped', {
        component: LogComponents.agent,
      });
    } else if (preserveShell) {
      logger.debugSync('Shell Handler preserved (restart mode)', {
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

// ============================================================================
// BOOTSTRAP PHASE HELPERS
// ============================================================================

export async function initFeatures(ctx: AgentInitContext): Promise<void> {
  const agentLogger = ctx.agentLogger!;

  const targetState = ctx.stateReconciler!.getTargetState();

	const featureContext: FeatureContext = {
		logger: agentLogger,
    deviceInfo: ctx.deviceInfo,
    deviceManager: ctx.deviceManager,
    stateReconciler: ctx.stateReconciler,
		mqttManager: (await import('../mqtt/manager.js')).MqttManager.getInstance(),
    httpClient: ctx.sharedHttpClient,
    containerManager: ctx.containerManager,
		configSettings: targetState?.config?.settings || {},
    configFeatures: ctx.configManager!.getFeatures(),
		configProtocols: targetState?.config?.protocols || {},
    cloudApiEndpoint: ctx.configManager!.getCloudApiEndpoint(),
    deviceApiPort: ctx.configManager!.getDeviceApiPort(),
    anomalyService: ctx.anomalyService,
    dictionaryManager: ctx.dictionaryManager,
    pipelineService: ctx.pipelineService,
	};

	const initializer = new FeatureInitializer(featureContext);
  ctx.featureInitializer = initializer;

  await initDiscoveryService(ctx);
  featureContext.discoveryService = ctx.discoveryService;

  // Initialize Node-RED pipeline before sensor publish so it is bound at start
  const { initPipeline } = await import('./pipeline.js');
  await initPipeline(ctx);
  if (ctx.pipelineService) {
    featureContext.pipelineService = ctx.pipelineService;
    initializer.setPipelineService(ctx.pipelineService);
  }

	await initializer.initSensorFeatures();
	await initializer.initJobsFeature();

	// Anomaly detection must be initialized before simulation so producer-mode scenarios can feed the shared pipeline.
  const { initAnomalyDetection } = await import('./ai.js');
  await initAnomalyDetection(ctx);

  const { initSimulationMode } = await import('./simulation.js');
  await initSimulationMode(ctx);

	await initializer.initSupportingFeatures();

	const initializedFeatures = initializer.getFeatures();
  agentLogger?.infoSync('Feature initialization complete', {
    component: LogComponents.agent,
    jobs: !!initializedFeatures.jobs,
    sensors: !!initializedFeatures.sensors,
    sensorPublish: !!initializedFeatures.sensorPublish,
    updater: !!initializedFeatures.updater,
    firewall: !!initializedFeatures.firewall,
    discovery: !!ctx.discoveryService,
  });

  ctx.updater = initializedFeatures.updater;
  ctx.firewall = initializedFeatures.firewall;

	if (initializedFeatures.updater) {
    ctx.stateReconciler?.setAgentUpdater(initializedFeatures.updater);
	} else {
		agentLogger?.warnSync('AgentUpdater not initialized, version reconciliation unavailable', {
			component: LogComponents.agent
		});
	}
}

export async function initDiscoveryService(ctx: AgentInitContext): Promise<void> {

	try {
    ctx.discoveryService = new DiscoveryService(ctx.agentLogger!, ctx.configManager!);
    await ctx.discoveryService.init();
	} catch (error) {
    ctx.agentLogger?.errorSync('Failed to initialize Discovery Service', error as Error, {
			component: LogComponents.agent,
		});
    ctx.discoveryService = undefined;
	}
}


