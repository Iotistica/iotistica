/**
 * SIMPLE CONTAINER MANAGER
 * =========================
 * 
 * Simplified version of application-manager WITHOUT commit logic
 * 
 * Purpose: Control containers on a device and update state
 * 
 * Core concept:
 *   currentState  = what co				config: {
					image: container.image,
					ports: container.ports && container.ports.length > 0
						? Array.from(new Set(container.ports
							.filter(p => p.PublicPort && p.PrivatePort)
							.map(p => `${p.PublicPort}:${p.PrivatePort}`)))
						: undefined,
				}, are running now
 *   targetState   = what containers should be running
 *   → Generate steps to transform current → target
 *   → Execute steps
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import type Docker from 'dockerode';
import { DockerManager } from './docker-manager';
import { RetryManager } from './retry-manager';
import { HealthCheckManager } from './health-check-manager';
import { type ContainerHealthProbe as HealthProbe } from './types';
import { cloneDeep, uniq } from '../lib/collection-utils';
import { StateSnapshotModel } from '../db/models';
import type { ContainerLogMonitor } from '../logging/container-monitor';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import {
	planStepsToAddApp,
	planStepsToRemoveApp,
	planStepsToUpdateApp,
	reconcileNetworksForApp,
	reconcileVolumesForApp,
} from './reconciliation-planner';
import { executeStep as executePlannedStep } from './step-executor';
import {
	createNetwork as createDockerNetwork,
	createVolume as createDockerVolume,
	downloadImage as downloadDockerImage,
	pauseContainer as pauseDockerContainer,
	removeContainer as removeDockerContainer,
	removeNetwork as removeDockerNetwork,
	removeVolume as removeDockerVolume,
	startContainer as startDockerContainer,
	stopContainer as stopDockerContainer,
	unpauseContainer as unpauseDockerContainer,
} from './docker-ops';
import {
	addServiceToCurrentState as addServiceToState,
	markServiceAsError as markServiceError,
	markServiceAsRunning as markServiceRunning,
	removeServiceFromCurrentState as removeServiceFromState,
	updateServiceState as updateServiceInState,
} from './state-helpers';
import { sanitizeState as sanitizeContainerState } from './state-sanitizer';
import {
	getManagerStatus,
	getReconciliationStatus as getStateReconciliationStatus,
	printStateDetails as printContainerStateDetails,
} from './state-introspection';
import {
	convertToHealthProbe as toHealthProbe,
	restartUnhealthyContainer as restartUnhealthyRuntime,
	startHealthMonitoring as startHealthRuntime,
} from './runtime-health';
import {
	attachLogsToAllContainers as attachAllRuntimeLogs,
	attachLogsToContainer as attachRuntimeLogs,
	startAutoReconciliation as startAutoRuntime,
	stopAutoReconciliation as stopAutoRuntime,
} from './runtime-lifecycle';
import { syncStateFromDocker } from './docker-state-sync';

// ============================================================================
// TYPES (Simplified)
// ============================================================================

export interface ContainerService {
	serviceId: number;
	serviceName: string;
	imageName: string; // e.g., "nginx:latest"
	appId: number;
	appName: string;
	
	// Desired container state (Docker-native approach)
	// "running" = container should be running (default)
	// "stopped" = container exists but stopped (docker stop)
	// "paused" = container frozen/suspended (docker pause)
	// undefined = defaults to "running"
	state?: 'running' | 'stopped' | 'paused';

	// Configuration
	config: {
		image: string;
		environment?: Record<string, string>;
		ports?: string[]; // e.g., ["80:80", "443:443"]
		volumes?: string[]; // e.g., ["data:/var/lib/data"]
		networks?: string[]; // e.g., ["frontend", "backend"]
		networkMode?: string;
		restart?: string;
		labels?: Record<string, string>;
		command?: string[];          // override container CMD
		entrypoint?: string[];       // override container ENTRYPOINT
		
		// Container runtime options
		stopSignal?: string;         // e.g., 'SIGTERM', 'SIGINT', 'SIGKILL'
		stopTimeout?: number;        // seconds to wait before force kill (default: 10)
		user?: string;               // run as non-root user (e.g., '1000:1000', 'node')
		readonlyRootfs?: boolean;    // make root filesystem read-only (security hardening)
		
		// Security configuration (edge-hardened)
		privileged?: boolean;        // BLOCKED on edge devices
		capAdd?: string[];           // BLOCKED on edge devices
		pidMode?: string;            // BLOCKED if 'host'
		ipcMode?: string;            // BLOCKED if 'host'
		usernsMode?: string;         // BLOCKED if 'host'
		
		// K8s-style resource limits
		resources?: {
			limits?: {
				cpu?: string;    // e.g., "0.5" = 50% of 1 CPU, "2" = 2 CPUs
				memory?: string; // e.g., "512M", "1G", "256Mi"
			};
			requests?: {
				cpu?: string;    // Minimum CPU guarantee
				memory?: string; // Minimum memory guarantee
			};
		};
		
		// Docker native health check (takes precedence if defined)
		healthcheck?: {
			test: string[];  // e.g., ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1']
			interval?: number;  // nanoseconds (e.g., 30_000_000_000 = 30s)
			timeout?: number;   // nanoseconds (e.g., 5_000_000_000 = 5s)
			retries?: number;   // number of consecutive failures
			startPeriod?: number;  // nanoseconds, grace period before health checks start
		};
		
		// K8s-style health probes (converted to Docker health check if no native healthcheck)
		livenessProbe?: {
			type: 'http' | 'tcp' | 'exec';
			// HTTP specific
			path?: string;
			port?: number;
			scheme?: 'http' | 'https';
			headers?: Record<string, string>;
			expectedStatus?: number[];
			// TCP specific
			tcpPort?: number;
			// Exec specific
			command?: string[];
			// Common settings
			initialDelaySeconds?: number;
			periodSeconds?: number;
			timeoutSeconds?: number;
			successThreshold?: number;
			failureThreshold?: number;
		};
		
		readinessProbe?: {
			type: 'http' | 'tcp' | 'exec';
			// HTTP specific
			path?: string;
			port?: number;
			scheme?: 'http' | 'https';
			headers?: Record<string, string>;
			expectedStatus?: number[];
			// TCP specific
			tcpPort?: number;
			// Exec specific
			command?: string[];
			// Common settings
			initialDelaySeconds?: number;
			periodSeconds?: number;
			timeoutSeconds?: number;
			successThreshold?: number;
			failureThreshold?: number;
		};
		
		startupProbe?: {
			type: 'http' | 'tcp' | 'exec';
			// HTTP specific
			path?: string;
			port?: number;
			scheme?: 'http' | 'https';
			headers?: Record<string, string>;
			expectedStatus?: number[];
			// TCP specific
			tcpPort?: number;
			// Exec specific
			command?: string[];
			// Common settings
			initialDelaySeconds?: number;
			periodSeconds?: number;
			timeoutSeconds?: number;
			successThreshold?: number;
			failureThreshold?: number;
		};
	};

	// Runtime state (for current state)
	containerId?: string;
	status?: string; // "Running", "Exited", etc.
	
	// Error tracking (K8s-style)
	serviceStatus?: 'pending' | 'running' | 'stopped' | 'error';
	error?: {
		type: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff';
		message: string;
		timestamp: string;
		retryCount: number;
		nextRetry?: string; // ISO timestamp
	};
}

export interface DeviceApp {
	appId: number;
	appName: string;
	appUuid?: string; // Optional UUID for network naming
	services: ContainerService[];
}

export interface DeviceState {
	apps: Record<number, DeviceApp>; // Keyed by appId
	config?: Record<string, any>; // Optional config from target state
}

export type AppStep =
	| { action: 'downloadImage'; appId: number; imageName: string }
	| { action: 'createVolume'; appId: number; volumeName: string }
	| { action: 'createNetwork'; appId: number; networkName: string }
	| {
			action: 'stopContainer';
			appId: number;
			serviceId: number;
			containerId: string;
	}
	| {
			action: 'pauseContainer';
			appId: number;
			serviceId: number;
			containerId: string;
	}
	| {
			action: 'unpauseContainer';
			appId: number;
			serviceId: number;
			containerId: string;
	}
	| {
			action: 'startStoppedContainer';
			appId: number;
			serviceId: number;
			containerId: string;
	}
	| {
			action: 'removeContainer';
			appId: number;
			serviceId: number;
			containerId: string;
	}
	| { action: 'startContainer'; appId: number; service: ContainerService }
	| { action: 'removeNetwork'; appId: number; networkName: string }
	| { action: 'removeVolume'; appId: number; volumeName: string }
	| { action: 'noop' };

// ============================================================================
// SIMPLE CONTAINER MANAGER
// ============================================================================

export interface ContainerManagerEvents {
	'target-state-changed': (state: DeviceState) => void;
	'current-state-changed': (state: DeviceState) => void;
	'state-applied': () => void;
}

export class ContainerManager extends EventEmitter {
	private currentState: DeviceState = { apps: {} };
	private targetState: DeviceState = { apps: {} };
	private isApplyingState = false;
	private dockerManager: DockerManager;
	private retryManager: RetryManager;
	private healthCheckManager: HealthCheckManager;
	private useRealDocker: boolean;
	private reconciliationInterval?: NodeJS.Timeout;
	private isReconciliationEnabled = false;
	private logMonitor?: ContainerLogMonitor;
	private lastSavedCurrentStateHash: string = '';
	private lastSavedTargetStateHash: string = '';
	private logger?: AgentLogger;

	constructor(logger?: AgentLogger) {
		super();
		this.logger = logger;
		this.useRealDocker = true;
		this.logger?.debugSync('Creating DockerManager', {
			component: LogComponents.containerManager,
			platform: process.platform
		});
		this.dockerManager = new DockerManager(undefined, this.logger);
		this.retryManager = new RetryManager();
		this.healthCheckManager = new HealthCheckManager(this.dockerManager.getDockerInstance());
		
		// Listen to health check events
		this.healthCheckManager.on('liveness-failed', async ({ containerId, serviceName, message }) => {
			this.logger?.warnSync('Liveness probe failed, restarting container', {
				component: LogComponents.containerManager,
				operation: 'health-check',
				serviceName,
				containerId: containerId.substring(0, 12),
				message
			});
			await this.restartUnhealthyContainer(containerId, serviceName, message);
		});
		
		this.healthCheckManager.on('readiness-changed', ({ containerId, serviceName, isReady }) => {
			this.logger?.debugSync('Readiness changed', {
				component: LogComponents.containerManager,
				operation: 'health-check',
				serviceName,
				containerId: containerId.substring(0, 12),
				isReady
			});
			// Could emit event for external consumers
		});
		
		this.healthCheckManager.on('startup-completed', ({ containerId, serviceName }) => {
			this.logger?.infoSync('Startup probe completed', {
				component: LogComponents.containerManager,
				operation: 'health-check',
				serviceName,
				containerId: containerId.substring(0, 12)
			});
		});
	}

	/**
	* Set logger (called after logger is initialized)
	*/
	public setLogger(logger: AgentLogger): void {
		this.logger = logger;
		// Also update DockerManager's logger
		if (this.dockerManager) {
			this.dockerManager.setLogger(logger);
		}
	}

	/**
	* Initialize and load persisted state from database
	*/
	public async init(): Promise<void> {
		this.logger?.infoSync('Initializing ContainerManager', {
			component: LogComponents.containerManager,
			operation: 'init'
		});
		
		// Load target state from database
		await this.loadTargetStateFromDB();
		
		// Sync current state from Docker
		await this.syncCurrentStateFromDocker();
		
		this.logger?.infoSync('ContainerManager initialized', {
			component: LogComponents.containerManager,
			operation: 'init'
		});
	}

	/**
	* Generate SHA-256 hash of state for efficient comparison
	*/
	private getStateHash(state: DeviceState): string {
		const stateJson = JSON.stringify(state);
		return crypto.createHash('sha256').update(stateJson).digest('hex');
	}

	/**
	* Load target state from database
	*/
	private async loadTargetStateFromDB(): Promise<void> {
		try {
			const snapshot = StateSnapshotModel.getLatest('apps-target');

			if (snapshot) {
				this.targetState = JSON.parse(snapshot.state);
			
				// Ensure config field exists (for backward compatibility with old snapshots)
				if (!this.targetState.config) {
					this.targetState.config = {};
				}
			
				// Load the hash for future comparisons
				if (snapshot.stateHash) {
					this.lastSavedTargetStateHash = snapshot.stateHash;
				}
			
				// Sanitize loaded state to ensure ports are strings
				this.sanitizeState(this.targetState);				this.logger?.infoSync('Loaded target state from database', {
					component: LogComponents.containerManager,
					operation: 'loadTargetState',
					appsCount: Object.keys(this.targetState.apps).length
				});
				this.emit('target-state-changed', this.targetState);
			}
		} catch (error) {
			this.logger?.errorSync(
				'Failed to load target state from DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'loadTargetState'
				}
			);
		}
	}

	/**
	* Save target state to database (only if changed)
	*/
	private async saveTargetStateToDB(): Promise<void> {
		try {
			const stateHash = this.getStateHash(this.targetState);
			
			// Skip if state hasn't changed (compare hashes)
			if (stateHash === this.lastSavedTargetStateHash) {
				this.logger?.debugSync('Skipping save - state unchanged', {
					component: LogComponents.containerManager,
					operation: 'saveTargetState'
				});
				return;
			}
			
			this.logger?.debugSync('Saving target state to database', {
				component: LogComponents.containerManager,
				operation: 'saveTargetState'
			});
			this.lastSavedTargetStateHash = stateHash;
		
			const stateJson = JSON.stringify(this.targetState);
	
			// Delete old target snapshots and insert new (with hash)
			StateSnapshotModel.replace('apps-target', stateJson, stateHash);
			
		} catch (error) {
			this.logger?.errorSync(
				'Failed to save target state to DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'saveTargetState'
				}
			);
		}
	}

	/**
	* Save current state to database (only if changed)
	*/
	private async saveCurrentStateToDB(): Promise<void> {
		try {
			const stateHash = this.getStateHash(this.currentState);
			
			this.lastSavedCurrentStateHash = stateHash;
			
			const stateJson = JSON.stringify(this.currentState);
			
			// Delete old current snapshots and insert new (with hash)
			StateSnapshotModel.replace('current', stateJson, stateHash);
		} catch (error) {
			this.logger?.errorSync(
				'Failed to save current state to DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'saveCurrentState'
				}
			);
		}
	}

	// Typed event emitter methods
	public on<K extends keyof ContainerManagerEvents>(
		event: K,
		listener: ContainerManagerEvents[K],
	): this {
		return super.on(event, listener as any);
	}

	public emit<K extends keyof ContainerManagerEvents>(
		event: K,
		...args: Parameters<ContainerManagerEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}

	// ========================================================================
	// PUBLIC API
	// ========================================================================

	/**
	* Set what containers SHOULD be running (target state)
	*/
	public async setTarget(target: DeviceState): Promise<void> {
		this.logger?.infoSync('Setting target state', {
			component: LogComponents.containerManager,
			operation: 'setTarget',
			appsCount: Object.keys(target.apps).length
		});
		
		this.targetState = cloneDeep(target);
		
		// Sanitize the target state to ensure correct data types
		this.sanitizeState(this.targetState);
		
		// Persist to database
		await this.saveTargetStateToDB();
		
		this.emit('target-state-changed', target);
		
		// Trigger immediate reconciliation if using real Docker
		if (this.useRealDocker && !this.isApplyingState) {
			this.logger?.infoSync('Triggering immediate reconciliation', {
				component: LogComponents.containerManager,
				operation: 'setTarget'
			});
			try {
				await this.applyTargetState();
			} catch (error) {
				this.logger?.errorSync(
					'Failed to apply target state',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'setTarget'
					}
				);
			}
		}
	}

	/**
	* Get what containers ARE running (current state)
	* Includes config from target state
	*/
	public async getCurrentState(): Promise<DeviceState> {
		if (this.useRealDocker) {
			// Query Docker for actual state
			await this.syncCurrentStateFromDocker();
		}
		
		// NOTE: ContainerManager only returns apps (Docker runtime state)
		// Config is handled separately by ConfigManager in StateReconciler
		const state = cloneDeep(this.currentState);
		
		return state;
	}

	/**
	* Sync current state from real Docker containers
	*/
	private async syncCurrentStateFromDocker(): Promise<void> {
		try {
			this.currentState = await syncStateFromDocker({
				dockerManager: this.dockerManager,
				logger: this.logger,
			});

			// Save the synced current state to database
			await this.saveCurrentStateToDB();
		} catch (error) {
			this.logger?.errorSync(
				'Failed to sync state from Docker',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'syncCurrentState'
				}
			);
		}
	}

	/**
	* Get target state
	*/
	public getTargetState(): DeviceState {
		return cloneDeep(this.targetState);
	}

	/**
	* Main function: Reconcile current state → target state
	* @param options.saveState - Whether to save state to DB after reconciliation (default: true)
	*/
	public async applyTargetState(options: { saveState?: boolean } = {}): Promise<void> {
		const { saveState = true } = options;
		
		if (this.isApplyingState) {
			this.logger?.debugSync('Already applying state, skipping', {
				component: LogComponents.containerManager,
				operation: 'applyTargetState'
			});
			return;
		}

		this.isApplyingState = true;

		try {
			// Step 1: Calculate what needs to change
			const steps = this.calculateSteps();

			if (steps.length === 0) {
				this.logger?.infoSync('No changes needed - system is in desired state', {
					component: LogComponents.containerManager,
					operation: 'applyTargetState'
				});
				return;
			}

			this.logger?.infoSync('Generated reconciliation steps', {
				component: LogComponents.containerManager,
				operation: 'applyTargetState',
				stepsCount: steps.length
			});
			
			steps.forEach((step, i) => {
				if (step.action === 'downloadImage') {
					this.logger?.infoSync(`Step ${i + 1}: ${step.action}`, {
						component: LogComponents.containerManager,
						image: step.imageName
					});
				} else if (step.action === 'startContainer') {
					this.logger?.infoSync(`Step ${i + 1}: ${step.action}`, {
						component: LogComponents.containerManager,
						serviceName: step.service.serviceName,
						image: step.service.imageName
					});
				}
			});

			// Step 2: Execute steps sequentially (K8s-style: continue on failures)
			this.logger?.infoSync('Executing reconciliation steps', {
				component: LogComponents.containerManager,
				operation: 'applyTargetState'
			});
			const failures: Array<{ step: AppStep; error: any }> = [];

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				this.logger?.infoSync(`Executing step ${i + 1}/${steps.length}: ${step.action}`, {
					component: LogComponents.containerManager,
					operation: 'applyTargetState'
				});
				
				try {
					await this.executeStep(step);
					this.logger?.infoSync(`Step ${i + 1} completed`, {
						component: LogComponents.containerManager,
						action: step.action
					});
				} catch (error: any) {
					this.logger?.warnSync(`Step ${i + 1} failed`, {
						component: LogComponents.containerManager,
						action: step.action,
						error: error.message
					});
					failures.push({ step, error });
					// ✅ Continue to next step instead of stopping
				}
			}

			// Report summary
			if (failures.length === 0) {
				this.logger?.infoSync('State reconciliation complete - all services healthy', {
					component: LogComponents.containerManager,
					operation: 'applyTargetState',
					stepsExecuted: steps.length
				});
			} else {
				this.logger?.warnSync('State reconciliation complete with failures', {
					component: LogComponents.containerManager,
					operation: 'applyTargetState',
					failuresCount: failures.length,
					failures: failures.map(({ step, error }) => {
						if (step.action === 'downloadImage') {
							return `${step.action}: ${step.imageName} - ${error.message}`;
						} else if (step.action === 'startContainer') {
							return `${step.action}: ${step.service.serviceName} - ${error.message}`;
						} else {
							return `${step.action} - ${error.message}`;
						}
					})
				});
			}

			// Save current state snapshot (includes error states)
			if (saveState) {
				await this.saveCurrentStateToDB();
			}

			// Ensure logs are attached to all running containers (including pre-existing ones)
			await this.attachLogsToAllContainers();

			this.emit('state-applied');
			
		} catch (error) {
			this.logger?.errorSync(
				'Critical error during reconciliation',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'applyTargetState'
				}
			);
			throw error;
		} finally {
			this.isApplyingState = false;
		}
	}

	/**
	* Simulate updating current state (in real app: query Docker)
	*/
	public setCurrentState(state: DeviceState): void {
		this.currentState = cloneDeep(state);
		this.emit('current-state-changed', state);
	}

	// ========================================================================
	// STEP CALCULATION (The Brain)
	// ========================================================================

	private calculateSteps(): AppStep[] {
		const steps: AppStep[] = [];
		const currentApps = this.currentState.apps;
		const targetApps = this.targetState.apps;

		// Get all app IDs
		const allAppIds = uniq([
			...Object.keys(currentApps).map(Number),
			...Object.keys(targetApps).map(Number),
		]);

		for (const appId of allAppIds) {
			const currentApp = currentApps[appId];
			const targetApp = targetApps[appId];

			// === VOLUME STEPS (BEFORE NETWORKS) ===
			// Volumes must be created before networks/containers can use them
			const volumeCreateSteps = reconcileVolumesForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'createVolume');
			steps.push(...volumeCreateSteps);

			// === NETWORK STEPS (BEFORE CONTAINER STEPS) ===
			// Networks must be created before containers can use them
			const networkCreateSteps = reconcileNetworksForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'createNetwork');
			steps.push(...networkCreateSteps);

			// === CONTAINER STEPS ===
			// Case 1: App should be removed (exists in current, not in target)
			if (currentApp && !targetApp) {
				steps.push(...planStepsToRemoveApp(currentApp));
			}
			// Case 2: App should be added (exists in target, not in current)
			else if (!currentApp && targetApp) {
				steps.push(
					...planStepsToAddApp(targetApp, {
						onServiceSkippedNotRunning: (service) => {
							this.logger?.debugSync('Skipping service - not in running state', {
								component: LogComponents.containerManager,
								operation: 'stepsToAddApp',
								serviceName: service.serviceName,
								desiredState: service.state || 'running',
								appId: targetApp.appId,
							});
						},
					}),
				);
			}
			// Case 3: App exists in both - check for updates
			else if (currentApp && targetApp) {
				steps.push(
					...planStepsToUpdateApp(currentApp, targetApp, {
						shouldRetryImage: (imageName) =>
							this.retryManager.shouldRetry(`image:${imageName}`),
						onNewServiceSkippedNotRunning: (service) => {
							this.logger?.debugSync('Skipping new service - not in running state', {
								component: LogComponents.containerManager,
								operation: 'stepsToUpdateApp',
								serviceName: service.serviceName,
								desiredState: service.state || 'running',
								appId: targetApp.appId,
							});
						},
						onServiceNeedsAdd: (service) => {
							this.logger?.debugSync('Service needs to be added', {
								component: LogComponents.containerManager,
								operation: 'calculateSteps',
								serviceName: service.serviceName,
								appId: targetApp.appId,
							});
						},
						onSkipImageRetryExceeded: (service) => {
							this.logger?.warnSync('Skipping service - image pull failed (max retries exceeded)', {
								component: LogComponents.containerManager,
								operation: 'calculateSteps',
								serviceName: service.serviceName,
								imageName: service.imageName,
							});
						},
						onStateTransition: (message, service, from, to) => {
							this.logger?.infoSync(message, {
								component: LogComponents.containerManager,
								operation: 'stepsToUpdateApp',
								serviceName: service.serviceName,
								from,
								to,
							});
						},
						onCannotPauseStopped: (service) => {
							this.logger?.warnSync('Cannot pause stopped container - will start first', {
								component: LogComponents.containerManager,
								operation: 'stepsToUpdateApp',
								serviceName: service.serviceName,
							});
						},
						onServiceNeedsUpdate: (service, changes) => {
							this.logger?.infoSync('Service needs update', {
								component: LogComponents.containerManager,
								operation: 'calculateSteps',
								serviceName: service.serviceName,
								changes,
							});
						},
					}),
				);
			}

			// === NETWORK CLEANUP (AFTER CONTAINER STEPS) ===
			// Networks should be removed after containers are stopped
			const networkRemoveSteps = reconcileNetworksForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'removeNetwork');
			steps.push(...networkRemoveSteps);

			// === VOLUME CLEANUP (AFTER EVERYTHING) ===
			// Volumes should be removed last, after containers and networks
			const volumeRemoveSteps = reconcileVolumesForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'removeVolume');
			steps.push(...volumeRemoveSteps);
		}

		return steps;
	}

	// ========================================================================
	// STEP EXECUTION (with K8s-style error handling)
	// ========================================================================

	private async executeStep(step: AppStep): Promise<void> {
		await executePlannedStep(step, {
			retryManager: this.retryManager,
			healthCheckManager: this.healthCheckManager,
			logger: this.logger,
			getServiceFromCurrentState: (appId, serviceId) => {
				const app = this.currentState.apps[appId];
				return app?.services.find((s) => s.serviceId === serviceId);
			},
			markServiceAsError: (appId, serviceIdOrImage, errorType, message) => {
				this.markServiceAsError(appId, serviceIdOrImage, errorType, message);
			},
			updateServiceState: (appId, serviceId, state) => {
				this.updateServiceState(appId, serviceId, state);
			},
			markServiceAsRunning: (appId, serviceId) => {
				this.markServiceAsRunning(appId, serviceId);
			},
			addServiceToCurrentState: (appId, service, containerId) => {
				this.addServiceToCurrentState(appId, service, containerId);
			},
			removeServiceFromCurrentState: (appId, serviceId) => {
				this.removeServiceFromCurrentState(appId, serviceId);
			},
			downloadImage: (imageName) => this.downloadImage(imageName),
			createNetwork: (appId, networkName) => this.createNetwork(appId, networkName),
			stopContainer: (containerId) => this.stopContainer(containerId),
			pauseContainer: (containerId) => this.pauseContainer(containerId),
			unpauseContainer: (containerId) => this.unpauseContainer(containerId),
			removeContainer: (containerId) => this.removeContainer(containerId),
			startContainer: (service) => this.startContainer(service),
			attachLogsToContainer: (containerId, service) =>
				this.attachLogsToContainer(containerId, service),
			startHealthMonitoring: (containerId, service) => {
				this.startHealthMonitoring(containerId, service);
			},
			removeNetwork: (appId, networkName) => this.removeNetwork(appId, networkName),
			createVolume: (appId, volumeName) => this.createVolume(appId, volumeName),
			removeVolume: (appId, volumeName) => this.removeVolume(appId, volumeName),
		});
	}

	// ========================================================================
	// DOCKER OPERATIONS
	// ========================================================================

	private getDockerOpsContext() {
		return {
			useRealDocker: this.useRealDocker,
			dockerManager: this.dockerManager,
			logger: this.logger,
			logMonitor: this.logMonitor,
			sleep: (ms: number) => this.sleep(ms),
			targetState: this.targetState,
			currentState: this.currentState,
		};
	}

	private async downloadImage(imageName: string): Promise<void> {
		await downloadDockerImage(this.getDockerOpsContext(), imageName);
	}

	private async stopContainer(containerId: string): Promise<void> {
		await stopDockerContainer(this.getDockerOpsContext(), containerId);
	}

	private async pauseContainer(containerId: string): Promise<void> {
		await pauseDockerContainer(this.getDockerOpsContext(), containerId);
	}

	private async unpauseContainer(containerId: string): Promise<void> {
		await unpauseDockerContainer(this.getDockerOpsContext(), containerId);
	}

	private async removeContainer(containerId: string): Promise<void> {
		await removeDockerContainer(this.getDockerOpsContext(), containerId);
	}

	private async startContainer(service: ContainerService): Promise<string> {
		return await startDockerContainer(this.getDockerOpsContext(), service);
	}

	private async createNetwork(appId: number, networkName: string): Promise<void> {
		await createDockerNetwork(this.getDockerOpsContext(), appId, networkName);
	}

	private async removeNetwork(appId: number, networkName: string): Promise<void> {
		await removeDockerNetwork(this.getDockerOpsContext(), appId, networkName);
	}

	private async createVolume(appId: number, volumeName: string): Promise<void> {
		await createDockerVolume(this.getDockerOpsContext(), appId, volumeName);
	}

	private async removeVolume(appId: number, volumeName: string): Promise<void> {
		await removeDockerVolume(this.getDockerOpsContext(), appId, volumeName);
	}

	private getStateHelpersContext() {
		return {
			currentState: this.currentState,
			targetState: this.targetState,
			retryManager: this.retryManager,
			logger: this.logger,
		};
	}

	// ========================================================================
	// STATE MANAGEMENT HELPERS
	// ========================================================================

	/**
	* Mark service as having an error (K8s-style)
	*/
	private markServiceAsError(
		appId: number,
		serviceIdOrImage: number | string,
		errorType: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff',
		message: string
	): void {
		markServiceError(
			this.getStateHelpersContext(),
			appId,
			serviceIdOrImage,
			errorType,
			message,
		);
	}

	/**
	* Mark service as running successfully
	*/
	private markServiceAsRunning(appId: number, serviceId: number): void {
		markServiceRunning(this.getStateHelpersContext(), appId, serviceId);
	}

	private removeServiceFromCurrentState(
		appId: number,
		serviceId: number,
	): void {
		removeServiceFromState(this.getStateHelpersContext(), appId, serviceId);
	}

	private addServiceToCurrentState(
		appId: number,
		service: ContainerService,
		containerId: string,
	): void {
		addServiceToState(this.getStateHelpersContext(), appId, service, containerId);
	}

	private updateServiceState(
		appId: number,
		serviceId: number,
		state: 'running' | 'stopped' | 'paused',
	): void {
		updateServiceInState(this.getStateHelpersContext(), appId, serviceId, state);
	}

	// ========================================================================
	// UTILITIES
	// ========================================================================

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	* Sanitize state to ensure all data is in correct format
	* Fixes issues with data loaded from database that may have wrong types
	*/
	private sanitizeState(state: DeviceState): void {
		sanitizeContainerState(state);
	}

	// ========================================================================
	// STATUS & REPORTING
	// ========================================================================

	public getStatus(): {
		isApplying: boolean;
		currentApps: number;
		targetApps: number;
		currentServices: number;
		targetServices: number;
		} {
		return getManagerStatus(
			this.currentState,
			this.targetState,
			this.isApplyingState,
		);
	}

	/**
	* Get reconciliation status for each service
	* Returns which services are out of sync and need updates
	*/
	public getReconciliationStatus(): {
		[appId: number]: {
			appName: string;
			services: {
				[serviceId: number]: {
					serviceName: string;
					status: 'in-sync' | 'needs-update' | 'missing' | 'extra';
					reason?: string;
				};
			};
		};
		} {
		return getStateReconciliationStatus(this.currentState, this.targetState);
	}

	public printState(): void {
		console.log('\n' + '='.repeat(80));
		console.log('SYSTEM STATE');
		console.log('='.repeat(80));

		console.log('\nCURRENT STATE (what IS running):');
		this.printStateDetails(this.currentState);

		console.log('\nTARGET STATE (what SHOULD be running):');
		this.printStateDetails(this.targetState);

		const status = this.getStatus();
		console.log('\nSTATUS:');
		console.log(`  Current Apps:     ${status.currentApps}`);
		console.log(`  Current Services: ${status.currentServices}`);
		console.log(`  Target Apps:      ${status.targetApps}`);
		console.log(`  Target Services:  ${status.targetServices}`);
		console.log(`  Is Applying:      ${status.isApplying ? 'Yes' : 'No'}`);
		console.log('='.repeat(80) + '\n');
	}

	private printStateDetails(state: DeviceState): void {
		printContainerStateDetails(state);
	}

	// ========================================================================
	// AUTO-RECONCILIATION (Like Balena Supervisor)
	// ========================================================================

	/**
	* Start automatic reconciliation loop
	* This monitors containers and automatically restarts them if they stop
	*/
	public startAutoReconciliation(intervalMs: number = 30000): void {
		const state = {
			enabled: this.isReconciliationEnabled,
			interval: this.reconciliationInterval,
		};
		startAutoRuntime(
			state,
			{
				logger: this.logger,
				shouldRun: () => this.useRealDocker && !this.isApplyingState,
				onTick: async () => {
					await this.applyTargetState({ saveState: false });
				},
			},
			intervalMs,
		);
		this.isReconciliationEnabled = state.enabled;
		this.reconciliationInterval = state.interval;
	}

	/**
	* Stop automatic reconciliation loop
	*/
	public stopAutoReconciliation(): void {
		const state = {
			enabled: this.isReconciliationEnabled,
			interval: this.reconciliationInterval,
		};
		stopAutoRuntime(state, this.logger);
		this.isReconciliationEnabled = state.enabled;
		this.reconciliationInterval = state.interval;
	}

	/**
	* Check if auto-reconciliation is enabled
	*/
	public isAutoReconciliationEnabled(): boolean {
		return this.isReconciliationEnabled;
	}

	/**
	* Get the Docker instance (for logging and advanced operations)
	*/
	public setDockerOptions(options: Docker.DockerOptions): void {
		this.dockerManager = new DockerManager(options, this.logger);
		this.healthCheckManager = new HealthCheckManager(this.dockerManager.getDockerInstance());
	}

	public getDocker(): Docker | undefined {
		if (this.useRealDocker && this.dockerManager) {
			return this.dockerManager.getDockerInstance();
		}
		return undefined;
	}

	/**
	* Set the log monitor (called by API server after initialization)
	*/
	public setLogMonitor(monitor: ContainerLogMonitor): void {
		this.logMonitor = monitor;
		this.logger?.infoSync('Log monitor attached to ContainerManager', {
			component: LogComponents.containerManager,
			operation: 'setLogMonitor'
		});
	}

	/**
	* Attach log monitor to a container
	*/
	private async attachLogsToContainer(
		containerId: string,
		service: ContainerService,
	): Promise<void> {
		await attachRuntimeLogs(this.logMonitor, this.logger, containerId, service);
	}

	/**
	* Attach logs to all running containers
	*/
	public async attachLogsToAllContainers(): Promise<void> {
		await attachAllRuntimeLogs(
			this.logMonitor,
			this.logger,
			this.useRealDocker,
			this.currentState,
			(containerId, service) => this.attachLogsToContainer(containerId, service),
		);
	}

	// ========================================================================
	// HEALTH CHECK MONITORING
	// ========================================================================

	/**
	* Start health check monitoring for a container
	*/
	private startHealthMonitoring(containerId: string, service: ContainerService): void {
		startHealthRuntime(
			{
				healthCheckManager: this.healthCheckManager,
				logger: this.logger,
				currentState: this.currentState,
				stopContainer: (id) => this.stopContainer(id),
				removeContainer: (id) => this.removeContainer(id),
				startContainer: (svc) => this.startContainer(svc),
				removeServiceFromCurrentState: (appId, serviceId) =>
					this.removeServiceFromCurrentState(appId, serviceId),
				addServiceToCurrentState: (appId, svc, newContainerId) =>
					this.addServiceToCurrentState(appId, svc, newContainerId),
				attachLogsToContainer: (id, svc) => this.attachLogsToContainer(id, svc),
			},
			containerId,
			service,
		);
	}

	/**
	* Convert service config probe to HealthProbe format
	*/
	private convertToHealthProbe(probe: any): HealthProbe {
		return toHealthProbe(probe);
	}

	/**
	* Restart a container that failed its liveness probe
	*/
	private async restartUnhealthyContainer(
		containerId: string,
		serviceName: string,
		message?: string
	): Promise<void> {
		await restartUnhealthyRuntime(
			{
				healthCheckManager: this.healthCheckManager,
				logger: this.logger,
				currentState: this.currentState,
				stopContainer: (id) => this.stopContainer(id),
				removeContainer: (id) => this.removeContainer(id),
				startContainer: (svc) => this.startContainer(svc),
				removeServiceFromCurrentState: (appId, serviceId) =>
					this.removeServiceFromCurrentState(appId, serviceId),
				addServiceToCurrentState: (appId, svc, newContainerId) =>
					this.addServiceToCurrentState(appId, svc, newContainerId),
				attachLogsToContainer: (id, svc) => this.attachLogsToContainer(id, svc),
			},
			containerId,
			serviceName,
			message,
		);
	}

	/**
	* Get health status for all containers
	*/
	public getContainerHealth(): any[] {
		return this.healthCheckManager.getAllHealth();
	}
}

// ============================================================================
// EXPORT
// ============================================================================

export default ContainerManager;


