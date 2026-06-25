/**
 * STATE RECONCILER
 * ================
 * 
 * Top-level orchestrator that coordinates both container management (ContainerManager)
 * and device configuration management (ConfigManager).
 * 
 * This provides a unified interface for managing the complete agent state:
 * - Apps/containers (via ContainerManager)
 * - Device configuration (via ConfigManager)
 * 
 * The StateReconciler persists the complete target state to SQLite and delegates
 * reconciliation to specialized managers.
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { cloneDeep, deepEqual } from '../lib/collection-utils.js';
import { StateSnapshotModel } from '../db/models/index.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents} from '../logging/types.js';
import { ContainerManager } from '../containers/container-manager.js';
import { ConfigManager } from './config.js';
import { type DeviceConfig } from './types.js';
import semver from 'semver';

/**
 * Simple state structure (compatible with existing code)
 */
export interface AgentState {
	apps: Record<number, any>;
	config?: DeviceConfig;
	endpoints?: any[]; // Protocol device endpoints (Modbus, OPC-UA, SNMP, etc.)
}

interface StateReconcilerEvents {
	'target-state-changed': (state: AgentState) => void;
	'state-applied': () => void;
	'reconciliation-complete': (hasEndpointChanges: boolean) => void;
	'logging-config-changed': (change: { old: any; new: any }) => void;
	'intervals-changed': (change: { old: any; new: any }) => void;
	'memory-config-changed': (change: { old: any; new: any }) => void;
	'endpoints-changed': (change: { old: any; new: any }) => void;
	'features-changed': (change: { old: any; new: any }) => void;
	'anomaly-config-changed': (change: { old: any; new: any }) => void;
}

export class StateManager extends EventEmitter {
	private targetState: AgentState = { apps: {}, config: {} };
	private previousState: AgentState = { apps: {}, config: {} };
	private containerManager: ContainerManager;
	private configManager: ConfigManager;
	private agentUpdater?: any; // AgentUpdater instance for version reconciliation
	private lastSavedStateHash: string = '';
	private lastSavedCurrentStateHash: string = '';
	private logger?: AgentLogger;
	private isReconciling = false;
	private pendingReconcile = false;
	private reconcileTimer?: NodeJS.Timeout;
	private readonly reconcileDelayMs = 500; // Debounce to coalesce rapid updates from cloud

	/**
	* Set logger (called after logger is initialized)
	*/
	public setLogger(logger: AgentLogger): void {
		this.logger = logger;
		
		// Propagate logger to ConfigManager for dynamic log level updates
		this.configManager.setLogger(logger);
	}

	constructor(logger?: AgentLogger) {
		super();
		this.logger = logger;
		
		// Initialize managers
		this.containerManager = new ContainerManager(logger);
		this.configManager = new ConfigManager(logger);
		
		// Forward events from managers
		this.containerManager.on('state-applied', () => {
			this.logger?.debugSync('Container reconciliation complete', {
				component: LogComponents.stateReconciler,
			});
		});
		
		this.configManager.on('config-applied', () => {
			this.logger?.debugSync('Config reconciliation complete', {
				component: LogComponents.stateReconciler,
			});
		});
		
		// Forward feature changes to agent
		this.configManager.on('features-changed', (change: { old: any; new: any }) => {
			this.emit('features-changed', change);
		});
		
		// Forward anomaly config changes to agent
		this.configManager.on('anomaly-config-changed', (change: { old: any; new: any }) => {
			this.emit('anomaly-config-changed', change);
		});
		
		// Wire reactive handler events to ConfigManager methods
		this.on('logging-config-changed', (change) => {
			this.configManager.handleLoggingConfigChanges(change);
		});
		
		this.on('intervals-changed', (change) => {
			this.configManager.handleIntervalsChanges(change);
		});
		
		this.on('memory-config-changed', (change) => {
			this.configManager.handleMemoryConfigChanges(change);
		});

		this.on('endpoints-changed', (change) => {
			this.configManager.handleEndpointsChanges(change);
		});
	}

	/**
	* Initialize state reconciler
	*/
	public async init(): Promise<void> {
		this.logger?.infoSync('Initializing StateReconciler', {
			component: LogComponents.stateReconciler,
			operation: 'init',
		});

		// Load target state from database
		await this.loadTargetStateFromDB();

		// Initialize both managers
		await this.containerManager.init();
		await this.configManager.init();

		// Load target config into ConfigManager from loaded target state
		// This ensures getLoggingConfig() returns correct values during agent startup
		// WITHOUT triggering reconciliation (which happens later)
		if (this.targetState.config) {
			this.configManager.loadTarget(this.targetState.config);
			
			this.logger?.infoSync('Loaded target config into ConfigManager', {
				component: LogComponents.stateReconciler,
				operation: 'init',
				hasLogging: !!this.targetState.config.logging,
				logLevel: this.targetState.config.logging?.level,
			});
		}

	}

	/**
	* Set target state (unified entry point)
	*/
	public async setTarget(state: AgentState): Promise<void> {
		this.logger?.infoSync('Setting target state', {
			component: LogComponents.stateReconciler,
			operation: 'setTarget',
			appsCount: Object.keys(state.apps).length,
			endpointCount: state.config?.endpoints?.length || 0,
		});

		// Store previous state before updating
		this.previousState = cloneDeep(this.targetState);
		this.targetState = cloneDeep(state);
		
		// Ensure config field exists
		if (!this.targetState.config) {
			this.targetState.config = {};
		}

		// Keep ConfigManager getters in sync with the newest target immediately.
		// Reconciliation is still debounced, but callers like anomaly init read feature
		// toggles synchronously right after setTarget() during startup and cloud polls.
		this.configManager.loadTarget(this.targetState.config);

		// Persist complete target state to database
		await this.saveTargetStateToDB();

		// Detect and emit granular change events
		this.emitConfigChangeEvents(this.previousState, this.targetState);

		// Emit generic event for backward compatibility
		this.emit('target-state-changed', this.targetState);

		// Debounced reconciliation to coalesce rapid updates from cloud
		// Skip scheduling if reconciliation is already in progress
		if (!this.isReconciling) {
			this.scheduleReconcile();
		} else {
			// Mark that we need to reconcile again after current one finishes
			this.pendingReconcile = true;
		}
	}

	/**
	* Update target state quietly (without triggering reconciliation)
	* Use this for state updates that should not trigger a reconciliation cycle,
	* such as merging discovered metrics during initialization.
	*/
	public async updateTargetStateQuietly(state: AgentState): Promise<void> {
		this.logger?.debugSync('Updating target state quietly (no reconciliation)', {
			component: LogComponents.stateReconciler,
			operation: 'updateTargetStateQuietly',
			appsCount: Object.keys(state.apps).length,
			endpointCount: state.config?.endpoints?.length || 0,
		});

		// Update target state without triggering events or reconciliation
		this.targetState = cloneDeep(state);
		
		// Ensure config field exists
		if (!this.targetState.config) {
			this.targetState.config = {};
		}

		// Keep ConfigManager target snapshot aligned even for quiet updates.
		this.configManager.loadTarget(this.targetState.config);

		// Persist to database only (no events, no reconciliation)
		await this.saveTargetStateToDB();
	}

	/**
	* Get current state (combined from both managers)
	* Returns the actual reconciled state from both managers
	*/
	public async getCurrentState(): Promise<AgentState> {
		// Get current state from container manager (Docker runtime state)
		const containerState = await this.containerManager.getCurrentState();
		
		// Get current config from config manager (reconciled device config + database devices)
		const currentConfig = await this.configManager.getCurrentConfig();
	
		const state: AgentState = {
			apps: containerState.apps || {},
			config: currentConfig || {},
		};

		this.logger?.debugSync('Retrieved current state', {
			component: LogComponents.stateReconciler,
			operation: 'getCurrentState',
			appsCount: Object.keys(state.apps).length,
			endpointCount: currentConfig.endpoints?.length || 0,
		});

		return state;
	}

	/**
	* Get target state
	*/
	public getTargetState(): AgentState {
		return cloneDeep(this.targetState);
	}

	/**
	* Main reconciliation loop with pending flag to avoid lost updates
	*/
	public async reconcile(): Promise<void> {
		if (this.isReconciling) {
			this.pendingReconcile = true;
			this.logger?.debugSync('Reconcile already in progress, marking pending', {
				component: LogComponents.stateReconciler,
				operation: 'reconcile',
			});
			return;
		}

		this.isReconciling = true;
		try {
			do {
				this.pendingReconcile = false;
				await this.runReconcileOnce();
			} while (this.pendingReconcile);
		} finally {
			this.isReconciling = false;
		}
	}

	private async runReconcileOnce(): Promise<void> {
		this.logger?.infoSync('Starting full state reconciliation', {
			component: LogComponents.stateReconciler,
			operation: 'reconcile',
		});

		try {
			// Step 1: Reconcile containers (protocol adapters must be running first)
			this.logger?.debugSync('Step 1: Reconciling containers', {
				component: LogComponents.stateReconciler,
			});
			
			await this.containerManager.setTarget({
				apps: this.targetState.apps,
			});

			// Step 2: Reconcile config (after containers are up)
			this.logger?.debugSync('Step 2: Reconciling device config', {
				component: LogComponents.stateReconciler,
			});
			
			const configResult = await this.configManager.setTarget(this.targetState.config || {});
			const hasEndpointChanges = (configResult.devicesRegistered + configResult.devicesUpdated + configResult.devicesUnregistered) > 0;


			// Step 3: Reconcile agent version (if needed)
			this.logger?.debugSync('Step 3: Reconciling agent version', {
				component: LogComponents.stateReconciler,
			});

			const containerStatus = this.containerManager.getStatus();
			if (containerStatus.isApplying) {
				this.logger?.infoSync('Deferring agent update until containers are stable', {
					component: LogComponents.stateReconciler,
					operation: 'reconcile',
					currentApps: containerStatus.currentApps,
					targetApps: containerStatus.targetApps,
				});
				// Schedule retry instead of tight loop
				this.scheduleReconcile(2000);
				return;
			}
		
			await this.reconcileAgentVersion(this.targetState);

			// Guaranteed semantic checkpoint: persist runtime current state
			// after a successful reconciliation cycle.
			await this.saveCurrentStateToDB(true);

			this.logger?.infoSync('Full state reconciliation complete', {
				component: LogComponents.stateReconciler,
				operation: 'reconcile',
			});

			this.emit('reconciliation-complete', hasEndpointChanges);
		} catch (error) {
			this.logger?.errorSync(
				'State reconciliation failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.stateReconciler,
					operation: 'reconcile',
				}
			);
			throw error;
		}
	}

	/**
	* Debounce reconciliation to coalesce rapid target updates
	*/
	private scheduleReconcile(delayMs: number = this.reconcileDelayMs): void {
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
		}

		this.reconcileTimer = setTimeout(async () => {
			this.reconcileTimer = undefined;
			try {
				await this.reconcile();
			} catch (error) {
				this.logger?.errorSync(
					'Debounced reconciliation failed',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.stateReconciler,
						operation: 'scheduleReconcile',
					}
				);
			}
		}, delayMs);
	}

	/**
	* Set AgentUpdater reference (called after initialization)
	*/
	public setAgentUpdater(agentUpdater: any): void {
		this.agentUpdater = agentUpdater;
		this.logger?.infoSync('AgentUpdater reference set', {
			component: LogComponents.stateReconciler,
			hasUpdater: !!agentUpdater
		});
	}

	/**
	* Reconcile agent version with target state
	*/
	private async reconcileAgentVersion(targetState: AgentState): Promise<void> {
		this.logger?.debugSync('Entering reconcileAgentVersion', {
			component: LogComponents.stateReconciler,
			operation: 'reconcileAgentVersion',
			hasConfig: !!targetState.config,
			hasAgentConfig: !!(targetState.config as any)?.agent,
			agentVersion: (targetState.config as any)?.agent?.version,
		});
		
		const agentConfig = (targetState.config as any)?.agent;
		
		if (!agentConfig?.version) {
			// No agent update requested
			this.logger?.debugSync('No agent version specified in target state', {
				component: LogComponents.stateReconciler,
				operation: 'reconcileAgentVersion',
				hasAgentConfig: !!agentConfig,
				agentConfigKeys: agentConfig ? Object.keys(agentConfig) : [],
			});
			return;
		}
		
		if (!this.agentUpdater) {
			this.logger?.warnSync('AgentUpdater not available, skipping version reconciliation', {
				component: LogComponents.stateReconciler,
				operation: 'reconcileAgentVersion',
				targetVersion: agentConfig.version,
			});
			return;
		}
		
		// Get current version from AgentUpdater
		const currentVersion = this.agentUpdater.getCurrentVersion();
		
		if (currentVersion === agentConfig.version) {
			// Already at desired version
			this.logger?.debugSync('Agent already at desired version', {
				component: LogComponents.stateReconciler,
				operation: 'reconcileAgentVersion',
				currentVersion,
				targetVersion: agentConfig.version,
			});
			return;
		}
		
		// Delegate to AgentUpdater for reconciliation
		const normalizedTargetVersion = semver.valid(agentConfig.version);
		const normalizedCurrentVersion = semver.valid(currentVersion);
		const isComparableVersionPair = !!normalizedTargetVersion && !!normalizedCurrentVersion;
		const isDowngrade = isComparableVersionPair
			? semver.lt(normalizedTargetVersion, normalizedCurrentVersion)
			: false;

		if (!isComparableVersionPair) {
			this.logger?.debugSync('Skipping downgrade check for non-semver agent version', {
				component: LogComponents.stateReconciler,
				operation: 'reconcileAgentVersion',
				currentVersion,
				targetVersion: agentConfig.version,
				normalizedCurrentVersion,
				normalizedTargetVersion,
			});
		}

		this.logger?.infoSync('Agent version mismatch detected, triggering reconciliation', {
			component: LogComponents.stateReconciler,
			operation: 'reconcileAgentVersion',
			currentVersion,
			targetVersion: agentConfig.version,
			isDowngrade,
			scheduledAt: agentConfig.update_scheduled_at,
			force: agentConfig.update_force,
		});
		
		try {
			await this.agentUpdater.reconcileVersion({
				targetVersion: agentConfig.version,
				scheduledAt: agentConfig.update_scheduled_at,
				force: agentConfig.update_force || false,
				issuedAt: agentConfig.update_issued_at,
				expiresAt: agentConfig.update_expires_at,
				signature: agentConfig.update_signature,
			});
		} catch (error) {
			this.logger?.errorSync(
				'Agent version reconciliation failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.stateReconciler,
					operation: 'reconcileAgentVersion',
					currentVersion,
					targetVersion: agentConfig.version,
				}
			);
			// Don't rethrow - allow other reconciliation to continue
		}
	}

	/**
	* Load target state from database
	*/
	private async loadTargetStateFromDB(): Promise<void> {
		try {
			const snapshot = StateSnapshotModel.getLatest('target');

			if (snapshot) {
				this.targetState = JSON.parse(snapshot.state);

				// Ensure config field exists (backward compatibility)
				if (!this.targetState.config) {
					this.targetState.config = {};
				}

				// Load the hash for future comparisons
				if (snapshot.stateHash) {
					this.lastSavedStateHash = snapshot.stateHash;
				}

				this.logger?.infoSync('Loaded target state from database', {
					component: LogComponents.stateReconciler,
					operation: 'loadTargetState',
					appsCount: Object.keys(this.targetState.apps).length,
					devicesCount: this.targetState.config?.endpoints?.length || 0,
					configKeys: Object.keys(this.targetState.config || {}),
					hasIntervals: !!this.targetState.config?.intervals,
					hasProtocols: !!this.targetState.config?.protocols,
				});
			}
		} catch (error) {
			this.logger?.errorSync(
				'Failed to load target state from DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.stateReconciler,
					operation: 'loadTargetState',
				}
			);
		}
	}

	/**
	* Save target state to database
	*/
	private async saveTargetStateToDB(): Promise<void> {
		try {
			const stateHash = this.getStateHash(this.targetState);
			// Skip if state hasn't changed
			if (stateHash === this.lastSavedStateHash) {
				this.logger?.debugSync('Skipping save - state unchanged', {
					component: LogComponents.stateReconciler,
					operation: 'saveTargetState',
				});
				return;
			}

			this.lastSavedStateHash = stateHash;

			const stateJson = JSON.stringify(this.targetState);

			StateSnapshotModel.appendAndTrim('target', stateJson, stateHash, 2);

		} catch (error) {
			this.logger?.errorSync(
				'Failed to save target state to DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.stateReconciler,
					operation: 'saveTargetState',
				}
			);
		}
	}

	/**
	* Save current state snapshot to database.
	* Hash-gated by default to avoid duplicate snapshots.
	* Set force=true for semantic checkpoint snapshots (e.g., post-reconcile).
	*/
	private async saveCurrentStateToDB(force: boolean = false): Promise<void> {
		try {
			const currentState = await this.getCurrentState();
			const stateHash = this.getStateHash(currentState);

			if (!force && stateHash === this.lastSavedCurrentStateHash) {
				this.logger?.debugSync('Skipping current snapshot save - state unchanged', {
					component: LogComponents.stateReconciler,
					operation: 'saveCurrentState',
				});
				return;
			}

			this.lastSavedCurrentStateHash = stateHash;
			const stateJson = JSON.stringify(currentState);

			StateSnapshotModel.appendAndTrim('current', stateJson, stateHash, 2);
		} catch (error) {
			this.logger?.errorSync(
				'Failed to save current state to DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.stateReconciler,
					operation: 'saveCurrentState',
				}
			);
		}
	}

	/**
	* Generate SHA-256 hash of state
	*/
	private getStateHash(state: AgentState): string {
		const canonical = this.canonicalizeState(state);
		const stateJson = stableStringify(canonical);
		return crypto.createHash('sha256').update(stateJson).digest('hex');
	}

	private canonicalizeState(state: AgentState): AgentState {
		const clone = cloneDeep(state);

		// Sort apps by numeric key to stabilize hashing
		if (clone.apps) {
			const sortedApps: Record<number, any> = {} as Record<number, any>;
			for (const key of Object.keys(clone.apps).sort((a, b) => Number(a) - Number(b))) {
				sortedApps[Number(key)] = clone.apps[Number(key)];
			}
			clone.apps = sortedApps;
		}

		// Normalize config arrays if present to avoid order-induced hash flips
		const cfg: any = clone.config;
		if (cfg) {
			if (Array.isArray(cfg.endpoints)) {
				cfg.endpoints = this.sortArrayStably(cfg.endpoints);
			}
			if (Array.isArray(cfg.protocols)) {
				cfg.protocols = this.sortArrayStably(cfg.protocols);
			}
		}

		return clone;
	}

	private sortArrayStably(arr: any[]): any[] {
		return [...arr].sort((a, b) => {
			const aKey = this.getComparableKey(a);
			const bKey = this.getComparableKey(b);
			return aKey.localeCompare(bKey);
		});
	}

	private getComparableKey(val: any): string {
		if (val && typeof val === 'object') {
			if (val.id !== undefined) return String(val.id);
			if (val.name !== undefined) return String(val.name);
		}
		return stableStringify(val);
	}

	/**
	* Detect configuration changes and emit granular events
	*/
	private emitConfigChangeEvents(oldState: AgentState, newState: AgentState): void {
		const oldConfig = oldState.config || {};
		const newConfig = newState.config || {};

		// Check logging config changes
		if (!deepEqual(oldConfig.logging, newConfig.logging)) {
			this.logger?.debugSync('Logging configuration changed - emitConfigChangeEvents', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
				oldConfig: oldConfig.logging,
				newConfig: newConfig.logging,
			});
			this.emit('logging-config-changed', {
				old: oldConfig.logging,
				new: newConfig.logging,
			});
		}

		// Check intervals changes
		if (!deepEqual(oldConfig.intervals, newConfig.intervals)) {
			this.logger?.debugSync('Intervals configuration changed - emitConfigChangeEvents', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
				oldConfig: oldConfig.intervals,
				newConfig: newConfig.intervals,
			});
			this.emit('intervals-changed', {
				old: oldConfig.intervals,
				new: newConfig.intervals,
			});
		}

		// Check memory/performance config changes
		const oldMemoryConfig = {
			memoryThresholdMb: oldConfig.settings?.memoryThresholdMb,
			memoryCheckIntervalMs: oldConfig.settings?.memoryCheckIntervalMs,
		};
		const newMemoryConfig = {
			memoryThresholdMb: newConfig.settings?.memoryThresholdMb,
			memoryCheckIntervalMs: newConfig.settings?.memoryCheckIntervalMs,
		};
		if (!deepEqual(oldMemoryConfig, newMemoryConfig)) {
			this.logger?.debugSync('Memory configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('memory-config-changed', {
				old: oldMemoryConfig,
				new: newMemoryConfig,
			});
		}

		// Check endpoints changes
		if (!deepEqual(oldConfig.endpoints, newConfig.endpoints)) {
			this.logger?.debugSync('Endpoints configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('endpoints-changed', {
				old: oldConfig.endpoints,
				new: newConfig.endpoints,
			});
		}
	}

	/**
	* Get container manager (for direct access if needed)
	*/
	public getContainerManager(): ContainerManager {
		return this.containerManager;
	}

	/**
	* Get config manager (for direct access if needed)
	*/
	public getConfigManager(): ConfigManager {
		return this.configManager;
	}

	/**
	* Get status information
	*/
	public async getStatus(): Promise<{
		isReconciling: boolean;
		currentApps: number;
		targetApps: number;
		currentDevices: number;
		targetDevices: number;
	}> {
		const containerStatus = this.containerManager.getStatus();
		const currentConfig = await this.configManager.getCurrentConfig();
		
		return {
			isReconciling: this.isReconciling,
			currentApps: containerStatus.currentApps,
			targetApps: containerStatus.targetApps,
			currentDevices: currentConfig.endpoints?.length || 0,
			targetDevices: this.targetState.config?.endpoints?.length || 0,
		};
	}

	// Typed event emitter methods
	public on<K extends keyof StateReconcilerEvents>(
		event: K,
		listener: StateReconcilerEvents[K],
	): this {
		return super.on(event, listener as any);
	}

	public emit<K extends keyof StateReconcilerEvents>(
		event: K,
		...args: Parameters<StateReconcilerEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}
}

// Local stable stringify to avoid key-order drift in hashes (no external dependency)
function stableStringify(value: any): string {
	return JSON.stringify(normalizeValue(value));
}

function normalizeValue(value: any): any {
	if (Array.isArray(value)) {
		return value.map(normalizeValue);
	}
	if (value && typeof value === 'object') {
		const sortedKeys = Object.keys(value).sort();
		const result: Record<string, any> = {};
		for (const key of sortedKeys) {
			result[key] = normalizeValue(value[key]);
		}
		return result;
	}
	return value;
}
