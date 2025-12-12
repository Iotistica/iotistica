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
import _ from 'lodash';
import crypto from 'crypto';
import { models as db } from '../db/connection.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { ContainerManager } from '../compose/container-manager.js';
import { ConfigManager } from './config.js';
import type { DeviceConfig } from '../drivers/types.js';

/**
 * Simple state structure (compatible with existing code)
 */
export interface DeviceState {
	apps: Record<number, any>;
	config?: DeviceConfig;
}

interface StateReconcilerEvents {
	'target-state-changed': (state: DeviceState) => void;
	'state-applied': () => void;
	'reconciliation-complete': () => void;
	'logging-config-changed': (change: { old: any; new: any }) => void;
	'protocol-config-changed': (change: { old: any; new: any }) => void;
	'intervals-changed': (change: { old: any; new: any }) => void;
	'memory-config-changed': (change: { old: any; new: any }) => void;
	'scheduled-restart-changed': (change: { old: any; new: any }) => void;
}

export class StateReconciler extends EventEmitter {
	private targetState: DeviceState = { apps: {}, config: {} };
	private previousState: DeviceState = { apps: {}, config: {} };
	private containerManager: ContainerManager;
	private configManager: ConfigManager;
	private lastSavedStateHash: string = '';
	private logger?: AgentLogger;
	private isReconciling = false;

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
	}

	/**
	 * Initialize state reconciler
	 */
	public async init(): Promise<void> {
		this.
		logger?.infoSync('Initializing StateReconciler', {
			component: LogComponents.stateReconciler,
			operation: 'init',
		});

		// Load target state from database
		await this.loadTargetStateFromDB();

		// Initialize both managers
		await this.containerManager.init();
		await this.configManager.init();

		this.logger?.infoSync('StateReconciler initialized', {
			component: LogComponents.stateReconciler,
			operation: 'init',
			appsCount: Object.keys(this.targetState.apps).length,
			devicesCount: this.targetState.config?.sensors?.length || 0,
		});
	}

	/**
	 * Set target state (unified entry point)
	 */
	public async setTarget(state: DeviceState): Promise<void> {
		this.logger?.infoSync('Setting target state', {
			component: LogComponents.stateReconciler,
			operation: 'setTarget',
			appsCount: Object.keys(state.apps).length,
			endpointCount: state.config?.endpoints?.length || 0,
		});

		// Store previous state before updating
		this.previousState = _.cloneDeep(this.targetState);
		this.targetState = _.cloneDeep(state);
		
		// Ensure config field exists
		if (!this.targetState.config) {
			this.targetState.config = {};
		}

		// Persist complete target state to database
		await this.saveTargetStateToDB();

		// Detect and emit granular change events
		this.emitConfigChangeEvents(this.previousState, this.targetState);

		// Emit generic event for backward compatibility
		this.emit('target-state-changed', this.targetState);

		// Trigger reconciliation
		await this.reconcile();
	}

	/**
	 * Get current state (combined from both managers)
	 * Returns the actual reconciled state from both managers
	 */
	public async getCurrentState(): Promise<DeviceState> {
		// Get current state from container manager (Docker runtime state)
		const containerState = await this.containerManager.getCurrentState();
		
		// Get current config from config manager (reconciled device config + database sensors)
		const currentConfig = await this.configManager.getCurrentConfig();
	
		const state: DeviceState = {
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
	public getTargetState(): DeviceState {
		return _.cloneDeep(this.targetState);
	}

	/**
	 * Main reconciliation loop
	 */
	public async reconcile(): Promise<void> {
		if (this.isReconciling) {
			this.logger?.debugSync('Already reconciling, skipping', {
				component: LogComponents.stateReconciler,
				operation: 'reconcile',
			});
			return;
		}

		this.isReconciling = true;

		try {
			this.logger?.infoSync('Starting full state reconciliation', {
				component: LogComponents.stateReconciler,
				operation: 'reconcile',
			});

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
			
			await this.configManager.setTarget(this.targetState.config || {});

			this.logger?.infoSync('Full state reconciliation complete', {
				component: LogComponents.stateReconciler,
				operation: 'reconcile',
			});

			this.emit('reconciliation-complete');
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
		} finally {
			this.isReconciling = false;
		}
	}

	/**
	 * Load target state from database
	 */
	private async loadTargetStateFromDB(): Promise<void> {
		try {
			const snapshots = await db('stateSnapshot')
				.where({ type: 'target' })
				.orderBy('createdAt', 'desc')
				.limit(1);

		if (snapshots.length > 0) {
			this.targetState = JSON.parse(snapshots[0].state);

			// Ensure config field exists (backward compatibility)
			if (!this.targetState.config) {
				this.targetState.config = {};
			}

			// Load the hash for future comparisons
			if (snapshots[0].stateHash) {
				this.lastSavedStateHash = snapshots[0].stateHash;
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

			// Delete old target snapshots and insert new
			await db('stateSnapshot')
				.where({ type: 'target' })
				.delete();

			await db('stateSnapshot').insert({
				type: 'target',
				state: stateJson,
				stateHash: stateHash,
			});

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
	 * Generate SHA-256 hash of state
	 */
	private getStateHash(state: DeviceState): string {
		const stateJson = JSON.stringify(state);
		return crypto.createHash('sha256').update(stateJson).digest('hex');
	}

	/**
	 * Detect configuration changes and emit granular events
	 */
	private emitConfigChangeEvents(oldState: DeviceState, newState: DeviceState): void {
		const oldConfig = oldState.config || {};
		const newConfig = newState.config || {};

		// Check logging config changes
		if (!_.isEqual(oldConfig.logging, newConfig.logging)) {
			this.logger?.debugSync('Logging configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('logging-config-changed', {
				old: oldConfig.logging,
				new: newConfig.logging,
			});
		}

		// Check protocol config changes
		if (!_.isEqual(oldConfig.protocols, newConfig.protocols)) {
			this.logger?.debugSync('Protocol configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('protocol-config-changed', {
				old: oldConfig.protocols,
				new: newConfig.protocols,
			});
		}

		// Check intervals changes
		if (!_.isEqual(oldConfig.intervals, newConfig.intervals)) {
			this.logger?.debugSync('Intervals configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
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
		if (!_.isEqual(oldMemoryConfig, newMemoryConfig)) {
			this.logger?.debugSync('Memory configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('memory-config-changed', {
				old: oldMemoryConfig,
				new: newMemoryConfig,
			});
		}

		// Check scheduled restart changes
		if (!_.isEqual(oldConfig.settings?.scheduledRestart, newConfig.settings?.scheduledRestart)) {
			this.logger?.debugSync('Scheduled restart configuration changed', {
				component: LogComponents.stateReconciler,
				operation: 'emitConfigChangeEvents',
			});
			this.emit('scheduled-restart-changed', {
				old: oldConfig.settings?.scheduledRestart,
				new: newConfig.settings?.scheduledRestart,
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
