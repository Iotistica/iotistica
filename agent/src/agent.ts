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
import { LocalLogBackend } from "./logging/local-backend.js";
import { CloudLogBackend } from "./logging/cloud-backend.js";
import { ContainerLogMonitor } from "./logging/docker-monitor.js";
import { AgentLogger } from "./logging/agent-logger.js";
import type { LogLevel } from "./logging/types.js";
import { LogComponents } from "./logging/types.js";

import { MqttManager } from "./mqtt/manager.js";
import { getPackageVersion } from "./utils/api-utils";
import { FetchHttpClient, createHttpClient } from "./lib/http-client.js";

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
import type { ConfigManager } from "./device-manager/config.js";

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

export default class Agent {
  private stateReconciler!: StateReconciler; // Main state manager
  private containerManager!: ContainerManager; // Keep for backward compatibility with DeviceAPI
  private deviceManager!: DeviceManager;
  private deviceInfo!: DeviceInfo; // Cache device info after initialization
  private deviceAPI!: DeviceAPI;
  private cloudSync?: CloudSync;
  private bufferSync?: import('./sync/buffer-sync').MessageBufferSync; // Local message data queue for offline MQTT
  private logMonitor?: ContainerLogMonitor;
  public agentLogger!: AgentLogger; // Structured logging for agent-level events (public for external access)
  private firewall?: AgentFirewall; // Network firewall protection
  private updater?: AgentUpdater; // Agent self-update handler
  private featureInitializer?: FeatureInitializer;
  private anomalyService?: AnomalyDetectionService; // Edge-based AI anomaly detection for metrics and sensors
  private simulationOrchestrator?: SimulationOrchestrator; // Simulation framework for testing
  private discoveryService?: DiscoveryService; // Protocol discovery (Modbus, OPC-UA, CAN, etc.)
  private configManager!: ConfigManager; // Configuration manager (centralized config access)
  private dictionaryManager?: import('./dictionary/manager').DictionaryManager; // MQTT message key compaction (top-level service)
  private sharedHttpClient?: import('./lib/http-client').HttpClient; // Shared HTTP client for connection pooling

  // System settings (config-driven with env var defaults)
  // Note: All settings now accessed via configManager getters (intervals, endpoints, ports, etc.)
  // Scheduled restart timer (controlled from cloud config)
  private scheduledRestartTimer?: NodeJS.Timeout;

  // Note: Configuration change handling done by ConfigManager reactive handlers
  // ConfigManager listens to StateReconciler events and applies changes automatically

  constructor() {
    // StateReconciler and ConfigManager will be initialized in init()
    // (StateReconciler needs async init() to load target state from SQLite)
  }

  public async init(): Promise<void> {

      // Initialize database FIRST (needed by StateReconciler)
      await this.initDatabase();

      // Initialize StateReconciler and ConfigManager EARLY (before logging setup)
      // This ensures ConfigManager can read target state from SQLite database
      await this.initializeStateReconciler();

      // Setup event listeners IMMEDIATELY after StateReconciler init
      // CRITICAL: Must happen before CloudSync/auto-reconciliation start
      // to ensure hot-reload events are captured from first reconciliation
      this.setupConfigEventListeners();

      // Initialize logging (now ConfigManager is available)
      const loggingConfig = this.configManager.getLoggingConfig();
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

      // Pass logger to StateReconciler (created before logger was available)
      this.stateReconciler.setLogger(this.agentLogger);

      // Initialize shared HTTP client EARLY (before DeviceManager needs it)
      // Uses centralized factory for consistent TLS configuration
      const cloudApiEndpoint = this.configManager.getCloudApiEndpoint();
      this.sharedHttpClient = createHttpClient(cloudApiEndpoint);

      // Initialize device provisioning (uses sharedHttpClient)
      await this.initializeDeviceManager();

      // Initialize VPN auto-reconnection EARLY (right after device manager)
      // This ensures device is reachable via VPN as soon as possible
      await this.initializeVpnReconnection();

      // Initialize cloud logging if device is provisioned
      await this.initializeCloudLogging();

      // Parallelize independent initializations (MQTT and Container Manager)
      // StateReconciler already initialized, so just get ContainerManager reference
      await Promise.all([
        this.initializeMqttManager(),      // ~300-500ms
        this.initContainerManager()       // ~200-300ms (just setup, no init)
      ]);
      // Saves ~300-500ms compared to sequential execution

      // Initialize buffer sync AFTER MQTT manager
      await this.initializeBufferSync();

      // Initialize device API
      await this.initDeviceAPI();

      // Memory checkpoint: Before loading target state
      const mem1 = process.memoryUsage();
      this.agentLogger.debugSync('Memory before loading target state', {
        component: 'Agent' as any,
        heapUsed: `${Math.round(mem1.heapUsed / 1024 / 1024)}MB`
      });

      // Get target state ONCE to avoid multiple calls
      const targetState = this.stateReconciler.getTargetState();
      
      // Memory checkpoint: After loading target state
      const mem2 = process.memoryUsage();
      const targetStateSize = targetState ? JSON.stringify(targetState).length : 0;
      this.agentLogger.debugSync('Memory after loading target state', {
        component: 'Agent' as any,
        heapUsed: `${Math.round(mem2.heapUsed / 1024 / 1024)}MB`,
        targetStateSize,
        targetStateSizeMB: (targetStateSize / 1024 / 1024).toFixed(2),
        hasConfig: !!targetState?.config,
        hasProtocols: !!targetState?.config?.protocols,
        hasSettings: !!targetState?.config?.settings
      });

      // Initialize optional features using FeatureInitializer
      const featureContext: FeatureContext = {
        logger: this.agentLogger,
        deviceInfo: this.deviceInfo,
        deviceManager: this.deviceManager,
        stateReconciler: this.stateReconciler,
        mqttManager: MqttManager.getInstance(),
        httpClient: this.sharedHttpClient,
        containerManager: this.containerManager,
        configSettings: targetState?.config?.settings || {},
        configFeatures: this.configManager.getFeatures(),
        configProtocols: targetState?.config?.protocols || {},
        cloudApiEndpoint: this.configManager.getCloudApiEndpoint(),
        deviceApiPort: this.configManager.getDeviceApiPort(),
        anomalyService: this.anomalyService,
        dictionaryManager: this.dictionaryManager
      };

      // Memory checkpoint: After creating featureContext
      const mem3 = process.memoryUsage();
      this.agentLogger.debugSync('Memory after creating featureContext', {
        component: 'Agent' as any,
        heapUsed: `${Math.round(mem3.heapUsed / 1024 / 1024)}MB`
      });

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

      // 11. Initialize supporting features (updater, firewall, sensor config handler)
      // MUST happen BEFORE initDeviceSync so AgentUpdater is available for CloudSync
      this.agentLogger?.infoSync('About to initialize supporting features', {
        component: LogComponents.agent
      });
      
      await this.featureInitializer.initSupportingFeatures();

      // Store references for backward compatibility
      const features = this.featureInitializer.getFeatures();
      
      this.agentLogger?.infoSync('Supporting features initialized', {
        component: LogComponents.agent,
        hasUpdater: !!features.updater,
        hasFirewall: !!features.firewall
      });
      
      this.updater = features.updater;
      this.firewall = features.firewall;

      // Set AgentUpdater on StateReconciler (for version reconciliation)
      if (this.updater) {
        this.agentLogger?.infoSync('Setting AgentUpdater on StateReconciler', {
          component: LogComponents.agent,
          hasUpdater: true
        });
        this.stateReconciler.setAgentUpdater(this.updater);
      } else {
        this.agentLogger?.warnSync('AgentUpdater not initialized, version reconciliation unavailable', {
          component: LogComponents.agent
        });
      }

      // 12. init sync (CloudSync will use AgentUpdater set above)
      await this.initDeviceSync();

      // 12.1. Initialize anomaly detection after CloudSync loads cloud config
      // This ensures we respect cloud-configured feature flags (not just env variables)
      await this.initAnomalyDetection();

      // 12.2. Initialize device actions with all dependencies ready
      // (containerManager, deviceManager, cloudSync, logger, anomalyService, simulationOrchestrator)
      deviceActions.initialize(
        this.containerManager,
        this.deviceManager,
        this.cloudSync,
        this.agentLogger,
        this.anomalyService,
        this.simulationOrchestrator
      );

		// 12.3. Expose agent and discovery service to API actions
		deviceActions.setAgent(this);
		deviceActions.setDiscoveryService(this.discoveryService);

      // 13. Initialize reactive ConfigManager handlers (handles all config changes automatically)
      // CRITICAL: Must be set BEFORE auto-reconciliation starts to ensure discoveryService is available
      // when handleEndpointsChanges() is triggered during initial reconciliation
      this.configManager.setReactiveHandlers({
        containerManager: this.containerManager,
        cloudSync: this.cloudSync,
        discoveryService: this.discoveryService,
      });

      // 14. Start auto-reconciliation
      this.startAutoReconciliation();

      // 15. Start active memory monitoring (independent of healthcheck endpoint)
      this.startMemoryMonitoring();

      // Note: Event listeners already set up in setupConfigEventListeners() (called early)

      //Final words
      const mode: "Cloud-connected" | "Standalone (not provisioned)" = this.deviceInfo.provisioned
        ? "Cloud-connected"
        : "Standalone (not provisioned)";

      const intervals = this.configManager.getIntervalConfig();
      
      this.agentLogger.debugSync("Device Agent initialized successfully", {
        component: LogComponents.agent,
        mode,
        deviceApiPort: this.configManager.getDeviceApiPort(),
        reconciliationInterval: intervals.reconciliationIntervalMs,
        cloudApiEndpoint: this.configManager.getCloudApiEndpoint(),
        cloudFeaturesEnabled: this.deviceInfo.provisioned && !!this.cloudSync,
      });

     
  }

  private async initializeCloudLogging(): Promise<void> {
    const cloudApiEndpoint = this.configManager.getCloudApiEndpoint();

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
      const loggingConfig = this.configManager.getLoggingConfig();
      
      const cloudLogBackend = new CloudLogBackend(
        {
          cloudEndpoint: cloudApiEndpoint,
          deviceUuid: this.deviceInfo.uuid,
          deviceApiKey: this.deviceInfo.apiKey,
          httpClient: this.sharedHttpClient, // Use shared HTTP client for connection pooling
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
    const { initialized } = await import('./db/connection.js');
    await initialized(this.agentLogger);
  }

  private async initializeDeviceManager(): Promise<void> {
    const cloudApiEndpoint = this.configManager.getCloudApiEndpoint();
    // Pass shared HTTP client for connection pooling
    this.deviceManager = new DeviceManager(this.agentLogger, this.sharedHttpClient, undefined, undefined, cloudApiEndpoint);
    await this.deviceManager.initialize();

    let deviceInfo = this.deviceManager.getDeviceInfo();

    // Load boot config if available (Yocto images or manual config)
    const bootConfig = loadBootConfig();
    
    // Get provisioning key from multiple sources (priority order):
    // 1. Environment variable (highest priority - manual override)
    // 2. Boot config file (Iotistic OS Yocto images)
    const provisioningApiKey = process.env.PROVISIONING_KEY || bootConfig?.provisioningKey;
    
    // Get API endpoint (environment takes priority over boot config)
    const cloudEndpoint = process.env.CLOUD_API_ENDPOINT || bootConfig?.cloudApiEndpoint || this.configManager.getCloudApiEndpoint();
    
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
            process.env.DEVICE_NAME || bootConfig?.deviceName || `agent-${deviceInfo.uuid.slice(0, 8)}`,
          deviceType: process.env.DEVICE_TYPE || bootConfig?.deviceType || "standalone",
          apiEndpoint: cloudEndpoint,
          macAddress,
          osVersion,
          agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
        });
        deviceInfo = this.deviceManager.getDeviceInfo();
        this.deviceInfo = deviceInfo;
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
        // Continue with unprovisioned device info (don't return early)
        deviceInfo = this.deviceManager.getDeviceInfo();
      }
    } else if (!deviceInfo.provisioned && cloudEndpoint && !provisioningApiKey
    ) {
      this.agentLogger.warnSync("Device not provisioned", {
        component: LogComponents.agent,
        note: "Set PROVISIONING_KEY environment variable or provide /data/iotistic/boot-config.json",
      });

    } else if (!deviceInfo.provisioned && !this.configManager.getCloudApiEndpoint()) {
      // Local mode - device never provisioned and no cloud endpoint
      this.agentLogger.infoSync("Running in local mode (no cloud connection)", {
        component: LogComponents.agent,
      });
      await this.deviceManager.markAsLocalMode();
      deviceInfo = this.deviceManager.getDeviceInfo();
    } else if (deviceInfo.provisioned && !this.configManager.getCloudApiEndpoint()) {
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

      // Log MQTT broker config for troubleshooting
      this.agentLogger.infoSync("🔍 MQTT BROKER CONFIG FROM DATABASE", {
        component: LogComponents.agent,
        operation: "mqtt-init",
        configKeys: Object.keys(config),
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        useTls: config.useTls,
        verifyCertificate: config.verifyCertificate,
        hasCaCert: !!config.caCert,
        hasUsername: !!config.username,
        hasPassword: !!config.password
      });

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
      if (config.useTls) {
        const hasCaCert = !!config.caCert;
        // If no CA is provided, always skip verification (self-signed/dev mode)
        const rejectUnauthorized = hasCaCert
          ? (config.verifyCertificate ?? true) // With CA: default to verify unless explicitly false
          : false; // Without CA: never verify

        mqttOptions.rejectUnauthorized = rejectUnauthorized;

        if (config.caCert) {
          // Fix double-escaped newlines in certificate (handles both \\n and \n)
          const caCert = config.caCert.replace(/\\n/g, '\n');
          // MQTT library expects CA cert as string (not Buffer)
          mqttOptions.ca = caCert;
        }
        
        this.agentLogger.infoSync("MQTT TLS enabled", {
          component: LogComponents.agent,
          protocol: config.protocol,
          verifyCertificate: config.verifyCertificate,
          hasCaCert,
          rejectUnauthorized,
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

      // Set logger on MQTT manager
      mqttManager.setLogger(this.agentLogger);

      // Initialize dictionary manager as top-level service (decoupled from MqttManager)
      await this.initializeDictionaryManager();
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

  /**
   * Initialize Dictionary Manager for MQTT message key compaction
   * Decoupled from MqttManager - initialized as top-level service
   */
  private async initializeDictionaryManager(): Promise<void> {
    // Only initialize if enabled via environment variable
    if (process.env.USE_KEY_COMPACTION_POC !== 'true') {
      this.agentLogger?.debugSync('Dictionary compaction disabled (USE_KEY_COMPACTION_POC != true)', {
        component: LogComponents.mqtt,
      });
      return;
    }

    try {
      const { DictionaryManager } = await import('./dictionary/manager.js');
      const mqttManager = MqttManager.getInstance();
      
      this.dictionaryManager = new DictionaryManager(mqttManager, this.agentLogger, this.deviceInfo.uuid);
      await this.dictionaryManager.initialize();
      
      this.agentLogger?.infoSync('Dictionary Manager initialized', {
        component: LogComponents.mqtt,
        deviceUuid: this.deviceInfo.uuid,
      });
    } catch (error) {
      this.agentLogger?.errorSync(
        'Failed to initialize Dictionary Manager',
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
          note: 'Dictionary compaction will be unavailable',
        }
      );
      // Don't throw - allow agent to continue without dictionary compaction
    }
  }

  private async initializeBufferSync(): Promise<void> {
    // Only initialize buffer sync if MQTT is configured
    if (!this.deviceInfo.mqttBrokerConfig) {
      this.agentLogger?.debugSync("Message buffer sync disabled - MQTT not configured", {
        component: LogComponents.agent
      });
      return;
    }

    try {
      const { MessageBufferSync } = await import('./sync/buffer-sync.js');
      const mqttManager = MqttManager.getInstance();
      
      this.bufferSync = new MessageBufferSync(
        mqttManager,
        this.agentLogger,
        {
          enabled: true,
          flushBatchSize: 100,
          flushIntervalMs: 30000, // 30 seconds
          maxRetries: 3,
          cleanupIntervalMs: 3600000 // 1 hour
        }
      );

      await this.bufferSync.start();

      this.agentLogger?.infoSync("Message buffer sync started", {
        component: LogComponents.agent,
        flushInterval: "30s",
        batchSize: 100
      });
    } catch (error) {
      this.agentLogger?.errorSync(
        "Failed to initialize message buffer sync",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
          note: "Message data will not be buffered when MQTT is offline"
        }
      );
    }
  }

  private async initializeStateReconciler(): Promise<void> {
    // Create StateReconciler (manages both containers and config)
    this.stateReconciler = new StateReconciler();
    await this.stateReconciler.init();
    
    // Get ConfigManager reference from StateReconciler
    this.configManager = this.stateReconciler.getConfigManager();
    
    // Note: Reactive handler setup happens later via setReactiveHandlers()
    // after all dependencies (logger, containerManager, etc.) are available
  }

  /**
   * Setup configuration event listeners
   * CRITICAL: Must be called early (before CloudSync/auto-reconciliation)
   * to ensure hot-reload events are captured from first reconciliation
   */
  private setupConfigEventListeners(): void {
    // Listen for feature changes from StateReconciler
    this.stateReconciler.on('features-changed', async (change: { old: any; new: any }) => {
      const logger = this.agentLogger;
      logger?.infoSync('Features configuration changed', {
        component: LogComponents.agent,
        changes: Object.keys(change.new).filter(key => change.old[key] !== change.new[key])
      });
      
      // Handle anomaly detection toggle
      if (change.old.enableAnomalyDetection !== change.new.enableAnomalyDetection) {
        if (change.new.enableAnomalyDetection && !this.anomalyService) {
          logger?.infoSync('Starting Anomaly Detection Service (dynamically enabled)', {
            component: LogComponents.agent
          });
          await this.initAnomalyDetection();
        } else if (!change.new.enableAnomalyDetection && this.anomalyService) {
          logger?.infoSync('Stopping Anomaly Detection Service (dynamically disabled)', {
            component: LogComponents.agent
          });
          this.anomalyService.stop();
          this.anomalyService = undefined;
        }
      }
    });

    // Listen for anomaly config changes from StateReconciler
    this.stateReconciler.on('anomaly-config-changed', (change: { old: any; new: any }) => {
      const logger = this.agentLogger;
      logger?.infoSync('Anomaly configuration changed from cloud', {
        component: LogComponents.agent
      });
      
      // Reload anomaly config if service is running
      if (this.anomalyService && change.new) {
        logger?.infoSync('Reloading anomaly detection configuration', {
          component: LogComponents.agent,
          metricsCount: change.new.metrics?.filter((m: any) => m.enabled).length
        });
        this.anomalyService.updateConfig(change.new);
      }
    });

    // Listen for ConfigManager events that require Agent context
    this.configManager.on('restart-discovery-timers', (intervals: any) => {
      this.discoveryService?.startPeriodicDiscovery();
    });

    this.configManager.on('schedule-restart', ({ restartTimeMs, restartConfig }: any) => {
      const logger = this.agentLogger;
      this.scheduledRestartTimer = setTimeout(async () => {
        logger?.infoSync("Initiating scheduled restart", {
          component: LogComponents.agent,
          trigger: "scheduled_timer",
          reason: restartConfig.reason || "heap_fragmentation_cleanup",
          memoryUsage: process.memoryUsage(),
          timestamp: new Date().toISOString()
        });

        try {
          await this.stop();
          logger?.infoSync("Graceful shutdown complete, exiting for restart", {
            component: LogComponents.agent,
            exitCode: 0
          });
          process.exit(0);
        } catch (error) {
          logger?.errorSync(
            "Error during scheduled restart shutdown",
            error instanceof Error ? error : new Error(String(error)),
            { component: LogComponents.agent, action: "forcing_exit" }
          );
          process.exit(1);
        }
      }, restartTimeMs);

      this.scheduledRestartTimer.unref();
    });
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

    // Note: Config change handling is now done by ConfigManager reactive layer
    // ConfigManager listens to StateReconciler's granular events directly

    this.agentLogger?.infoSync("Container manager setup complete", {
      component: LogComponents.agent,
    });
  }


  private async initDeviceAPI(): Promise<void> {
    // Skip if Device API is already running (e.g., during restartServices)
    if (this.deviceAPI) {
      this.agentLogger?.infoSync("Device API already running, skipping initialization", {
        component: LogComponents.agent,
      });
      return;
    }

    this.agentLogger?.infoSync("Initializing device API", {
      component: LogComponents.agent,
    });

    // Note: deviceActions.initialize deferred until all dependencies ready (see initDeviceSync)

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
    await this.deviceAPI.listen(this.configManager.getDeviceApiPort());
    this.agentLogger?.infoSync("Device API started", {
      component: LogComponents.agent,
      port: this.configManager.getDeviceApiPort(),
    });
  }

  private async initAnomalyDetection(): Promise<void> {
    // Check if anomaly detection is enabled (cloud config → env fallback)
    const features = this.configManager.getFeatures();
    
    if (!features.enableAnomalyDetection) {
      this.agentLogger?.infoSync("Anomaly Detection disabled by configuration", {
        component: LogComponents.agent,
      });
      return;
    }
    
    // Clean up existing service before reinitializing (prevents memory leaks)
    if (this.anomalyService) {
      this.agentLogger?.infoSync("Cleaning up existing Anomaly Detection Service before reinitializing", {
        component: LogComponents.agent,
      });
      this.anomalyService.stop();
      this.anomalyService = undefined;
    }
    
    this.agentLogger?.infoSync("Initializing Anomaly Detection Service", {
      component: LogComponents.agent,
    });

    try {
      // Load configuration from target state (preferred) or environment variables (fallback)
      const targetStateConfig = this.stateReconciler.getTargetState()?.config;
      const config = loadConfigFromTargetState(targetStateConfig);
      
      // Get database connection for storage
      const { getKnex } = await import('./db/connection.js');
      const dbInstance = getKnex();
      
      // Build unified metrics array from system metrics + endpoint datapoint configs
      const systemMetrics = config.systemMetrics || [];
      const endpointMetrics = this.buildEndpointMetrics(targetStateConfig, config.defaults);
      
      // Merge system metrics with endpoint metrics
      config.metrics = [...systemMetrics, ...endpointMetrics];
      
      this.agentLogger?.infoSync('Anomaly metrics configured (two-level inheritance)', {
        component: LogComponents.agent,
        systemMetrics: systemMetrics.length,
        endpointMetrics: endpointMetrics.length,
        totalMetrics: config.metrics.length,
        defaults: config.defaults,
      });
      
      // Create anomaly detection service with database storage and MQTT publishing
      this.anomalyService = new AnomalyDetectionService(
        config,
        dbInstance,
        this.agentLogger,
        MqttManager.getInstance(),
        this.deviceInfo.uuid
      );
      
      this.agentLogger?.infoSync('Anomaly detection initialized with inheritance support', {
        component: LogComponents.agent,
        enabledMetrics: config.metrics.filter(m => m.enabled).length,
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
   * Build endpoint metrics from datapoint anomaly configs
   * Applies inheritance: defaults → datapoint overrides
   */
  private buildEndpointMetrics(targetStateConfig: any, defaults: any): any[] {
    const metrics: any[] = [];
    const endpoints = targetStateConfig?.endpoints || [];
    
    for (const endpoint of endpoints) {
      if (!endpoint.enabled || !endpoint.dataPoints) continue;
      
      for (const dp of endpoint.dataPoints) {
        const anomalyConfig = dp.anomalyDetection;
        
        // Skip if anomaly detection not enabled for this data point
        if (!anomalyConfig?.enabled) continue;
        
        // Build metric name: {deviceUuid}_{endpointName}_{dataPointName}
        const metricName = `${this.deviceInfo.uuid}_${endpoint.name}_${dp.name}`;
        
        // Merge defaults with datapoint overrides
        const metric: any = {
          name: metricName,
          enabled: true,
          methods: anomalyConfig.methods || defaults?.methods || ['mad'],
          threshold: anomalyConfig.threshold ?? defaults?.threshold ?? 3.0,
          windowSize: anomalyConfig.windowSize ?? defaults?.windowSize ?? 120,
          minConfidence: anomalyConfig.minConfidence ?? 0.7,
        };
        
        // Add expected range if provided
        if (anomalyConfig.expectedRange) {
          const range = anomalyConfig.expectedRange;
          if (range.min !== undefined && range.max !== undefined) {
            metric.expectedRange = [range.min, range.max];
          }
        }
        
        metrics.push(metric);
      }
    }
    
    return metrics;
  }
  
  /**
   * Configure anomaly detection feed for system metrics and sensors
   */
  private async configureAnomalyFeed(): Promise<void> {
    if (!this.anomalyService) return;
    
    this.agentLogger?.infoSync('Configuring edge anomaly detection', {
      component: LogComponents.agent,
    });
    
    // Wire edge AI anomaly service to system metrics
    const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('./system/metrics.js');
    configureSystemMetrics(this.anomalyService);
    
    // Wire edge AI anomaly service to sensor-publish
    const { configureAnomalyFeed: configureSensorAnomaly } = await import('./features/publish/manager.js');
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
      this.discoveryService = new DiscoveryService(this.agentLogger, this.configManager);
      await this.discoveryService.init();

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
    const cloudApiEndpoint = this.configManager.getCloudApiEndpoint();
    
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

    // Get intervals from ConfigManager (cloud → env fallback)
    const intervals = this.configManager.getIntervalConfig();

    // Get features for CloudSync (endpoints service for health reporting)
    const features = this.featureInitializer?.getFeatures() || {};

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
      features.sensors, // Endpoints service for health reporting
      MqttManager.getInstance(), // Pass MQTT manager singleton for state reporting (optional)
      this.sharedHttpClient, // Use shared HTTP client for connection pooling
      this.updater // Pass AgentUpdater for version reporting
    );

    // Pass CloudSync reference to FeatureInitializer for auto-reload coordination
    // This allows auto-reload to update CloudSync's endpoints reference after reinitializing protocol adapters
    this.featureInitializer?.setCloudSync(this.cloudSync);

    // Start polling for target state (loads cloud config)
    await this.cloudSync.startPoll();


  }

  private startAutoReconciliation(): void {
    const intervals = this.configManager.getIntervalConfig();
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
    const performanceConfig = this.configManager.getPerformanceConfig();
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

      // Shutdown dictionary manager before disconnecting MQTT (it needs MQTT for final sync)
      if (this.dictionaryManager) {
        await this.dictionaryManager.shutdown();
        this.agentLogger?.infoSync('Dictionary Manager shutdown', {
          component: LogComponents.mqtt,
        });
        this.dictionaryManager = undefined;
      }

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

      // ConfigManager handles its own cleanup (event listeners)
      // No manual removal needed since ConfigManager is garbage collected

      // **CRITICAL: Database shutdown LAST** (after all features stopped)
      // Import here to avoid circular dependencies
      const { gracefulShutdown: shutdownDatabase } = await import('./db/connection.js');
      await shutdownDatabase();
      this.agentLogger?.infoSync("Database connection closed", {
        component: LogComponents.agent,
      });

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

  /**
   * Restart all agent services except the API server and MQTT
   * This is a soft restart that keeps the HTTP server and MQTT connection running
   */
  public async restartServices(): Promise<void> {
    this.agentLogger?.infoSync('Starting agent services restart (soft restart)', {
      component: LogComponents.agent,
      note: 'API and MQTT will remain running',
    });

    try {
      // Stop features (sensors, jobs, protocols) but preserve shell handler
      if (this.featureInitializer) {
        this.agentLogger?.infoSync('Stopping features (sensors, jobs, protocols)...', {
          component: LogComponents.agent,
        });
        await this.featureInitializer.cleanup(true); // preserveShell = true
        this.featureInitializer = undefined;
        this.agentLogger?.infoSync('✓ Features stopped (shell preserved)', {
          component: LogComponents.agent,
        });
      }
      
      // Stop cloud sync
      if (this.cloudSync) {
        this.agentLogger?.infoSync('Stopping cloud sync...', {
          component: LogComponents.agent,
        });
        await this.cloudSync.stop();
        this.cloudSync = undefined;
        this.agentLogger?.infoSync('✓ Cloud sync stopped', {
          component: LogComponents.agent,
        });
      }

      // Stop firewall
      if (this.firewall) {
        this.agentLogger?.infoSync('Stopping firewall...', {
          component: LogComponents.agent,
        });
        await this.firewall.stop();
        this.firewall = undefined;
        this.agentLogger?.infoSync('✓ Firewall stopped', {
          component: LogComponents.agent,
        });
      }

      // Stop updater
      if (this.updater) {
        this.agentLogger?.infoSync('Stopping agent updater...', {
          component: LogComponents.agent,
        });
        await this.updater.cleanup();
        this.updater = undefined;
        this.agentLogger?.infoSync('✓ Agent updater stopped', {
          component: LogComponents.agent,
        });
      }

      // Stop memory monitoring
      this.agentLogger?.infoSync('Stopping memory monitoring...', {
        component: LogComponents.agent,
      });
      stopMemoryMonitoring();
      this.agentLogger?.infoSync('✓ Memory monitoring stopped', {
        component: LogComponents.agent,
      });

      // Stop simulation orchestrator
      if (this.simulationOrchestrator) {
        this.agentLogger?.infoSync('Stopping simulation orchestrator...', {
          component: LogComponents.agent,
        });
        await this.simulationOrchestrator.stop();
        this.simulationOrchestrator = undefined;
        this.agentLogger?.infoSync('✓ Simulation orchestrator stopped', {
          component: LogComponents.agent,
        });
      }

      stopMemoryLeakSimulation();

      // Stop log backends (cloud logging)
      this.agentLogger?.infoSync('Stopping log backends...', {
        component: LogComponents.agent,
      });
      for (const backend of this.agentLogger?.getBackends() || []) {
        try {
          if ('disconnect' in backend && typeof backend.disconnect === 'function') {
            await backend.disconnect();
          } else if ('stop' in backend && typeof backend.stop === 'function') {
            await (backend as any).stop();
          }
        } catch (error) {
          this.agentLogger?.warnSync('Error stopping log backend', {
            component: LogComponents.agent,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.agentLogger?.infoSync('✓ Log backends stopped', {
        component: LogComponents.agent,
      });

      // Stop dictionary manager
      if (this.dictionaryManager) {
        this.agentLogger?.infoSync('Stopping dictionary manager...', {
          component: LogComponents.agent,
        });
        await this.dictionaryManager.shutdown();
        this.dictionaryManager = undefined;
        this.agentLogger?.infoSync('✓ Dictionary manager stopped', {
          component: LogComponents.agent,
        });
      }

      // SKIP MQTT - keep it running for shell session and MQTT monitoring
      this.agentLogger?.infoSync('✓ MQTT connection preserved (not restarted)', {
        component: LogComponents.agent,
      });

      // NOTE: Skip deviceAPI - keep it running!

      // Stop auto-reconciliation
      if (this.containerManager) {
        this.agentLogger?.infoSync('Stopping auto-reconciliation...', {
          component: LogComponents.agent,
        });
        this.containerManager.stopAutoReconciliation();
        this.agentLogger?.infoSync('✓ Auto-reconciliation stopped', {
          component: LogComponents.agent,
        });
      }

      // Clear scheduled restart timer
      if (this.scheduledRestartTimer) {
        clearTimeout(this.scheduledRestartTimer);
        this.scheduledRestartTimer = undefined;
      }
      
      // Stop discovery service
      if (this.discoveryService) {
        this.agentLogger?.infoSync('Stopping discovery service...', {
          component: LogComponents.agent,
        });
        this.discoveryService.stopPeriodicDiscovery();
        this.discoveryService = undefined;
        this.agentLogger?.infoSync('✓ Discovery service stopped', {
          component: LogComponents.agent,
        });
      }

      this.agentLogger?.infoSync('All services stopped, reinitializing...', {
        component: LogComponents.agent,
      });

      // Small delay to ensure cleanup completes
      await new Promise(resolve => setTimeout(resolve, 500));

      // Re-initialize all services (reuse init logic)
      await this.init();

      this.agentLogger?.infoSync('✓ Agent services restarted successfully', {
        component: LogComponents.agent,
        note: 'All services reinitialized (API and MQTT preserved)',
      });
    } catch (error) {
      this.agentLogger?.errorSync(
        'Agent restart failed',
        error instanceof Error ? error : new Error(String(error)),
        { component: LogComponents.agent }
      );
      throw error;
    }
  }

  /**
   * Initialize VPN auto-reconnection
   * Ensures Tailscale daemon is running and reconnects if device was previously connected
   */
  private async initializeVpnReconnection(): Promise<void> {
    this.agentLogger?.infoSync('Checking VPN auto-reconnection status', {
      component: LogComponents.agent,
      provisioned: this.deviceInfo.provisioned,
      vpnEnabled: this.deviceInfo.vpnEnabled,
    });

    // Only attempt VPN reconnection if device is provisioned AND VPN was enabled during provisioning
    if (!this.deviceInfo.provisioned || !this.deviceInfo.vpnEnabled) {
      this.agentLogger?.infoSync('VPN auto-reconnection skipped (device not provisioned with VPN)', {
        component: LogComponents.agent,
        provisioned: this.deviceInfo.provisioned,
        vpnEnabled: this.deviceInfo.vpnEnabled,
      });
      return;
    }

    try {
      const { TailscaleManager } = await import('./network/vpn/tailscale-manager.js');
      const tailscale = new TailscaleManager(this.agentLogger);

      // Check if Tailscale is installed
      const isInstalled = await tailscale.checkInstallation();
      if (!isInstalled) {
        this.agentLogger?.infoSync('VPN auto-reconnection skipped (Tailscale not installed)', {
          component: LogComponents.agent,
        });
        return;
      }

      // Ensure daemon is running (critical for container restarts)
      this.agentLogger?.infoSync('Starting Tailscale daemon for auto-reconnection', {
        component: LogComponents.agent,
      });
      await tailscale.ensureDaemonRunning();

      // Check if Tailscale is connected
      const status = await tailscale.getStatus();
      
      if (status.connected) {
        this.agentLogger?.infoSync('Tailscale VPN reconnected on startup', {
          component: LogComponents.agent,
          tailnetIP: status.tailnetIP,
          hostname: status.hostname,
          online: status.online,
        });
      } else {
        // Daemon running but not authenticated - needs manual connection
        this.agentLogger?.infoSync('Tailscale daemon started but not authenticated', {
          component: LogComponents.agent,
          backendState: status.backendState,
          note: 'Device needs to be provisioned with VPN auth key',
        });
      }
    } catch (error) {
      // VPN reconnection failure should not stop agent startup
      this.agentLogger?.warnSync(
        'Failed to reconnect VPN on startup (non-critical)',
        {
          component: LogComponents.agent,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
      );
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

  /**
   * Check if agent is fully operational and ready for systemd READY=1
   * 
   * This is a strict readiness check - all critical subsystems must be initialized
   * and operational before systemd considers the service "ready".
   * 
   * READY=1 semantics: "Restarting me after this point is meaningful"
   * 
   * @returns true if all critical components are operational
   */
  public isFullyOperational(): boolean {
    // CI mode: Skip provisioning-dependent checks (MQTT, CloudSync)
    // Allows agent to start and test basic functionality without cloud connection
    const isCiMode = process.env.CI === 'true';
    
    // Critical components that MUST be operational for READY=1
    const checks = {
      database: !!this.stateReconciler,
      logging: !!this.agentLogger,
      deviceInfo: !!this.deviceInfo,
      deviceAPI: !!this.deviceAPI,
      containerManager: !!this.containerManager,
      // MQTT is critical only if device is provisioned (skip in CI mode)
      mqtt: isCiMode || !this.deviceInfo?.provisioned || !!MqttManager.getInstance()?.isConnected(),
      // CloudSync is critical only if device is provisioned (skip in CI mode)
      cloudSync: isCiMode || !this.deviceInfo?.provisioned || !!this.cloudSync
    };

    // Check all critical components
    for (const [component, operational] of Object.entries(checks)) {
      if (!operational) {
        this.agentLogger?.warnSync('Agent not fully operational - missing critical component', {
          component: LogComponents.agent,
          operation: 'isFullyOperational',
          missingComponent: component,
          checks
        });
        return false;
      }
    }

    return true;
  }
}
