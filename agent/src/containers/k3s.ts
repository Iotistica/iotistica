/**
 * K3S ORCHESTRATOR DRIVER
 * ========================
 * 
 * K3s (Lightweight Kubernetes) implementation of the orchestrator driver interface.
 * Provides container orchestration using Kubernetes APIs.
 * 
 * NOTE: This is a skeleton implementation. Full K3s support requires:
 * 1. npm install @kubernetes/client-node
 * 2. K3s installed on the device
 * 3. Valid kubeconfig access
 */

import { type Readable } from 'stream';
import { BaseOrchestratorDriver } from './types';
import type {
	TargetState as _TargetState,
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

// K8s types - imported dynamically to handle CommonJS/ESM compatibility
type KubeConfig = any;
type CoreV1Api = any;
type AppsV1Api = any;

/**
 * K3s driver implementation
 * 
 * This driver translates our ServiceConfig format into Kubernetes manifests
 * and manages workloads using the Kubernetes API.
 */
export class K3sDriver extends BaseOrchestratorDriver {
	readonly name = 'k3s';
	readonly version = '1.0.0';

	private kubeconfigPath: string;
	private namespace: string;
	private inCluster: boolean;
	
	// K8s client instances (will be initialized in init())
	private k8sApi: KubeConfig;
	private coreV1Api: CoreV1Api;
	private appsV1Api: AppsV1Api;
	
	// Target state for reconciliation (inherited from base class)

	constructor(logger?: AgentLogger, config?: {
		kubeconfigPath?: string;
		namespace?: string;
		inCluster?: boolean;
	}) {
		super(logger);
		
		this.kubeconfigPath = config?.kubeconfigPath || '/etc/rancher/k3s/k3s.yaml';
		this.namespace = config?.namespace || 'iotistica';
		this.inCluster = config?.inCluster || false;
	}

	async init(): Promise<void> {
		this.log('info', 'Initializing K3s driver', {
			kubeconfigPath: this.kubeconfigPath,
			namespace: this.namespace,
			inCluster: this.inCluster
		});

		try {
			// Dynamic import to handle optional @kubernetes/client-node dependency
			// @ts-ignore - Package may not be installed
			const k8s = await import('@kubernetes/client-node');
			
			// Initialize kubeconfig
			this.k8sApi = new k8s.KubeConfig();
			
			if (this.inCluster) {
				this.k8sApi.loadFromCluster();
			} else {
				this.k8sApi.loadFromFile(this.kubeconfigPath);
			}

			// Create API clients
			this.coreV1Api = this.k8sApi.makeApiClient(k8s.CoreV1Api);
			this.appsV1Api = this.k8sApi.makeApiClient(k8s.AppsV1Api);

			// Verify connection
			await this.verifyConnection();

			// Ensure namespace exists
			await this.ensureNamespace();

			this.ready = true;
			this.log('info', 'K3s driver initialized successfully');
		} catch (error) {
			this.log('error', 'Failed to initialize K3s driver', { error });
			throw error;
		}
	}

	private async verifyConnection(): Promise<void> {
		this.log('debug', 'Verifying K3s connection');
		
		try {
			// Try to list namespaces to verify connection
			await this.coreV1Api.listNamespace();
			this.log('debug', 'K3s connection verified');
		} catch (error) {
			throw new Error(`Failed to connect to K3s: ${error}`);
		}
	}

	private async ensureNamespace(): Promise<void> {
		this.log('debug', 'Ensuring namespace exists', { namespace: this.namespace });
		
		try {
			await this.coreV1Api.readNamespace(this.namespace);
			this.log('debug', 'Namespace exists');
		} catch (error: any) {
			if (error.statusCode === 404) {
				// Namespace doesn't exist, create it
				this.log('info', 'Creating namespace', { namespace: this.namespace });
				
				await this.coreV1Api.createNamespace({
					metadata: {
						name: this.namespace,
						labels: {
							'managed-by': 'iotistica-agent',
							'iotistica.io/managed': 'true'
						}
					}
				});
			} else {
				throw error;
			}
		}
	}

	async shutdown(): Promise<void> {
		this.log('info', 'Shutting down K3s driver');
		
		// No persistent connections to close
		
		this.ready = false;
		this.log('info', 'K3s driver shut down');
	}

	async getCurrentState(): Promise<CurrentState> {
		this.log('debug', 'Getting current state from K3s');
		
		try {
			// List all deployments in namespace
			const deploymentsResponse = await this.appsV1Api.listNamespacedDeployment(
				this.namespace
			);

			// Convert K8s deployments to our format
			const apps: Record<string, any> = {};
			
			for (const deployment of deploymentsResponse.body.items) {
				const appName = deployment.metadata.labels?.['app'] || deployment.metadata.name;
				
				if (!apps[appName]) {
					apps[appName] = {
						appId: 0, // Would need to extract from labels
						appName,
						services: []
					};
				}

				// Convert deployment to service
				const service = await this.deploymentToService(deployment);
				apps[appName].services.push(service);
			}

			return {
				apps,
				timestamp: new Date()
			};
		} catch (error) {
			this.log('error', 'Failed to get current state', { error });
			throw error;
		}
	}

	private async deploymentToService(deployment: any): Promise<ServiceConfig> {
		// Convert K8s Deployment to our ServiceConfig format
		const container = deployment.spec.template.spec.containers[0];
		return {
			serviceId: parseInt(deployment.metadata.labels?.['service-id'] || '0'),
			serviceName: deployment.metadata.name,
			imageName: container.image,
			appId: parseInt(deployment.metadata.labels?.['app-id'] || '0'),
			appName: deployment.metadata.labels?.['app'] || deployment.metadata.name,
			config: {
				image: container.image,
				environment: this.envArrayToObject(container.env || []),
				// ... other fields
			},
			status: {
				state: deployment.status?.availableReplicas > 0 ? 'running' : 'stopped',
				restartCount: deployment.status?.replicas || 0
			},
			containerId: deployment.metadata.uid
		};
	}

	private envArrayToObject(envArray: Array<{ name: string; value?: string }>): Record<string, string> {
		const env: Record<string, string> = {};
		for (const item of envArray) {
			if (item.value !== undefined) {
				env[item.name] = item.value;
			}
		}
		return env;
	}

	async reconcile(): Promise<ReconciliationResult> {
		this.log('info', 'Reconciling K3s state');
		
		const errors: Array<{ serviceName: string; error: string }> = [];
		let servicesCreated = 0;
		let servicesUpdated = 0;
		let servicesRemoved = 0;

		try {
			// Get target state from supervisor (should be set beforehand)
			if (!this.targetState) {
				this.log('warn', 'No target state set, skipping reconciliation');
				return {
					success: true,
					servicesCreated: 0,
					servicesUpdated: 0,
					servicesRemoved: 0,
					errors: [],
					timestamp: new Date()
				};
			}

			// Get current state from K3s
			const currentState = await this.getCurrentState();
			
			// Build maps for comparison
			const currentServices = new Map<string, ServiceConfig>();
			const targetServices = new Map<string, ServiceConfig>();
			
			// Index current services by serviceId
			for (const app of Object.values(currentState.apps)) {
				for (const service of app.services) {
					currentServices.set(String(service.serviceId), service);
				}
			}
			
			// Index target services by serviceId
			const targetApps = this.targetState.local?.apps || {};
			for (const app of Object.values(targetApps)) {
				for (const service of app.services) {
					targetServices.set(String(service.serviceId), service);
				}
			}
			
			// Find services to add or update
			for (const [serviceId, targetService] of targetServices) {
				try {
					const currentService = currentServices.get(serviceId);
					
					if (!currentService) {
						// Service doesn't exist - create it
						this.log('debug', 'Adding new service', { serviceName: targetService.serviceName });
						await this.createService(targetService);
						servicesCreated++;
					} else if (this.needsUpdate(currentService, targetService)) {
						// Service exists but needs update
						this.log('debug', 'Updating service', { serviceName: targetService.serviceName });
						await this.updateService(targetService);
						servicesUpdated++;
					}
				} catch (error) {
					this.log('error', 'Failed to reconcile service', { 
						serviceId, 
						serviceName: targetService.serviceName, 
						error 
					});
					errors.push({
						serviceName: targetService.serviceName,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
			
			// Find services to remove
			for (const [serviceId, currentService] of currentServices) {
				if (!targetServices.has(serviceId)) {
					try {
						this.log('debug', 'Removing service', { serviceName: currentService.serviceName });
						await this.removeService(currentService.serviceName);
						servicesRemoved++;
					} catch (error) {
						this.log('error', 'Failed to remove service', { 
							serviceId, 
							serviceName: currentService.serviceName, 
							error 
						});
						errors.push({
							serviceName: currentService.serviceName,
							error: error instanceof Error ? error.message : String(error)
						});
					}
				}
			}
			
			const result: ReconciliationResult = {
				success: errors.length === 0,
				servicesCreated,
				servicesUpdated,
				servicesRemoved,
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

	private needsUpdate(current: ServiceConfig, target: ServiceConfig): boolean {
		// Check if image changed
		if (current.config.image !== target.config.image) {
			return true;
		}
		
		// Check if environment variables changed
		const currentEnv = JSON.stringify(current.config.environment || {});
		const targetEnv = JSON.stringify(target.config.environment || {});
		if (currentEnv !== targetEnv) {
			return true;
		}
		
		// Check if ports changed
		const currentPorts = JSON.stringify(current.config.ports || []);
		const targetPorts = JSON.stringify(target.config.ports || []);
		if (currentPorts !== targetPorts) {
			return true;
		}
		
		return false;
	}

	private async updateService(service: ServiceConfig): Promise<void> {
		this.log('debug', 'Updating K3s deployment', { serviceName: service.serviceName });
		
		try {
			// Convert to deployment manifest
			const deployment = this.serviceToDeployment(service);
			
			// Update the deployment
			await this.appsV1Api.replaceNamespacedDeployment(
				service.serviceName,
				this.namespace,
				deployment
			);
			
			this.log('info', 'Service updated successfully', { serviceName: service.serviceName });
		} catch (error) {
			this.log('error', 'Failed to update service', { serviceName: service.serviceName, error });
			throw error;
		}
	}

	async createService(service: ServiceConfig): Promise<string> {
		this.log('info', 'Creating K3s service', { serviceName: service.serviceName });
		
		// Convert ServiceConfig to K8s Deployment manifest
		const deployment = this.serviceToDeployment(service);
		
		try {
			const response = await this.appsV1Api.createNamespacedDeployment(
				this.namespace,
				deployment
			);
			
			return response.body.metadata.uid;
		} catch (error) {
			this.log('error', 'Failed to create service', { service: service.serviceName, error });
			throw error;
		}
	}

	private serviceToDeployment(service: ServiceConfig): any {
		// Convert our ServiceConfig to K8s Deployment manifest
		return {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: {
				name: service.serviceName,
				namespace: this.namespace,
				labels: {
					'app': service.appName,
					'service': service.serviceName,
					'app-id': String(service.appId),
					'service-id': String(service.serviceId),
					'managed-by': 'iotistic-agent'
				}
			},
			spec: {
				replicas: 1,
				selector: {
					matchLabels: {
						'service': service.serviceName
					}
				},
				template: {
					metadata: {
						labels: {
							'app': service.appName,
							'service': service.serviceName
						}
					},
					spec: {
						containers: [{
							name: service.serviceName,
							image: service.config.image,
							env: this.envObjectToArray(service.config.environment || {}),
							ports: this.parsePortsForK8s(service.config.ports || []),
							resources: this.parseResourcesForK8s(service.config.resources),
							// Health probes
							livenessProbe: this.probeToK8s(service.config.livenessProbe),
							readinessProbe: this.probeToK8s(service.config.readinessProbe),
							startupProbe: this.probeToK8s(service.config.startupProbe)
						}]
					}
				}
			}
		};
	}

	private envObjectToArray(env: Record<string, string>): Array<{ name: string; value: string }> {
		return Object.entries(env).map(([name, value]) => ({ name, value }));
	}

	private parsePortsForK8s(ports: string[]): Array<{ containerPort: number; protocol?: string }> {
		// Parse "80:80" format to K8s format
		return ports.map(portStr => {
			const [, containerPort] = portStr.split(':');
			return {
				containerPort: parseInt(containerPort),
				protocol: 'TCP'
			};
		});
	}

	private parseResourcesForK8s(resources: any): any {
		if (!resources) return undefined;

		return {
			limits: resources.limits,
			requests: resources.requests
		};
	}

	private probeToK8s(probe: any): any {
		if (!probe) return undefined;

		const k8sProbe: any = {
			initialDelaySeconds: probe.initialDelaySeconds || 0,
			periodSeconds: probe.periodSeconds || 10,
			timeoutSeconds: probe.timeoutSeconds || 1,
			successThreshold: probe.successThreshold || 1,
			failureThreshold: probe.failureThreshold || 3
		};

		switch (probe.type) {
			case 'http':
				k8sProbe.httpGet = {
					path: probe.path || '/',
					port: probe.port || 80,
					scheme: probe.scheme?.toUpperCase() || 'HTTP'
				};
				break;

			case 'tcp':
				k8sProbe.tcpSocket = {
					port: probe.tcpPort || 80
				};
				break;

			case 'exec':
				k8sProbe.exec = {
					command: probe.command || []
				};
				break;
		}

		return k8sProbe;
	}

	// Stub implementations for remaining methods
	
	async stopService(serviceId: string, _timeout?: number): Promise<void> {
		this.log('info', 'Stopping service', { serviceId });
		// Scale deployment to 0 replicas
		try {
			const deployment = await this.appsV1Api.readNamespacedDeployment(serviceId, this.namespace);
			deployment.spec.replicas = 0;
			await this.appsV1Api.replaceNamespacedDeployment(serviceId, this.namespace, deployment);
			this.log('info', 'Service stopped', { serviceId });
		} catch (error) {
			this.log('error', 'Failed to stop service', { serviceId, error });
			throw error;
		}
	}

	async removeService(serviceName: string, force?: boolean): Promise<void> {
		this.log('info', 'Removing service', { serviceName });
		
		try {
			// Delete the deployment
			await this.appsV1Api.deleteNamespacedDeployment(
				serviceName,
				this.namespace
			);
			
			this.log('info', 'Service removed successfully', { serviceName });
		} catch (error) {
			this.log('error', 'Failed to remove service', { serviceName, error });
			if (!force) {
				throw error;
			}
		}
	}

	async restartService(serviceId: string, _timeout?: number): Promise<void> {
		this.log('info', 'Restarting service', { serviceId });
		
		try {
			// Get deployment
			const deployment = await this.appsV1Api.readNamespacedDeployment(serviceId, this.namespace);
			
			// Add restart annotation to trigger rolling update
			if (!deployment.spec.template.metadata) {
				deployment.spec.template.metadata = {};
			}
			if (!deployment.spec.template.metadata.annotations) {
				deployment.spec.template.metadata.annotations = {};
			}
			deployment.spec.template.metadata.annotations['iotistica.com/restartedAt'] = new Date().toISOString();
			
			// Update deployment
			await this.appsV1Api.replaceNamespacedDeployment(serviceId, this.namespace, deployment);
			
			this.log('info', 'Service restarted', { serviceId });
		} catch (error) {
			this.log('error', 'Failed to restart service', { serviceId, error });
			throw error;
		}
	}

	async getServiceStatus(serviceId: string): Promise<ServiceStatus> {
		this.log('debug', 'Getting service status', { serviceId });
		
		try {
			const deployment = await this.appsV1Api.readNamespacedDeployment(serviceId, this.namespace);
			
			const replicas = deployment.status?.replicas || 0;
			const availableReplicas = deployment.status?.availableReplicas || 0;
			const readyReplicas = deployment.status?.readyReplicas || 0;
			
			let state: 'running' | 'stopped' | 'creating' | 'error' | 'unknown' = 'unknown';
			
			if (availableReplicas === replicas && replicas > 0) {
				state = 'running';
			} else if (replicas === 0) {
				state = 'stopped';
			} else if (readyReplicas < replicas) {
				state = 'creating';
			} else if (deployment.status?.conditions?.some((c: any) => c.type === 'Progressing' && c.status === 'False')) {
				state = 'error';
			}
			
			return {
				state,
				health: availableReplicas === replicas ? 'healthy' : 'unhealthy'
			};
		} catch (error) {
			this.log('error', 'Failed to get service status', { serviceId, error });
			return {
				state: 'unknown',
				health: 'unknown'
			};
		}
	}

	async listServices(): Promise<ServiceConfig[]> {
		this.log('debug', 'Listing services');
		
		try {
			const deploymentsResponse = await this.appsV1Api.listNamespacedDeployment(this.namespace);
			
			const services: ServiceConfig[] = [];
			for (const deployment of deploymentsResponse.items) {
				const service = await this.deploymentToService(deployment);
				services.push(service);
			}
			
			return services;
		} catch (error) {
			this.log('error', 'Failed to list services', { error });
			throw error;
		}
	}

	async getServiceLogs(serviceId: string, options?: LogStreamOptions): Promise<Readable> {
		this.log('debug', 'Getting service logs', { serviceId, options });
		
		try {
			// Get pods for this deployment
			const podsResponse = await this.coreV1Api.listNamespacedPod(
				this.namespace,
				undefined,
				undefined,
				undefined,
				undefined,
				`service=${serviceId}`
			);
			
			if (podsResponse.items.length === 0) {
				throw new Error(`No pods found for service ${serviceId}`);
			}
			
			// Get logs from first pod
			const pod = podsResponse.items[0];
			const logStream = await this.coreV1Api.readNamespacedPodLog(
				pod.metadata!.name,
				this.namespace,
				undefined, // container (use default)
				options?.follow || false,
				undefined,
				undefined,
				undefined,
				undefined,
				options?.tail,
				undefined
			);
			
			// Convert response to Readable stream
			const { Readable } = await import('stream');
			const stream = new Readable();
			stream.push(logStream);
			stream.push(null);
			
			return stream;
		} catch (error) {
			this.log('error', 'Failed to get service logs', { serviceId, error });
			throw error;
		}
	}

	async executeHealthCheck(_serviceId: string): Promise<{ healthy: boolean; message?: string }> {
		throw new Error('K3s executeHealthCheck not yet implemented');
	}

	async startHealthMonitoring(_serviceId: string): Promise<void> {
		throw new Error('K3s startHealthMonitoring not yet implemented');
	}

	async stopHealthMonitoring(_serviceId: string): Promise<void> {
		throw new Error('K3s stopHealthMonitoring not yet implemented');
	}

	async getServiceMetrics(_serviceId: string): Promise<ContainerMetrics> {
		throw new Error('K3s getServiceMetrics not yet implemented');
	}

	async getAllMetrics(): Promise<ContainerMetrics[]> {
		throw new Error('K3s getAllMetrics not yet implemented');
	}

	async createNetwork(_network: NetworkConfig): Promise<void> {
		throw new Error('K3s createNetwork not yet implemented');
	}

	async removeNetwork(_networkName: string): Promise<void> {
		throw new Error('K3s removeNetwork not yet implemented');
	}

	async listNetworks(): Promise<NetworkConfig[]> {
		throw new Error('K3s listNetworks not yet implemented');
	}

	async createVolume(_volume: VolumeConfig): Promise<void> {
		throw new Error('K3s createVolume not yet implemented');
	}

	async removeVolume(_volumeName: string): Promise<void> {
		throw new Error('K3s removeVolume not yet implemented');
	}

	async listVolumes(): Promise<VolumeConfig[]> {
		throw new Error('K3s listVolumes not yet implemented');
	}
}
