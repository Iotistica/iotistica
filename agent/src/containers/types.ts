/**
 * ORCHESTRATOR DRIVER INTERFACE & TYPES
 * =======================================
 * 
 * Abstract interface and types for all orchestrator drivers.
 * This allows seamless switching between Docker, K3s, and future orchestrators.
 * 
 * Design principles:
 * - Driver-agnostic operations
 * - Promise-based async operations
 * - Event-driven updates
 * - Graceful error handling
 */

import { EventEmitter } from 'events';
import type { Stream } from 'stream';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

// ============================================================================
// COMMON TYPES (shared across all drivers)
// ============================================================================

/**
 * Container service definition - driver-agnostic
 */
export interface ServiceConfig {
	serviceId: number;
	serviceName: string;
	imageName: string;
	appId: number;
	appName: string;
	
	// Desired container state (Docker-native approach)
	// "running" = container should be running (default)
	// "stopped" = container exists but stopped (docker stop)
	// "paused" = container frozen/suspended (docker pause)
	// undefined = defaults to "running"
	state?: 'running' | 'stopped' | 'paused';

	// Container configuration
	config: {
		image: string;
		environment?: Record<string, string>;
		ports?: string[]; // e.g., ["80:80", "443:443"]
		volumes?: string[]; // e.g., ["data:/var/lib/data"]
		networks?: string[]; // e.g., ["frontend", "backend"]
		networkMode?: string;
		restart?: string;
		labels?: Record<string, string>;
		command?: string[];
		entrypoint?: string[];
		workingDir?: string;
		user?: string;
		hostname?: string;
		domainname?: string;
		stopSignal?: string;
		stopTimeout?: number;
		readonlyRootfs?: boolean;
		
		// Resource limits (K8s-style)
		resources?: {
			limits?: {
				cpu?: string;    // e.g., "0.5" = 50% of 1 CPU, "2" = 2 CPUs
				memory?: string; // e.g., "512M", "1G", "256Mi"
			};
			requests?: {
				cpu?: string;
				memory?: string;
			};
		};
		
		// Health probes (K8s-style)
		livenessProbe?: HealthProbe;
		readinessProbe?: HealthProbe;
		startupProbe?: HealthProbe;
	};

	// Runtime state
	containerId?: string;
	status?: ServiceStatus;
	
	// Error tracking
	serviceStatus?: 'pending' | 'running' | 'stopped' | 'error';
	error?: ServiceError;
}

/**
 * Health probe configuration
 */
export interface HealthProbe {
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
}

/**
 * Service status information
 */
export interface ServiceStatus {
	state: 'creating' | 'running' | 'stopped' | 'error' | 'unknown';
	startedAt?: Date;
	finishedAt?: Date;
	exitCode?: number;
	restartCount?: number;
	health?: 'healthy' | 'unhealthy' | 'starting' | 'unknown';
	message?: string;
}

/**
 * Service error information
 */
export interface ServiceError {
	type: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff' | 'Unknown';
	message: string;
	timestamp: string;
	retryCount: number;
	nextRetry?: string;
}

/**
 * Application definition
 */
export interface AppConfig {
	appId: number;
	appName: string;
	appUuid?: string;
	services: ServiceConfig[];
	networks?: NetworkConfig[];
	volumes?: VolumeConfig[];
}

/**
 * Network configuration
 */
export interface NetworkConfig {
	name: string;
	driver?: string;
	internal?: boolean;
	ipam?: {
		driver: string;
		config: Array<{
			subnet?: string;
			gateway?: string;
		}>;
	};
}

/**
 * Volume configuration
 */
export interface VolumeConfig {
	name: string;
	driver?: string;
	labels?: Record<string, string>;
	driverOpts?: Record<string, string>;
}

/**
 * Docker label map
 */
export type LabelObject = Record<string, string>;

/**
 * Docker Compose network config shape
 */
export interface ComposeNetworkConfig {
	driver?: string;
	driver_opts?: Record<string, string>;
	enable_ipv6?: boolean;
	internal?: boolean;
	ipam?: {
		driver?: string;
		config?: Array<{
			subnet?: string;
			gateway?: string;
			ip_range?: string;
			aux_addresses?: Record<string, string>;
		}>;
		options?: Record<string, string>;
	};
	labels?: Record<string, string>;
	config_only?: boolean;
}

/**
 * Docker network config used by docker/network.ts
 */
export interface DockerNetworkConfig {
	driver: string;
	ipam: {
		driver: string;
		config: Array<{
			subnet?: string;
			gateway?: string;
			ipRange?: string;
			auxAddress?: Record<string, string>;
		}>;
		options: Record<string, string>;
	};
	enableIPv6: boolean;
	internal: boolean;
	labels: Record<string, string>;
	options: Record<string, string>;
	configOnly: boolean;
}

/**
 * Docker inspect network shape used by docker/network.ts
 */
export interface DockerNetworkInspectInfo {
	Name: string;
	Id: string;
	Driver: string;
	EnableIPv6: boolean;
	IPAM: {
		Driver: string;
		Config: Array<{
			Subnet?: string;
			Gateway?: string;
			IPRange?: string;
			AuxAddress?: Record<string, string>;
		}>;
		Options?: Record<string, string>;
	};
	Internal: boolean;
	Options: Record<string, string>;
	Labels: Record<string, string>;
	ConfigOnly: boolean;
}

/**
 * Docker network interface used by docker/network.ts
 */
export interface DockerNetwork {
	appId: number;
	appUuid?: string;
	name: string;
	config: DockerNetworkConfig;

	create(): Promise<void>;
	remove(): Promise<void>;
	isEqualConfig(network: DockerNetwork): boolean;
	toComposeObject(): ComposeNetworkConfig;
	toDockerConfig(): any;
}

/**
 * Docker Compose volume config shape
 */
export interface ComposeVolumeConfig {
	driver?: string;
	driver_opts?: Record<string, string>;
	labels?: Record<string, string>;
}

/**
 * Docker volume config used by docker/volume.ts
 */
export interface DockerVolumeConfig {
	driver: string;
	driverOpts?: Record<string, string>;
	labels: Record<string, string>;
}

/**
 * Docker volume interface used by docker/volume.ts
 */
export interface DockerVolume {
	name: string;
	appId: number;
	appUuid: string;
	config: DockerVolumeConfig;

	create(): Promise<void>;
	remove(): Promise<void>;
	isEqualConfig(volume: DockerVolume): boolean;
	toComposeObject(): ComposeVolumeConfig;
}

// ============================================================================
// DOCKER HEALTH CHECK TYPES
// ============================================================================

export type HealthCheckType = 'http' | 'tcp' | 'exec';
export type ProbeType = 'liveness' | 'readiness' | 'startup';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface HttpHealthCheck {
	type: 'http';
	path: string;
	port: number;
	scheme?: 'http' | 'https';
	headers?: Record<string, string>;
	expectedStatus?: number[];
}

export interface TcpHealthCheck {
	type: 'tcp';
	port: number;
}

export interface ExecHealthCheck {
	type: 'exec';
	command: string[];
}

export type HealthCheck = HttpHealthCheck | TcpHealthCheck | ExecHealthCheck;

export interface ContainerHealthProbe {
	check: HealthCheck;
	initialDelaySeconds?: number;
	periodSeconds?: number;
	timeoutSeconds?: number;
	successThreshold?: number;
	failureThreshold?: number;
}

export interface HealthCheckResult {
	success: boolean;
	message?: string;
	timestamp: number;
	duration: number;
}

export interface ProbeState {
	probe: ContainerHealthProbe;
	probeType: ProbeType;
	containerId: string;
	serviceName: string;
	status: HealthStatus;
	consecutiveSuccesses: number;
	consecutiveFailures: number;
	lastCheck?: HealthCheckResult;
	lastTransition?: number;
	timerId?: NodeJS.Timeout;
	nextCheckAt?: number;
}

export interface ContainerHealth {
	containerId: string;
	serviceName: string;
	liveness?: ProbeState;
	readiness?: ProbeState;
	startup?: ProbeState;
	isLive: boolean;
	isReady: boolean;
	isStarted: boolean;
}

/**
 * Target state for orchestrator
 */
export interface TargetState {
	local?: {
		apps?: Record<string, AppConfig>;
	};
	config?: {
		settings?: {
			// Orchestrator selection
			orchestrator?: 'docker' | 'k3s';
			
			// Orchestrator-specific config
			k3s?: {
				kubeconfigPath?: string;
				namespace?: string;
				inCluster?: boolean;
			};
			
			// Legacy interval fields (DEPRECATED - use config.intervals instead)
			reconciliationIntervalMs?: number;
			targetStatePollIntervalMs?: number;
			
			// Performance and resource settings
			memoryCheckIntervalMs?: number;
			memoryThresholdMb?: number;
			
			// Logging settings
			logMaxAge?: number;
			maxLogFileSize?: number;
			maxLogs?: number;
		};
		features?: {
			enableDeviceJobs?: boolean;
			enableAnomalyDetection?: boolean;
			enableDeviceRemoteAccess?: boolean;
			enableDevicePublish?: boolean;
			enableJobEngine?: boolean;
			enableShadow?: boolean;
			enableLogs?: boolean;
		};
		publish?: {
			enabled?: boolean;
		};
		logging?: {
			level?: string;
			enableFilePersistence?: boolean;
			enableCompression?: boolean;
		};
		
		// Protocol configurations (unified enablement + settings)
		// Each protocol contains both the enabled flag and its specific configuration
		protocols?: {
			modbus?: {
				enabled: boolean;
				// Modbus-specific configuration
				tcpHost?: string;
				tcpPort?: number;
				serialPort?: string;
				baudRate?: number;
				slaveRangeStart?: number;
				slaveRangeEnd?: number;
				timeout?: number;
				profile?: string;
				profileFile?: string;
			};
			opcua?: {
				enabled: boolean;
				// OPC-UA specific configuration
				discoveryUrls?: string[];
			};
			snmp?: {
				enabled: boolean;
				// SNMP specific configuration
				ipRanges?: string[];
				port?: number;
			};
			can?: {
				enabled: boolean;
				// CAN bus specific configuration (future)
			};
		};
		
		// DEPRECATED: Legacy protocolAdapters section for backward compatibility only
		// Will be removed in future version. Use 'protocols' section above instead.
		protocolAdapters?: {
			modbus?: {
				enabled?: boolean;
				tcpHost?: string;
				tcpPort?: number;
				serialPort?: string;
				baudRate?: number;
				slaveRangeStart?: number;
				slaveRangeEnd?: number;
				timeout?: number;
				profile?: string;
				profileFile?: string;
			};
			opcua?: {
				enabled?: boolean;
				discoveryUrls?: string[];
			};
			snmp?: {
				enabled?: boolean;
				ipRanges?: string[];
				port?: number;
			};
		};
	};
}

/**
 * Current state from orchestrator
 */
export interface CurrentState {
	apps: Record<string, AppConfig>;
	timestamp: Date;
}

/**
 * Log stream options
 */
export interface LogStreamOptions {
	follow?: boolean;
	tail?: number;
	since?: Date;
	timestamps?: boolean;
	stdout?: boolean;
	stderr?: boolean;
}

/**
 * Container metrics
 */
export interface ContainerMetrics {
	containerId: string;
	serviceName: string;
	cpu: {
		usage: number; // Percentage
		cores?: number;
	};
	memory: {
		usage: number; // Bytes
		limit?: number; // Bytes
		percentage?: number;
	};
	network?: {
		rxBytes: number;
		txBytes: number;
	};
	timestamp: Date;
}

/**
 * Reconciliation result
 */
export interface ReconciliationResult {
	success: boolean;
	servicesCreated: number;
	servicesUpdated: number;
	servicesRemoved: number;
	errors: Array<{
		serviceName: string;
		error: string;
	}>;
	timestamp: Date;
}

// ============================================================================
// DRIVER INTERFACE
// ============================================================================

/**
 * Base orchestrator driver interface
 * 
 * All orchestrator implementations (Docker, K3s, etc.) must implement this interface.
 * 
 * Events emitted:
 * - 'service-started': { serviceName: string, containerId: string }
 * - 'service-stopped': { serviceName: string, containerId: string, exitCode?: number }
 * - 'service-error': { serviceName: string, error: Error }
 * - 'health-changed': { serviceName: string, health: 'healthy' | 'unhealthy' }
 * - 'reconciliation-complete': ReconciliationResult
 */
export interface IOrchestratorDriver extends EventEmitter {
	/**
	* Driver name (e.g., 'docker', 'k3s')
	*/
	readonly name: string;

	/**
	* Driver version
	*/
	readonly version: string;

	// ============================================================================
	// LIFECYCLE METHODS
	// ============================================================================

	/**
	* Initialize the orchestrator driver
	* - Connect to orchestrator API
	* - Verify connectivity
	* - Set up event listeners
	* 
	* @throws Error if initialization fails
	*/
	init(): Promise<void>;

	/**
	* Shutdown the orchestrator driver
	* - Clean up resources
	* - Close connections
	* - Stop event listeners
	*/
	shutdown(): Promise<void>;

	/**
	* Check if driver is ready to accept operations
	*/
	isReady(): boolean;

	/**
	* Get driver health status
	*/
	getHealth(): Promise<{
		healthy: boolean;
		message?: string;
		lastCheck: Date;
	}>;

	// ============================================================================
	// STATE MANAGEMENT
	// ============================================================================

	/**
	* Get current state of all running services
	* 
	* @returns Current state snapshot
	*/
	getCurrentState(): Promise<CurrentState>;

	/**
	* Set target state (desired state)
	* This does NOT apply the state - use reconcile() to apply changes
	* 
	* @param targetState - Desired state configuration
	*/
	setTargetState(targetState: TargetState): Promise<void>;

	/**
	* Get current target state
	*/
	getTargetState(): TargetState | null;

	/**
	* Reconcile current state with target state
	* - Compare current vs target
	* - Create/update/remove services as needed
	* - Handle errors gracefully
	* 
	* @returns Reconciliation result with statistics
	*/
	reconcile(): Promise<ReconciliationResult>;

	// ============================================================================
	// SERVICE OPERATIONS
	// ============================================================================

	/**
	* Create and start a service
	* 
	* @param service - Service configuration
	* @returns Container/pod ID
	*/
	createService(service: ServiceConfig): Promise<string>;

	/**
	* Stop a running service
	* 
	* @param serviceId - Service identifier (name or ID)
	* @param timeout - Graceful shutdown timeout in seconds
	*/
	stopService(serviceId: string, timeout?: number): Promise<void>;

	/**
	* Remove a service
	* 
	* @param serviceId - Service identifier
	* @param force - Force removal even if running
	*/
	removeService(serviceId: string, force?: boolean): Promise<void>;

	/**
	* Restart a service
	* 
	* @param serviceId - Service identifier
	* @param timeout - Graceful shutdown timeout in seconds
	*/
	restartService(serviceId: string, timeout?: number): Promise<void>;

	/**
	* Get service status
	* 
	* @param serviceId - Service identifier
	*/
	getServiceStatus(serviceId: string): Promise<ServiceStatus>;

	/**
	* List all services managed by this driver
	*/
	listServices(): Promise<ServiceConfig[]>;

	// ============================================================================
	// LOGGING
	// ============================================================================

	/**
	* Get service logs
	* 
	* @param serviceId - Service identifier
	* @param options - Log streaming options
	* @returns Stream of log data
	*/
	getServiceLogs(serviceId: string, options?: LogStreamOptions): Promise<Stream>;

	// ============================================================================
	// HEALTH CHECKS
	// ============================================================================

	/**
	* Execute health check for a service
	* 
	* @param serviceId - Service identifier
	* @returns Health status
	*/
	executeHealthCheck(serviceId: string): Promise<{
		healthy: boolean;
		message?: string;
	}>;

	/**
	* Start continuous health monitoring for a service
	* 
	* @param serviceId - Service identifier
	*/
	startHealthMonitoring(serviceId: string): Promise<void>;

	/**
	* Stop health monitoring for a service
	* 
	* @param serviceId - Service identifier
	*/
	stopHealthMonitoring(serviceId: string): Promise<void>;

	// ============================================================================
	// METRICS
	// ============================================================================

	/**
	* Get resource usage metrics for a service
	* 
	* @param serviceId - Service identifier
	*/
	getServiceMetrics(serviceId: string): Promise<ContainerMetrics>;

	/**
	* Get metrics for all services
	*/
	getAllMetrics(): Promise<ContainerMetrics[]>;

	// ============================================================================
	// NETWORK OPERATIONS
	// ============================================================================

	/**
	* Create a network
	* 
	* @param network - Network configuration
	*/
	createNetwork(network: NetworkConfig): Promise<void>;

	/**
	* Remove a network
	* 
	* @param networkName - Network name
	*/
	removeNetwork(networkName: string): Promise<void>;

	/**
	* List all networks
	*/
	listNetworks(): Promise<NetworkConfig[]>;

	// ============================================================================
	// VOLUME OPERATIONS
	// ============================================================================

	/**
	* Create a volume
	* 
	* @param volume - Volume configuration
	*/
	createVolume(volume: VolumeConfig): Promise<void>;

	/**
	* Remove a volume
	* 
	* @param volumeName - Volume name
	*/
	removeVolume(volumeName: string): Promise<void>;

	/**
	* List all volumes
	*/
	listVolumes(): Promise<VolumeConfig[]>;
}

/**
 * Base abstract class that provides common functionality
 * Drivers can extend this to avoid reimplementing common logic
 */
export abstract class BaseOrchestratorDriver extends EventEmitter implements IOrchestratorDriver {
	protected logger?: AgentLogger;
	protected targetState: TargetState | null = null;
	protected ready: boolean = false;

	abstract readonly name: string;
	abstract readonly version: string;

	constructor(logger?: AgentLogger) {
		super();
		this.logger = logger;
	}

	abstract init(): Promise<void>;
	abstract shutdown(): Promise<void>;
	abstract getCurrentState(): Promise<CurrentState>;
	abstract reconcile(): Promise<ReconciliationResult>;
	abstract createService(service: ServiceConfig): Promise<string>;
	abstract stopService(serviceId: string, timeout?: number): Promise<void>;
	abstract removeService(serviceId: string, force?: boolean): Promise<void>;
	abstract restartService(serviceId: string, timeout?: number): Promise<void>;
	abstract getServiceStatus(serviceId: string): Promise<ServiceStatus>;
	abstract listServices(): Promise<ServiceConfig[]>;
	abstract getServiceLogs(serviceId: string, options?: LogStreamOptions): Promise<Stream>;
	abstract executeHealthCheck(serviceId: string): Promise<{ healthy: boolean; message?: string }>;
	abstract startHealthMonitoring(serviceId: string): Promise<void>;
	abstract stopHealthMonitoring(serviceId: string): Promise<void>;
	abstract getServiceMetrics(serviceId: string): Promise<ContainerMetrics>;
	abstract getAllMetrics(): Promise<ContainerMetrics[]>;
	abstract createNetwork(network: NetworkConfig): Promise<void>;
	abstract removeNetwork(networkName: string): Promise<void>;
	abstract listNetworks(): Promise<NetworkConfig[]>;
	abstract createVolume(volume: VolumeConfig): Promise<void>;
	abstract removeVolume(volumeName: string): Promise<void>;
	abstract listVolumes(): Promise<VolumeConfig[]>;

	// Default implementations

	isReady(): boolean {
		return this.ready;
	}

	async getHealth(): Promise<{ healthy: boolean; message?: string; lastCheck: Date }> {
		return {
			healthy: this.ready,
			message: this.ready ? 'Driver is operational' : 'Driver not initialized',
			lastCheck: new Date()
		};
	}

	async setTargetState(targetState: TargetState): Promise<void> {
		this.targetState = targetState;
		this.logger?.debugSync('Target state updated', {
			component: LogComponents.orchestratorDriver,
			driver: this.name,
			appsCount: Object.keys(targetState.local?.apps || {}).length
		});
	}

	getTargetState(): TargetState | null {
		return this.targetState;
	}

	protected log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: any) {
		const logMeta = {
			component: LogComponents.orchestratorDriver,
			driver: this.name,
			...meta
		};

		switch (level) {
			case 'debug':
				this.logger?.debugSync(message, logMeta);
				break;
			case 'info':
				this.logger?.infoSync(message, logMeta);
				break;
			case 'warn':
				this.logger?.warnSync(message, logMeta);
				break;
			case 'error':
				this.logger?.errorSync(message, logMeta);
				break;
		}
	}
}
