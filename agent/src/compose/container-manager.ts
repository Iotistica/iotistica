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
import _ from 'lodash';
import crypto from 'crypto';
import type Docker from 'dockerode';
import { DockerManager } from './docker-manager';
import { RetryManager } from './retry-manager';
import { HealthCheckManager } from './health-check-manager';
import { HealthProbe } from './types/health-check';
import * as db from '../db/connection';
import type { ContainerLogMonitor } from '../logging/docker-monitor';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import * as networkManager from './network-manager';
import { Network } from './network';

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
			const snapshots = await db.models('stateSnapshot')
				.where({ type: 'target' })
				.orderBy('createdAt', 'desc')
				.limit(1);

		if (snapshots.length > 0) {
			this.targetState = JSON.parse(snapshots[0].state);
			
			// Ensure config field exists (for backward compatibility with old snapshots)
			if (!this.targetState.config) {
				this.targetState.config = {};
			}
			
			// Load the hash for future comparisons
			if (snapshots[0].stateHash) {
				this.lastSavedTargetStateHash = snapshots[0].stateHash;
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
			
			// Log save attempt details
			this.logger?.debugSync('Target state save attempt', {
				component: LogComponents.containerManager,
				operation: 'saveTargetState',
				newHashPreview: stateHash.substring(0, 8),
				lastSavedHashPreview: this.lastSavedTargetStateHash?.substring(0, 8) || 'none',
				appsCount: Object.keys(this.targetState.apps).length,
				configKeys: Object.keys(this.targetState.config || {}).length,
				hasSensors: !!this.targetState.config?.sensors
			});
			
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
		
		// Log JSON details for debugging
		this.logger?.debugSync('Target state JSON details', {
			component: LogComponents.containerManager,
			operation: 'saveTargetState',
			jsonPreview: stateJson.substring(0, 500),
			jsonLength: stateJson.length,
			hasConfigField: stateJson.includes('"config"'),
			hasSensorsField: stateJson.includes('"sensors"')
		});
		
		// Delete old target snapshots and insert new (with hash)
		await db.models('stateSnapshot')
			.where({ type: 'target' })
			.delete();
		
		await db.models('stateSnapshot').insert({
			type: 'target',
			state: stateJson,
			stateHash: stateHash,
		});			
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
			await db.models('stateSnapshot')
				.where({ type: 'current' })
				.delete();
			
			await db.models('stateSnapshot').insert({
				type: 'current',
				state: stateJson,
				stateHash: stateHash,
			});
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
		
		this.targetState = _.cloneDeep(target);
		
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
		const state = _.cloneDeep(this.currentState);
		
		return state;
	}

	/**
	 * Sync current state from real Docker containers
	 */
	private async syncCurrentStateFromDocker(): Promise<void> {
		try {
			const containers = await this.dockerManager.listManagedContainers();

			// Reset current state
			this.currentState = { apps: {} };

			// Build state from running containers
			for (const container of containers) {
				const appId = parseInt(container.labels['iotistic.app-id']);
				const appName = container.labels['iotistic.app-name'];
				const serviceId = parseInt(container.labels['iotistic.service-id']);
				const serviceName = container.labels['iotistic.service-name'];

				// Ensure app exists
				if (!this.currentState.apps[appId]) {
					this.currentState.apps[appId] = {
						appId,
						appName,
						services: [],
					};
				}

				// Get network, environment, volumes, and other config from container inspect
				let networks: string[] = [];
				let environment: Record<string, string> = {};
				let volumes: string[] = [];
				let restart: string = 'no';
				let labels: Record<string, string> = {};
				let networkMode: string = 'bridge';
				
				try {
					const containerInfo = await this.dockerManager.inspectContainer(container.id);
					
					// Extract networks
					if (containerInfo.NetworkSettings?.Networks) {
						// Extract network names, filtering out default networks
						const networkNames = Object.keys(containerInfo.NetworkSettings.Networks)
							.filter((name) => {
								// Filter to only include our custom networks (appId_networkName pattern)
								return name.startsWith(`${appId}_`);
							})
							.map((name) => {
								// Remove the appId_ prefix to get the original network name
								return name.replace(`${appId}_`, '');
							});
						
						if (networkNames.length > 0) {
							networks = networkNames;
						}
					}
					
					// Extract environment variables
					if (containerInfo.Config?.Env) {
						for (const envVar of containerInfo.Config.Env) {
							const [key, ...valueParts] = envVar.split('=');
							if (key) {
								environment[key] = valueParts.join('=');
							}
						}
					}
					
					// Extract volumes (mounts)
					if (containerInfo.Mounts) {
						volumes = containerInfo.Mounts
							.filter((mount: any) => mount.Type === 'volume' || mount.Type === 'bind')
							.map((mount: any) => {
								// Format as "source:destination" or "volumeName:destination"
								const source = mount.Type === 'volume' ? mount.Name : mount.Source;
								return `${source}:${mount.Destination}`;
							});
					}
					
					// Extract restart policy
					if (containerInfo.HostConfig?.RestartPolicy) {
						restart = containerInfo.HostConfig.RestartPolicy.Name || 'no';
					}
					
					// Extract labels (only iotistic labels, not all Docker labels)
					if (containerInfo.Config?.Labels) {
						Object.entries(containerInfo.Config.Labels).forEach(([key, value]) => {
							if (key.startsWith('iotistic.') && typeof value === 'string') {
								labels[key] = value;
							}
						});
					}
					
					// Extract network mode
					if (containerInfo.HostConfig?.NetworkMode) {
						networkMode = containerInfo.HostConfig.NetworkMode;
					}
				} catch (error) {
					this.logger?.warnSync('Failed to inspect container', {
						component: LogComponents.containerManager,
						operation: 'syncCurrentState',
						containerId: container.id.substring(0, 12),
						error: error instanceof Error ? error.message : String(error)
					});
				}

			// Map Docker state to our state field
			// Docker states: "running", "paused", "exited", "restarting", "removing", "dead", "created"
			let state: "running" | "stopped" | "paused" | undefined;
			const dockerState = container.state.toLowerCase();
			if (dockerState === 'running') {
				state = 'running';
			} else if (dockerState === 'paused') {
				state = 'paused';
			} else if (dockerState === 'exited') {
				state = 'stopped';
			}
			// For other states (restarting, removing, dead, created), leave state undefined
			
			// Add service
			const service: ContainerService = {
				serviceId,
				serviceName,
				imageName: container.image,
				appId,
				appName,
				containerId: container.id,
				// Normalize status to lowercase for consistent comparison
				status: container.state.toLowerCase(),
				state,  // Add the mapped state field
				config: {
					image: container.image,
					ports: container.ports && container.ports.length > 0
					? Array.from(new Set(container.ports
						.filter(p => p.PublicPort && p.PrivatePort)
						.map(p => `${p.PublicPort}:${p.PrivatePort}`)))
					: [],  // Use empty array instead of undefined
					volumes: volumes.length > 0 ? volumes : [],  // Include volumes
					networks: networks.length > 0 ? networks : [],  // Include networks
					environment,  // Extract actual environment variables
					restart,  // Include restart policy
					labels: Object.keys(labels).length > 0 ? labels : undefined,  // Include labels if any
					networkMode,  // Include network mode
				},
			};				this.currentState.apps[appId].services.push(service);
			}

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
		return _.cloneDeep(this.targetState);
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
		this.currentState = _.cloneDeep(state);
		this.emit('current-state-changed', state);
	}

	// ========================================================================
	// NETWORK RECONCILIATION
	// ========================================================================

	/**
	 * Reconcile networks for an app
	 * Returns steps to create/remove networks based on service requirements
	 */
	private reconcileNetworksForApp(
		appId: number,
		currentApp: DeviceApp | undefined,
		targetApp: DeviceApp | undefined,
	): AppStep[] {
		const steps: AppStep[] = [];

		// Collect all network names from current and target services
		const currentNetworks = new Set<string>();
		const targetNetworks = new Set<string>();

		if (currentApp) {
			for (const service of currentApp.services) {
				// Handle both formats: service.config.networks and service.networks
				const networks = service.config?.networks || (service as any).networks;
				if (networks) {
					networks.forEach((net: string) => currentNetworks.add(net));
				}
			}
		}

		if (targetApp) {
			for (const service of targetApp.services) {
				// Handle both formats: service.config.networks and service.networks
				const networks = service.config?.networks || (service as any).networks;
				if (networks) {
					networks.forEach((net: string) => targetNetworks.add(net));
				}
			}
		}

		// Networks to create (in target but not in current)
		for (const networkName of targetNetworks) {
			if (!currentNetworks.has(networkName)) {
				steps.push({
					action: 'createNetwork',
					appId,
					networkName,
				});
			}
		}

		// Networks to remove (in current but not in target)
		for (const networkName of currentNetworks) {
			if (!targetNetworks.has(networkName)) {
				steps.push({
					action: 'removeNetwork',
					appId,
					networkName,
				});
			}
		}

		return steps;
	}

	private reconcileVolumesForApp(
		appId: number,
		currentApp: DeviceApp | undefined,
		targetApp: DeviceApp | undefined,
	): AppStep[] {
		const steps: AppStep[] = [];

		// Collect all volume names from current and target services
		const currentVolumes = new Set<string>();
		const targetVolumes = new Set<string>();

		if (currentApp) {
			for (const service of currentApp.services) {
				// Handle both formats: service.config.volumes and service.volumes
				const volumes = service.config?.volumes || (service as any).volumes;
				if (volumes) {
					for (const volume of volumes) {
						// Only track named volumes (format: "volumeName:/path")
						// Skip bind mounts (format: "/host/path:/container/path")
						if (!volume.startsWith('/')) {
							const volumeName = volume.split(':')[0];
							currentVolumes.add(volumeName);
						}
					}
				}
			}
		}

		if (targetApp) {
			for (const service of targetApp.services) {
				// Handle both formats: service.config.volumes and service.volumes
				const volumes = service.config?.volumes || (service as any).volumes;
				if (volumes) {
					for (const volume of volumes) {
						// Only track named volumes (format: "volumeName:/path")
						// Skip bind mounts (format: "/host/path:/container/path")
						if (!volume.startsWith('/')) {
							const volumeName = volume.split(':')[0];
							targetVolumes.add(volumeName);
						}
					}
				}
			}
		}

		// Volumes to create (in target but not in current)
		for (const volumeName of targetVolumes) {
			if (!currentVolumes.has(volumeName)) {
				steps.push({
					action: 'createVolume',
					appId,
					volumeName,
				});
			}
		}

		// Volumes to remove (in current but not in target)
		for (const volumeName of currentVolumes) {
			if (!targetVolumes.has(volumeName)) {
				steps.push({
					action: 'removeVolume',
					appId,
					volumeName,
				});
			}
		}

		return steps;
	}

	// ========================================================================
	// STEP CALCULATION (The Brain)
	// ========================================================================

	private calculateSteps(): AppStep[] {
		const steps: AppStep[] = [];
		const currentApps = this.currentState.apps;
		const targetApps = this.targetState.apps;

		// Get all app IDs
		const allAppIds = _.uniq([
			...Object.keys(currentApps).map(Number),
			...Object.keys(targetApps).map(Number),
		]);

		for (const appId of allAppIds) {
			const currentApp = currentApps[appId];
			const targetApp = targetApps[appId];

			// === VOLUME STEPS (BEFORE NETWORKS) ===
			// Volumes must be created before networks/containers can use them
			const volumeCreateSteps = this.reconcileVolumesForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'createVolume');
			steps.push(...volumeCreateSteps);

			// === NETWORK STEPS (BEFORE CONTAINER STEPS) ===
			// Networks must be created before containers can use them
			const networkCreateSteps = this.reconcileNetworksForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'createNetwork');
			steps.push(...networkCreateSteps);

			// === CONTAINER STEPS ===
			// Case 1: App should be removed (exists in current, not in target)
			if (currentApp && !targetApp) {
				steps.push(...this.stepsToRemoveApp(currentApp));
			}
			// Case 2: App should be added (exists in target, not in current)
			else if (!currentApp && targetApp) {
				steps.push(...this.stepsToAddApp(targetApp));
			}
			// Case 3: App exists in both - check for updates
			else if (currentApp && targetApp) {
				steps.push(...this.stepsToUpdateApp(currentApp, targetApp));
			}

			// === NETWORK CLEANUP (AFTER CONTAINER STEPS) ===
			// Networks should be removed after containers are stopped
			const networkRemoveSteps = this.reconcileNetworksForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'removeNetwork');
			steps.push(...networkRemoveSteps);

			// === VOLUME CLEANUP (AFTER EVERYTHING) ===
			// Volumes should be removed last, after containers and networks
			const volumeRemoveSteps = this.reconcileVolumesForApp(
				appId,
				currentApp,
				targetApp,
			).filter((step) => step.action === 'removeVolume');
			steps.push(...volumeRemoveSteps);
		}

		return steps;
	}

	private stepsToRemoveApp(app: DeviceApp): AppStep[] {
		const steps: AppStep[] = [];

		// Stop and remove all services
		for (const service of app.services) {
			if (service.containerId) {
				steps.push({
					action: 'stopContainer',
					appId: app.appId,
					serviceId: service.serviceId,
					containerId: service.containerId,
				});
				steps.push({
					action: 'removeContainer',
					appId: app.appId,
					serviceId: service.serviceId,
					containerId: service.containerId,
				});
			}
		}

		return steps;
	}

	private stepsToAddApp(app: DeviceApp): AppStep[] {
		const steps: AppStep[] = [];

		// Download images and start all services
		for (const service of app.services) {
			// Check desired state (defaults to "running")
			const desiredState = service.state || 'running';
			
			// Skip services that shouldn't be running
			if (desiredState !== 'running') {
				this.logger?.debugSync('Skipping service - not in running state', {
					component: LogComponents.containerManager,
					operation: 'stepsToAddApp',
					serviceName: service.serviceName,
					desiredState,
					appId: app.appId
				});
				continue;
			}
			
			// 1. Download image
			steps.push({
				action: 'downloadImage',
				appId: app.appId,
				imageName: service.imageName,
			});

			// 2. Start container
			steps.push({
				action: 'startContainer',
				appId: app.appId,
				service: service,
			});
		}

		return steps;
	}

	private stepsToUpdateApp(
		current: DeviceApp,
		target: DeviceApp,
	): AppStep[] {
		const steps: AppStep[] = [];

		const currentServices = new Map(
			current.services.map((s) => [s.serviceId, s]),
		);
		const targetServices = new Map(
			target.services.map((s) => [s.serviceId, s]),
		);

		// Get all service IDs
		const allServiceIds = _.uniq([
			...currentServices.keys(),
			...targetServices.keys(),
		]);

		for (const serviceId of allServiceIds) {
			const currentSvc = currentServices.get(serviceId);
			const targetSvc = targetServices.get(serviceId);

			// Service removed
			if (currentSvc && !targetSvc && currentSvc.containerId) {
				steps.push({
					action: 'stopContainer',
					appId: current.appId,
					serviceId: serviceId,
					containerId: currentSvc.containerId,
				});
				steps.push({
					action: 'removeContainer',
					appId: current.appId,
					serviceId: serviceId,
					containerId: currentSvc.containerId,
				});
			}

			// Service added
			if (!currentSvc && targetSvc) {
				// Check desired state (defaults to "running")
				const desiredState = targetSvc.state || 'running';
				
				// Skip services that shouldn't be running
				if (desiredState !== 'running') {
					this.logger?.debugSync('Skipping new service - not in running state', {
						component: LogComponents.containerManager,
						operation: 'stepsToUpdateApp',
						serviceName: targetSvc.serviceName,
						desiredState,
						appId: target.appId
					});
					continue;
				}
				
				this.logger?.debugSync('Service needs to be added', {
					component: LogComponents.containerManager,
					operation: 'calculateSteps',
					serviceName: targetSvc.serviceName,
					appId: target.appId
				});
				
				// Check if we can proceed with this image
				const imageKey = `image:${targetSvc.imageName}`;
				const canRetryImage = this.retryManager.shouldRetry(imageKey);
				
				if (!canRetryImage) {
					this.logger?.warnSync('Skipping service - image pull failed (max retries exceeded)', {
						component: LogComponents.containerManager,
						operation: 'calculateSteps',
						serviceName: targetSvc.serviceName,
						imageName: targetSvc.imageName
					});
					continue; // Skip this service entirely
				}
				
				steps.push({
					action: 'downloadImage',
					appId: target.appId,
					imageName: targetSvc.imageName,
				});
				steps.push({
					action: 'startContainer',
					appId: target.appId,
					service: targetSvc,
				});
			}

			// Service updated (image or config changed) OR container state changed
			if (currentSvc && targetSvc) {
				// Check state change
				const currentState = currentSvc.state || 'running';
				const targetState = targetSvc.state || 'running';
				const stateChanged = currentState !== targetState;
				
				// Handle state transitions
				if (stateChanged && currentSvc.containerId) {
					// Transition: running → stopped
					if (currentState === 'running' && targetState === 'stopped') {
						this.logger?.infoSync('Service state changed to stopped', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName,
							from: currentState,
							to: targetState
						});
						
						steps.push({
							action: 'stopContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
					
					// Transition: running → paused
					if (currentState === 'running' && targetState === 'paused') {
						this.logger?.infoSync('Service state changed to paused', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName,
							from: currentState,
							to: targetState
						});
						
						steps.push({
							action: 'pauseContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
					
					// Transition: stopped → running
					if (currentState === 'stopped' && targetState === 'running') {
						this.logger?.infoSync('Service state changed to running (restarting stopped container)', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName,
							from: currentState,
							to: targetState
						});
						
						steps.push({
							action: 'startStoppedContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
					
					// Transition: paused → running
					if (currentState === 'paused' && targetState === 'running') {
						this.logger?.infoSync('Service state changed from paused to running', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName,
							from: currentState,
							to: targetState
						});
						
						steps.push({
							action: 'unpauseContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
					
					// Transition: paused → stopped
					if (currentState === 'paused' && targetState === 'stopped') {
						this.logger?.infoSync('Service state changed from paused to stopped', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName,
							from: currentState,
							to: targetState
						});
						
						// Unpause first, then stop
						steps.push({
							action: 'unpauseContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						steps.push({
							action: 'stopContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
					
					// Transition: stopped → paused (not allowed - need to start first)
					if (currentState === 'stopped' && targetState === 'paused') {
						this.logger?.warnSync('Cannot pause stopped container - will start first', {
							component: LogComponents.containerManager,
							operation: 'stepsToUpdateApp',
							serviceName: currentSvc.serviceName
						});
						
						steps.push({
							action: 'startStoppedContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						steps.push({
							action: 'pauseContainer',
							appId: current.appId,
							serviceId: serviceId,
							containerId: currentSvc.containerId,
						});
						continue; // Don't check other changes
					}
				}
				
				// Check if image changed (this requires container recreation)
				const imageChanged = currentSvc.imageName !== targetSvc.imageName;
				
				// Check if configuration changed (ports, environment, volumes, networks, etc.)
				// Normalize undefined/null to empty arrays/objects for consistent comparison
				// Sort arrays to make comparison order-independent
				const currentPorts = JSON.stringify((currentSvc.config.ports || []).sort());
				const targetPorts = JSON.stringify((targetSvc.config.ports || []).sort());
				const portsChanged = currentPorts !== targetPorts;
				
				// For environment, only compare variables that are defined in target state
				// Docker injects many env vars (PATH, HOSTNAME, etc.) that we don't care about
				const targetEnvKeys = Object.keys(targetSvc.config.environment || {});
				const filteredCurrentEnv: Record<string, string> = {};
				for (const key of targetEnvKeys) {
					if (currentSvc.config.environment && key in currentSvc.config.environment) {
						filteredCurrentEnv[key] = currentSvc.config.environment[key];
					}
				}
				const currentEnv = JSON.stringify(filteredCurrentEnv);
				const targetEnv = JSON.stringify(targetSvc.config.environment || {});
				const envChanged = currentEnv !== targetEnv;
				
				const currentVolumes = JSON.stringify((currentSvc.config.volumes || []).sort());
				const targetVolumes = JSON.stringify((targetSvc.config.volumes || []).sort());
				const volumesChanged = currentVolumes !== targetVolumes;
				
				const currentNetworks = JSON.stringify((currentSvc.config.networks || []).sort());
				const targetNetworks = JSON.stringify((targetSvc.config.networks || []).sort());
				const networksChanged = currentNetworks !== targetNetworks;
				
				// Compare restart policy (only if defined in target)
				const currentRestart = currentSvc.config.restart || 'no';
				const targetRestart = targetSvc.config.restart || 'no';
				const restartChanged = targetSvc.config.restart !== undefined && currentRestart !== targetRestart;
				
				// Compare network mode (only if defined in target)
				const currentNetworkMode = currentSvc.config.networkMode || 'bridge';
				const targetNetworkMode = targetSvc.config.networkMode || 'bridge';
				const networkModeChanged = targetSvc.config.networkMode !== undefined && currentNetworkMode !== targetNetworkMode;
				
				const configChanged = portsChanged || envChanged || volumesChanged || networksChanged || restartChanged || networkModeChanged;
				
				// Only check if container is stopped/exited (not just "not running")
				// Don't restart containers that are already running
				const containerStopped = currentSvc.status?.toLowerCase() === 'exited' || 
				                        currentSvc.status?.toLowerCase() === 'stopped' ||
				                        currentSvc.status?.toLowerCase() === 'dead';
				
				const needsUpdate = imageChanged || configChanged || containerStopped;
				
				if (needsUpdate) {
					const changes: string[] = [];
					if (imageChanged) changes.push(`image: ${currentSvc.imageName} → ${targetSvc.imageName}`);
					if (portsChanged) changes.push(`ports: ${currentPorts} → ${targetPorts}`);
					if (envChanged) changes.push(`environment changed`);
					if (volumesChanged) changes.push(`volumes: ${currentVolumes} → ${targetVolumes}`);
					if (networksChanged) changes.push(`networks: ${currentNetworks} → ${targetNetworks}`);
					if (restartChanged) changes.push(`restart: ${currentRestart} → ${targetRestart}`);
					if (networkModeChanged) changes.push(`networkMode: ${currentNetworkMode} → ${targetNetworkMode}`);
					if (containerStopped) changes.push(`container stopped: ${currentSvc.status}`);
					
					this.logger?.infoSync('Service needs update', {
						component: LogComponents.containerManager,
						operation: 'calculateSteps',
						serviceName: currentSvc.serviceName,
						changes
					});
				}

				if (needsUpdate && currentSvc.containerId) {
					// Download new image
					if (currentSvc.imageName !== targetSvc.imageName) {
						steps.push({
							action: 'downloadImage',
							appId: target.appId,
							imageName: targetSvc.imageName,
						});
					}

					// Stop old container
					steps.push({
						action: 'stopContainer',
						appId: current.appId,
						serviceId: serviceId,
						containerId: currentSvc.containerId,
					});

					// Remove old container
					steps.push({
						action: 'removeContainer',
						appId: current.appId,
						serviceId: serviceId,
						containerId: currentSvc.containerId,
					});

					// Start new container
					steps.push({
						action: 'startContainer',
						appId: target.appId,
						service: targetSvc,
					});
				}
			}
		}

		return steps;
	}

	// ========================================================================
	// STEP EXECUTION (with K8s-style error handling)
	// ========================================================================

	private async executeStep(step: AppStep): Promise<void> {
		const stepKey = this.getStepKey(step);

		switch (step.action) {
			case 'downloadImage': {
				// Check if we should retry this image
				if (!this.retryManager.shouldRetry(stepKey)) {
					this.logger?.warnSync('Skipping image - max retries exceeded', {
						component: LogComponents.containerManager,
						operation: 'executeStep',
						imageName: step.imageName
					});
					this.markServiceAsError(
						step.appId,
						step.imageName,
						'ImagePullBackOff',
						'Max retries exceeded'
					);
					throw new Error(`Max retries exceeded for ${step.imageName}`);
				}

				try {
					await this.downloadImage(step.imageName);
					this.retryManager.recordSuccess(stepKey); // Clear retry state
				} catch (error: any) {
					this.logger?.errorSync(
						'Failed to pull image',
						error instanceof Error ? error : new Error(String(error)),
						{
							component: LogComponents.containerManager,
							operation: 'executeStep',
							imageName: step.imageName
						}
					);
					this.retryManager.recordFailure(stepKey, error.message);
					this.markServiceAsError(
						step.appId,
						step.imageName,
						'ImagePullBackOff',
						error.message
					);
					throw error; // Re-throw to mark step as failed
				}
				break;
			}

			case 'createNetwork':
				await this.createNetwork(step.appId, step.networkName);
				break;

			case 'stopContainer':
				await this.stopContainer(step.containerId);
				// Update current state to reflect stopped status
				this.updateServiceState(step.appId, step.serviceId, 'stopped');
				// Stop health monitoring when container is stopped
				this.healthCheckManager.stopMonitoring(step.containerId);
				break;

			case 'pauseContainer':
				await this.pauseContainer(step.containerId);
				// Update current state to reflect paused status
				this.updateServiceState(step.appId, step.serviceId, 'paused');
				this.logger?.infoSync('Container paused', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					containerId: step.containerId,
					appId: step.appId,
					serviceId: step.serviceId
				});
				break;


		case 'unpauseContainer':
			await this.unpauseContainer(step.containerId);
			// Update current state to reflect running status
			this.updateServiceState(step.appId, step.serviceId, 'running');
			this.logger?.infoSync('Container unpaused', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId
			});
			break;

		case 'startStoppedContainer': {
			// For stopped containers, we need to remove and recreate them
			// Docker doesn't support restarting exited containers directly
			this.logger?.infoSync('Restarting stopped container (remove + recreate)', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId
			});
			
			try {
				// Get the service config from current state before removing
				const app = this.currentState.apps[step.appId];
				const service = app?.services.find(s => s.serviceId === step.serviceId);
				
				if (!service) {
					throw new Error(`Service ${step.serviceId} not found in current state`);
				}
				
				// Stop health monitoring
				this.healthCheckManager.stopMonitoring(step.containerId);
				
				// Remove the stopped container
				await this.removeContainer(step.containerId);
				this.removeServiceFromCurrentState(step.appId, step.serviceId);
				
				// Recreate and start the container with the same config
				const newContainerId = await this.startContainer(service);
				
				// Update current state with new container
				this.addServiceToCurrentState(step.appId, service, newContainerId);
				this.markServiceAsRunning(step.appId, step.serviceId);
				
				// Attach logs and start health monitoring
				await this.attachLogsToContainer(newContainerId, service);
				this.startHealthMonitoring(newContainerId, service);
				
				this.logger?.infoSync('Stopped container restarted successfully', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					oldContainerId: step.containerId.substring(0, 12),
					newContainerId: newContainerId.substring(0, 12),
					serviceId: step.serviceId
				});
			} catch (error: any) {
				this.logger?.errorSync(
					'Failed to restart stopped container',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						containerId: step.containerId,
						serviceId: step.serviceId
					}
				);
				this.markServiceAsError(
					step.appId,
					step.serviceId,
					'StartFailure',
					error.message
				);
				throw error;
			}
			break;
		}

		case 'removeContainer':
			await this.removeContainer(step.containerId);
			// Update current state
			this.removeServiceFromCurrentState(step.appId, step.serviceId);
			// Stop health monitoring when container is removed
			this.healthCheckManager.stopMonitoring(step.containerId);
			break;
			case 'startContainer': {
				try {
					const containerId = await this.startContainer(step.service);
					// Update current state
					this.addServiceToCurrentState(step.appId, step.service, containerId);
					// Mark as running successfully
					this.markServiceAsRunning(step.appId, step.service.serviceId);
					// Attach logs automatically
					await this.attachLogsToContainer(containerId, step.service);
					// Start health check monitoring if probes are configured
					this.startHealthMonitoring(containerId, step.service);
				} catch (error: any) {
					this.logger?.errorSync(
						'Failed to start container',
						error instanceof Error ? error : new Error(String(error)),
						{
							component: LogComponents.containerManager,
							operation: 'executeStep',
							serviceName: step.service.serviceName
						}
					);
					this.markServiceAsError(
						step.appId,
						step.service.serviceId,
						'StartFailure',
						error.message
					);
					throw error; // Re-throw to mark step as failed
				}
				break;
			}

			case 'removeNetwork':
				await this.removeNetwork(step.appId, step.networkName);
				break;

			case 'createVolume':
				await this.createVolume(step.appId, step.volumeName);
				break;

			case 'removeVolume':
				await this.removeVolume(step.appId, step.volumeName);
				break;

			case 'noop':
				// Do nothing
				break;
		}
	}

	// ========================================================================
	// DOCKER OPERATIONS
	// ========================================================================

	private async downloadImage(imageName: string): Promise<void> {
		if (this.useRealDocker) {
			// Real Docker pull
			await this.dockerManager.pullImage(imageName);
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Downloading image: ${imageName}`);
			await this.sleep(100);
		}
	}

	private async stopContainer(containerId: string): Promise<void> {
		// Detach logs before stopping container (stream will end anyway)
		if (this.logMonitor) {
			await this.logMonitor.detach(containerId);
			this.logger?.debugSync('Detached logs before stopping container', {
				component: LogComponents.containerManager,
				operation: 'stopContainer',
				containerId: containerId.substring(0, 12)
			});
		}
		
		if (this.useRealDocker) {
			// Real Docker stop
			await this.dockerManager.stopContainer(containerId);
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Stopping container: ${containerId}`);
			await this.sleep(50);
		}
	}

	private async pauseContainer(containerId: string): Promise<void> {
		if (this.useRealDocker) {
			// Real Docker pause (freeze processes)
			await this.dockerManager.pauseContainer(containerId);
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Pausing container: ${containerId}`);
			await this.sleep(50);
		}
	}

	private async unpauseContainer(containerId: string): Promise<void> {
		if (this.useRealDocker) {
			// Real Docker unpause (resume processes)
			await this.dockerManager.unpauseContainer(containerId);
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Unpausing container: ${containerId}`);
			await this.sleep(50);
		}
	}

	private async removeContainer(containerId: string): Promise<void> {
		// Detach logs before removing container (prevents reconnection attempts to stale IDs)
		if (this.logMonitor) {
			await this.logMonitor.detach(containerId);
			this.logger?.debugSync('Detached logs before removing container', {
				component: LogComponents.containerManager,
				operation: 'removeContainer',
				containerId: containerId.substring(0, 12)
			});
		}
		
		if (this.useRealDocker) {
			// Real Docker remove
			await this.dockerManager.removeContainer(containerId);
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Removing container: ${containerId}`);
			await this.sleep(50);
		}
	}

	private async startContainer(service: ContainerService): Promise<string> {
		if (this.useRealDocker) {
			// Real Docker start (now supports networks)
			return await this.dockerManager.startContainer(service);
		} else {
			// Simulated for testing
			const containerId = `container_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
			console.log(`    [SIMULATED] Starting container: ${service.serviceName}`);
			console.log(`        Container ID: ${containerId}`);
			await this.sleep(100);
			return containerId;
		}
	}

	private async createNetwork(appId: number, networkName: string): Promise<void> {
		if (this.useRealDocker) {
			// Get app info for UUID
			const app = this.targetState.apps[appId] || this.currentState.apps[appId];
			const appUuid = app?.appUuid || String(appId); // Fallback to appId if no UUID

			// Create Network object
			const network = Network.fromComposeObject(
				networkName,
				appId,
				appUuid,
				{ driver: 'bridge' }, // Simple bridge network
			);

			// Create via network-manager
			await networkManager.create(network);
			this.logger?.infoSync('Created network', {
				component: LogComponents.containerManager,
				operation: 'createNetwork',
				networkName,
				fullName: `${appId}_${networkName}`,
				appId
			});
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Creating network: ${networkName} for app ${appId}`);
			await this.sleep(50);
		}
	}

	private async removeNetwork(appId: number, networkName: string): Promise<void> {
		if (this.useRealDocker) {
			// Get app info for UUID
			const app = this.currentState.apps[appId];
			const appUuid = app?.appUuid || String(appId); // Fallback to appId if no UUID

			// Create Network object for removal
			const network = Network.fromComposeObject(
				networkName,
				appId,
				appUuid,
				{ driver: 'bridge' },
			);

			// Remove via network-manager
			await networkManager.remove(network);
			this.logger?.infoSync('Removed network', {
				component: LogComponents.containerManager,
				operation: 'removeNetwork',
				networkName,
				fullName: `${appId}_${networkName}`,
				appId
			});
		} else {
			// Simulated for testing
			console.log(`    [SIMULATED] Removing network: ${networkName} for app ${appId}`);
			await this.sleep(50);
		}
	}

	private async createVolume(appId: number, volumeName: string): Promise<void> {
		if (this.useRealDocker) {
			const { Volume } = await import('./volume.js');
			const appUuid = String(appId);

			const volume = Volume.fromComposeObject(
				volumeName,
				appId,
				appUuid,
				{
					driver: 'local',
					labels: {
						'iotistic.managed': 'true',
						'iotistic.app-id': String(appId),
					},
				},
			);

			await volume.create();
			this.logger?.infoSync('Created volume', {
				component: LogComponents.containerManager,
				operation: 'createVolume',
				volumeName,
				fullName: `${appId}_${volumeName}`,
				appId
			});
		} else {
			console.log(`    [SIMULATED] Creating volume: ${volumeName} for app ${appId}`);
			await this.sleep(50);
		}
	}

	private async removeVolume(appId: number, volumeName: string): Promise<void> {
		if (this.useRealDocker) {
			const { Volume } = await import('./volume.js');
			const appUuid = String(appId);

			const volume = Volume.fromComposeObject(
				volumeName,
				appId,
				appUuid,
				{},
			);

			await volume.remove();
			this.logger?.infoSync('Removed volume', {
				component: LogComponents.containerManager,
				operation: 'removeVolume',
				volumeName,
				fullName: `${appId}_${volumeName}`,
				appId
			});
		} else {
			console.log(`    [SIMULATED] Removing volume: ${volumeName} for app ${appId}`);
			await this.sleep(50);
		}
	}

	// ========================================================================
	// STATE MANAGEMENT HELPERS
	// ========================================================================

	/**
	 * Generate unique key for retry tracking
	 */
	private getStepKey(step: AppStep): string {
		switch (step.action) {
			case 'downloadImage':
				return `image:${step.imageName}`;
			case 'startContainer':
				return `service:${step.appId}:${step.service.serviceId}`;
			case 'stopContainer':
			case 'pauseContainer':
			case 'unpauseContainer':
			case 'startStoppedContainer':
			case 'removeContainer':
				return `service:${step.appId}:${step.serviceId}`;
			case 'createVolume':
				return `volume:${step.appId}:${step.volumeName}`;
			case 'createNetwork':
				return `network:${step.appId}:${step.networkName}`;
			case 'removeNetwork':
				return `network:${step.appId}:${step.networkName}`;
		case 'removeVolume':
			return `volume:${step.appId}:${step.volumeName}`;
		case 'noop':
			return 'noop';
		default: {
			// Exhaustiveness check - if we get here, we missed a case
			const _exhaustiveCheck: never = step;
			return `unknown:${(_exhaustiveCheck as any).action}`;
		}
	}
}	/**
	 * Mark service as having an error (K8s-style)
	 */
	private markServiceAsError(
		appId: number,
		serviceIdOrImage: number | string,
		errorType: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff',
		message: string
	): void {
		const app = this.currentState.apps[appId] || this.targetState.apps[appId];
		if (!app) {
			this.logger?.warnSync('Cannot mark error: app not found', {
				component: LogComponents.containerManager,
				operation: 'markServiceAsError',
				appId
			});
			return;
		}

		// Find service by ID or image name
		const service = typeof serviceIdOrImage === 'number'
			? app.services.find(s => s.serviceId === serviceIdOrImage)
			: app.services.find(s => s.imageName === serviceIdOrImage);

		if (!service) {
			this.logger?.warnSync('Cannot mark error: service not found', {
				component: LogComponents.containerManager,
				operation: 'markServiceAsError',
				serviceIdOrImage
			});
			return;
		}

		const retryKey = typeof serviceIdOrImage === 'number'
			? `service:${appId}:${serviceIdOrImage}`
			: `image:${serviceIdOrImage}`;

		const retryState = this.retryManager.getState(retryKey);

		service.serviceStatus = 'error';
		service.error = {
			type: errorType,
			message,
			timestamp: new Date().toISOString(),
			retryCount: retryState?.count || 0,
			nextRetry: retryState?.nextRetry?.toISOString(),
		};

		this.logger?.warnSync('Marked service as error', {
			component: LogComponents.containerManager,
			operation: 'markServiceAsError',
			serviceName: service.serviceName,
			errorType,
			message,
			retryCount: service.error.retryCount,
			nextRetry: service.error.nextRetry
		});
	}

	/**
	 * Mark service as running successfully
	 */
	private markServiceAsRunning(appId: number, serviceId: number): void {
		const app = this.currentState.apps[appId];
		if (!app) return;

		const service = app.services.find(s => s.serviceId === serviceId);
		if (service) {
			service.serviceStatus = 'running';
			delete service.error; // Clear any previous errors
			this.logger?.debugSync('Service marked as running', {
				component: LogComponents.containerManager,
				operation: 'markServiceAsRunning',
				serviceName: service.serviceName
			});
		}
	}

	private removeServiceFromCurrentState(
		appId: number,
		serviceId: number,
	): void {
		const app = this.currentState.apps[appId];
		if (app) {
			app.services = app.services.filter((s) => s.serviceId !== serviceId);
			// Remove app if no services left
			if (app.services.length === 0) {
				delete this.currentState.apps[appId];
			}
		}
	}

	private addServiceToCurrentState(
		appId: number,
		service: ContainerService,
		containerId: string,
	): void {
		// Ensure app exists
		if (!this.currentState.apps[appId]) {
			this.currentState.apps[appId] = {
				appId: appId,
				appName: service.appName,
				services: [],
			};
		}

		// Add service with container ID
		const serviceWithContainer = {
			...service,
			containerId: containerId,
			status: 'running',  // Use lowercase for consistency
		};

		this.currentState.apps[appId].services.push(serviceWithContainer);
	}

	private updateServiceState(
		appId: number,
		serviceId: number,
		state: 'running' | 'stopped' | 'paused',
	): void {
		const app = this.currentState.apps[appId];
		if (app) {
			const service = app.services.find((s) => s.serviceId === serviceId);
			if (service) {
				service.state = state;
				this.logger?.debugSync('Updated service state in current state', {
					component: LogComponents.containerManager,
					operation: 'updateServiceState',
					serviceName: service.serviceName,
					newState: state
				});
			}
		}
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
		for (const app of Object.values(state.apps)) {
			// Ensure appId is a number
			if (typeof app.appId === 'string') {
				app.appId = parseInt(app.appId, 10);
			}
			
			for (const service of app.services) {
				// Ensure serviceId is a number (critical for Map lookups!)
				if (typeof service.serviceId === 'string') {
					service.serviceId = parseInt(service.serviceId, 10);
				}
				
				// Normalize flat format to nested config format
				// If service has properties at top level (from cloud API), move them to config
				const flatService = service as any;
				
				if (!service.config) {
					service.config = {
						image: flatService.image || 'unknown',
					};
				}
				
				// Move image to both imageName and config.image
				if (flatService.image && !service.imageName) {
					service.imageName = flatService.image;
					service.config.image = flatService.image;
				}
				
				// Move top-level properties to config
				if (flatService.environment && !service.config.environment) {
					service.config.environment = flatService.environment;
				}
				if (flatService.ports && !service.config.ports) {
					service.config.ports = flatService.ports;
				}
				if (flatService.volumes && !service.config.volumes) {
					service.config.volumes = flatService.volumes;
				}
				if (flatService.networks && !service.config.networks) {
					service.config.networks = flatService.networks;
				}
				if (flatService.restart && !service.config.restart) {
					service.config.restart = flatService.restart;
				}
				if (flatService.labels && !service.config.labels) {
					service.config.labels = flatService.labels;
				}
				
				// Set appId and appName if missing
				if (!service.appId) {
					service.appId = app.appId;
				}
				if (!service.appName) {
					service.appName = app.appName;
				}
				
				// Ensure ports are strings
				if (service.config.ports) {
					service.config.ports = service.config.ports.map(port => {
						// Convert any non-string port to string
						return typeof port === 'string' ? port : String(port);
					});
				}
				
				// Ensure environment values are strings
				if (service.config.environment) {
					const sanitizedEnv: Record<string, string> = {};
					for (const [key, value] of Object.entries(service.config.environment)) {
						sanitizedEnv[key] = typeof value === 'string' ? value : String(value);
					}
					service.config.environment = sanitizedEnv;
				}
				
				// Ensure volumes are strings
				if (service.config.volumes) {
					service.config.volumes = service.config.volumes.map(vol => {
						return typeof vol === 'string' ? vol : String(vol);
					});
				}
			}
		}
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
		return {
			isApplying: this.isApplyingState,
			currentApps: Object.keys(this.currentState.apps).length,
			targetApps: Object.keys(this.targetState.apps).length,
			currentServices: Object.values(this.currentState.apps).reduce(
				(sum, app) => sum + app.services.length,
				0,
			),
			targetServices: Object.values(this.targetState.apps).reduce(
				(sum, app) => sum + app.services.length,
				0,
			),
		};
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
		const status: any = {};

		// Get all app IDs from both states
		const allAppIds = _.uniq([
			...Object.keys(this.currentState.apps).map(Number),
			...Object.keys(this.targetState.apps).map(Number),
		]);

		for (const appId of allAppIds) {
			const currentApp = this.currentState.apps[appId];
			const targetApp = this.targetState.apps[appId];

			if (!targetApp) {
				// App exists in current but not in target (should be removed)
				status[appId] = {
					appName: currentApp.appName,
					services: {},
				};
				for (const svc of currentApp.services) {
					status[appId].services[svc.serviceId] = {
						serviceName: svc.serviceName,
						status: 'extra',
						reason: 'Service exists but not in target state',
					};
				}
				continue;
			}

			status[appId] = {
				appName: targetApp.appName,
				services: {},
			};

			// Build service maps
			const currentServices = new Map(
				currentApp ? currentApp.services.map((s) => [s.serviceId, s]) : [],
			);
			const targetServices = new Map(
				targetApp.services.map((s) => [s.serviceId, s]),
			);

			// Check all services
			const allServiceIds = _.uniq([
				...currentServices.keys(),
				...targetServices.keys(),
			]);

			for (const serviceId of allServiceIds) {
				const currentSvc = currentServices.get(serviceId);
				const targetSvc = targetServices.get(serviceId);

				if (!targetSvc) {
					// Service in current but not target (extra)
					status[appId].services[serviceId] = {
						serviceName: currentSvc!.serviceName,
						status: 'extra',
						reason: 'Service exists but not in target state',
					};
				} else if (!currentSvc) {
					// Service in target but not current (missing)
					status[appId].services[serviceId] = {
						serviceName: targetSvc.serviceName,
						status: 'missing',
						reason: 'Service not yet deployed',
					};
				} else {
					// Both exist - check if they match
					const imageChanged = currentSvc.imageName !== targetSvc.imageName;
					const portsChanged = JSON.stringify(currentSvc.config.ports || []) !== 
					                     JSON.stringify(targetSvc.config.ports || []);
					const envChanged = JSON.stringify(currentSvc.config.environment || {}) !== 
					                   JSON.stringify(targetSvc.config.environment || {});
					const volumesChanged = JSON.stringify(currentSvc.config.volumes || []) !== 
					                       JSON.stringify(targetSvc.config.volumes || []);
					
					const containerStopped = currentSvc.status?.toLowerCase() === 'exited' || 
					                        currentSvc.status?.toLowerCase() === 'stopped' ||
					                        currentSvc.status?.toLowerCase() === 'dead';

					const needsUpdate = imageChanged || portsChanged || envChanged || volumesChanged || containerStopped;

					if (needsUpdate) {
						const reasons = [];
						if (imageChanged) reasons.push('Image changed');
						if (portsChanged) reasons.push('Ports changed');
						if (envChanged) reasons.push('Environment changed');
						if (volumesChanged) reasons.push('Volumes changed');
						if (containerStopped) reasons.push('Container stopped');

						status[appId].services[serviceId] = {
							serviceName: currentSvc.serviceName,
							status: 'needs-update',
							reason: reasons.join(', '),
						};
					} else {
						status[appId].services[serviceId] = {
							serviceName: currentSvc.serviceName,
							status: 'in-sync',
						};
					}
				}
			}
		}

		return status;
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
		const apps = Object.values(state.apps);
		if (apps.length === 0) {
			console.log('  (empty)');
			return;
		}

		apps.forEach((app) => {
			console.log(`  App ${app.appId}: ${app.appName}`);
			app.services.forEach((svc) => {
				console.log(`    - ${svc.serviceName} (${svc.imageName})`);
				if (svc.containerId) {
					console.log(`      Container: ${svc.containerId}`);
				}
			});
		});
	}

	// ========================================================================
	// AUTO-RECONCILIATION (Like Balena Supervisor)
	// ========================================================================

	/**
	 * Start automatic reconciliation loop
	 * This monitors containers and automatically restarts them if they stop
	 */
	public startAutoReconciliation(intervalMs: number = 30000): void {
		if (this.isReconciliationEnabled) {
			this.logger?.debugSync('Auto-reconciliation already running', {
				component: LogComponents.containerManager,
				operation: 'startAutoReconciliation'
			});
			return;
		}

		
		this.isReconciliationEnabled = true;

		this.reconciliationInterval = setInterval(async () => {
			if (this.useRealDocker && !this.isApplyingState) {
				this.logger?.debugSync('Auto-reconciliation check', {
					component: LogComponents.containerManager,
					operation: 'autoReconciliation'
				});
				try {
					// Don't save to DB on auto-reconciliation (reduces writes by 99%)
					// State is only saved when it actually changes via syncStateFromDocker
					await this.applyTargetState({ saveState: false });
				} catch (error) {
					this.logger?.errorSync(
						'Auto-reconciliation error',
						error instanceof Error ? error : new Error(String(error)),
						{
							component: LogComponents.containerManager,
							operation: 'autoReconciliation'
						}
					);
				}
			}
		}, intervalMs);
	}

	/**
	 * Stop automatic reconciliation loop
	 */
	public stopAutoReconciliation(): void {
		if (this.reconciliationInterval) {
			clearInterval(this.reconciliationInterval);
			this.reconciliationInterval = undefined;
			this.isReconciliationEnabled = false;
			this.logger?.infoSync('Stopped auto-reconciliation', {
				component: LogComponents.containerManager,
				operation: 'stopAutoReconciliation'
			});
		}
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
		if (!this.logMonitor) {
			return;
		}

		try {
			// Check if already attached
			if (this.logMonitor.isAttached(containerId)) {
				return;
			}

			await this.logMonitor.attach({
				containerId,
				serviceId: service.serviceId,
				serviceName: service.serviceName,
				follow: true,
				stdout: true,
				stderr: true,
			});

			this.logger?.debugSync('Attached log monitor', {
				component: LogComponents.containerManager,
				operation: 'attachLogs',
				serviceName: service.serviceName,
				containerId: containerId.substring(0, 12)
			});
		} catch (error) {
			this.logger?.warnSync('Failed to attach logs', {
				component: LogComponents.containerManager,
				operation: 'attachLogs',
				serviceName: service.serviceName,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}

	/**
	 * Attach logs to all running containers
	 */
	public async attachLogsToAllContainers(): Promise<void> {
		if (!this.logMonitor || !this.useRealDocker) {
			return;
		}

		this.logger?.infoSync('Attaching logs to existing containers', {
			component: LogComponents.containerManager,
			operation: 'attachLogsToAll'
		});

		for (const app of Object.values(this.currentState.apps)) {
			for (const service of app.services) {
				if (service.containerId && service.status === 'running') {
					await this.attachLogsToContainer(service.containerId, service);
				}
			}
		}
	}

	// ========================================================================
	// HEALTH CHECK MONITORING
	// ========================================================================

	/**
	 * Start health check monitoring for a container
	 */
	private startHealthMonitoring(containerId: string, service: ContainerService): void {
		const { livenessProbe, readinessProbe, startupProbe } = service.config;
		
		// Only start monitoring if at least one probe is configured
		if (!livenessProbe && !readinessProbe && !startupProbe) {
			return;
		}

		this.logger?.infoSync('Starting health monitoring', {
			component: LogComponents.containerManager,
			operation: 'startHealthMonitoring',
			serviceName: service.serviceName,
			containerId: containerId.slice(0, 12),
			hasLiveness: !!livenessProbe,
			hasReadiness: !!readinessProbe,
			hasStartup: !!startupProbe
		});

		// Convert service config probes to HealthProbe format
		const config: {
			containerId: string;
			serviceName: string;
			livenessProbe?: HealthProbe;
			readinessProbe?: HealthProbe;
			startupProbe?: HealthProbe;
		} = {
			containerId,
			serviceName: service.serviceName,
		};

		if (livenessProbe) {
			config.livenessProbe = this.convertToHealthProbe(livenessProbe);
		}

		if (readinessProbe) {
			config.readinessProbe = this.convertToHealthProbe(readinessProbe);
		}

		if (startupProbe) {
			config.startupProbe = this.convertToHealthProbe(startupProbe);
		}

		this.healthCheckManager.startMonitoring(config);
	}

	/**
	 * Convert service config probe to HealthProbe format
	 */
	private convertToHealthProbe(probe: any): HealthProbe {
		const healthProbe: HealthProbe = {
			check: {
				type: probe.type,
			} as any,
			initialDelaySeconds: probe.initialDelaySeconds,
			periodSeconds: probe.periodSeconds,
			timeoutSeconds: probe.timeoutSeconds,
			successThreshold: probe.successThreshold,
			failureThreshold: probe.failureThreshold,
		};

		// Add type-specific fields
		if (probe.type === 'http') {
			healthProbe.check = {
				type: 'http',
				path: probe.path || '/',
				port: probe.port,
				scheme: probe.scheme,
				headers: probe.headers,
				expectedStatus: probe.expectedStatus,
			};
		} else if (probe.type === 'tcp') {
			healthProbe.check = {
				type: 'tcp',
				port: probe.tcpPort || probe.port,
			};
		} else if (probe.type === 'exec') {
			healthProbe.check = {
				type: 'exec',
				command: probe.command || [],
			};
		}

		return healthProbe;
	}

	/**
	 * Restart a container that failed its liveness probe
	 */
	private async restartUnhealthyContainer(
		containerId: string,
		serviceName: string,
		message?: string
	): Promise<void> {
		this.logger?.infoSync('Restarting unhealthy container', {
			component: LogComponents.containerManager,
			operation: 'restartUnhealthy',
			serviceName,
			containerId: containerId.substring(0, 12),
			reason: message || 'liveness check failed'
		});

		try {
		// Find the service in current state
		let targetService: ContainerService | undefined;
		let targetAppId: number | undefined;			for (const app of Object.values(this.currentState.apps)) {
				for (const service of app.services) {
					if (service.containerId === containerId) {
						targetService = service;
						targetAppId = app.appId;
						break;
					}
				}
				if (targetService) break;
			}

			if (!targetService || targetAppId === undefined) {
				this.logger?.errorSync(
					'Cannot restart container - service not found in current state',
					new Error('Service not found'),
					{
						component: LogComponents.containerManager,
						operation: 'restartUnhealthy',
						containerId: containerId.substring(0, 12)
					}
				);
				return;
			}

			// Stop health monitoring during restart
			this.healthCheckManager.stopMonitoring(containerId);

			// Stop and remove the unhealthy container
			await this.stopContainer(containerId);
			await this.removeContainer(containerId);

			// Start a new container with the same configuration
			const newContainerId = await this.startContainer(targetService);

			// Update current state
			this.removeServiceFromCurrentState(targetAppId, targetService.serviceId);
			this.addServiceToCurrentState(targetAppId, targetService, newContainerId);

			// Restart health monitoring
			this.startHealthMonitoring(newContainerId, targetService);

			// Attach logs
			await this.attachLogsToContainer(newContainerId, targetService);

			this.logger?.infoSync('Container restarted successfully', {
				component: LogComponents.containerManager,
				operation: 'restartUnhealthy',
				serviceName,
				oldContainerId: containerId.substring(0, 12),
				newContainerId: newContainerId.slice(0, 12)
			});
		} catch (error) {
			this.logger?.errorSync(
				'Failed to restart unhealthy container',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'restartUnhealthy',
					serviceName
				}
			);
		}
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

