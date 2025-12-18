/**
 * Device Agent
 *
 * Orchestrates all device-side operations:
 * - Container management
 * - Device provisioning
 * - System monitoring
 * - Device API server
 * - Logging
 */

import { StateReconciler, DeviceState } from "./device-manager/reconciler.js";
import ContainerManager from "./compose/container-manager.js";
import { DeviceManager } from "./device-manager/index.js";
import type { DeviceInfo } from "./device-manager/types.js";
import { DeviceAPI } from "./api/index.js";
import { router as v1Router } from "./api/v1.js";
import * as deviceActions from "./api/actions.js";
import { CloudSync } from "./device-manager/sync.js";
import * as db from "./db/connection.js";
import { LocalLogBackend } from "./logging/local-backend.js";
import { CloudLogBackend } from "./logging/cloud-backend.js";
import { ContainerLogMonitor } from "./logging/docker-monitor.js";
import { AgentLogger } from "./logging/agent-logger.js";
import type { LogLevel } from "./logging/types.js";
import { LogComponents } from "./logging/types.js";

import { MqttManager } from "./mqtt/manager.js";
import { getPackageVersion } from "./utils/api-utils";

import { AgentFirewall } from "./network/firewall.js";
import { AgentUpdater } from "./updater.js";
import { getMacAddress, getOsVersion } from "./system/metrics.js";
import * as fs from 'fs';
import { 
  healthcheck as memoryHealthcheck, 
  setMemoryLogger,
  startMemoryMonitoring,
  stopMemoryMonitoring,
  startMemoryLeakSimulation,
  stopMemoryLeakSimulation
} from "./system/memory.js";
import { AnomalyDetectionService } from "./ai/anomaly/index.js";
import { loadConfigFromEnv, loadConfigFromTargetState } from "./ai/anomaly/utils.js";
import { SimulationOrchestrator, loadSimulationConfig } from "./simulation/index.js";
import { DiscoveryService } from "./features/discovery/discovery-service.js";
import { FeatureInitializer, type FeatureContext } from "./bootstrap/init.js";
import { AgentConfig } from "./config/agent-config.js";

/**
 * Load boot configuration from file
 * Priority: /data/iotistic/boot-config.json (Yocto) or BOOT_CONFIG_PATH env var
 */
function loadBootConfig(): Record<string, any> | null {
  const bootConfigPath = process.env.BOOT_CONFIG_PATH || '/data/iotistic/boot-config.json';
  
  try {
    if (fs.existsSync(bootConfigPath)) {
      const content = fs.readFileSync(bootConfigPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn(`Failed to load boot config from ${bootConfigPath}:`, error);
  }
  
  return null;
}

export default class DeviceAgent {
  private stateReconciler!: StateReconciler; // Main state manager
  private containerManager!: ContainerManager; // Keep for backward compatibility with DeviceAPI
  private deviceManager!: DeviceManager;
  private deviceInfo!: DeviceInfo; // Cache device info after initialization
  private deviceAPI!: DeviceAPI;
  private cloudSync?: CloudSync;
  private logMonitor?: ContainerLogMonitor;
  private agentLogger!: AgentLogger; // Structured logging for agent-level events
  private firewall?: AgentFirewall; // Network firewall protection
  private updater?: AgentUpdater; // Agent self-update handler
  private featureInitializer?: FeatureInitializer;
  private anomalyService?: AnomalyDetectionService; // Edge-based AI anomaly detection for metrics and sensors
  private simulationOrchestrator?: SimulationOrchestrator; // Simulation framework for testing
  private discoveryService?: DiscoveryService; // Protocol discovery (Modbus, OPC-UA, CAN, etc.)
  private agentConfig!: AgentConfig; // Configuration accessor (cloud → device.json → hardcoded fallback)

  // System settings (config-driven with env var defaults)
  // Note: All settings now accessed via agentConfig getters (intervals, endpoints, ports, etc.)
  // Scheduled restart timer (controlled from cloud config)
  private scheduledRestartTimer?: NodeJS.Timeout;

  // Note: Configuration change handling moved to AgentConfig reactive layer
  // AgentConfig listens to StateReconciler events and applies changes automatically

  constructor() {
    // StateReconciler and AgentConfig will be initialized in init()
    // (StateReconciler needs async init() to load target state from SQLite)
  }

  public async init(): Promise<void> {

      // Initialize database FIRST (needed by StateReconciler)
      await this.initDatabase();

      // Initialize StateReconciler and AgentConfig EARLY (before logging setup)
      // This ensures AgentConfig can read target state from SQLite database
      await this.initializeStateReconciler();

      // Initialize logging (now AgentConfig is available)
      const loggingConfig = this.agentConfig.getLoggingConfig();
      const logLevel = (loggingConfig.logLevel as LogLevel) || "info";
      
      const localBackend = new LocalLogBackend({
        maxLogs: loggingConfig.maxLogs!,
        maxAge: loggingConfig.logMaxAge!,
        enableFilePersistence: loggingConfig.enableFilePersistence!,
        logDir: loggingConfig.logDir!,
        maxFileSize: loggingConfig.maxLogFileSize!,
      });
      await localBackend.initialize();
      
      this.agentLogger = new AgentLogger(localBackend, logLevel);

      // Initialize device provisioning
      await this.initializeDeviceManager();

      // Initialize cloud logging if device is provisioned
      await this.initializeCloudLogging();

      // Parallelize independent initializations (MQTT and Container Manager)
      // StateReconciler already initialized, so just get ContainerManager reference
      await Promise.all([
        this.initializeMqttManager(),      // ~300-500ms
        this.initContainerManager()       // ~200-300ms (just setup, no init)
      ]);
      // Saves ~300-500ms compared to sequential execution

      // Initialize device API
      await this.initDeviceAPI();

     
      // Initialize optional features using FeatureInitializer
      const featureContext: FeatureContext = {
        logger: this.agentLogger,
        deviceInfo: this.deviceInfo,
        deviceManager: this.deviceManager,
        stateReconciler: this.stateReconciler,
        mqttManager: MqttManager.getInstance(),
        containerManager: this.containerManager,
        configSettings: this.stateReconciler.getTargetState()?.config?.settings || {},
        configFeatures: this.agentConfig.getFeatures(),
        configProtocols: this.stateReconciler.getTargetState()?.config?.protocols || {},
        cloudApiEndpoint: this.agentConfig.getCloudApiEndpoint(),
        deviceApiPort: this.agentConfig.getDeviceApiPort(),
        anomalyService: this.anomalyService
      };

      this.featureInitializer = new FeatureInitializer(featureContext);

      // Initialize Discovery Service
      await this.initDiscoveryService();
      
      // Update feature context with discoveryService
      featureContext.discoveryService = this.discoveryService;

      // Initialize sensor features (sensor publish + protocol adapters)
      await this.featureInitializer.initSensorFeatures();

      // Initialize jobs feature (cloud job polling/execution)
      await this.featureInitializer.initJobsFeature();

      // NOTE: Anomaly Detection initialization is DEFERRED until after CloudSync fetches target state
      // This ensures we respect cloud-configured feature flags (not just local/env variables)
  

      // 10.5. Initialize Simulation Orchestrator
      await this.initializeSimulationMode();

      // init sync
      await this.initDeviceSync();

      // 11.5. Start periodic discovery timers
      this.discoveryService?.startPeriodicDiscovery();

      // 11-13. Initialize supporting features (updater, firewall, sensor config handler)
      await this.featureInitializer.initSupportingFeatures();

      // Store references for backward compatibility
      const features = this.featureInitializer.getFeatures();
      this.updater = features.updater;
      this.firewall = features.firewall;

      // 14. Start auto-reconciliation
      this.startAutoReconciliation();

      // 15. Start active memory monitoring (independent of healthcheck endpoint)
      this.startMemoryMonitoring();

      // 16. Initialize reactive AgentConfig layer (handles all config changes automatically)
      this.agentConfig.initialize({
        logger: this.agentLogger,
        containerManager: this.containerManager,
        cloudSync: this.cloudSync,
        discoveryService: this.discoveryService,
      });

      // Setup AgentConfig event listeners for actions requiring Agent context
      this.agentConfig.on('restart-discovery-timers', (intervals: any) => {
        // Restart discovery timers with new intervals
        this.discoveryService?.startPeriodicDiscovery();
      });

      this.agentConfig.on('schedule-restart', ({ restartTimeMs, restartConfig }: any) => {
        // Schedule the restart
        this.scheduledRestartTimer = setTimeout(async () => {
          this.agentLogger?.infoSync("Initiating scheduled restart", {
            component: LogComponents.agent,
            trigger: "scheduled_timer",
            reason: restartConfig.reason || "heap_fragmentation_cleanup",
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
          });

          try {
            await this.stop();
            this.agentLogger?.infoSync("Graceful shutdown complete, exiting for restart", {
              component: LogComponents.agent,
              exitCode: 0
            });
            process.exit(0);
          } catch (error) {
            this.agentLogger?.errorSync(
              "Error during scheduled restart shutdown",
              error instanceof Error ? error : new Error(String(error)),
              { component: LogComponents.agent, action: "forcing_exit" }
            );
            process.exit(1);
          }
        }, restartTimeMs);

        // Don't prevent graceful shutdown
        this.scheduledRestartTimer.unref();
      });

      // Listen for feature changes from ConfigManager
      this.stateReconciler.on('features-changed', async (change: { old: any; new: any }) => {
        this.agentLogger?.infoSync('Features configuration changed', {
          component: LogComponents.agent,
          changes: Object.keys(change.new).filter(key => change.old[key] !== change.new[key])
        });
        
        // Handle anomaly detection toggle
        if (change.old.enableAnomalyDetection !== change.new.enableAnomalyDetection) {
          if (change.new.enableAnomalyDetection && !this.anomalyService) {
            // Start anomaly detection
            this.agentLogger?.infoSync('Starting Anomaly Detection Service (dynamically enabled)', {
              component: LogComponents.agent
            });
            await this.initAnomalyDetection();
          } else if (!change.new.enableAnomalyDetection && this.anomalyService) {
            // Stop anomaly detection
            this.agentLogger?.infoSync('Stopping Anomaly Detection Service (dynamically disabled)', {
              component: LogComponents.agent
            });
            this.anomalyService.stop();
            this.anomalyService = undefined;
          }
        }
      });
      
      // Listen for anomaly config changes from ConfigManager
      this.stateReconciler.on('anomaly-config-changed', (change: { old: any; new: any }) => {
        this.agentLogger?.infoSync('Anomaly configuration changed from cloud', {
          component: LogComponents.agent
        });
        
        // Reload anomaly config if service is running
        if (this.anomalyService && change.new) {
          this.agentLogger?.infoSync('Reloading anomaly detection configuration', {
            component: LogComponents.agent,
            metricsCount: change.new.metrics?.filter((m: any) => m.enabled).length
          });
          this.anomalyService.updateConfig(change.new);
        }
      });

      //Final words
      const mode: "Cloud-connected" | "Standalone (not provisioned)" = this.deviceInfo.provisioned
        ? "Cloud-connected"
        : "Standalone (not provisioned)";

      const intervals = this.agentConfig.getIntervalConfig();
      
      this.agentLogger.debugSync("Device Agent initialized successfully", {
        component: LogComponents.agent,
        mode,
        deviceApiPort: this.agentConfig.getDeviceApiPort(),
        reconciliationInterval: intervals.reconciliationIntervalMs,
        cloudApiEndpoint: this.agentConfig.getCloudApiEndpoint(),
        cloudFeaturesEnabled: this.deviceInfo.provisioned && !!this.cloudSync,
      });

     
  }

  private async initializeCloudLogging(): Promise<void> {
    const cloudApiEndpoint = this.agentConfig.getCloudApiEndpoint();

    // Only initialize cloud logging if device is provisioned
    if (
      !cloudApiEndpoint ||
      !this.deviceInfo.provisioned ||
      !this.deviceInfo.deviceApiKey
    ) {
      if (cloudApiEndpoint && !this.deviceInfo.provisioned) {
        this.agentLogger.warnSync(
          "Cloud logging disabled - device not provisioned",
          {
            component: LogComponents.agent,
            note: "Device must be provisioned before enabling cloud log streaming",
          }
        );
      }
      return;
    }

    try {
      const loggingConfig = this.agentConfig.getLoggingConfig();
      
      const cloudLogBackend = new CloudLogBackend(
        {
          cloudEndpoint: cloudApiEndpoint,
          deviceUuid: this.deviceInfo.uuid,
          deviceApiKey: this.deviceInfo.apiKey,
          compression: loggingConfig.enableCompression,
          batchSize: loggingConfig.logBatchSize,
          flushInterval: loggingConfig.logFlushIntervalMs,
        },
        this.agentLogger
      );
      await cloudLogBackend.initialize();
      
      // Add cloud backend to AgentLogger
      this.agentLogger.addBackend(cloudLogBackend);

      this.agentLogger.debugSync("Cloud log backend initialized", {
        component: LogComponents.agent,
        cloudEndpoint: cloudApiEndpoint,
      });
    } catch (error) {
      this.agentLogger.errorSync(
        "Failed to initialize cloud log backend. Continuing without cloud logging",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
        }
      );
    }
  }

  private async initDatabase(): Promise<void> {
    await db.initialized(this.agentLogger);
  }

  private async initializeDeviceManager(): Promise<void> {
    this.deviceManager = new DeviceManager();
    await this.deviceManager.initialize();

    let deviceInfo = this.deviceManager.getDeviceInfo();

    // Load boot config if available (Yocto images or manual config)
    const bootConfig = loadBootConfig();
    
    // Get provisioning key from multiple sources (priority order):
    // 1. Environment variable (highest priority - manual override)
    // 2. Boot config file (Iotistic OS Yocto images)
    const provisioningApiKey = process.env.PROVISIONING_KEY || bootConfig?.provisioningKey;
    
    // Get API endpoint (environment takes priority over boot config)
    const cloudEndpoint = process.env.CLOUD_API_ENDPOINT || bootConfig?.cloudApiEndpoint || this.agentConfig.getCloudApiEndpoint();
    
    this.agentLogger.debugSync("Checking provisioning configuration", {
      component: LogComponents.agent,
      hasProvisioningKey: !!provisioningApiKey,
      provisioningKeyLength: provisioningApiKey?.length || 0,
      provisioningKeyPrefix: provisioningApiKey ? provisioningApiKey.substring(0, 20) + '...' : 'not set',
      keySource: process.env.PROVISIONING_KEY ? 'environment' : (bootConfig?.provisioningKey ? 'boot-config' : 'none'),
      isProvisioned: deviceInfo.provisioned,
      hasCloudEndpoint: !!cloudEndpoint,
      cloudEndpoint: cloudEndpoint || 'not set',
      bootConfigLoaded: !!bootConfig,
    });

    if (
      !deviceInfo.provisioned &&
      provisioningApiKey &&
      cloudEndpoint
    ) {
      this.agentLogger.debugSync(
        "Auto-provisioning device with two-phase authentication",
        {
          component: LogComponents.agent,
          keySource: process.env.PROVISIONING_KEY ? 'environment variable' : 'boot config file',
        }
      );
      try {
        // Auto-detect system information if not provided via env vars
        const macAddress = process.env.MAC_ADDRESS || (await getMacAddress());
        const osVersion = process.env.OS_VERSION || (await getOsVersion());

        this.agentLogger.debugSync("System information detected", {
          component: LogComponents.agent,
          macAddress: macAddress
            ? `${macAddress.substring(0, 8)}...`
            : "unknown",
          osVersion: osVersion || "unknown",
        });

        await this.deviceManager.provision({
          provisioningApiKey, // Required for two-phase auth
          deviceName:
            process.env.DEVICE_NAME || bootConfig?.deviceName || `device-${deviceInfo.uuid.slice(0, 8)}`,
          deviceType: process.env.DEVICE_TYPE || bootConfig?.deviceType || "standalone",
          apiEndpoint: cloudEndpoint,
          macAddress,
          osVersion,
          agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
        });
        deviceInfo = this.deviceManager.getDeviceInfo();
        this.agentLogger.infoSync("Device auto-provisioned successfully", {
          component: LogComponents.agent,
        });
      } catch (error: any) {
        this.agentLogger.errorSync(
          "Auto-provisioning failed",
          error instanceof Error ? error : new Error(error.message),
          {
            componet: LogComponents.agent,
            note: "Device will remain unprovisioned. Check PROVISIONING_KEY or boot config file.",
          }
        );

      }
    } else if (!deviceInfo.provisioned && cloudEndpoint && !provisioningApiKey
    ) {
      this.agentLogger.warnSync("Device not provisioned", {
        component: LogComponents.agent,
        note: "Set PROVISIONING_KEY environment variable or provide /data/iotistic/boot-config.json",
      });

    } else if (!deviceInfo.provisioned && !this.agentConfig.getCloudApiEndpoint()) {
      // Local mode - device never provisioned and no cloud endpoint
      this.agentLogger.infoSync("Running in local mode (no cloud connection)", {
        component: LogComponents.agent,
      });
      await this.deviceManager.markAsLocalMode();
      deviceInfo = this.deviceManager.getDeviceInfo();
    } else if (deviceInfo.provisioned && !this.agentConfig.getCloudApiEndpoint()) {
      // Device was previously provisioned but now running in local mode
      this.agentLogger.infoSync("Switching to local mode (no cloud connection)", {
        component: LogComponents.agent,
        note: "Device was previously provisioned but CLOUD_API_ENDPOINT is not set",
      });
      await this.deviceManager.markAsLocalMode();
      deviceInfo = this.deviceManager.getDeviceInfo();
    }

    // Cache device info for reuse across all methods
    this.deviceInfo = deviceInfo;
    
    // Always update agent version on startup (in case of upgrades)
    const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
    if (this.deviceInfo.agentVersion !== currentVersion) {
      this.agentLogger.debugSync("Updating agent version", {
        component: LogComponents.agent,
        oldVersion: this.deviceInfo.agentVersion || "unknown",
        newVersion: currentVersion,
      });
      await this.deviceManager.updateAgentVersion(currentVersion);
      this.deviceInfo = this.deviceManager.getDeviceInfo();
    }
    
    // Now set the device ID on the logger
    this.agentLogger.setDeviceId(this.deviceInfo.uuid);

    this.agentLogger.debugSync("Device manager initialized", {
      component: LogComponents.agent,
      uuid: this.deviceInfo.uuid,
      name: this.deviceInfo.deviceName || "Not set",
      provisioned: this.deviceInfo.provisioned,
      hasApiKey: !!this.deviceInfo.deviceApiKey,
      agentVersion: this.deviceInfo.agentVersion,
      mqtt: this.deviceInfo.mqttBrokerConfig
    });
  }

  private async initializeMqttManager(): Promise<void> {

    try {
      // Only use MQTT if device is provisioned with mqttBrokerConfig
      if (!this.deviceInfo.mqttBrokerConfig) {
        this.agentLogger.debugSync("MQTT disabled - device not provisioned with broker config", {
          component: LogComponents.agent,
          note: "Provision device to enable MQTT",
        });
        return;
      }
      
      // Build MQTT broker URL from mqttBrokerConfig JSON
      const config = this.deviceInfo.mqttBrokerConfig;
      const mqttBrokerUrl = `${config.protocol || 'mqtt'}://${config.host}:${config.port}`;
      
      this.agentLogger.debugSync(`Built MQTT Broker URL from config`, {
        component: LogComponents.agent,
        source: "mqttBrokerConfig",
        url: mqttBrokerUrl,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        hasUsername: !!config.username,
      });
      
      const mqttManager = MqttManager.getInstance();

      // Build MQTT connection options from mqttBrokerConfig
      const mqttOptions: any = {
        clientId: config.clientIdPrefix ? `${config.clientIdPrefix}_${this.deviceInfo.uuid}` : `device_${this.deviceInfo.uuid}`,
        clean: config.cleanSession ?? true,
        reconnectPeriod: config.reconnectPeriod ?? 5000,
        keepalive: config.keepAlive ?? 60,
        connectTimeout: config.connectTimeout ?? 30000,
        username: config.username,
        password: config.password,
      };

      // Add TLS options if broker config specifies TLS
      if (config.useTls && config.caCert) {
        // Fix double-escaped newlines in certificate (handles both \\n and \n)
        const caCert = config.caCert.replace(/\\n/g, '\n');
        
        // MQTT library expects CA cert as string (not Buffer)
        mqttOptions.ca = caCert;
        mqttOptions.rejectUnauthorized = config.verifyCertificate ?? true;
        
        this.agentLogger.debugSync("MQTT TLS enabled", {
          component: LogComponents.agent,
          protocol: config.protocol,
          verifyCertificate: config.verifyCertificate,
          hasCaCert: !!config.caCert,
        });
      }

      // Connect to MQTT broker with provisioned credentials
      await mqttManager.connect(mqttBrokerUrl, mqttOptions);

      // Initialize message ID generator for HA deduplication
      mqttManager.initMessageIdGenerator(this.deviceInfo.uuid);

      // Enable debug mode if requested
      if (process.env.MQTT_DEBUG === "true") {
        mqttManager.setDebug(true);
      }

      this.agentLogger.infoSync("MQTT Manager connected", {
        component: LogComponents.agent,
        brokerUrl: mqttBrokerUrl,
        clientId: `device_${this.deviceInfo.uuid}`,
        username: config.username || "(none)",
        debugMode: process.env.MQTT_DEBUG === "true",
        totalLogBackends: this.agentLogger.getBackends().length,
      });
    } catch (error) {
      this.agentLogger.errorSync(
        "Failed to initialize MQTT Manager",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
          note: "MQTT features will be unavailable",
        }
      );
      // Don't throw - allow agent to continue without MQTT
    }
  }

  private async initializeStateReconciler(): Promise<void> {
    // Create StateReconciler (manages both containers and config)
    this.stateReconciler = new StateReconciler();
    await this.stateReconciler.init();
    
    // Initialize AgentConfig AFTER StateReconciler loads target state from SQLite
    this.agentConfig = new AgentConfig(this.stateReconciler);
    
    // Note: Full initialization of AgentConfig (reactive handlers) happens later
    // after all dependencies (logger, containerManager, etc.) are available
  }

  private async initContainerManager(): Promise<void> {
    // StateReconciler already initialized, just setup logging and event handlers
    // For backward compatibility, keep ContainerManager reference for DeviceAPI
    this.containerManager = this.stateReconciler.getContainerManager();

    // Set up log monitor for Docker containers
    const docker = this.containerManager.getDocker();
    if (docker) {
      // Use all configured log backends
      this.logMonitor = new ContainerLogMonitor(docker, this.agentLogger);
      this.containerManager.setLogMonitor(this.logMonitor);
      await this.containerManager.attachLogsToAllContainers();
      this.agentLogger.debugSync("Log monitor attached to container manager", {
        component: LogComponents.agent,
        backendCount: this.agentLogger.getBackends().length,
      });
    }

    // Note: Config change handling is now done by AgentConfig reactive layer
    // AgentConfig listens to StateReconciler's granular events directly

    this.agentLogger?.infoSync("Container manager setup complete", {
      component: LogComponents.agent,
    });
  }


  private async initDeviceAPI(): Promise<void> {
    this.agentLogger?.infoSync("Initializing device API", {
      component: LogComponents.agent,
    });

    // Initialize device actions with managers
    deviceActions.initialize(this.containerManager, this.deviceManager, undefined, this.agentLogger, undefined, undefined);

    // Health checks
    const healthchecks = [
      // Container manager health
      async () => {
        try {
          this.containerManager.getStatus();
          return true;
        } catch {
          return false;
        }
      },
      // Agent process memory leak detection
      async () => {
        setMemoryLogger(this.agentLogger);
        return memoryHealthcheck();
      },
    ];

    // Create device API with routers
    this.deviceAPI = new DeviceAPI({
      routers: [v1Router],
      healthchecks,
      logger: this.agentLogger,
    });

    // Start listening
    await this.deviceAPI.listen(this.agentConfig.getDeviceApiPort());
    this.agentLogger?.infoSync("Device API started", {
      component: LogComponents.agent,
      port: this.agentConfig.getDeviceApiPort(),
    });
  }

  private async initAnomalyDetection(): Promise<void> {
    // Check if anomaly detection is enabled (cloud config → env fallback)
    const features = this.agentConfig.getFeatures();
    
    if (!features.enableAnomalyDetection) {
      this.agentLogger?.infoSync("Anomaly Detection disabled by configuration", {
        component: LogComponents.agent,
      });
      return;
    }
    
    this.agentLogger?.infoSync("Initializing Anomaly Detection Service", {
      component: LogComponents.agent,
    });

    try {
      // Load configuration from target state (preferred) or environment variables (fallback)
      const targetStateConfig = this.stateReconciler.getTargetState()?.config;
      const config = loadConfigFromTargetState(targetStateConfig);
      
      // Get database connection for storage
      const dbInstance = db.getKnex();
      
      // Auto-discover endpoint metrics and merge with cloud config
      const { discoverEndpointMetrics, mergeMetricConfigs } = await import('./ai/anomaly/endpoint-sync.js');
      const discoveredMetrics = await discoverEndpointMetrics(dbInstance, this.agentLogger);
      const mergedMetrics = mergeMetricConfigs(config.metrics, discoveredMetrics);
      
      // Update config with merged metrics
      config.metrics = mergedMetrics;
      
      this.agentLogger?.infoSync("Merged cloud and discovered endpoint metrics", {
        component: LogComponents.agent,
        cloudMetrics: config.metrics.length - discoveredMetrics.length,
        discoveredMetrics: discoveredMetrics.length,
        totalMetrics: mergedMetrics.length,
      });
      
      // Save merged config back to target state (will be reported to cloud)
      if (discoveredMetrics.length > 0 && targetStateConfig) {
        const currentTargetState = this.stateReconciler.getTargetState();
        if (currentTargetState?.config) {
          // Update target state with merged anomaly config
          currentTargetState.config.anomaly = config;
          
          // Save to database (this will trigger config change detection and cloud report)
          await this.stateReconciler.setTarget(currentTargetState);
          
          this.agentLogger?.infoSync("Saved merged anomaly config to target state", {
            component: LogComponents.agent,
            totalMetrics: mergedMetrics.length,
          });
        }
      }
      
      // Create anomaly detection service with database storage
      this.anomalyService = new AnomalyDetectionService(config, dbInstance, this.agentLogger);
      
      this.agentLogger?.infoSync("Anomaly Detection Service initialized", {
        component: LogComponents.agent,
        metricsCount: config.metrics.filter(m => m.enabled).length,
        source: targetStateConfig?.anomaly ? 'cloud' : 'environment',
        storageEnabled: !!config.storage,
      });
      
      // Wire anomaly service to system metrics and sensor-publish
      this.configureAnomalyFeed();
    } catch (error) {
      this.agentLogger?.errorSync(
        "Failed to initialize Anomaly Detection Service",
        error as Error,
        { component: LogComponents.agent }
      );
      // Don't fail startup - anomaly detection is optional
      this.anomalyService = undefined;
    }
  }
  
  /**
   * Configure anomaly detection feed for system metrics and sensors
   */
  private async configureAnomalyFeed(): Promise<void> {
    if (!this.anomalyService) return;
    
    this.agentLogger?.infoSync('Configuring edge AI anomaly detection', {
      component: LogComponents.agent,
    });
    
    // Wire edge AI anomaly service to system metrics
    const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('./system/metrics.js');
    configureSystemMetrics(this.anomalyService);
    
    // Wire edge AI anomaly service to sensor-publish
    const { configureAnomalyFeed: configureSensorAnomaly } = await import('./features/sensor-publish/sensor.js');
    configureSensorAnomaly(this.anomalyService);
    
    this.agentLogger?.infoSync('Anomaly detection configured for system metrics and endpoints', {
      component: LogComponents.agent,
    });
    
    // Immediately collect initial metrics to populate buffers
    // (Don't wait for first metricsInterval cycle)
    this.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
      component: LogComponents.agent,
    });
    await getSystemMetrics();
  }

  private async initDiscoveryService (): Promise<void> {
    this.agentLogger?.infoSync("Initializing Discovery Service", {
      component: LogComponents.agent,
    });

    try {
      // Create discovery service with config accessor
      this.discoveryService = new DiscoveryService(this.agentLogger, this.agentConfig);
      await this.discoveryService.init();

      // NOTE: First boot discovery is DEFERRED until after CloudSync fetches target state
      // This ensures we respect cloud-configured feature flags (not just env variables)
      // See runFirstBootDiscoveryIfEnabled() called after CloudSync initialization

      this.agentLogger?.infoSync("Discovery Service initialized (first boot discovery deferred until cloud config loaded)", {
        component: LogComponents.agent,
      });
    } catch (error) {
      this.agentLogger?.errorSync(
        "Failed to initialize Discovery Service",
        error as Error,
        { component: LogComponents.agent }
      );
      // Don't fail startup - discovery is optional
      this.discoveryService = undefined;
    }
  }
  


  private async initializeSimulationMode(): Promise<void> {
    try {
      // Load simulation configuration from environment
      const config = loadSimulationConfig();
      
      if (!config.enabled) {
        return; // Simulation mode disabled
      }
      
      // Only run simulation if provisioned OR in standalone dev mode
      // This prevents MQTT errors when device is not provisioned
      const isProvisioned = this.deviceInfo.provisioned && this.deviceInfo.mqttBrokerConfig;
      const isDevMode = process.env.NODE_ENV === 'development' || process.env.FORCE_SIMULATION === 'true';
      
      if (!isProvisioned && !isDevMode) {
        this.agentLogger?.warnSync("Simulation Mode disabled - device not provisioned", {
          component: LogComponents.agent,
          note: "Provision device first, or set FORCE_SIMULATION=true for testing",
        });
        return;
      }
      
      this.agentLogger?.warnSync("Initializing Simulation Mode - FOR TESTING ONLY", {
        component: LogComponents.agent,
        provisioned: isProvisioned,
        devMode: isDevMode,
      });
      
      // Create simulation orchestrator
      this.simulationOrchestrator = new SimulationOrchestrator(config, {
        logger: this.agentLogger,
        anomalyService: this.anomalyService,
        mqttManager: MqttManager.getInstance(),
        deviceUuid: this.deviceInfo.uuid,
      });
      
      // Start all enabled scenarios
      await this.simulationOrchestrator.start();
      
    } catch (error) {
      this.agentLogger?.errorSync(
        "Failed to initialize Simulation Mode",
        error as Error,
        { component: LogComponents.agent }
      );
      // Don't fail startup - simulation is optional
      this.simulationOrchestrator = undefined;
    }
  }

  private async initDeviceSync(): Promise<void> {
    const cloudApiEndpoint = this.agentConfig.getCloudApiEndpoint();
    
    if (!cloudApiEndpoint) {
      this.agentLogger?.warnSync(
        "Cloud API endpoint not configured - running in standalone mode",
        {
          component: LogComponents.agent,
          note: "Set CLOUD_API_ENDPOINT env var to enable cloud features",
        }
      );
      return;
    }

    // Check if device is provisioned before enabling cloud sync
    if (!this.deviceInfo.provisioned || !this.deviceInfo.deviceApiKey) {
      this.agentLogger?.warnSync(
        "Device not provisioned - cloud sync disabled",
        {
          component: LogComponents.agent,
          note: "Device must be provisioned with valid API key before enabling cloud features",
          provisioned: this.deviceInfo.provisioned,
          hasApiKey: !!this.deviceInfo.deviceApiKey,
        }
      );
      return;
    }

    // Get intervals from agentConfig (cloud → env fallback)
    const intervals = this.agentConfig.getIntervalConfig();

    this.cloudSync = new CloudSync(
      this.stateReconciler, // Use StateReconciler instead of ContainerManager
      this.deviceManager,
      {
        cloudApiEndpoint: cloudApiEndpoint,
        pollInterval: intervals.targetStatePollIntervalMs!,
        reportInterval: intervals.deviceReportIntervalMs!,
        metricsInterval: intervals.metricsIntervalMs!,
      },
      this.agentLogger, // Pass the agent logger
      undefined, // sensorPublish (unused)
      undefined, // sensors (unused)
      MqttManager.getInstance() // Pass MQTT manager singleton for state reporting (optional)
    );

    // Reinitialize device actions with cloudSync, anomaly service, and simulation
    this.agentLogger?.infoSync('Reinitializing device actions with all services', {
      component: LogComponents.agent,
      hasCloudSync: !!this.cloudSync,
      hasAnomalyService: !!this.anomalyService,
      hasSimulation: !!this.simulationOrchestrator,
    });
    
    deviceActions.initialize(
      this.containerManager,
      this.deviceManager,
      this.cloudSync,
      this.agentLogger,
      this.anomalyService,
      this.simulationOrchestrator
    );


    // Start polling for target state
    await this.cloudSync.startPoll();

    // Initialize anomaly detection after cloud config is loaded
    await this.initAnomalyDetection();
    
    // Reinitialize device actions WITH anomaly service now available
    if (this.anomalyService) {
      this.agentLogger?.infoSync('Reinitializing device actions with anomaly service', {
        component: LogComponents.agent,
        hasAnomalyService: true,
      });
      
      deviceActions.initialize(
        this.containerManager,
        this.deviceManager,
        this.cloudSync,
        this.agentLogger,
        this.anomalyService,
        this.simulationOrchestrator
      );
    }

    // Trigger first boot discovery after cloud config is loaded
    // This ensures we respect cloud-configured feature flags
    await this.runFirstBootDiscoveryIfEnabled();

  }

  /**
   * Run first boot discovery if enabled
   * Called after CloudSync initializes and fetches target state
   */
  private async runFirstBootDiscoveryIfEnabled(): Promise<void> {
    if (!this.discoveryService) {
      this.agentLogger?.debugSync('Discovery service not available, skipping first boot discovery', {
        component: LogComponents.agent
      });
      return;
    }

    // Check if first boot discovery is enabled (default: true)
    const enableFirstBootDiscovery = process.env.ENABLE_FIRST_BOOT_DISCOVERY !== 'false';
    
    if (!enableFirstBootDiscovery) {
      this.agentLogger?.infoSync('First boot discovery disabled by configuration', {
        component: LogComponents.agent
      });
      return;
    }


    try {
      await this.discoveryService.runDiscovery({
        trigger: 'first_boot',
        validate: true, // Always run full validation on first boot
      });

      this.agentLogger?.infoSync('First boot discovery completed', {
        component: LogComponents.agent
      });

      // Re-initialize anomaly detection now that endpoints are discovered
      // This allows auto-discovery of endpoint metrics
      if (this.agentConfig.getFeatures().enableAnomalyDetection) {
        this.agentLogger?.infoSync('Re-initializing anomaly detection after endpoint discovery', {
          component: LogComponents.agent
        });
        await this.initAnomalyDetection();
      }
    } catch (error) {
      this.agentLogger?.errorSync(
        'First boot discovery failed',
        error as Error,
        { component: LogComponents.agent }
      );
      // Don't fail startup - discovery errors are non-fatal
    }
  }


  private startAutoReconciliation(): void {
    const intervals = this.agentConfig.getIntervalConfig();
    this.containerManager.startAutoReconciliation(
      intervals.reconciliationIntervalMs!
    );
    this.agentLogger?.infoSync("Auto-reconciliation started", {
      component: LogComponents.agent,
      intervalMs: intervals.reconciliationIntervalMs,
    });
  }

  /**
   * Start active memory monitoring (independent of /ping healthcheck)
   */
  private startMemoryMonitoring(): void {
    const performanceConfig = this.agentConfig.getPerformanceConfig();
    const memoryCheckInterval = performanceConfig.memoryCheckIntervalMs!;
    const memoryThreshold = performanceConfig.memoryThresholdMb! * 1024 * 1024; // Convert MB to bytes

    setMemoryLogger(this.agentLogger);
    
    // Start monitoring with callback for threshold breach
    startMemoryMonitoring(
      memoryCheckInterval,
      memoryThreshold,
      () => {
        // Callback when memory threshold is breached
        this.agentLogger?.errorSync(
          'Memory threshold breached - agent may need restart',
          undefined,
          {
            component: LogComponents.agent,
            thresholdMB: memoryThreshold / (1024 * 1024),
            action: 'Consider restarting agent or investigating memory leak'
          }
        );

        // Optional: Trigger graceful shutdown or restart
        // Uncomment if you want automatic restart on memory leak
        // process.exit(1);
      }
    );

    this.agentLogger?.infoSync("Active memory monitoring started", {
      component: LogComponents.agent,
      intervalMs: memoryCheckInterval,
      thresholdMB: memoryThreshold / (1024 * 1024)
    });

    // Start memory leak simulation if enabled (for testing only)
    if (process.env.SIMULATE_MEMORY_LEAK === 'true') {
      this.agentLogger?.warnSync("MEMORY LEAK SIMULATION ENABLED - FOR TESTING ONLY", {
        component: LogComponents.agent,
        leakType: process.env.LEAK_TYPE || 'gradual',
        leakRateMB: process.env.LEAK_RATE_MB || '1',
        leakIntervalMs: process.env.LEAK_INTERVAL_MS || '5000',
        leakMaxMB: process.env.LEAK_MAX_MB || '50'
      });
      
      // Wait 30 seconds after startup before starting simulation
      // This allows baseline memory to be established
      setTimeout(() => {
        startMemoryLeakSimulation();
      }, 30000);
    }
  }

  public async stop(): Promise<void> {
    this.agentLogger?.infoSync("Stopping Device Agent", { component: LogComponents.agent });

    try {
      // Stop all features managed by FeatureInitializer
      if (this.featureInitializer) {
        await this.featureInitializer.cleanup();
        this.agentLogger?.infoSync("Features stopped", {
          component: LogComponents.agent,
        });
      } 
     
      // Stop API binder
      if (this.cloudSync) {
        await this.cloudSync.stop();
        this.agentLogger?.infoSync("API Binder stopped", {
          component: LogComponents.agent,
        });
      }

      // Stop firewall
      if (this.firewall) {
        await this.firewall.stop();
        this.agentLogger?.infoSync("Firewall stopped", {
          component: LogComponents.agent,
        });
      }

      // Stop updater
      if (this.updater) {
        await this.updater.cleanup();
        this.agentLogger?.infoSync("Agent Updater stopped", {
          component: LogComponents.agent,
        });
      }

      // Stop active memory monitoring
      stopMemoryMonitoring();
      this.agentLogger?.infoSync("Memory monitoring stopped", {
        component: LogComponents.agent,
      });

      // Stop simulation orchestrator if running
      if (this.simulationOrchestrator) {
        await this.simulationOrchestrator.stop();
        this.agentLogger?.infoSync("Simulation orchestrator stopped", {
          component: LogComponents.agent,
        });
      }

      // Stop memory leak simulation if running (backward compatibility)
      stopMemoryLeakSimulation();
      this.agentLogger?.infoSync("Memory leak simulation stopped", {
        component: LogComponents.agent,
      });

      // Stop log backends (flush buffers, clear timers)
      this.agentLogger?.infoSync("Stopping log backends", {
        component: LogComponents.agent,
      });
      for (const backend of this.agentLogger.getBackends()) {
        try {
          if (
            "disconnect" in backend &&
            typeof backend.disconnect === "function"
          ) {
            await backend.disconnect();
          } else if ("stop" in backend && typeof backend.stop === "function") {
            await (backend as any).stop();
          }
        } catch (error) {
          this.agentLogger?.warnSync("Error stopping log backend", {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.agentLogger?.infoSync("Log backends stopped", {
        component: LogComponents.agent,
      });

      // Stop MQTT Manager (shared singleton - do this after all MQTT-dependent features)
      const mqttManager = MqttManager.getInstance();
      if (mqttManager.isConnected()) {
        await mqttManager.disconnect();
        this.agentLogger?.infoSync("MQTT Manager disconnected", {
          component: LogComponents.agent,
        });
      }

      // Stop device API
      if (this.deviceAPI) {
        await this.deviceAPI.stop();
        this.agentLogger?.infoSync("Device API stopped", {
          component: LogComponents.agent,
        });
      }

      // Stop container manager
      if (this.containerManager) {
        this.containerManager.stopAutoReconciliation();
        this.agentLogger?.infoSync("Container manager stopped", {
          component: LogComponents.agent,
        });
      }

      // Clear scheduled restart timer
      if (this.scheduledRestartTimer) {
        clearTimeout(this.scheduledRestartTimer);
        this.scheduledRestartTimer = undefined;
        this.agentLogger?.infoSync("Scheduled restart timer cleared", {
          component: LogComponents.agent,
        });
      }
      
      // Stop discovery timers
      this.discoveryService?.stopPeriodicDiscovery();

      // AgentConfig handles its own cleanup (event listeners)
      // No manual removal needed since AgentConfig is garbage collected

      this.agentLogger?.infoSync("Device Agent stopped successfully", {
        component: LogComponents.agent,
      });
    } catch (error) {
      this.agentLogger?.errorSync(
        "Error stopping Device Agent",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
        }
      );
      throw error;
    }
  }

  // Getters for external access (if needed)
  public getContainerManager(): ContainerManager {
    return this.containerManager;
  }

  public getDeviceManager(): DeviceManager {
    return this.deviceManager;
  }

  public getDeviceAPI(): DeviceAPI {
    return this.deviceAPI;
  }
}
