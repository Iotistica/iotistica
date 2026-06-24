/**
 * DOCKER MANAGER
 * ==============
 * 
 * Real Docker integration for ContainerManager
 * Handles: pulling images, creating/starting/stopping/removing containers
 */

import Docker from 'dockerode';
import { type ContainerService } from './container-manager';
import { type AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { EventEmitter } from 'events';

export interface DockerContainerInfo {
	id: string;
	name: string;
	image: string;
	state: string; // "running", "exited", etc.
	status: string;
	labels: Record<string, string>;
	ports?: Docker.Port[];
}

export interface DockerAuthConfig {
	username: string;
	password: string;
	serveraddress?: string;
	email?: string;
}

export class DockerManager extends EventEmitter {
	private docker: Docker;
	private logger?: AgentLogger;
	private eventStream?: NodeJS.ReadableStream;
	private isMonitoringEvents: boolean = false;
	private imageCache: Map<string, boolean> = new Map(); // Cache image existence checks

	constructor(dockerOptions?: Docker.DockerOptions, logger?: AgentLogger) {
		super(); // EventEmitter
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

	/**
	* Set logger (called after logger is initialized)
	*/
	public setLogger(logger: AgentLogger): void {
		this.logger = logger;
	}

	// ========================================================================
	// EVENT-DRIVEN RECONCILIATION
	// ========================================================================

	/**
	* Start monitoring Docker events for declarative reconciliation
	* 
	* Event-driven approach for edge devices:
	* - Detects crashes immediately (no polling)
	* - Auto-restarts critical services
	* - Updates internal state in real-time
	* - Works with label-based filtering
	* 
	* Emits events:
	* - 'container:start' - Container started
	* - 'container:stop' - Container stopped
	* - 'container:die' - Container crashed
	* - 'container:health' - Health status changed
	* - 'container:oom' - Out of memory killed
	*/
	async startEventMonitoring(): Promise<void> {
		if (this.isMonitoringEvents) {
			this.logger?.debugSync('Event monitoring already active', {
				component: LogComponents.dockerManager,
				operation: 'startEventMonitoring'
			});
			return;
		}

		this.logger?.infoSync('Starting Docker event monitoring', {
			component: LogComponents.dockerManager,
			operation: 'startEventMonitoring'
		});

		try {
			// Subscribe to Docker events
			this.eventStream = await this.docker.getEvents({
				filters: {
					// Only monitor containers managed by our app
					label: ['iotistic.app-id'],
					type: ['container']
				}
			});

			this.eventStream.on('data', (chunk: Buffer) => {
				try {
					const event = JSON.parse(chunk.toString());
					this.handleDockerEvent(event);
				} catch (error: any) {
					this.logger?.errorSync('Failed to parse Docker event', error, {
						component: LogComponents.dockerManager,
						operation: 'startEventMonitoring'
					});
				}
			});

			this.eventStream.on('error', (error: any) => {
				this.logger?.errorSync('Docker event stream error', error, {
					component: LogComponents.dockerManager,
					operation: 'startEventMonitoring'
				});
				this.isMonitoringEvents = false;
				// Attempt to restart monitoring after delay
				setTimeout(() => this.startEventMonitoring(), 5000);
			});

			this.eventStream.on('end', () => {
				this.logger?.warnSync('Docker event stream ended', {
					component: LogComponents.dockerManager,
					operation: 'startEventMonitoring'
				});
				this.isMonitoringEvents = false;
				// Attempt to restart monitoring
				setTimeout(() => this.startEventMonitoring(), 5000);
			});

			this.isMonitoringEvents = true;
			this.logger?.infoSync('Docker event monitoring started', {
				component: LogComponents.dockerManager,
				operation: 'startEventMonitoring'
			});
		} catch (error: any) {
			this.logger?.errorSync('Failed to start event monitoring', error, {
				component: LogComponents.dockerManager,
				operation: 'startEventMonitoring'
			});
			throw error;
		}
	}

	/**
	* Stop monitoring Docker events
	*/
	stopEventMonitoring(): void {
		if (this.eventStream) {
			this.logger?.infoSync('Stopping Docker event monitoring', {
				component: LogComponents.dockerManager,
				operation: 'stopEventMonitoring'
			});
			// Remove all listeners and unpipe to close the stream
			this.eventStream.removeAllListeners();
			if (typeof (this.eventStream as any).destroy === 'function') {
				(this.eventStream as any).destroy();
			}
			this.eventStream = undefined;
			this.isMonitoringEvents = false;
		}
	}

	/**
	* Handle Docker event and emit appropriate signals
	*/
	private handleDockerEvent(event: any): void {
		const action = event.Action as string;
		const containerId = event.Actor?.ID as string;
		const labels = event.Actor?.Attributes || {};
		const containerName = labels['name'] || 'unknown';
		const appId = labels['iotistic.app-id'];
		const serviceName = labels['iotistic.service-name'];

		// Log all events for debugging
		this.logger?.debugSync('Docker event received', {
			component: LogComponents.dockerManager,
			operation: 'handleDockerEvent',
			action,
			containerId: containerId?.substring(0, 12),
			containerName,
			appId,
			serviceName
		});

		// Handle different event types
		switch (action) {
			case 'start':
				this.logger?.infoSync('Container started', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:start', { containerId, containerName, appId, serviceName });
				break;

			case 'stop':
				this.logger?.infoSync('Container stopped', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:stop', { containerId, containerName, appId, serviceName });
				break;

			case 'die': {
				const exitCode = event.Actor?.Attributes?.exitCode;
				this.logger?.warnSync('Container died', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName,
					exitCode
				});
				this.emit('container:die', { containerId, containerName, appId, serviceName, exitCode });
				
				// Trigger auto-restart for critical services (handled by ContainerManager)
				if (exitCode !== '0') {
					this.emit('container:crash', { containerId, containerName, appId, serviceName, exitCode });
				}
				break;
			}

			case 'kill':
				this.logger?.warnSync('Container killed', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:kill', { containerId, containerName, appId, serviceName });
				break;

			case 'pause':
				this.logger?.infoSync('Container paused', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:pause', { containerId, containerName, appId, serviceName });
				break;

			case 'unpause':
				this.logger?.infoSync('Container unpaused', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:unpause', { containerId, containerName, appId, serviceName });
				break;

			case 'health_status': {
				const healthStatus = event.Actor?.Attributes?.['health_status'];
				this.logger?.infoSync('Container health status changed', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName,
					healthStatus
				});
				this.emit('container:health', { containerId, containerName, appId, serviceName, healthStatus });
				break;
			}

			case 'oom':
				this.logger?.errorSync('Container out of memory', new Error('OOM'), {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					containerId: containerId?.substring(0, 12),
					containerName
				});
				this.emit('container:oom', { containerId, containerName, appId, serviceName });
				break;

			default:
				// Log other events at debug level
				this.logger?.debugSync('Unhandled Docker event', {
					component: LogComponents.dockerManager,
					operation: 'handleDockerEvent',
					action,
					containerId: containerId?.substring(0, 12)
				});
		}
	}

	// ========================================================================
	// SECURITY VALIDATION
	// ========================================================================

	/**
	* Validate container security configuration for edge devices
	* 
	* CRITICAL: Edge devices have Docker socket access (root equivalent)
	* Must prevent container escape and privilege escalation
	* 
	* Blocked configurations:
	* - privileged: true (full root access to host)
	* - cap_add (capability additions)
	* - pid=host (access to all host processes)
	* - ipc=host (access to host IPC namespace)
	* - userns=host (bypass user namespace isolation)
	* 
	* @throws Error if configuration violates security policy
	*/
	private sanitizeNamePart(s: string): string {
		return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
	}

	private validateSecurityConfig(service: ContainerService): void {
		const violations: string[] = [];

		// Block privileged containers (full root access)
		if (service.config.privileged) {
			violations.push('privileged=true (grants full root access to host)');
		}

		// Block capability additions (privilege escalation)
		if (service.config.capAdd && service.config.capAdd.length > 0) {
			violations.push(`cap_add=${service.config.capAdd.join(',')} (capability additions blocked)`);
		}

		// Block host PID namespace (access to all host processes)
		if (service.config.pidMode === 'host') {
			violations.push('pid=host (exposes all host processes)');
		}

		// Block host IPC namespace (shared memory access)
		if (service.config.ipcMode === 'host') {
			violations.push('ipc=host (exposes host IPC namespace)');
		}

		// Block host user namespace (bypasses isolation)
		if (service.config.usernsMode === 'host') {
			violations.push('userns=host (bypasses user namespace isolation)');
		}

		if (violations.length > 0) {
			const errorMsg = `Security policy violation: ${violations.join(', ')}. Edge devices cannot run containers with elevated privileges due to Docker socket access.`;
			this.logger?.errorSync('Container security validation failed', new Error(errorMsg), {
				component: LogComponents.dockerManager,
				operation: 'validateSecurityConfig',
				serviceName: service.serviceName,
				violations
			});
			throw new Error(errorMsg);
		}

		this.logger?.debugSync('Security validation passed', {
			component: LogComponents.dockerManager,
			operation: 'validateSecurityConfig',
			serviceName: service.serviceName
		});
	}

	// ========================================================================
	// IMAGE OPERATIONS
	// ========================================================================

	/**
	* Pull an image from registry
	* @param imageName - Image name (e.g., "nginx:latest")
	* @param authConfig - Optional authentication for private registries
	*/
	async pullImage(imageName: string, authConfig?: DockerAuthConfig): Promise<void> {
		this.logger?.infoSync('Pulling Docker image', {
			component: LogComponents.dockerManager,
			operation: 'pullImage',
			imageName,
			hasAuth: !!authConfig
		});

		return new Promise((resolve, reject) => {
			const pullOptions = authConfig ? { authconfig: authConfig } : {};
			this.docker.pull(imageName, pullOptions, (err: any, stream: NodeJS.ReadableStream) => {
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
					(err: any, _output: any) => {
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
	* Pull an image with retry logic and exponential backoff
	* Critical for edge devices with flaky network connections
	* @param imageName - Image name to pull
	* @param authConfig - Optional authentication for private registries
	* @param retries - Number of retry attempts (default: 3)
	*/
	async pullImageWithRetry(
		imageName: string,
		authConfig?: DockerAuthConfig,
		retries: number = 3
	): Promise<void> {
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				if (attempt > 0) {
					this.logger?.infoSync('Retrying image pull', {
						component: LogComponents.dockerManager,
						operation: 'pullImageWithRetry',
						imageName,
						attempt: attempt + 1,
						maxRetries: retries
					});
				}
				await this.pullImage(imageName, authConfig);
				// Clear cache after successful pull
				this.imageCache.set(imageName, true);
				return; // Success
			} catch (err: any) {
				if (attempt === retries - 1) {
					// Final attempt failed
					this.logger?.errorSync('Image pull failed after all retries', err, {
						component: LogComponents.dockerManager,
						operation: 'pullImageWithRetry',
						imageName,
						attempts: retries
					});
					throw err;
				}
				
				// Exponential backoff: 2s, 4s, 6s...
				const delayMs = 2000 * (attempt + 1);
				this.logger?.warnSync('Image pull failed, retrying after delay', {
					component: LogComponents.dockerManager,
					operation: 'pullImageWithRetry',
					imageName,
					attempt: attempt + 1,
					delayMs,
					error: err.message
				});
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}
	}

	/**
	* Check if image exists locally (with caching)
	*/
	async hasImage(imageName: string): Promise<boolean> {
		// Check cache first
		if (this.imageCache.has(imageName)) {
			return this.imageCache.get(imageName)!;
		}

		try {
			const image = this.docker.getImage(imageName);
			await image.inspect();
			this.imageCache.set(imageName, true);
			return true;
		} catch (_error) {
			this.imageCache.set(imageName, false);
			return false;
		}
	}

	/**
	* Clear image cache (call after pulling images)
	*/
	clearImageCache(): void {
		this.imageCache.clear();
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
	* Find a container by name
	*/
	async findContainerByName(name: string): Promise<Docker.Container | null> {
		const containers = await this.docker.listContainers({ all: true });
		const found = containers.find(c =>
			c.Names.some(n => n === `/${name}`)
		);
		return found ? this.docker.getContainer(found.Id) : null;
	}

	/**
	* Create and start a container from a service definition
	* Idempotent: Reuses existing containers if found (crash-safe/restart-safe)
	*/
	async startContainer(service: ContainerService): Promise<string> {
		this.logger?.infoSync('Starting container', {
			component: LogComponents.dockerManager,
			operation: 'startContainer',
			serviceName: service.serviceName,
			imageName: service.imageName
		});

		try {
			// 0a. Validate security configuration (CRITICAL for edge devices)
			this.validateSecurityConfig(service);

			// 0b. Check for existing container (idempotency)
			const containerName = `${this.sanitizeNamePart(service.appName)}_${this.sanitizeNamePart(service.serviceName)}_${service.serviceId}`;
			const existing = await this.findContainerByName(containerName);
			
			if (existing) {
				const info = await existing.inspect();
				if (info.State.Running) {
					this.logger?.infoSync('Container already running, reusing existing', {
						component: LogComponents.dockerManager,
						operation: 'startContainer',
						serviceName: service.serviceName,
						containerId: info.Id.substring(0, 12),
						state: info.State.Status
					});
					return info.Id;
				} else {
					this.logger?.infoSync('Container exists but not running, starting it', {
						component: LogComponents.dockerManager,
						operation: 'startContainer',
						serviceName: service.serviceName,
						containerId: info.Id.substring(0, 12),
						state: info.State.Status
					});
					await existing.start();
					return info.Id;
				}
			}

			// 1. Ensure image exists (pull if needed, with retry for edge reliability)
			const hasImage = await this.hasImage(service.imageName);
			if (!hasImage) {
				this.logger?.infoSync('Image not found locally, pulling with retry...', {
					component: LogComponents.dockerManager,
					operation: 'startContainer',
					imageName: service.imageName
				});
				// Use retry logic for flaky edge networks
				// TODO: Support authConfig from service.config.imagePullSecrets
				await this.pullImageWithRetry(service.imageName);
			}

			// 2. Parse port bindings
			const portBindings: Docker.PortMap = {};
			const exposedPorts: Record<string, object> = {};

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

			// 4. Parse resource limits (K8s-style)
			const resourceLimits = this.parseResourceLimits(service);

			// 5. Parse health check configuration
			let healthcheck: Docker.HealthConfig | undefined;
			if (service.config.healthcheck) {
				// Use Docker native healthcheck if provided
				healthcheck = {
					Test: service.config.healthcheck.test,
					Interval: service.config.healthcheck.interval,
					Timeout: service.config.healthcheck.timeout,
					Retries: service.config.healthcheck.retries,
					StartPeriod: service.config.healthcheck.startPeriod,
				};
				this.logger?.debugSync('Using native Docker healthcheck', {
					component: LogComponents.dockerManager,
					operation: 'startContainer',
					serviceName: service.serviceName,
					test: service.config.healthcheck.test
				});
			} else if (service.config.livenessProbe) {
				// Convert K8s livenessProbe to Docker healthcheck
				healthcheck = this.convertProbeToDockerHealthcheck(service.config.livenessProbe);
				this.logger?.debugSync('Converted livenessProbe to Docker healthcheck', {
					component: LogComponents.dockerManager,
					operation: 'startContainer',
					serviceName: service.serviceName,
					probeType: service.config.livenessProbe.type
				});
			}

			// 6. Guard: Remove port bindings for incompatible network modes
			const networkMode = service.config.networkMode || 'bridge';
			if (networkMode === 'host' || networkMode.startsWith('container:')) {
				if (Object.keys(portBindings).length > 0) {
					this.logger?.warnSync('Port bindings ignored - incompatible with network mode', {
						component: LogComponents.dockerManager,
						operation: 'startContainer',
						serviceName: service.serviceName,
						networkMode,
						reason: 'Docker ignores PortBindings with host/container network modes'
					});
				}
				// Clear port configurations
				Object.keys(portBindings).forEach(key => delete portBindings[key]);
				Object.keys(exposedPorts).forEach(key => delete exposedPorts[key]);
			}

			const createOptions: Docker.ContainerCreateOptions = {
				name: containerName,
				Image: service.imageName,
				Cmd: service.config.command,
				User: service.config.user,
				StopSignal: service.config.stopSignal,
				StopTimeout: service.config.stopTimeout,
				Env: service.config.environment
					? Object.entries(service.config.environment).map(
						([key, value]) => `${key}=${value}`,
					)
					: [],
				ExposedPorts: exposedPorts,
				Healthcheck: healthcheck,
				HostConfig: {
					PortBindings: portBindings,
					Binds: binds.length > 0 ? binds : undefined,
					NetworkMode: service.config.networkMode || 'bridge',
					ReadonlyRootfs: service.config.readonlyRootfs || false,
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
	* Rename a container
	*/
	async renameContainer(containerId: string, newName: string): Promise<void> {
		this.logger?.infoSync('Renaming container', {
			component: LogComponents.dockerManager,
			operation: 'renameContainer',
			containerId: containerId.substring(0, 12),
			newName
		});

		try {
			const container = this.docker.getContainer(containerId);
			await container.rename({ name: newName });
			this.logger?.infoSync('Container renamed successfully', {
				component: LogComponents.dockerManager,
				operation: 'renameContainer',
				containerId: containerId.substring(0, 12),
				newName
			});
		} catch (error: any) {
			this.logger?.errorSync('Failed to rename container', error, {
				component: LogComponents.dockerManager,
				operation: 'renameContainer',
				containerId: containerId.substring(0, 12),
				newName
			});
			throw error;
		}
	}

	/**
	* Wait for container to become healthy
	* @param containerId - Container ID to monitor
	* @param timeoutMs - Maximum time to wait (default: 30 seconds)
	* @param intervalMs - Poll interval (default: 1 second)
	* @returns true if healthy, false if timeout
	*/
	async waitForHealthy(
		containerId: string,
		timeoutMs: number = 30000,
		intervalMs: number = 1000
	): Promise<boolean> {
		this.logger?.infoSync('Waiting for container to become healthy', {
			component: LogComponents.dockerManager,
			operation: 'waitForHealthy',
			containerId: containerId.substring(0, 12),
			timeoutMs,
			intervalMs
		});

		const startTime = Date.now();
		const container = this.docker.getContainer(containerId);

		while (Date.now() - startTime < timeoutMs) {
			try {
				const info = await container.inspect();
				
				// If container has health check, use it
				if (info.State.Health) {
					if (info.State.Health.Status === 'healthy') {
						this.logger?.infoSync('Container is healthy', {
							component: LogComponents.dockerManager,
							operation: 'waitForHealthy',
							containerId: containerId.substring(0, 12),
							elapsedMs: Date.now() - startTime
						});
						return true;
					} else if (info.State.Health.Status === 'unhealthy') {
						this.logger?.warnSync('Container is unhealthy', {
							component: LogComponents.dockerManager,
							operation: 'waitForHealthy',
							containerId: containerId.substring(0, 12),
							healthStatus: info.State.Health.Status
						});
						return false;
					}
					// Status is 'starting', continue waiting
				} else if (info.State.Running) {
					// No health check defined, just check if running
					this.logger?.infoSync('Container is running (no health check defined)', {
						component: LogComponents.dockerManager,
						operation: 'waitForHealthy',
						containerId: containerId.substring(0, 12),
						elapsedMs: Date.now() - startTime
					});
					return true;
				} else if (!info.State.Running) {
					this.logger?.errorSync('Container stopped during health check', new Error('Container not running'), {
						component: LogComponents.dockerManager,
						operation: 'waitForHealthy',
						containerId: containerId.substring(0, 12)
					});
					return false;
				}
			} catch (error: any) {
				this.logger?.errorSync('Failed to inspect container during health check', error, {
					component: LogComponents.dockerManager,
					operation: 'waitForHealthy',
					containerId: containerId.substring(0, 12)
				});
				return false;
			}

			// Wait before next check
			await new Promise(resolve => setTimeout(resolve, intervalMs));
		}

		this.logger?.warnSync('Health check timeout', {
			component: LogComponents.dockerManager,
			operation: 'waitForHealthy',
			containerId: containerId.substring(0, 12),
			timeoutMs
		});
		return false;
	}

	/**
	* Update a container with zero-downtime (blue-green deployment)
	* Critical for edge services like MQTT brokers, OPC UA simulators, gateways
	* 
	* Strategy:
	* 1. Create new container with temp name
	* 2. Wait for health check to pass
	* 3. Stop old container
	* 4. Rename new container to final name
	* 5. Remove old container
	* 
	* @param service - Service definition for new container
	* @param healthCheckTimeoutMs - Time to wait for health check (default: 30s)
	* @returns New container ID
	*/
	async updateContainer(
		service: ContainerService,
		healthCheckTimeoutMs: number = 30000
	): Promise<string> {
		const finalName = `${this.sanitizeNamePart(service.appName)}_${this.sanitizeNamePart(service.serviceName)}_${service.serviceId}`;
		const tempName = `${finalName}_new_${Date.now()}`;
		
		this.logger?.infoSync('Starting zero-downtime container update', {
			component: LogComponents.dockerManager,
			operation: 'updateContainer',
			serviceName: service.serviceName,
			finalName,
			tempName
		});

		try {
			// 0. Validate security configuration (CRITICAL for edge devices)
			this.validateSecurityConfig(service);

			// 1. Find existing container
			const oldContainer = await this.findContainerByName(finalName);
			let oldContainerId: string | undefined;
			
			if (oldContainer) {
				const oldInfo = await oldContainer.inspect();
				oldContainerId = oldInfo.Id;
				this.logger?.infoSync('Found existing container to update', {
					component: LogComponents.dockerManager,
					operation: 'updateContainer',
					oldContainerId: oldContainerId.substring(0, 12),
					state: oldInfo.State.Status
				});
			}

			// 2. Ensure image exists (pull if needed)
			const hasImage = await this.hasImage(service.imageName);
			if (!hasImage) {
				this.logger?.infoSync('Pulling new image for update', {
					component: LogComponents.dockerManager,
					operation: 'updateContainer',
					imageName: service.imageName
				});
				await this.pullImageWithRetry(service.imageName);
			}

			// 3. Create new container with temp name
			const _tempService = { ...service };
			const portBindings: Docker.PortMap = {};
			const exposedPorts: Record<string, object> = {};

			if (service.config.ports) {
				for (const portMapping of service.config.ports) {
					const portStr = typeof portMapping === 'string' ? portMapping : String(portMapping);
					const [hostPort, containerPort] = portStr.split(':');
					
					if (hostPort && containerPort) {
						const port = `${containerPort}/tcp`;
						exposedPorts[port] = {};
						portBindings[port] = [{ HostPort: hostPort }];
					}
				}
			}

			const binds: string[] = [];
			if (service.config.volumes) {
				for (const volume of service.config.volumes) {
					binds.push(volume);
				}
			}

			const resourceLimits = this.parseResourceLimits(service);

			// Guard: Remove port bindings for incompatible network modes
			const networkMode = service.config.networkMode || 'bridge';
			if (networkMode === 'host' || networkMode.startsWith('container:')) {
				if (Object.keys(portBindings).length > 0) {
					this.logger?.warnSync('Port bindings ignored - incompatible with network mode', {
						component: LogComponents.dockerManager,
						operation: 'updateContainer',
						serviceName: service.serviceName,
						networkMode,
						reason: 'Docker ignores PortBindings with host/container network modes'
					});
				}
				// Clear port configurations
				Object.keys(portBindings).forEach(key => delete portBindings[key]);
				Object.keys(exposedPorts).forEach(key => delete exposedPorts[key]);
			}

			const createOptions: Docker.ContainerCreateOptions = {
				name: tempName,
				Image: service.imageName,
				Cmd: service.config.command,
				User: service.config.user,
				StopSignal: service.config.stopSignal,
				StopTimeout: service.config.stopTimeout,
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
					ReadonlyRootfs: service.config.readonlyRootfs || false,
					RestartPolicy: {
						Name: service.config.restart || 'unless-stopped',
						MaximumRetryCount: 0,
					},
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

			const newContainer = await this.docker.createContainer(createOptions);
			const newContainerId = newContainer.id;
			
			this.logger?.infoSync('Created new container for update', {
				component: LogComponents.dockerManager,
				operation: 'updateContainer',
				newContainerId: newContainerId.substring(0, 12),
				tempName
			});

			// 4. Start new container
			await newContainer.start();
			this.logger?.infoSync('Started new container', {
				component: LogComponents.dockerManager,
				operation: 'updateContainer',
				newContainerId: newContainerId.substring(0, 12)
			});

			// 5. Wait for health check
			const isHealthy = await this.waitForHealthy(newContainerId, healthCheckTimeoutMs);
			
			if (!isHealthy) {
				this.logger?.errorSync('New container failed health check, rolling back', new Error('Health check failed'), {
					component: LogComponents.dockerManager,
					operation: 'updateContainer',
					newContainerId: newContainerId.substring(0, 12)
				});
				
				// Rollback: stop and remove new container
				try {
					await this.stopContainer(newContainerId, 5);
					await this.removeContainer(newContainerId, true);
				} catch (cleanupError: any) {
					this.logger?.warnSync('Failed to cleanup unhealthy container', {
						component: LogComponents.dockerManager,
						operation: 'updateContainer',
						error: cleanupError.message
					});
				}
				
				throw new Error('Container health check failed during update');
			}

			// 6. Stop old container (if exists)
			if (oldContainerId) {
				this.logger?.infoSync('Stopping old container', {
					component: LogComponents.dockerManager,
					operation: 'updateContainer',
					oldContainerId: oldContainerId.substring(0, 12)
				});
				
				try {
					await this.stopContainer(oldContainerId, 10);
				} catch (error: any) {
					this.logger?.warnSync('Failed to stop old container gracefully', {
						component: LogComponents.dockerManager,
						operation: 'updateContainer',
						error: error.message
					});
				}
			}

			// 7. Rename new container to final name
			await this.renameContainer(newContainerId, finalName);
			
			// 8. Remove old container (if exists)
			if (oldContainerId) {
				this.logger?.infoSync('Removing old container', {
					component: LogComponents.dockerManager,
					operation: 'updateContainer',
					oldContainerId: oldContainerId.substring(0, 12)
				});
				
				try {
					await this.removeContainer(oldContainerId, true);
				} catch (error: any) {
					this.logger?.warnSync('Failed to remove old container', {
						component: LogComponents.dockerManager,
						operation: 'updateContainer',
						error: error.message
					});
				}
			}

			this.logger?.infoSync('Zero-downtime update completed successfully', {
				component: LogComponents.dockerManager,
				operation: 'updateContainer',
				serviceName: service.serviceName,
				newContainerId: newContainerId.substring(0, 12),
				finalName
			});

			return newContainerId;
		} catch (error: any) {
			this.logger?.errorSync('Zero-downtime update failed', error, {
				component: LogComponents.dockerManager,
				operation: 'updateContainer',
				serviceName: service.serviceName
			});
			throw error;
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
	* Convert K8s-style health probe to Docker native healthcheck
	*/
	private convertProbeToDockerHealthcheck(probe: {
		type: 'http' | 'tcp' | 'exec';
		path?: string;
		port?: number;
		scheme?: 'http' | 'https';
		tcpPort?: number;
		command?: string[];
		periodSeconds?: number;
		timeoutSeconds?: number;
		failureThreshold?: number;
		initialDelaySeconds?: number;
	}): Docker.HealthConfig {
		const healthcheck: Docker.HealthConfig = {};

		// Build test command based on probe type
		if (probe.type === 'http') {
			const scheme = probe.scheme || 'http';
			const port = probe.port || 80;
			const path = probe.path || '/';
			healthcheck.Test = ['CMD-SHELL', `curl -f ${scheme}://localhost:${port}${path} || exit 1`];
		} else if (probe.type === 'tcp') {
			const port = probe.tcpPort || probe.port || 80;
			healthcheck.Test = ['CMD-SHELL', `nc -z localhost ${port} || exit 1`];
		} else if (probe.type === 'exec' && probe.command) {
			healthcheck.Test = ['CMD', ...probe.command];
		}

		// Convert seconds to nanoseconds for Docker API
		if (probe.periodSeconds) {
			healthcheck.Interval = probe.periodSeconds * 1_000_000_000;
		}
		if (probe.timeoutSeconds) {
			healthcheck.Timeout = probe.timeoutSeconds * 1_000_000_000;
		}
		if (probe.failureThreshold) {
			healthcheck.Retries = probe.failureThreshold;
		}
		if (probe.initialDelaySeconds) {
			healthcheck.StartPeriod = probe.initialDelaySeconds * 1_000_000_000;
		}

		return healthcheck;
	}

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

		// Guard: Don't mix NanoCpus (hard limit) with CpuShares (relative weight)
		// Docker docs recommend using one or the other for consistent behavior
		// Prioritize hard limits (NanoCpus) for edge device isolation
		if (hostConfig.NanoCpus && hostConfig.CpuShares) {
			this.logger?.debugSync('Removing CpuShares (conflicts with NanoCpus hard limit)', {
				component: LogComponents.dockerManager,
				operation: 'parseResourceLimits',
				serviceName: service.serviceName,
				nanocpus: hostConfig.NanoCpus,
				removedCpuShares: hostConfig.CpuShares
			});
			delete hostConfig.CpuShares;
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
		} catch (_error) {
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

