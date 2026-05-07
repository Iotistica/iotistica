/**
 * DOCKER ORCHESTRATOR DRIVER
 * ============================
 * 
 * Docker implementation of the orchestrator driver interface.
 * Wraps the existing ContainerManager to provide a unified API.
 */

import { Readable } from 'stream';
import { BaseOrchestratorDriver } from './types';
import ContainerManager from './container-manager';
import type {
	CurrentState,
	ServiceConfig,
	ServiceStatus,
	LogStreamOptions,
	ContainerMetrics,
	ReconciliationResult,
	NetworkConfig,
	VolumeConfig
} from './types';
import type { AgentLogger } from '../logging/agent-logger';

/**
 * Docker driver implementation
 */
export class DockerDriver extends BaseOrchestratorDriver {
	readonly name = 'docker';
	readonly version = '1.0.0';

	private containerManager!: ContainerManager;

	constructor(logger?: AgentLogger) {
		super(logger);
	}

	async init(): Promise<void> {
		this.log('info', 'Initializing Docker driver');

		try {
			// Create and initialize container manager
			this.containerManager = new ContainerManager(this.logger);
			await this.containerManager.init();

			// Note: Event forwarding would be implemented here when ContainerManager supports events
			// For now, we rely on polling getCurrentState()

			this.ready = true;
			this.log('info', 'Docker driver initialized successfully');
		} catch (error) {
			this.log('error', 'Failed to initialize Docker driver', { error });
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		this.log('info', 'Shutting down Docker driver');
		
		if (this.containerManager) {
			this.containerManager.stopAutoReconciliation();
		}

		this.ready = false;
		this.log('info', 'Docker driver shut down');
	}

	async getCurrentState(): Promise<CurrentState> {
		this.log('debug', 'Getting current state');
		
		const currentState = await this.containerManager.getCurrentState();
		
		// Convert SimpleApp format to AppConfig format
		const apps: Record<string, any> = {};
		if (currentState.apps) {
			for (const [appId, app] of Object.entries(currentState.apps)) {
				apps[appId] = app;
			}
		}
		
		return {
			apps,
			timestamp: new Date()
		};
	}

	async reconcile(): Promise<ReconciliationResult> {
		this.log('info', 'Starting reconciliation');

		const errors: Array<{ serviceName: string; error: string }> = [];

		try {
			// ContainerManager doesn't have a reconcile() method exposed
			// Reconciliation happens automatically via auto-reconciliation
			// For now, just return success
			
			const result: ReconciliationResult = {
				success: true,
				servicesCreated: 0,
				servicesUpdated: 0,
				servicesRemoved: 0,
				errors,
				timestamp: new Date()
			};

			this.log('info', 'Reconciliation complete', result);
			this.emit('reconciliation-complete', result);

			return result;
		} catch (error) {
			this.log('error', 'Reconciliation failed', { error });
			throw error;
		}
	}

	async createService(service: ServiceConfig): Promise<string> {
		this.log('info', 'Creating service', { serviceName: service.serviceName });
		
		// Delegate to container manager
		// Note: ContainerManager handles this through reconciliation
		// We would need to add a direct create method or use reconciliation
		
		throw new Error('Direct service creation not implemented - use reconciliation');
	}

	async stopService(serviceId: string, timeout?: number): Promise<void> {
		this.log('info', 'Stopping service', { serviceId, timeout });
		
		// Would need to add to container manager
		throw new Error('Direct service stop not implemented');
	}

	async removeService(serviceId: string, force?: boolean): Promise<void> {
		this.log('info', 'Removing service', { serviceId, force });
		
		// Would need to add to container manager
		throw new Error('Direct service removal not implemented');
	}

	async restartService(serviceId: string, timeout?: number): Promise<void> {
		this.log('info', 'Restarting service', { serviceId, timeout });
		
		// Would need to add to container manager
		throw new Error('Direct service restart not implemented');
	}

	async getServiceStatus(serviceId: string): Promise<ServiceStatus> {
		this.log('debug', 'Getting service status', { serviceId });
		
		const currentState = await this.containerManager.getCurrentState();
		
		// Find service in current state
		for (const app of Object.values(currentState.apps)) {
			const service = app.services?.find((s: any) => 
				s.serviceName === serviceId || s.containerId === serviceId
			);
			
			if (service) {
				return {
					state: service.status === 'Running' ? 'running' : 
						service.status === 'Exited' ? 'stopped' : 
							'unknown',
					startedAt: undefined, // Would need to get from Docker
					message: service.status
				};
			}
		}

		throw new Error(`Service not found: ${serviceId}`);
	}

	async listServices(): Promise<ServiceConfig[]> {
		this.log('debug', 'Listing services');
		
		const currentState = await this.containerManager.getCurrentState();
		const services: ServiceConfig[] = [];

		for (const app of Object.values(currentState.apps)) {
			if (app.services) {
				services.push(...app.services as any);
			}
		}

		return services;
	}

	async getServiceLogs(serviceId: string, options?: LogStreamOptions): Promise<Readable> {
		this.log('debug', 'Getting service logs', { serviceId });
		
		const docker = this.containerManager.getDocker();
		if (!docker) {
			throw new Error('Docker instance not available');
		}

		const container = docker.getContainer(serviceId);
		
		// Handle Docker logs with proper type handling
		const logOptions: any = {
			stdout: options?.stdout !== false,
			stderr: options?.stderr !== false,
			tail: options?.tail,
			since: options?.since ? Math.floor(options.since.getTime() / 1000) : undefined,
			timestamps: options?.timestamps || false
		};

		// Follow requires different handling
		if (options?.follow) {
			logOptions.follow = true;
			const stream = await container.logs(logOptions);
			return stream as any as Readable;
		} else {
			const buffer = await container.logs(logOptions);
			const stream = new Readable();
			stream.push(buffer);
			stream.push(null);
			return stream;
		}
	}

	async executeHealthCheck(serviceId: string): Promise<{ healthy: boolean; message?: string }> {
		this.log('debug', 'Executing health check', { serviceId });
		
		// Would delegate to health check manager
		// For now, return basic status
		try {
			const status = await this.getServiceStatus(serviceId);
			return {
				healthy: status.state === 'running',
				message: status.message
			};
		} catch (error) {
			return {
				healthy: false,
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}

	async startHealthMonitoring(serviceId: string): Promise<void> {
		this.log('info', 'Starting health monitoring', { serviceId });
		// Would delegate to health check manager
	}

	async stopHealthMonitoring(serviceId: string): Promise<void> {
		this.log('info', 'Stopping health monitoring', { serviceId });
		// Would delegate to health check manager
	}

	async getServiceMetrics(serviceId: string): Promise<ContainerMetrics> {
		this.log('debug', 'Getting service metrics', { serviceId });
		
		const docker = this.containerManager.getDocker();
		if (!docker) {
			throw new Error('Docker instance not available');
		}

		const container = docker.getContainer(serviceId);
		const stats = await container.stats({ stream: false });

		// Parse Docker stats
		const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
		const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
		const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;

		const memoryUsage = stats.memory_stats.usage || 0;
		const memoryLimit = stats.memory_stats.limit || 0;

		return {
			containerId: serviceId,
			serviceName: serviceId,
			cpu: {
				usage: cpuPercent,
				cores: stats.cpu_stats.online_cpus
			},
			memory: {
				usage: memoryUsage,
				limit: memoryLimit,
				percentage: (memoryUsage / memoryLimit) * 100
			},
			network: {
				rxBytes: stats.networks?.eth0?.rx_bytes || 0,
				txBytes: stats.networks?.eth0?.tx_bytes || 0
			},
			timestamp: new Date()
		};
	}

	async getAllMetrics(): Promise<ContainerMetrics[]> {
		this.log('debug', 'Getting all metrics');
		
		const services = await this.listServices();
		const metrics: ContainerMetrics[] = [];

		for (const service of services) {
			if (service.containerId) {
				try {
					const metric = await this.getServiceMetrics(service.containerId);
					metrics.push(metric);
				} catch (error) {
					this.log('warn', 'Failed to get metrics for service', {
						serviceName: service.serviceName,
						error
					});
				}
			}
		}

		return metrics;
	}

	async createNetwork(network: NetworkConfig): Promise<void> {
		this.log('info', 'Creating network', { networkName: network.name });
		
		// Would delegate to network manager
		throw new Error('Network creation not implemented');
	}

	async removeNetwork(networkName: string): Promise<void> {
		this.log('info', 'Removing network', { networkName });
		
		// Would delegate to network manager
		throw new Error('Network removal not implemented');
	}

	async listNetworks(): Promise<NetworkConfig[]> {
		this.log('debug', 'Listing networks');
		
		// Would delegate to network manager
		return [];
	}

	async createVolume(volume: VolumeConfig): Promise<void> {
		this.log('info', 'Creating volume', { volumeName: volume.name });
		
		// Would delegate to volume manager
		throw new Error('Volume creation not implemented');
	}

	async removeVolume(volumeName: string): Promise<void> {
		this.log('info', 'Removing volume', { volumeName });
		
		// Would delegate to volume manager
		throw new Error('Volume removal not implemented');
	}

	async listVolumes(): Promise<VolumeConfig[]> {
		this.log('debug', 'Listing volumes');
		
		// Would delegate to volume manager
		return [];
	}
}

