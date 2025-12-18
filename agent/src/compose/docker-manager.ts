/**
 * DOCKER MANAGER
 * ==============
 * 
 * Real Docker integration for ContainerManager
 * Handles: pulling images, creating/starting/stopping/removing containers
 */

import Docker from 'dockerode';
import { ContainerService } from './container-manager';
import { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

export interface DockerContainerInfo {
	id: string;
	name: string;
	image: string;
	state: string; // "running", "exited", etc.
	status: string;
	labels: Record<string, string>;
	ports?: Docker.Port[];
}

export class DockerManager {
	private docker: Docker;
	private logger?: AgentLogger;

	constructor(dockerOptions?: Docker.DockerOptions, logger?: AgentLogger) {
		this.logger = logger;
		// Default: connect to local Docker daemon
		// Detect platform and use appropriate socket
		this.logger?.infoSync('Initializing Docker Manager', {
			component: LogComponents.dockerManager,
			operation: 'constructor',
			platform: process.platform
		});
		
		if (dockerOptions) {
			this.logger?.debugSync('Using custom Docker options', {
				component: LogComponents.dockerManager,
				operation: 'constructor'
			});
			this.docker = new Docker(dockerOptions);
		} else if (process.platform === 'win32') {
			// Windows: Explicitly use named pipe for Docker Desktop
			this.logger?.infoSync('Connecting to Docker Desktop on Windows', {
				component: LogComponents.dockerManager,
				operation: 'constructor',
				socketPath: '//./pipe/docker_engine'
			});
			this.docker = new Docker({
				socketPath: '//./pipe/docker_engine'
			});
		} else {
			// Linux/Mac: Use Unix socket
			this.logger?.infoSync('Using Unix socket', {
				component: LogComponents.dockerManager,
				operation: 'constructor',
				socketPath: '/var/run/docker.sock'
			});
			this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
		}
	}

	// ========================================================================
	// IMAGE OPERATIONS
	// ========================================================================

	/**
	 * Pull an image from registry
	 */
	async pullImage(imageName: string): Promise<void> {
		this.logger?.infoSync('Pulling Docker image', {
			component: LogComponents.dockerManager,
			operation: 'pullImage',
			imageName
		});

		return new Promise((resolve, reject) => {
			this.docker.pull(imageName, (err: any, stream: NodeJS.ReadableStream) => {
				if (err) {
					this.logger?.errorSync('Failed to pull image', err, {
						component: LogComponents.dockerManager,
						operation: 'pullImage',
						imageName
					});
					return reject(err);
				}

				// Follow progress
				this.docker.modem.followProgress(
					stream,
					(err: any, output: any) => {
						if (err) {
							this.logger?.errorSync('Image pull failed during progress', err, {
								component: LogComponents.dockerManager,
								operation: 'pullImage',
								imageName
							});
							return reject(err);
						}
						this.logger?.infoSync('Successfully pulled image', {
							component: LogComponents.dockerManager,
							operation: 'pullImage',
							imageName
						});
						resolve();
					},
					(event: any) => {
						// Progress events - can show download progress
						if (event.status === 'Downloading') {
							// Optional: show progress bar
						}
					},
				);
			});
		});
	}

	/**
	 * Check if image exists locally
	 */
	async hasImage(imageName: string): Promise<boolean> {
		try {
			const image = this.docker.getImage(imageName);
			await image.inspect();
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * List all local images
	 */
	async listImages(): Promise<Docker.ImageInfo[]> {
		return this.docker.listImages();
	}

	// ========================================================================
	// CONTAINER OPERATIONS
	// ========================================================================

	/**
	 * Create and start a container from a service definition
	 */
	async startContainer(service: ContainerService): Promise<string> {
		this.logger?.infoSync('Starting container', {
			component: LogComponents.dockerManager,
			operation: 'startContainer',
			serviceName: service.serviceName,
			imageName: service.imageName
		});

		try {
			// 1. Ensure image exists (pull if needed)
			const hasImage = await this.hasImage(service.imageName);
			if (!hasImage) {
				this.logger?.infoSync('Image not found locally, pulling...', {
					component: LogComponents.dockerManager,
					operation: 'startContainer',
					imageName: service.imageName
				});
				await this.pullImage(service.imageName);
			}

			// 2. Parse port bindings
			const portBindings: Docker.PortMap = {};
			const exposedPorts: { [port: string]: {} } = {};

			if (service.config.ports) {
				for (const portMapping of service.config.ports) {
					// Ensure portMapping is a string
					const portStr = typeof portMapping === 'string' ? portMapping : String(portMapping);
					
					if (!portStr || typeof portStr.split !== 'function') {
						this.logger?.errorSync('Invalid port mapping format', new Error('Invalid port mapping'), {
							component: LogComponents.dockerManager,
							operation: 'startContainer',
							serviceName: service.serviceName,
							portMapping: JSON.stringify(portMapping)
						});
						continue;
					}
					
					const [hostPort, containerPort] = portStr.split(':');
					
					if (!hostPort || !containerPort) {
						this.logger?.errorSync('Invalid port mapping (missing host or container port)', new Error('Invalid port mapping'), {
							component: LogComponents.dockerManager,
							operation: 'startContainer',
							serviceName: service.serviceName,
							portStr
						});
						continue;
					}
					
					const port = `${containerPort}/tcp`;
					exposedPorts[port] = {};
					portBindings[port] = [{ HostPort: hostPort }];
				}
			}

			// 3. Parse volume bindings
			const binds: string[] = [];
			if (service.config.volumes) {
				for (const volume of service.config.volumes) {
					// Format: "host-path:/container-path" or "volume-name:/container-path"
					binds.push(volume);
				}
			}

			// 4. Build container configuration
			const containerName = `${service.appName}_${service.serviceName}_${service.serviceId}`;

			// 5. Parse resource limits (K8s-style)
			const resourceLimits = this.parseResourceLimits(service);

			const createOptions: Docker.ContainerCreateOptions = {
				name: containerName,
				Image: service.imageName,
				Env: service.config.environment
					? Object.entries(service.config.environment).map(
							([key, value]) => `${key}=${value}`,
					  )
					: [],
				ExposedPorts: exposedPorts,
				HostConfig: {
					PortBindings: portBindings,
					Binds: binds.length > 0 ? binds : undefined,
					NetworkMode: service.config.networkMode || 'bridge',
					RestartPolicy: {
						Name: service.config.restart || 'unless-stopped',
						MaximumRetryCount: 0,
					},
					// Apply resource limits
					...resourceLimits,
				},
				Labels: {
					'iotistic.app-id': service.appId.toString(),
					'iotistic.app-name': service.appName,
					'iotistic.service-id': service.serviceId.toString(),
					'iotistic.service-name': service.serviceName,
					...(service.config.labels || {}),
				},
			};

			// 5. Create container
			const container = await this.docker.createContainer(createOptions);
			const containerId = container.id;
			this.logger?.infoSync('Container created', {
				component: LogComponents.dockerManager,
				operation: 'startContainer',
				serviceName: service.serviceName,
				containerId: containerId.substring(0, 12),
				imageName: service.imageName
			});
			// 6. Start container
			await container.start();

			// 7. Connect to custom networks (if specified)
			// Note: Default network already connected via NetworkMode in HostConfig
			if (service.config.networks && service.config.networks.length > 0) {
				for (const networkName of service.config.networks) {
					try {
						// Generate the Docker network name (appId_networkName)
						const dockerNetworkName = `${service.appId}_${networkName}`;
						const network = this.docker.getNetwork(dockerNetworkName);
						
						// Connect container to network
						await network.connect({
							Container: containerId,
						});
						this.logger?.debugSync('Connected container to network', {
							component: LogComponents.dockerManager,
							operation: 'startContainer',
							containerId: containerId.substring(0, 12),
							dockerNetworkName
						});
					} catch (error: any) {
						this.logger?.warnSync('Failed to connect container to network', {
							component: LogComponents.dockerManager,
							operation: 'startContainer',
							containerId: containerId.substring(0, 12),
							networkName,
							error: error.message
						});
						// Don't fail the whole operation if network connection fails
					}
				}
			}

			this.logger?.infoSync('Container started successfully', {
				component: LogComponents.dockerManager,
				operation: 'startContainer',
				serviceName: service.serviceName,
				containerId: containerId.substring(0, 12)
			});
			return containerId;
		} catch (error: any) {
			this.logger?.errorSync('Failed to start container', error, {
				component: LogComponents.dockerManager,
				operation: 'startContainer',
				serviceName: service.serviceName
			});
			throw error;
		}
	}

	/**
	 * Stop a running container
	 */
	async stopContainer(containerId: string, timeout: number = 10): Promise<void> {
		this.logger?.infoSync('Stopping container', {
			component: LogComponents.dockerManager,
			operation: 'stopContainer',
			containerId: containerId.substring(0, 12),
			timeout
		});

		try {
			const container = this.docker.getContainer(containerId);
			await container.stop({ t: timeout });
			this.logger?.infoSync('Container stopped', {
				component: LogComponents.dockerManager,
				operation: 'stopContainer',
				containerId: containerId.substring(0, 12)
			});
		} catch (error: any) {
			// Container might already be stopped
			if (error.statusCode === 304) {
				this.logger?.debugSync('Container already stopped', {
					component: LogComponents.dockerManager,
					operation: 'stopContainer',
					containerId: containerId.substring(0, 12)
				});
			} else {
				this.logger?.errorSync('Failed to stop container', error, {
					component: LogComponents.dockerManager,
					operation: 'stopContainer',
					containerId: containerId.substring(0, 12)
				});
				throw error;
			}
		}
	}

	/**
	 * Pause a container (freeze all processes)
	 */
	async pauseContainer(containerId: string): Promise<void> {
		this.logger?.infoSync('Pausing container', {
			component: LogComponents.dockerManager,
			operation: 'pauseContainer',
			containerId: containerId.substring(0, 12)
		});

		try {
			const container = this.docker.getContainer(containerId);
			await container.pause();
			this.logger?.infoSync('Container paused', {
				component: LogComponents.dockerManager,
				operation: 'pauseContainer',
				containerId: containerId.substring(0, 12)
			});
		} catch (error: any) {
			this.logger?.errorSync('Failed to pause container', error, {
				component: LogComponents.dockerManager,
				operation: 'pauseContainer',
				containerId: containerId.substring(0, 12)
			});
			throw error;
		}
	}

	/**
	 * Unpause a container (resume all processes)
	 */
	async unpauseContainer(containerId: string): Promise<void> {
		this.logger?.infoSync('Unpausing container', {
			component: LogComponents.dockerManager,
			operation: 'unpauseContainer',
			containerId: containerId.substring(0, 12)
		});

		try {
			const container = this.docker.getContainer(containerId);
			await container.unpause();
			this.logger?.infoSync('Container unpaused', {
				component: LogComponents.dockerManager,
				operation: 'unpauseContainer',
				containerId: containerId.substring(0, 12)
			});
		} catch (error: any) {
			this.logger?.errorSync('Failed to unpause container', error, {
				component: LogComponents.dockerManager,
				operation: 'unpauseContainer',
				containerId: containerId.substring(0, 12)
			});
			throw error;
		}
	}

	/**
	 * Remove a container
	 */
	async removeContainer(containerId: string, force: boolean = false): Promise<void> {
		this.logger?.infoSync('Removing container', {
			component: LogComponents.dockerManager,
			operation: 'removeContainer',
			containerId: containerId.substring(0, 12),
			force
		});

		try {
			const container = this.docker.getContainer(containerId);
			await container.remove({ force });
			this.logger?.infoSync('Container removed', {
				component: LogComponents.dockerManager,
				operation: 'removeContainer',
				containerId: containerId.substring(0, 12)
			});
		} catch (error: any) {
			// Container might already be removed
			if (error.statusCode === 404) {
				this.logger?.debugSync('Container already removed', {
					component: LogComponents.dockerManager,
					operation: 'removeContainer',
					containerId: containerId.substring(0, 12)
				});
			} else {
				this.logger?.errorSync('Failed to remove container', error, {
					component: LogComponents.dockerManager,
					operation: 'removeContainer',
					containerId: containerId.substring(0, 12)
				});
				throw error;
			}
		}
	}

	/**
	 * Get container information
	 */
	async inspectContainer(containerId: string): Promise<Docker.ContainerInspectInfo> {
		const container = this.docker.getContainer(containerId);
		return container.inspect();
	}

	/**
	 * List all containers (running and stopped)
	 */
	async listContainers(all: boolean = true): Promise<Docker.ContainerInfo[]> {
		return this.docker.listContainers({ all });
	}

	/**
	 * List containers managed by our app (filtered by labels)
	 */
	async listManagedContainers(): Promise<DockerContainerInfo[]> {
		const containers = await this.docker.listContainers({
			all: true,
			filters: {
				label: ['iotistic.app-id'],
			},
		});

		return containers.map((c) => ({
			id: c.Id,
			name: c.Names[0]?.replace(/^\//, '') || '',
			image: c.Image,
			state: c.State,
			status: c.Status,
			labels: c.Labels,
			ports: c.Ports || [],
		}));
	}

	/**
	 * Get container logs
	 */
	async getContainerLogs(
		containerId: string,
		tail: number = 100,
	): Promise<string> {
		const container = this.docker.getContainer(containerId);
		const logs = await container.logs({
			stdout: true,
			stderr: true,
			tail,
			timestamps: true,
		});
		return logs.toString();
	}

	// ========================================================================
	// NETWORK OPERATIONS (OPTIONAL)
	// ========================================================================

	/**
	 * Create a Docker network
	 */
	async createNetwork(name: string): Promise<Docker.Network> {
		this.logger?.infoSync('Creating Docker network', {
			component: LogComponents.dockerManager,
			operation: 'createNetwork',
			networkName: name
		});
		const network = await this.docker.createNetwork({
			Name: name,
			Driver: 'bridge',
			Labels: {
				'iotistic.managed': 'true',
			},
		});
		this.logger?.infoSync('Network created successfully', {
			component: LogComponents.dockerManager,
			operation: 'createNetwork',
			networkName: name
		});
		return network;
	}

	/**
	 * List all networks
	 */
	async listNetworks(): Promise<Docker.NetworkInspectInfo[]> {
		return this.docker.listNetworks();
	}

	/**
	 * Remove a network
	 */
	async removeNetwork(networkId: string): Promise<void> {
		this.logger?.infoSync('Removing Docker network', {
			component: LogComponents.dockerManager,
			operation: 'removeNetwork',
			networkId
		});
		const network = this.docker.getNetwork(networkId);
		await network.remove();
		this.logger?.infoSync('Network removed successfully', {
			component: LogComponents.dockerManager,
			operation: 'removeNetwork',
			networkId
		});
	}

	// ========================================================================
	// VOLUME OPERATIONS (OPTIONAL)
	// ========================================================================

	/**
	 * Create a Docker volume
	 */
	async createVolume(name: string): Promise<Docker.VolumeCreateResponse> {
		this.logger?.infoSync('Creating Docker volume', {
			component: LogComponents.dockerManager,
			operation: 'createVolume',
			volumeName: name
		});
		const volume = await this.docker.createVolume({
			Name: name,
			Labels: {
				'iotistic.managed': 'true',
			},
		});
		this.logger?.infoSync('Volume created successfully', {
			component: LogComponents.dockerManager,
			operation: 'createVolume',
			volumeName: name
		});
		return volume;
	}

	/**
	 * List all volumes
	 */
	async listVolumes(): Promise<Docker.VolumeInspectInfo[]> {
		const result = await this.docker.listVolumes();
		return result.Volumes;
	}

	/**
	 * Remove a volume
	 */
	async removeVolume(volumeName: string, force: boolean = false): Promise<void> {
		this.logger?.infoSync('Removing Docker volume', {
			component: LogComponents.dockerManager,
			operation: 'removeVolume',
			volumeName,
			force
		});
		const volume = this.docker.getVolume(volumeName);
		await volume.remove({ force });
		this.logger?.infoSync('Volume removed successfully', {
			component: LogComponents.dockerManager,
			operation: 'removeVolume',
			volumeName
		});
	}

	// ========================================================================
	// UTILITY
	// ========================================================================

	/**
	 * Parse K8s-style resource limits to Docker format
	 * 
	 * K8s format:
	 *   cpu: "0.5" (50% of 1 CPU), "2" (2 CPUs), "500m" (500 millicores = 0.5 CPU)
	 *   memory: "512M", "1G", "256Mi", "2Gi"
	 * 
	 * Docker format:
	 *   NanoCpus: 1000000000 = 1 CPU, 500000000 = 0.5 CPU
	 *   Memory: bytes (e.g., 536870912 = 512MB)
	 */
	private parseResourceLimits(service: ContainerService): Partial<Docker.HostConfig> {
		const hostConfig: Partial<Docker.HostConfig> = {};
		
		if (!service.config.resources) {
			return hostConfig;
		}

		// Parse CPU limits
		if (service.config.resources.limits?.cpu) {
			const cpuLimit = this.parseCpuLimit(service.config.resources.limits.cpu);
			if (cpuLimit > 0) {
				hostConfig.NanoCpus = cpuLimit;
				this.logger?.debugSync('Setting CPU limit', {
					component: LogComponents.dockerManager,
					operation: 'parseResourceLimits',
					serviceName: service.serviceName,
					cpuLimit: service.config.resources.limits.cpu,
					nanocpus: cpuLimit
				});
			}
		}

		// Parse memory limits
		if (service.config.resources.limits?.memory) {
			const memoryLimit = this.parseMemoryLimit(service.config.resources.limits.memory);
			if (memoryLimit > 0) {
				hostConfig.Memory = memoryLimit;
				this.logger?.debugSync('Setting memory limit', {
					component: LogComponents.dockerManager,
					operation: 'parseResourceLimits',
					serviceName: service.serviceName,
					memoryLimit: service.config.resources.limits.memory,
					bytes: memoryLimit
				});
			}
		}

		// Parse CPU requests (Docker doesn't have direct equivalent, but we can use CpuShares)
		// CpuShares is relative weight: 1024 = normal, 512 = half, 2048 = double
		if (service.config.resources.requests?.cpu) {
			const cpuRequest = this.parseCpuLimit(service.config.resources.requests.cpu);
			// Convert NanoCpus to CpuShares (1 CPU = 1024 shares)
			const cpuShares = Math.round((cpuRequest / 1000000000) * 1024);
			if (cpuShares > 0) {
				hostConfig.CpuShares = cpuShares;
				this.logger?.debugSync('Setting CPU request', {
					component: LogComponents.dockerManager,
					operation: 'parseResourceLimits',
					serviceName: service.serviceName,
					cpuRequest: service.config.resources.requests.cpu,
					cpuShares
				});
			}
		}

		// Parse memory requests (use as reservation)
		if (service.config.resources.requests?.memory) {
			const memoryRequest = this.parseMemoryLimit(service.config.resources.requests.memory);
			if (memoryRequest > 0) {
				hostConfig.MemoryReservation = memoryRequest;
				this.logger?.debugSync('Setting memory request', {
					component: LogComponents.dockerManager,
					operation: 'parseResourceLimits',
					serviceName: service.serviceName,
					memoryRequest: service.config.resources.requests.memory,
					bytes: memoryRequest
				});
			}
		}

		return hostConfig;
	}

	/**
	 * Parse CPU limit string to Docker NanoCpus format
	 * Examples: "0.5" -> 500000000, "2" -> 2000000000, "500m" -> 500000000
	 */
	private parseCpuLimit(cpu: string): number {
		// Handle millicores (e.g., "500m" = 0.5 CPU)
		if (cpu.endsWith('m')) {
			const millicores = parseFloat(cpu.slice(0, -1));
			return Math.round((millicores / 1000) * 1000000000);
		}
		
		// Handle decimal (e.g., "0.5" = 0.5 CPU, "2" = 2 CPUs)
		const cpuFloat = parseFloat(cpu);
		return Math.round(cpuFloat * 1000000000);
	}

	/**
	 * Parse memory limit string to bytes
	 * Examples: "512M" -> 536870912, "1G" -> 1073741824, "256Mi" -> 268435456
	 */
	private parseMemoryLimit(memory: string): number {
		const units: Record<string, number> = {
			// Decimal units (1000-based)
			'K': 1000,
			'M': 1000 * 1000,
			'G': 1000 * 1000 * 1000,
			'T': 1000 * 1000 * 1000 * 1000,
			// Binary units (1024-based, K8s standard)
			'Ki': 1024,
			'Mi': 1024 * 1024,
			'Gi': 1024 * 1024 * 1024,
			'Ti': 1024 * 1024 * 1024 * 1024,
		};

		// Try binary units first (K8s standard)
		for (const [suffix, multiplier] of Object.entries(units)) {
			if (memory.endsWith(suffix)) {
				const value = parseFloat(memory.slice(0, -suffix.length));
				return Math.round(value * multiplier);
			}
		}

		// No unit specified, assume bytes
		return parseInt(memory);
	}

	/**
	 * Check if Docker daemon is accessible
	 */
	async ping(): Promise<boolean> {
		try {
			await this.docker.ping();
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Get Docker version info
	 */
	async getVersion(): Promise<any> {
		return this.docker.version();
	}

	/**
	 * Get Docker system info
	 */
	async getInfo(): Promise<any> {
		return this.docker.info();
	}

	/**
	 * Get the Docker instance (for advanced operations)
	 */
	public getDockerInstance(): Docker {
		return this.docker;
	}
}

export default DockerManager;
