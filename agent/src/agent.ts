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

import { StateManager } from "./managers/state.js";
import ContainerManager from "./docker/container-manager.js";
import { DeviceManager } from "./managers/index.js";
import type { DeviceInfo } from "./managers/types.js";
import { DeviceAPI } from "./api/index.js";
import { CloudSync } from "./managers/cloud.js";
import { AgentLogger } from "./logging/agent-logger.js";
import { LogComponents } from "./logging/types.js";
import { MqttManager } from "./mqtt";
import { AgentFirewall } from "./network/firewall.js";
import { AgentUpdater } from "./updater.js";
import { 
  setMemoryLogger,
  startMemoryMonitoring,
  stopMemoryMonitoring,
  startMemoryLeakSimulation,
  stopMemoryLeakSimulation
} from "./system/memory.js";
import { AnomalyDetectionService } from "./ai/anomaly/index.js";
import { SimulationOrchestrator} from "./simulation/index.js";
import { DiscoveryService } from "./features/adapters/discovery-service.js";
import { FeatureInitializer } from "./init/features.js";
import type { ConfigManager } from "./managers/config.js";
import {
  initCore as runInitCore,
} from './init/core.js';
import type { AgentInitContext } from './init/context.js';
import { initLogging as runInitLogging } from './init/logging.js';
import { initDevice as runInitDevice } from './init/device.js';
import {
  initInfrastructure as runInitInfrastructure,
} from './init/infra.js';
import {
  initFeatures as runInitFeatures,
} from './init/features.js';
import { initSync as runInitSync } from './init/sync.js';
import { AgentLifecycle, AgentState } from './lifecycle.js';


export default class Agent {
  private readonly lifecycle = new AgentLifecycle();
  private stateReconciler!: StateManager; // Main state manager
  private containerManager!: ContainerManager; // Keep for backward compatibility with DeviceAPI
  private deviceManager!: DeviceManager;
  private deviceInfo!: DeviceInfo; // Cache device info after initialization
  private deviceAPI!: DeviceAPI;
  private cloudSync?: CloudSync;
  public agentLogger!: AgentLogger; // Structured logging for agent-level events (public for external access)
  private firewall?: AgentFirewall; // Network firewall protection
  private updater?: AgentUpdater; // Agent self-update handler
  private featureInitializer?: FeatureInitializer;
  private anomalyService?: AnomalyDetectionService; // Edge-based AI anomaly detection for metrics and sensors
  private simulationOrchestrator?: SimulationOrchestrator; // Simulation framework for testing
  private discoveryService?: DiscoveryService; // Protocol discovery (Modbus, OPC-UA, CAN, etc.)
  private configManager!: ConfigManager; // Configuration manager (centralized config access)
  private dictionaryManager?: import('./managers/dictionary.js').DictionaryManager; // MQTT message key compaction (top-level service)
  private sharedHttpClient?: import('./lib/http-client').HttpClient; // Shared HTTP client for connection pooling

  // System settings (config-driven with env var defaults)
  // Note: All settings now accessed via configManager getters (intervals, endpoints, ports, etc.)
  // Scheduled restart timer (controlled from cloud config)
  private scheduledRestartTimer?: NodeJS.Timeout;
  private memoryLeakSimulationTimer?: NodeJS.Timeout;
  private lastOperationalFailureKey?: string;
  private lastOperationalFailureLogAt = 0;

  // Note: Configuration change handling done by ConfigManager reactive handlers
  // ConfigManager listens to StateReconciler events and applies changes automatically

  constructor() {
    // StateReconciler and ConfigManager will be initialized in init()
    // (StateReconciler needs async init() to load target state from SQLite)
    this.configureLifecycleHooks();
  }

  private configureLifecycleHooks(): void {
    this.lifecycle.onExit(AgentState.RUNNING, () => {
      this.stopRuntimeServices();
    });

    this.lifecycle.onError(({ state, error }) => {
      this.agentLogger?.errorSync(
        'Lifecycle transition failed',
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
          state,
        }
      );
    });
  }

  public async init(): Promise<void> {
      const currentState = this.lifecycle.getState();
      if (currentState === AgentState.INIT || currentState === AgentState.STOPPING) {
        throw new Error(`Cannot initialize agent while state is ${currentState}`);
      }
      if (currentState === AgentState.RUNNING || currentState === AgentState.READY) {
        this.agentLogger?.warnSync('Agent init skipped - already initialized', {
          component: LogComponents.agent,
          state: currentState,
        });
        return;
      }

      const ctx: AgentInitContext = {
        agent: this,
        stateReconciler: this.stateReconciler,
        configManager: this.configManager,
        agentLogger: this.agentLogger,
        sharedHttpClient: this.sharedHttpClient,
        deviceManager: this.deviceManager,
        deviceInfo: this.deviceInfo,
        containerManager: this.containerManager,
        logMonitor: (this as any).logMonitor,
        deviceAPI: this.deviceAPI,
        cloudSync: this.cloudSync,
        firewall: this.firewall,
        updater: this.updater,
        featureInitializer: this.featureInitializer,
        anomalyService: this.anomalyService,
        simulationOrchestrator: this.simulationOrchestrator,
        discoveryService: this.discoveryService,
        dictionaryManager: this.dictionaryManager,
        scheduledRestartTimer: this.scheduledRestartTimer,
      };

      await this.lifecycle.transition(AgentState.INIT, async () => {
        await runInitCore(ctx);
        await runInitLogging(ctx);
        await runInitDevice(ctx);
        await runInitInfrastructure(ctx);
        await runInitFeatures(ctx);
        await runInitSync(ctx);
      });

      await this.lifecycle.transition(AgentState.READY, async () => {
        this.applyInitContext(ctx);
      });

      await this.lifecycle.transition(AgentState.RUNNING, async () => {
        await this.startServices();
        this.logStartupSummary();
      });
  }

  private applyInitContext(ctx: AgentInitContext): void {
    this.stateReconciler = ctx.stateReconciler!;
    this.configManager = ctx.configManager!;
    this.agentLogger = ctx.agentLogger!;
    this.lifecycle.setLogger(this.agentLogger);
    this.sharedHttpClient = ctx.sharedHttpClient;
    this.deviceManager = ctx.deviceManager;
    this.deviceInfo = ctx.deviceInfo;
    this.containerManager = ctx.containerManager;
    (this as any).logMonitor = ctx.logMonitor;
    this.deviceAPI = ctx.deviceAPI;
    this.cloudSync = ctx.cloudSync;
    this.firewall = ctx.firewall;
    this.updater = ctx.updater;
    this.featureInitializer = ctx.featureInitializer;
    this.anomalyService = ctx.anomalyService;
    this.simulationOrchestrator = ctx.simulationOrchestrator;
    this.discoveryService = ctx.discoveryService;
    this.dictionaryManager = ctx.dictionaryManager;
    this.scheduledRestartTimer = ctx.scheduledRestartTimer;
  }

  private async startServices(): Promise<void> {
    this.startAutoReconciliation();
    this.startMemoryMonitoring();
  }

  private stopRuntimeServices(): void {
    if (this.containerManager) {
      this.containerManager.stopAutoReconciliation();
      this.agentLogger?.infoSync("Auto-reconciliation stopped", {
        component: LogComponents.agent,
      });
    }

    stopMemoryMonitoring();
    this.agentLogger?.infoSync("Memory monitoring stopped", {
      component: LogComponents.agent,
    });

    this.clearPendingMemoryLeakSimulation();
  }

  private async safeStopSubsystem(
    name: string,
    shouldStop: boolean,
    stopFn: () => Promise<void> | void,
    failures: string[],
  ): Promise<void> {
    if (!shouldStop) {
      return;
    }

    try {
      await stopFn();
      this.agentLogger?.infoSync(`${name} stopped`, {
        component: LogComponents.agent,
        subsystem: name,
      });
    } catch (error) {
      failures.push(name);
      this.agentLogger?.warnSync(`Error stopping ${name}`, {
        component: LogComponents.agent,
        subsystem: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopLogBackends(failures: string[]): Promise<void> {
    await this.safeStopSubsystem('Log backends', !!this.agentLogger, async () => {
      for (const backend of this.agentLogger?.getBackends() || []) {
        try {
          if ('disconnect' in backend && typeof backend.disconnect === 'function') {
            await backend.disconnect();
          } else if ('stop' in backend && typeof backend.stop === 'function') {
            await (backend as any).stop();
          }
        } catch (error) {
          const backendName = backend?.constructor?.name || 'UnknownLogBackend';
          this.agentLogger?.warnSync('Error stopping log backend', {
            component: LogComponents.agent,
            subsystem: 'Log backends',
            backend: backendName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }, failures);
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
      this.clearPendingMemoryLeakSimulation();

      this.agentLogger?.warnSync("MEMORY LEAK SIMULATION ENABLED - FOR TESTING ONLY", {
        component: LogComponents.agent,
        leakType: process.env.LEAK_TYPE || 'gradual',
        leakRateMB: process.env.LEAK_RATE_MB || '1',
        leakIntervalMs: process.env.LEAK_INTERVAL_MS || '5000',
        leakMaxMB: process.env.LEAK_MAX_MB || '50'
      });
      
      // Wait 30 seconds after startup before starting simulation
      // This allows baseline memory to be established
      this.memoryLeakSimulationTimer = setTimeout(() => {
        this.memoryLeakSimulationTimer = undefined;
        startMemoryLeakSimulation();
      }, 30000);

      this.memoryLeakSimulationTimer.unref?.();
    }
  }

  private clearPendingMemoryLeakSimulation(): void {
    if (!this.memoryLeakSimulationTimer) {
      return;
    }

    clearTimeout(this.memoryLeakSimulationTimer);
    this.memoryLeakSimulationTimer = undefined;
  }

  public async stop(): Promise<void> {
    const currentState = this.lifecycle.getState();
    if (currentState === AgentState.STOPPING) {
      this.agentLogger?.warnSync('Stop skipped - agent is already stopping', {
        component: LogComponents.agent,
        state: currentState,
      });
      return;
    }
    if (currentState !== AgentState.RUNNING && currentState !== AgentState.READY && currentState !== AgentState.ERROR) {
      throw new Error(`Cannot stop agent from lifecycle state ${currentState}`);
    }

    await this.lifecycle.transition(AgentState.STOPPING, async () => {
      this.agentLogger?.infoSync("Stopping Device Agent", { component: LogComponents.agent });
      const cleanupFailures: string[] = [];

      await this.safeStopSubsystem('Features', !!this.featureInitializer, async () => {
        try {
          await this.featureInitializer?.cleanup();
        } finally {
          this.featureInitializer = undefined;
        }
      }, cleanupFailures);
     
      await this.safeStopSubsystem('API Binder', !!this.cloudSync, async () => {
        try {
          await this.cloudSync?.stop();
        } finally {
          this.cloudSync = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Firewall', !!this.firewall, async () => {
        try {
          await this.firewall?.stop();
        } finally {
          this.firewall = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Agent Updater', !!this.updater, async () => {
        try {
          await this.updater?.cleanup();
        } finally {
          this.updater = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Simulation orchestrator', !!this.simulationOrchestrator, async () => {
        try {
          await this.simulationOrchestrator?.stop();
        } finally {
          this.simulationOrchestrator = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Memory leak simulation', true, async () => {
        this.clearPendingMemoryLeakSimulation();
        stopMemoryLeakSimulation();
      }, cleanupFailures);

      this.agentLogger?.infoSync("Stopping log backends", {
        component: LogComponents.agent,
      });
      await this.stopLogBackends(cleanupFailures);

      await this.safeStopSubsystem('Dictionary Manager', !!this.dictionaryManager, async () => {
        try {
          await this.dictionaryManager?.shutdown();
        } finally {
          this.dictionaryManager = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('MQTT Manager', MqttManager.getInstance().isConnected(), async () => {
        const mqttManager = MqttManager.getInstance();
        await mqttManager.disconnect();
      }, cleanupFailures);

      await this.safeStopSubsystem('Device API', !!this.deviceAPI, async () => {
        try {
          await this.deviceAPI?.stop();
        } finally {
          this.deviceAPI = undefined as unknown as DeviceAPI;
        }
      }, cleanupFailures);

      // Runtime-only services are stopped by lifecycle RUNNING exit hooks

      if (this.scheduledRestartTimer) {
        clearTimeout(this.scheduledRestartTimer);
        this.scheduledRestartTimer = undefined;
        this.agentLogger?.infoSync("Scheduled restart timer cleared", {
          component: LogComponents.agent,
        });
      }
      
      await this.safeStopSubsystem('Discovery service', !!this.discoveryService, async () => {
        try {
          this.discoveryService?.stopPeriodicDiscovery();
        } finally {
          this.discoveryService = undefined;
        }
      }, cleanupFailures);

      // ConfigManager handles its own cleanup (event listeners)
      // No manual removal needed since ConfigManager is garbage collected

      await this.safeStopSubsystem('Database connection', true, async () => {
        const { gracefulShutdown: shutdownDatabase } = await import('./db/connection.js');
        await shutdownDatabase();
      }, cleanupFailures);

      if (cleanupFailures.length > 0) {
        this.agentLogger?.warnSync('Device Agent stopped with cleanup warnings', {
          component: LogComponents.agent,
          cleanupFailures,
        });
        return;
      }

      this.agentLogger?.infoSync('Device Agent stopped successfully', {
        component: LogComponents.agent,
      });
    }).catch((error) => {
      this.agentLogger?.errorSync(
        "Error stopping Device Agent",
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent,
        }
      );
      throw error;
    });

    await this.lifecycle.transition(AgentState.STOPPED);
  }

  /**
   * Restart all agent services except the API server and MQTT
   * This is a soft restart that keeps the HTTP server and MQTT connection running
   */
  public async restartServices(): Promise<void> {
    const state = this.lifecycle.getState();
    if (state !== AgentState.RUNNING) {
      throw new Error(`Cannot restart services while agent is in ${state} state`);
    }

    await this.lifecycle.transition(AgentState.STOPPING, async () => {
      this.agentLogger?.infoSync('Starting agent services restart (soft restart)', {
        component: LogComponents.agent,
        note: 'API and MQTT will remain running',
      });
      const cleanupFailures: string[] = [];

      await this.safeStopSubsystem('Features', !!this.featureInitializer, async () => {
        try {
          await this.featureInitializer?.cleanup(true);
        } finally {
          this.featureInitializer = undefined;
        }
      }, cleanupFailures);
      
      await this.safeStopSubsystem('Cloud sync', !!this.cloudSync, async () => {
        try {
          await this.cloudSync?.stop();
        } finally {
          this.cloudSync = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Firewall', !!this.firewall, async () => {
        try {
          await this.firewall?.stop();
        } finally {
          this.firewall = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Agent updater', !!this.updater, async () => {
        try {
          await this.updater?.cleanup();
        } finally {
          this.updater = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Simulation orchestrator', !!this.simulationOrchestrator, async () => {
        try {
          await this.simulationOrchestrator?.stop();
        } finally {
          this.simulationOrchestrator = undefined;
        }
      }, cleanupFailures);

      await this.safeStopSubsystem('Memory leak simulation', true, async () => {
        this.clearPendingMemoryLeakSimulation();
        stopMemoryLeakSimulation();
      }, cleanupFailures);

      this.agentLogger?.infoSync('Stopping log backends...', {
        component: LogComponents.agent,
      });
      await this.stopLogBackends(cleanupFailures);

      await this.safeStopSubsystem('Dictionary manager', !!this.dictionaryManager, async () => {
        try {
          await this.dictionaryManager?.shutdown();
        } finally {
          this.dictionaryManager = undefined;
        }
      }, cleanupFailures);

      // SKIP MQTT - keep it running for shell session and MQTT monitoring
      this.agentLogger?.infoSync('✓ MQTT connection preserved (not restarted)', {
        component: LogComponents.agent,
      });

      // NOTE: Skip deviceAPI - keep it running!

      // Runtime-only services are stopped by lifecycle RUNNING exit hooks

      if (this.scheduledRestartTimer) {
        clearTimeout(this.scheduledRestartTimer);
        this.scheduledRestartTimer = undefined;
        this.agentLogger?.infoSync('Scheduled restart timer cleared', {
          component: LogComponents.agent,
        });
      }
      
      await this.safeStopSubsystem('Discovery service', !!this.discoveryService, async () => {
        try {
          this.discoveryService?.stopPeriodicDiscovery();
        } finally {
          this.discoveryService = undefined;
        }
      }, cleanupFailures);

      this.agentLogger?.infoSync('Service shutdown phase completed, reinitializing...', {
        component: LogComponents.agent,
        cleanupFailures,
      });

    }).catch((error) => {
      this.agentLogger?.errorSync(
        'Agent restart failed',
        error instanceof Error ? error : new Error(String(error)),
        { component: LogComponents.agent }
      );
      throw error;
    });

    await this.lifecycle.transition(AgentState.STOPPED, async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
    });

    // Re-initialize all services (reuse init logic)
    await this.init();

    this.agentLogger?.infoSync('✓ Agent services restarted successfully', {
      component: LogComponents.agent,
      note: 'All services reinitialized (API and MQTT preserved)',
    });
  }

  public getLifecycleState(): AgentState {
    return this.lifecycle.getState();
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

  public getCloudSync(): CloudSync | undefined {
    return this.cloudSync;
  }

  public isProvisioned(): boolean {
    return this.deviceInfo?.provisioned === true;
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
      // For already-provisioned devices (state loaded from SQLite), the agent must continue
      // running even if the local API is unavailable. For unprovisioned devices, keep the API
      // startup-critical so provisioning/setup flows still require it.
      deviceAPI: !!this.deviceInfo?.provisioned || !!this.deviceAPI,
      containerManager: !!this.containerManager,
      // MQTT connectivity is not startup-critical. A provisioned device must continue running
      // and buffering local state/data when broker auth or the API backing auth is unavailable.
      mqtt: true,
      // CloudSync is critical only if device is provisioned (skip in CI mode).
      // Only require the instance to exist (provisioning config was valid + service was wired).
      // Whether it is currently connected is a runtime/health concern - a cloud outage must not
      // prevent the agent from sending READY=1 or operating as a standalone device.
      cloudSync: isCiMode || !this.deviceInfo?.provisioned || !!this.cloudSync
    };

    const now = Date.now();

    // Check all critical components
    for (const [component, operational] of Object.entries(checks)) {
      if (!operational) {
        const shouldLog =
          this.lastOperationalFailureKey !== component ||
          now - this.lastOperationalFailureLogAt >= 30000;

        if (shouldLog) {
          this.agentLogger?.warnSync('Agent not fully operational - missing critical component', {
            component: LogComponents.agent,
            operation: 'isFullyOperational',
            missingComponent: component,
            checks
          });
          this.lastOperationalFailureKey = component;
          this.lastOperationalFailureLogAt = now;
        }

        return false;
      }
    }

    this.lastOperationalFailureKey = undefined;
    this.lastOperationalFailureLogAt = 0;

    return true;
  }
}
