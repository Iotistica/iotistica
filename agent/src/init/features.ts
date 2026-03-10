/**
 * Feature Initializer
 * 
 * Handles initialization of optional agent features in a clean, modular way.
 * Separates feature orchestration from the main agent class.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { DeviceInfo } from '../managers/types.js';
import type { AgentInitContext } from './core.js';
import { LogComponents } from '../logging/types';
import { JobsFeature } from '../features/jobs/src/monitor.js';
import { DiscoveryService } from '../features/discovery/discovery-service.js';

import { SensorPublishFeature } from '../features/publish/index.js';
import { SensorsFeature, type SensorConfig } from '../features/adapters/index.js';
import { AgentUpdater } from '../updater.js';
import { AgentFirewall } from '../network/firewall.js';
import { MqttManager } from '../mqtt/manager.js';
import { StateReconciler } from '../managers/reconciler.js';
import { getPackageVersion } from '../utils/api-utils.js';

export interface FeatureContext {
  logger: AgentLogger;
  deviceInfo: DeviceInfo;
  mqttManager: MqttManager;
  httpClient: any; // Shared HTTP client with connection pooling (singleton pattern)
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
  dictionaryManager?: any; // Dictionary manager for MQTT message key compaction
}

export interface InitializedFeatures {
  jobs?: JobsFeature;
  sensorPublish?: SensorPublishFeature;
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

    logger.infoSync('Initializing Device Publish Feature', {
      component: LogComponents.agent
    });

    try {
      // Load sensor output configurations from database
      const { EndpointOutputModel: DeviceOutputModel } = await import('../db/models/endpoint-outputs.model.js');
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      
      const deviceOutputs = await DeviceOutputModel.getAll();

      if (deviceOutputs.length === 0) {
        logger.warnSync('No device outputs configured in database', {
          component: LogComponents.agent,
          note: 'Run migrations to create default endpoint_outputs entries'
        });
        return;
      }

      // Get all enabled protocols
      const allDevices = await DeviceEndpointModel.getAll();
      const enabledDevices = new Set(
        allDevices.filter((s: any) => s.enabled).map((s: any) => s.protocol)
      );

      if (enabledDevices.size === 0) {
        logger.warnSync('No enabled devices found', {
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
        logger.warnSync('No pipes to read from', {
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

      this.features.sensorPublish = new SensorPublishFeature(
        sensorConfig as any,
        logger,
        deviceInfo.uuid,
        this.context.dictionaryManager, // Pass dictionary manager for message compression
        useMsgpackPoc, // Pass msgpack compression flag
        useKeyCompactionPoc, // Pass key compaction flag
        useDeflatePoc // Pass deflate compression flag
      );

      // Configure edge AI anomaly detection if enabled
      if (anomalyService) {
        const { configureAnomalyFeed } = await import('../features/publish/manager.js');
        configureAnomalyFeed(anomalyService);

        logger.debugSync('Configured edge AI anomaly detection for device data', {
          component: LogComponents.agent,
          sensorCount: devices.length
        });
      }

      await this.features.sensorPublish.start();

      logger.debugSync('Device Publish Feature initialized', {
        component: LogComponents.agent,
        pipeCount: devices.length,
        enabledProtocols: Array.from(enabledDevices),
        pipes: devices.map(s => s.addr),
        mqttTopicPattern: 'iot/device/{deviceUuid}/endpoints/{topic}'
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
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      const enabledProtocols: string[] = [];
      
      for (const protocol of ['modbus', 'opcua', 'snmp', 'can', 'mqtt']) {
        const devices = await DeviceEndpointModel.getEnabled(protocol);
        if (devices.length > 0) {
          enabledProtocols.push(protocol);
          // Enable the protocol adapter since we have enabled endpoints
          if (!devicesConfig[protocol]) {
            devicesConfig[protocol] = { enabled: true };
          } else {
            devicesConfig[protocol].enabled = true;
          }
        }
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

      // Reload protocol adapters and Sensor Publish for manual/scheduled discovery
      // For config-change triggers, wait for reconciliation-complete instead to avoid race conditions
      // - first_boot: Initial discovery scan
      // - manual: User-triggered discovery
      // - config-change: Skip here, reload after reconciliation completes
      const shouldReload = data.trigger !== 'config-change' && data.savedCount > 0;
      
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
            logger.infoSync('Updated CloudSync endpoints reference after reload', {
              component: LogComponents.agent
            });
          }

          logger.infoSync('Protocol adapters and Sensor Publish reloaded successfully', {
            component: LogComponents.agent,
            trigger: data.trigger,
            deviceCount: data.deviceCount
          });
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

    // Listen for reconciliation-complete to reload after config changes (avoids race with discovery)
    if (this.context.stateReconciler) {
      this.context.stateReconciler.on('reconciliation-complete', async () => {
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

  private async initShellHandler(): Promise<void> {
    const { logger, deviceInfo, mqttManager } = this.context;

    try {
      const { ShellHandler } = await import('../shell/shell-handler.js');
      
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
	const agentLogger = ctx.features.getAgentLogger();

	const memBefore = process.memoryUsage();
	agentLogger.debugSync('Memory before loading target state', {
		component: 'Agent' as any,
		heapUsed: `${Math.round(memBefore.heapUsed / 1024 / 1024)}MB`
	});

	const targetState = ctx.features.getTargetState();
	const targetStateSize = targetState ? JSON.stringify(targetState).length : 0;

	const memAfterState = process.memoryUsage();
	agentLogger.debugSync('Memory after loading target state', {
		component: 'Agent' as any,
		heapUsed: `${Math.round(memAfterState.heapUsed / 1024 / 1024)}MB`,
		targetStateSize,
		targetStateSizeMB: (targetStateSize / 1024 / 1024).toFixed(2),
		hasConfig: !!targetState?.config,
		hasProtocols: !!targetState?.config?.protocols,
		hasSettings: !!targetState?.config?.settings
	});

	const featureContext: FeatureContext = {
		logger: agentLogger,
		deviceInfo: ctx.features.getDeviceInfo(),
		deviceManager: ctx.features.getDeviceManager(),
		stateReconciler: ctx.features.getStateReconciler(),
		mqttManager: (await import('../mqtt/manager.js')).MqttManager.getInstance(),
		httpClient: ctx.features.getSharedHttpClient(),
		containerManager: ctx.features.getContainerManager(),
		configSettings: targetState?.config?.settings || {},
		configFeatures: ctx.features.getConfigManagerFeatures(),
		configProtocols: targetState?.config?.protocols || {},
		cloudApiEndpoint: ctx.features.getCloudApiEndpoint(),
		deviceApiPort: ctx.features.getDeviceApiPort(),
		anomalyService: ctx.features.getAnomalyService(),
		dictionaryManager: ctx.features.getDictionaryManager()
	};

	const memAfterContext = process.memoryUsage();
	agentLogger.debugSync('Memory after creating featureContext', {
		component: 'Agent' as any,
		heapUsed: `${Math.round(memAfterContext.heapUsed / 1024 / 1024)}MB`
	});

	const initializer = new FeatureInitializer(featureContext);
	ctx.features.setFeatureInitializer(initializer);

	await ctx.features.initDiscoveryService();
	featureContext.discoveryService = ctx.features.getDiscoveryService();

	await initializer.initSensorFeatures();
	await initializer.initJobsFeature();
	await ctx.features.initializeSimulationMode();

	agentLogger?.infoSync('About to initialize supporting features', {
		component: LogComponents.agent
	});
	await initializer.initSupportingFeatures();

	const initializedFeatures = initializer.getFeatures();
	agentLogger?.infoSync('Supporting features initialized', {
		component: LogComponents.agent,
		hasUpdater: !!initializedFeatures.updater,
		hasFirewall: !!initializedFeatures.firewall
	});

	ctx.features.setUpdater(initializedFeatures.updater);
	ctx.features.setFirewall(initializedFeatures.firewall);

	if (initializedFeatures.updater) {
		agentLogger?.infoSync('Setting AgentUpdater on StateReconciler', {
			component: LogComponents.agent,
			hasUpdater: true
		});
		ctx.features.setStateReconcilerUpdater(initializedFeatures.updater);
	} else {
		agentLogger?.warnSync('AgentUpdater not initialized, version reconciliation unavailable', {
			component: LogComponents.agent
		});
	}
}

export async function initDiscoveryService(agent: any): Promise<void> {
	agent.agentLogger?.infoSync('Initializing Discovery Service', {
		component: LogComponents.agent,
	});

	try {
		agent.discoveryService = new DiscoveryService(agent.agentLogger, agent.configManager);
		await agent.discoveryService.init();
	} catch (error) {
		agent.agentLogger?.errorSync('Failed to initialize Discovery Service', error as Error, {
			component: LogComponents.agent,
		});
		agent.discoveryService = undefined;
	}
}


