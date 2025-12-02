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
import type { LogBackend, LogLevel } from "./logging/types.js";
import { LogComponents } from "./logging/types.js";
import { JobsFeature } from "./features/jobs/src/monitor.js";
import { SensorPublishFeature } from "./features/sensor-publish/index.js";
import { SensorConfigHandler } from "./features/sensor-publish/config-handler.js";
import { MqttManager } from "./mqtt/manager.js";
import { getPackageVersion } from "./utils/api-utils";
import {
  SensorsFeature as SensorsFeature,
  SensorConfig,
} from "./features/endpoints/index.js";
import { AgentFirewall } from "./network/firewall.js";
import { AgentUpdater } from "./updater.js";
import { getMacAddress, getOsVersion } from "./system/metrics.js";
import * as fs from 'fs';
import * as path from 'path';
import { 
  healthcheck as memoryHealthcheck, 
  setMemoryLogger,
  startMemoryMonitoring,
  stopMemoryMonitoring,
  startMemoryLeakSimulation,
  stopMemoryLeakSimulation,
  getSimulationStatus
} from "./system/memory.js";
import { AnomalyDetectionService } from "./ai/anomaly/index.js";
import { loadConfigFromEnv } from "./ai/anomaly/utils.js";
import { SimulationOrchestrator, loadSimulationConfig } from "./simulation/index.js";
import { DiscoveryService } from "./features/discovery/discovery-service.js";
import { FeatureInitializer, type FeatureContext } from "./bootstrap/init.js";

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
  private jobs?: JobsFeature;
  private sensorPublish?: SensorPublishFeature;
  private sensors?: SensorsFeature;
  private anomalyService?: AnomalyDetectionService; // Edge-based AI anomaly detection for metrics and sensors
  private simulationOrchestrator?: SimulationOrchestrator; // Simulation framework for testing
  private discoveryService?: DiscoveryService; // Protocol discovery (Modbus, OPC-UA, CAN, etc.)

  // Cached target state (updated when target state changes)
  private cachedTargetState: any = null;

  // System settings (config-driven with env var defaults)
  private reconciliationIntervalMs: number;
  private discoveryFullIntervalMs: number;    
  private discoveryLightIntervalMs: number; 
  private targetStatePollIntervalMs: number; 
  private deviceReportIntervalMs: number; 
  private metricsIntervalMs: number; 
  // Scheduled restart timer (controlled from cloud config)
  private scheduledRestartTimer?: NodeJS.Timeout;

  // API endpoint URL
  private apiUrl: string;

  // Device API port
  private deviceApiPort : number;
  
  // Periodic discovery timers
  private discoveryLightTimer?: NodeJS.Timeout;
  private discoveryFullTimer?: NodeJS.Timeout;


 
  // Event handler for target state changes (stored for cleanup)
  private targetStateChangeHandler = (newState: DeviceState) => {
    this.updateCachedTargetState();
    
    // Check for scheduled restart config changes
    this.handleScheduledRestartConfig();
  };

  constructor() {
    this.reconciliationIntervalMs = parseInt(process.env.RECONCILIATION_INTERVAL_MS || "30000",10);
    this.apiUrl = process.env.CLOUD_API_ENDPOINT || "http://localhost:3002";
    this.deviceApiPort = parseInt(process.env.DEVICE_API_PORT || "48484",10);
    this.discoveryFullIntervalMs = parseInt(process.env.DISCOVERY_FULL_INTERVAL_MS || "86400000", 10 ); // 24 hours default
    this.discoveryLightIntervalMs = parseInt(process.env.DISCOVERY_LIGHT_INTERVAL_MS || "14400000", 10 ); // 4 hours default
    this.targetStatePollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
    this.deviceReportIntervalMs = parseInt(process.env.REPORT_INTERVAL_MS || "60000", 10);
    this.metricsIntervalMs = parseInt(process.env.METRICS_INTERVAL_MS || "300000", 10);
  
  }

  public async init(): Promise<void> {


     // Get all configuration from database
      const config = this.getAgentConfiguration();

      // Initialize logging FIRST (so all other components can use agentLogger)
      const logLevel = (config.logging.level as LogLevel) || "info";
      
      const localBackend = new LocalLogBackend({
        maxLogs: parseInt(process.env.MAX_LOGS || "1000", 10),
        maxAge: parseInt(process.env.LOG_MAX_AGE || "3600000", 10), // 1 hour
        enableFilePersistence: process.env.LOG_FILE_PERSISTANCE === 'true',
        logDir: process.env.LOG_DIR || "/app/data/logs",
        maxFileSize: parseInt(process.env.MAX_LOG_FILE_SIZE || "5242880", 10), // 5MB
      });
      await localBackend.initialize();
      
      this.agentLogger = new AgentLogger(localBackend, logLevel);

      // Initialize database
      await this.initializeDatabase();

      // Initialize device provisioning
      await this.initializeDeviceManager();

      // Initialize cloud logging if device is provisioned
      await this.initializeCloudLogging();

      // Parallelize independent initializations (MQTT and Container Manager)
      // These don't depend on each other, so run them concurrently
      await Promise.all([
        this.initializeMqttManager(),      // ~300-500ms
        this.initializeContainerManager()  // ~500-800ms
      ]);
      // Saves ~300-500ms compared to sequential execution

      // Initialize device API
      await this.initializeDeviceAPI();

     
      // Initialize optional features using FeatureInitializer
      const featureContext: FeatureContext = {
        logger: this.agentLogger,
        deviceInfo: this.deviceInfo,
        deviceManager: this.deviceManager,
        stateReconciler: this.stateReconciler,
        mqttManager: MqttManager.getInstance(),
        containerManager: this.containerManager,
        configSettings: config.settings,
        configFeatures: config.features,
        cloudApiEndpoint: this.apiUrl,
        deviceApiPort: this.deviceApiPort,
        anomalyService: this.anomalyService
      };

      this.featureInitializer = new FeatureInitializer(featureContext);

      await this.featureInitializer.initOptionalFeatures();

      // Store references to features for backward compatibility
      const features = this.featureInitializer.getFeatures();
      this.jobs = features.jobs;
      this.sensorPublish = features.sensorPublish;
      this.sensors = features.sensors;

      // 10. Initialize Anomaly Detection Service (BEFORE API Binder so it can be passed to CloudSync)
      this.initializeAnomalyDetection();

      // 10.5. Initialize Simulation Orchestrator (AFTER Anomaly Detection, used for testing)
      await this.initializeSimulationMode();

      // 10.7. Initialize Discovery Service (protocol auto-discovery)
      await this.initDiscoveryService ();

      // 11. Initialize API Binder (AFTER features are initialized so it can access sensor health)
      await this.initDeviceSync(config.settings);

      // 11-13. Initialize supporting features (updater, firewall, sensor config handler)
      await this.featureInitializer.initSupportingFeatures();

      // Store references for backward compatibility
      this.updater = features.updater;
      this.firewall = features.firewall;

      // 14. Start auto-reconciliation
      this.startAutoReconciliation();

      // 15. Start active memory monitoring (independent of healthcheck endpoint)
      this.startMemoryMonitoring();

      // 16. Handle scheduled restart configuration (cloud-controlled)
      this.handleScheduledRestartConfig();

      //Final words
      const mode: "Cloud-connected" | "Standalone (not provisioned)" = this.deviceInfo.provisioned
        ? "Cloud-connected"
        : "Standalone (not provisioned)";

      this.agentLogger.infoSync("Device Agent initialized successfully", {
        component: LogComponents.agent,
        mode,
        deviceApiPort: this.deviceApiPort,
        reconciliationInterval: config.settings.reconciliationIntervalMs || this.reconciliationIntervalMs,
        cloudApiEndpoint: this.apiUrl,
        cloudFeaturesEnabled: this.deviceInfo.provisioned && !!this.cloudSync,
      });

     
  }

  private async initializeCloudLogging(): Promise<void> {
    const enableCloudLogging = process.env.ENABLE_CLOUD_LOGGING !== "false";

    // Only initialize cloud logging if device is provisioned
    if (
      !this.apiUrl ||
      !enableCloudLogging ||
      !this.deviceInfo.provisioned ||
      !this.deviceInfo.deviceApiKey
    ) {
      if (this.apiUrl && enableCloudLogging && !this.deviceInfo.provisioned) {
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
      const cloudLogBackend = new CloudLogBackend(
        {
          cloudEndpoint: this.apiUrl,
          deviceUuid: this.deviceInfo.uuid,
          deviceApiKey: this.deviceInfo.apiKey,
          compression: process.env.LOG_COMPRESSION !== "false",
        },
        this.agentLogger
      );
      await cloudLogBackend.initialize();
      
      // Add cloud backend to AgentLogger
      this.agentLogger.addBackend(cloudLogBackend);

      this.agentLogger.infoSync("Cloud log backend initialized", {
        component: LogComponents.agent,
        cloudEndpoint: this.apiUrl,
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

  private async initializeDatabase(): Promise<void> {
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
    const cloudEndpoint = process.env.CLOUD_API_ENDPOINT || bootConfig?.cloudApiEndpoint || this.apiUrl;
    
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
      this.agentLogger.infoSync(
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

        this.agentLogger.infoSync("System information detected", {
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

    } else if (!deviceInfo.provisioned && !this.apiUrl) {
      // Local mode - device never provisioned and no cloud endpoint
      this.agentLogger.infoSync("Running in local mode (no cloud connection)", {
        component: LogComponents.agent,
      });
      await this.deviceManager.markAsLocalMode();
      deviceInfo = this.deviceManager.getDeviceInfo();
    } else if (deviceInfo.provisioned && !this.apiUrl) {
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
      this.agentLogger.infoSync("Updating agent version", {
        component: LogComponents.agent,
        oldVersion: this.deviceInfo.agentVersion || "unknown",
        newVersion: currentVersion,
      });
      await this.deviceManager.updateAgentVersion(currentVersion);
      this.deviceInfo = this.deviceManager.getDeviceInfo();
    }
    
    // Now set the device ID on the logger
    this.agentLogger.setDeviceId(this.deviceInfo.uuid);

    this.agentLogger.infoSync("Device manager initialized", {
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
    this.agentLogger.infoSync("Initializing MQTT Manager", {
      component: LogComponents.agent,
    });

    try {
      // Use MQTT credentials from provisioning if available, otherwise fall back to env vars
      const mqttBrokerUrl =
        this.deviceInfo.mqttBrokerUrl || process.env.MQTT_BROKER;
      const mqttUsername =
        this.deviceInfo.mqttUsername || process.env.MQTT_USERNAME;
      const mqttPassword =
        this.deviceInfo.mqttPassword || process.env.MQTT_PASSWORD;

      // Debug: Log broker URL being used
      this.agentLogger.debugSync(`MQTT Broker URL: ${mqttBrokerUrl}`, {
        component: LogComponents.agent,
        source: this.deviceInfo.mqttBrokerUrl ? "provisioning" : "environment",
        hasUsername: !!mqttUsername,
      });

      if (!mqttBrokerUrl) {
        this.agentLogger.debugSync("MQTT disabled - no broker URL provided", {
          component: LogComponents.agent,
          note: "Provision device or set MQTT_BROKER env var to enable",
        });
        return;
      }

      const mqttManager = MqttManager.getInstance();

      // Build MQTT connection options
      const mqttOptions: any = {
        clientId: `device_${this.deviceInfo.uuid}`,
        clean: true,
        reconnectPeriod: 5000,
        username: mqttUsername,
        password: mqttPassword,
      };

      // Add TLS options if broker config specifies TLS
      if (this.deviceInfo.mqttBrokerConfig?.useTls && this.deviceInfo.mqttBrokerConfig.caCert) {
        // Fix double-escaped newlines in certificate (handles both \\n and \n)
        const caCert = this.deviceInfo.mqttBrokerConfig.caCert.replace(/\\n/g, '\n');
        
        // MQTT library expects CA cert as string (not Buffer)
        mqttOptions.ca = caCert;
        mqttOptions.rejectUnauthorized = this.deviceInfo.mqttBrokerConfig.verifyCertificate;
        
        this.agentLogger.infoSync("MQTT TLS enabled", {
          component: LogComponents.agent,
          protocol: this.deviceInfo.mqttBrokerConfig.protocol,
          verifyCertificate: this.deviceInfo.mqttBrokerConfig.verifyCertificate,
          hasCaCert: !!this.deviceInfo.mqttBrokerConfig.caCert,
        });
      }

      // Connect to MQTT broker with provisioned credentials
      await mqttManager.connect(mqttBrokerUrl, mqttOptions);

      // Enable debug mode if requested
      if (process.env.MQTT_DEBUG === "true") {
        mqttManager.setDebug(true);
      }

      this.agentLogger.infoSync("MQTT Manager connected", {
        component: LogComponents.agent,
        brokerUrl: mqttBrokerUrl,
        clientId: `device_${this.deviceInfo.uuid}`,
        username: mqttUsername || "(none)",
        credentialsSource: this.deviceInfo.mqttUsername
          ? "provisioning"
          : "environment",
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

  private async initializeContainerManager(): Promise<void> {
    this.agentLogger?.infoSync("Initializing state reconciler", {
      component: LogComponents.agent,
    });

    // Create StateReconciler (manages both containers and config)
    this.stateReconciler = new StateReconciler(this.agentLogger);
    await this.stateReconciler.init();

    // For backward compatibility, keep ContainerManager reference for DeviceAPI
    this.containerManager = this.stateReconciler.getContainerManager();

    // Set up log monitor for Docker containers
    const docker = this.containerManager.getDocker();
    if (docker) {
      // Use all configured log backends
      this.logMonitor = new ContainerLogMonitor(docker, this.agentLogger);
      this.containerManager.setLogMonitor(this.logMonitor);
      await this.containerManager.attachLogsToAllContainers();
      this.agentLogger.infoSync("Log monitor attached to container manager", {
        component: LogComponents.agent,
        backendCount: this.agentLogger.getBackends().length,
      });
    }

    // Watch for target state changes to update cache
    // Note: Config handling is now done by ConfigManager inside StateReconciler
    // Remove any existing listener to prevent duplicates on re-initialization
    this.stateReconciler.removeListener("target-state-changed", this.targetStateChangeHandler);
    this.stateReconciler.on("target-state-changed", this.targetStateChangeHandler);

    // Initialize cache with current target state
    this.updateCachedTargetState();

    this.agentLogger?.infoSync("State reconciler initialized", {
      component: LogComponents.agent,
    });
  }

  private async initializeDeviceAPI(): Promise<void> {
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
    await this.deviceAPI.listen(this.deviceApiPort);
    this.agentLogger?.infoSync("Device API started", {
      component: LogComponents.agent,
      port: this.deviceApiPort,
    });
  }

  private initializeAnomalyDetection(): void {
    this.agentLogger?.infoSync("Initializing Anomaly Detection Service", {
      component: LogComponents.agent,
    });

    try {
      // Load configuration from environment variables
      const config = loadConfigFromEnv();
      
      // Create anomaly detection service
      this.anomalyService = new AnomalyDetectionService(config, this.agentLogger);
      
      this.agentLogger?.infoSync("Anomaly Detection Service initialized", {
        component: LogComponents.agent,
        enabled: config.enabled,
        metricsCount: config.metrics.filter(m => m.enabled).length,
      });
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

  private async initDiscoveryService (): Promise<void> {
    this.agentLogger?.infoSync("Initializing Discovery Service", {
      component: LogComponents.agent,
    });

    try {
      // Create discovery service
      this.discoveryService = new DiscoveryService(this.agentLogger);
      await this.discoveryService.init();

      // Check if first boot discovery should run
      const enableFirstBootDiscovery = process.env.ENABLE_FIRST_BOOT_DISCOVERY === 'true';
      
      if (enableFirstBootDiscovery) {
        this.agentLogger?.infoSync("Running first boot discovery", {
          component: LogComponents.agent,
        });
        
        // Run discovery in background (don't block startup)
        this.discoveryService.runDiscovery({ 
          trigger: 'first_boot', 
          validate: true 
        }).catch(error => {
          this.agentLogger?.errorSync(
            "First boot discovery failed",
            error as Error,
            { component: LogComponents.agent }
          );
        });
      }

      this.agentLogger?.infoSync("Discovery Service initialized", {
        component: LogComponents.agent,
        firstBootDiscovery: enableFirstBootDiscovery,
      });
      
      // Start periodic discovery if enabled
      this.startPeriodicDiscovery();
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
  
  /**
   * Start periodic discovery timers
   * - Light discovery: Fast scan (ping only) every 4 hours (default)
   * - Full discovery: Deep validation every 24 hours (default)
   */
  private startPeriodicDiscovery(): void {
    if (!this.discoveryService) {
      return;
    }
    
    const enablePeriodicDiscovery = process.env.ENABLE_PERIODIC_DISCOVERY !== 'false'; // Default: enabled
    
    if (!enablePeriodicDiscovery) {
      this.agentLogger?.infoSync('Periodic discovery disabled', {
        component: LogComponents.agent,
      });
      return;
    }
    
    this.agentLogger?.infoSync('Starting periodic discovery timers', {
      component: LogComponents.agent,
      lightIntervalHours: this.discoveryLightIntervalMs / (60 * 60 * 1000),
      fullIntervalHours: this.discoveryFullIntervalMs / (60 * 60 * 1000),
    });
    
    // Light discovery: Fast scan (ping only)
    this.discoveryLightTimer = setInterval(() => {
      this.agentLogger?.infoSync('Running scheduled light discovery', {
        component: LogComponents.agent,
      });
      
      this.discoveryService?.runDiscovery({
        trigger: 'scheduled',
        validate: false, // Ping only, no deep validation
      }).catch(error => {
        this.agentLogger?.errorSync(
          'Scheduled light discovery failed',
          error as Error,
          { component: LogComponents.agent }
        );
      });
    }, this.discoveryLightIntervalMs);
    
    // Full discovery: Deep validation with device info reads
    this.discoveryFullTimer = setInterval(() => {
      this.agentLogger?.infoSync('Running scheduled full discovery', {
        component: LogComponents.agent,
      });
      
      this.discoveryService?.runDiscovery({
        trigger: 'scheduled',
        validate: true, // Full validation with device info
      }).catch(error => {
        this.agentLogger?.errorSync(
          'Scheduled full discovery failed',
          error as Error,
          { component: LogComponents.agent }
        );
      });
    }, this.discoveryFullIntervalMs);
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
      const isProvisioned = this.deviceInfo.provisioned && this.deviceInfo.mqttBrokerUrl;
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

  private async initDeviceSync(
    configSettings: Record<string, any>
  ): Promise<void> {
    if (!this.apiUrl) {
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

    // Get intervals from config (passed as parameter during init)
    this.targetStatePollIntervalMs = configSettings.targetStatePollIntervalMs;
    this.deviceReportIntervalMs = configSettings.deviceReportIntervalMs;
    this.metricsIntervalMs = configSettings.metricsIntervalMs;
 

    // Configure edge AI anomaly detection for system metrics and sensors
    if (this.anomalyService) {
      this.agentLogger?.infoSync('Configuring edge AI anomaly detection', {
        component: LogComponents.agent,
      });
      
      // Wire edge AI anomaly service to system metrics
      const { configureAnomalyFeed: configureSystemMetrics } = await import('./system/metrics.js');
      configureSystemMetrics(this.anomalyService);
      
      // Wire edge AI anomaly service to sensor-publish
      const { configureAnomalyFeed: configureSensorAnomaly } = await import('./features/sensor-publish/sensor.js');
      configureSensorAnomaly(this.anomalyService);
      
      this.agentLogger?.infoSync('Anomaly detection configured for system metrics and sensors', {
        component: LogComponents.agent,
      });
    }

    this.cloudSync = new CloudSync(
      this.stateReconciler, // Use StateReconciler instead of ContainerManager
      this.deviceManager,
      {
        cloudApiEndpoint: this.apiUrl,
        pollInterval: this.targetStatePollIntervalMs, // Use config value or default 60s
        reportInterval: this.deviceReportIntervalMs, // Use config value or default 60s
        metricsInterval: this.metricsIntervalMs, // Use config value or default 5min
      },
      this.agentLogger, // Pass the agent logger
      this.sensorPublish, // Pass sensor-publish for health reporting
      this.sensors, // Pass protocol-adapters for health reporting
      MqttManager.getInstance() // Pass MQTT manager singleton for state reporting (optional)
    );

    // Reinitialize device actions with cloudSync for connection health endpoint
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

  }


  private startAutoReconciliation(): void {
    this.containerManager.startAutoReconciliation(
      this.reconciliationIntervalMs
    );
    this.agentLogger?.infoSync("Auto-reconciliation started", {
      component: LogComponents.agent,
      intervalMs: this.reconciliationIntervalMs,
    });
  }

  /**
   * Start active memory monitoring (independent of /ping healthcheck)
   */
  private startMemoryMonitoring(): void {
    const memoryCheckInterval = parseInt(
      process.env.MEMORY_CHECK_INTERVAL_MS || "30000",
      10
    );
    const memoryThreshold = parseInt(
      process.env.MEMORY_THRESHOLD_MB || "15",
      10
    ) * 1024 * 1024; // Convert MB to bytes

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

  /**
   * Handle scheduled restart configuration from cloud
   * Controlled via target state config.settings.scheduledRestart
   */
  private handleScheduledRestartConfig(): void {
    const config = this.getAgentConfiguration();
    const restartConfig = config.settings.scheduledRestart;

    // Clear existing timer if present
    if (this.scheduledRestartTimer) {
      clearTimeout(this.scheduledRestartTimer);
      this.scheduledRestartTimer = undefined;
      this.agentLogger?.infoSync("Cleared existing scheduled restart timer", {
        component: LogComponents.agent,
      });
    }

    // Check if scheduled restart is enabled
    if (!restartConfig || !restartConfig.enabled) {
      this.agentLogger?.debugSync("Scheduled restart disabled or not configured", {
        component: LogComponents.agent,
        config: restartConfig || "not set"
      });
      return;
    }

    // Validate configuration
    const intervalDays = parseInt(restartConfig.intervalDays, 10);
    if (isNaN(intervalDays) || intervalDays < 1 || intervalDays > 90) {
      this.agentLogger?.warnSync("Invalid scheduled restart intervalDays, must be 1-90", {
        component: LogComponents.agent,
        providedValue: restartConfig.intervalDays,
        using: "disabled"
      });
      return;
    }

    // Calculate restart time
    const restartTimeMs = intervalDays * 24 * 60 * 60 * 1000;
    const restartAt = new Date(Date.now() + restartTimeMs);

    this.agentLogger?.infoSync("Scheduled restart configured from cloud", {
      component: LogComponents.agent,
      enabled: true,
      intervalDays,
      restartAtISO: restartAt.toISOString(),
      restartAtLocal: restartAt.toLocaleString(),
      reason: restartConfig.reason || "heap_fragmentation_cleanup",
      configSource: "cloud_target_state"
    });

    // Schedule the restart
    this.scheduledRestartTimer = setTimeout(async () => {
      this.agentLogger?.infoSync("Initiating scheduled restart", {
        component: LogComponents.agent,
        trigger: "scheduled_timer",
        intervalDays,
        reason: restartConfig.reason || "heap_fragmentation_cleanup",
        uptimeDays: intervalDays,
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString()
      });

      try {
        // Graceful shutdown
        await this.stop();
        
        this.agentLogger?.infoSync("Graceful shutdown complete, exiting for restart", {
          component: LogComponents.agent,
          exitCode: 0
        });
        
        // Exit with code 0 (Docker/systemd will restart automatically)
        process.exit(0);
      } catch (error) {
        this.agentLogger?.errorSync(
          "Error during scheduled restart shutdown",
          error instanceof Error ? error : new Error(String(error)),
          {
            component: LogComponents.agent,
            action: "forcing_exit"
          }
        );
        
        // Force exit even if graceful shutdown fails
        process.exit(1);
      }
    }, restartTimeMs);

    // Don't prevent graceful shutdown
    this.scheduledRestartTimer.unref();
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
      
      // Clear discovery timers
      if (this.discoveryLightTimer) {
        clearInterval(this.discoveryLightTimer);
        this.discoveryLightTimer = undefined;
      }
      if (this.discoveryFullTimer) {
        clearInterval(this.discoveryFullTimer);
        this.discoveryFullTimer = undefined;
      }
      if (this.discoveryLightTimer || this.discoveryFullTimer) {
        this.agentLogger?.infoSync("Discovery timers cleared", {
          component: LogComponents.agent,
        });
      }

      // Remove all StateReconciler event listeners
      if (this.stateReconciler) {
        this.stateReconciler.removeListener("target-state-changed", this.targetStateChangeHandler);
        this.agentLogger?.infoSync("StateReconciler event listeners removed", {
          component: LogComponents.agent,
        });
      }

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

  
  private updateCachedTargetState(): void {
    this.cachedTargetState = this.stateReconciler.getTargetState();
  }

  /**
   * Get all agent configuration sections in one call
   * Reduces repeated property access and makes config usage clearer
   */
  private getAgentConfiguration() {
    return {
      features: this.cachedTargetState?.config?.features || {},
      settings: this.cachedTargetState?.config?.settings || {},
      logging: this.cachedTargetState?.config?.logging || {}
    };
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

  public getJobEngine() {
    return this.jobs?.getJobEngine();
  }
}
