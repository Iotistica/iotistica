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

import { StateReconciler, DeviceState } from "./managers/reconciler.js";
import ContainerManager from "./compose/container-manager.js";
import { DeviceManager } from "./managers/index.js";
import type { DeviceInfo } from "./managers/types.js";
import { DeviceAPI } from "./api/index.js";
import { router as v1Router } from "./api/v1.js";
import * as deviceActions from "./api/actions.js";
import { CloudSync } from "./managers/sync.js";
import { CloudLogBackend } from "./logging/cloud-backend.js";
import { ContainerLogMonitor } from "./logging/docker-monitor.js";
import { AgentLogger } from "./logging/agent-logger.js";
import { LogComponents } from "./logging/types.js";

import { MqttManager } from "./mqtt";
import { setTenantId, resetTenantIdCache } from "./mqtt/topics.js";
import { getPackageVersion } from "./utils/api-utils";
import { FetchHttpClient } from "./lib/http-client.js";

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
import { SimulationOrchestrator} from "./simulation/index.js";
import { DiscoveryService } from "./features/discovery/discovery-service.js";
import { FeatureInitializer } from "./init/features.js";
import type { ConfigManager } from "./managers/config.js";
import {
  initCore as runInitCore,
  initializeStateReconciler as runInitializeStateReconciler,
  setupConfigEventListeners as runSetupConfigEventListeners,
  type AgentInitContext,
} from './init/core.js';
import { initializeDatabase as runInitializeDatabase } from './init/database.js';
import { initLogging as runInitLogging } from './init/logging.js';
import {
  initDevice as runInitDevice,
  initializeCloudLogging as runInitializeCloudLogging,
  initializeDeviceManager as runInitializeDeviceManager,
  initializeVpnReconnection as runInitializeVpnReconnection,
} from './init/device.js';
import {
  initInfrastructure as runInitInfrastructure,
  initializeMqttManager as runInitializeMqttManager,
  initContainerManager as runInitContainerManager,
  initDeviceAPI as runInitDeviceAPI,
} from './init/infra.js';
import {
  initFeatures as runInitFeatures,
  initDiscoveryService as runInitDiscoveryService,
} from './init/features.js';
import { initializeSimulationMode as runInitializeSimulationMode } from './init/simulation.js';
import {
  initAnomalyDetection as runInitAnomalyDetection,
} from './init/ai.js';
import { initSync as runInitSync, initDeviceSync as runInitDeviceSync } from './init/sync.js';


export default class Agent {
  private stateReconciler!: StateReconciler; // Main state manager
  private containerManager!: ContainerManager; // Keep for backward compatibility with DeviceAPI
  private deviceManager!: DeviceManager;
  private deviceInfo!: DeviceInfo; // Cache device info after initialization
  private deviceAPI!: DeviceAPI;
  private cloudSync?: CloudSync;
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
      const ctx: AgentInitContext = {
        self: this,
        core: {
          initDatabase: () => this.initDatabase(),
          initializeStateReconciler: () => this.initializeStateReconciler(),
          setupConfigEventListeners: () => this.setupConfigEventListeners(),
        },
        logging: {
          getLoggingConfig: () => this.configManager.getLoggingConfig(),
          setAgentLogger: (logger) => {
            this.agentLogger = logger;
          },
          setStateReconcilerLogger: (logger) => {
            this.stateReconciler.setLogger(logger);
          },
        },
        device: {
          getCloudApiEndpoint: () => this.configManager.getCloudApiEndpoint(),
          setSharedHttpClient: (httpClient) => {
            this.sharedHttpClient = httpClient;
          },
          initializeDeviceManager: () => this.initializeDeviceManager(),
          initializeVpnReconnection: () => this.initializeVpnReconnection(),
          initializeCloudLogging: () => this.initializeCloudLogging(),
        },
        runtime: {
          initializeMqttManager: () => this.initializeMqttManager(),
          initContainerManager: () => this.initContainerManager(),
          initDeviceAPI: () => this.initDeviceAPI(),
        },
        features: {
          getAgentLogger: () => this.agentLogger,
          getStateReconciler: () => this.stateReconciler,
          getTargetState: () => this.stateReconciler.getTargetState(),
          getConfigManagerFeatures: () => this.configManager.getFeatures(),
          getDeviceInfo: () => this.deviceInfo,
          getDeviceManager: () => this.deviceManager,
          getContainerManager: () => this.containerManager,
          getSharedHttpClient: () => this.sharedHttpClient,
          getCloudApiEndpoint: () => this.configManager.getCloudApiEndpoint(),
          getDeviceApiPort: () => this.configManager.getDeviceApiPort(),
          getAnomalyService: () => this.anomalyService,
          getDictionaryManager: () => this.dictionaryManager,
          setFeatureInitializer: (initializer) => {
            this.featureInitializer = initializer;
          },
          getFeatureInitializer: () => this.featureInitializer,
          initDiscoveryService: () => this.initDiscoveryService(),
          getDiscoveryService: () => this.discoveryService,
          initializeSimulationMode: () => this.initializeSimulationMode(),
          setUpdater: (updater) => {
            this.updater = updater;
          },
          setFirewall: (firewall) => {
            this.firewall = firewall;
          },
          setStateReconcilerUpdater: (updater) => {
            this.stateReconciler.setAgentUpdater(updater);
          },
        },
        sync: {
          initDeviceSync: () => this.initDeviceSync(),
          initAnomalyDetection: () => this.initAnomalyDetection(),
          getContainerManager: () => this.containerManager,
          getDeviceManager: () => this.deviceManager,
          getCloudSync: () => this.cloudSync,
          getAgentLogger: () => this.agentLogger,
          getAnomalyService: () => this.anomalyService,
          getSimulationOrchestrator: () => this.simulationOrchestrator,
          getDiscoveryService: () => this.discoveryService,
          setAgent: (agent) => {
            deviceActions.setAgent(agent);
          },
          setReactiveHandlers: (args) => {
            this.configManager.setReactiveHandlers(args);
          },
        },
        services: {
          start: () => this.startServices(),
          logStartupSummary: () => this.logStartupSummary(),
        },
      };

      await runInitCore(ctx);
      await runInitLogging(ctx);
      await runInitDevice(ctx);
      await runInitInfrastructure(ctx);
      await runInitFeatures(ctx);
      await runInitSync(ctx);
      await ctx.services.start();
      ctx.services.logStartupSummary();
  }

  private async startServices(): Promise<void> {
    this.startAutoReconciliation();
    this.startMemoryMonitoring();
  }

  private logStartupSummary(): void {
    const mode = this.deviceInfo.provisioned ? "Cloud-connected" : "Standalone";
    const intervals = this.configManager.getIntervalConfig();

    this.agentLogger.infoSync("Device Agent initialized", {
      component: LogComponents.agent,
      mode,
      deviceApiPort: this.configManager.getDeviceApiPort(),
      reconciliationInterval: intervals.reconciliationIntervalMs,
      cloudApiEndpoint: this.configManager.getCloudApiEndpoint(),
      cloudFeaturesEnabled: this.deviceInfo.provisioned && !!this.cloudSync,
    });
  }

  private async initializeCloudLogging(): Promise<void> {
    await runInitializeCloudLogging(this as any);
  }

  private async initDatabase(): Promise<void> {
    await runInitializeDatabase(this as any);
  }

  private async initializeDeviceManager(): Promise<void> {
    await runInitializeDeviceManager(this as any);
  }

  private async initializeMqttManager(): Promise<void> {
    await runInitializeMqttManager(this as any);
  }

  private async initializeStateReconciler(): Promise<void> {
    await runInitializeStateReconciler(this as any);
  }

  /**
   * Setup configuration event listeners
   */
  private setupConfigEventListeners(): void {
    runSetupConfigEventListeners(this as any);
  }

  private async initContainerManager(): Promise<void> {
    await runInitContainerManager(this as any);
  }


  private async initDeviceAPI(): Promise<void> {
    await runInitDeviceAPI(this as any);
  }

  private async initAnomalyDetection(): Promise<void> {
    await runInitAnomalyDetection(this as any);
  }

  private async initDiscoveryService (): Promise<void> {
    await runInitDiscoveryService(this as any);
  }
  

  private async initializeSimulationMode(): Promise<void> {
    await runInitializeSimulationMode(this as any);
  }

  private async initDeviceSync(): Promise<void> {
    await runInitDeviceSync(this as any);
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

    this.agentLogger?.debugSync("Active memory monitoring started", {
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
    await runInitializeVpnReconnection(this as any);
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
