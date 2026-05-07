import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { ContainerService, DeviceState } from './container-manager';

interface ManagedContainerSummary {
	id: string;
	image: string;
	state: string;
	ports?: Array<{ PublicPort?: number; PrivatePort?: number }>;
	labels?: Record<string, string>;
}

interface DockerContainerInfo {
	NetworkSettings?: {
		Networks?: Record<string, unknown>;
	};
	Config?: {
		Env?: string[];
		Labels?: Record<string, string>;
	};
	Mounts?: Array<{
		Type: string;
		Name?: string;
		Source?: string;
		Destination: string;
	}>;
	HostConfig?: {
		RestartPolicy?: {
			Name?: string;
		};
		NetworkMode?: string;
	};
}

interface DockerStateSyncContext {
	dockerManager: {
		listManagedContainers: () => Promise<ManagedContainerSummary[]>;
		inspectContainer: (containerId: string) => Promise<DockerContainerInfo>;
	};
	logger?: AgentLogger;
}

function mapDockerStateToServiceState(
	dockerState: string,
): 'running' | 'stopped' | 'paused' | undefined {
	const normalized = dockerState.toLowerCase();
	if (normalized === 'running') {
		return 'running';
	}
	if (normalized === 'paused') {
		return 'paused';
	}
	if (normalized === 'exited') {
		return 'stopped';
	}
	return undefined;
}

export async function syncStateFromDocker(
	ctx: DockerStateSyncContext,
): Promise<DeviceState> {
	const containers = await ctx.dockerManager.listManagedContainers();
	const nextState: DeviceState = { apps: {} };

	for (const container of containers) {
		const containerLabels = container.labels || {};
		const appId = parseInt(containerLabels['iotistic.app-id']);
		const appName = containerLabels['iotistic.app-name'];
		const serviceId = parseInt(containerLabels['iotistic.service-id']);
		const serviceName = containerLabels['iotistic.service-name'];

		if (!nextState.apps[appId]) {
			nextState.apps[appId] = {
				appId,
				appName,
				services: [],
			};
		}

		let networks: string[] = [];
		const environment: Record<string, string> = {};
		let volumes: string[] = [];
		let restart = 'no';
		const labels: Record<string, string> = {};
		let networkMode = 'bridge';

		try {
			const containerInfo = await ctx.dockerManager.inspectContainer(container.id);

			if (containerInfo.NetworkSettings?.Networks) {
				const networkNames = Object.keys(containerInfo.NetworkSettings.Networks)
					.filter((name) => name.startsWith(`${appId}_`))
					.map((name) => name.replace(`${appId}_`, ''));
				if (networkNames.length > 0) {
					networks = networkNames;
				}
			}

			if (containerInfo.Config?.Env) {
				for (const envVar of containerInfo.Config.Env) {
					const [key, ...valueParts] = envVar.split('=');
					if (key) {
						environment[key] = valueParts.join('=');
					}
				}
			}

			if (containerInfo.Mounts) {
				volumes = containerInfo.Mounts
					.filter((mount) => mount.Type === 'volume' || mount.Type === 'bind')
					.map((mount) => {
						const source = mount.Type === 'volume' ? mount.Name : mount.Source;
						return `${source}:${mount.Destination}`;
					});
			}

			if (containerInfo.HostConfig?.RestartPolicy) {
				restart = containerInfo.HostConfig.RestartPolicy.Name || 'no';
			}

			if (containerInfo.Config?.Labels) {
				Object.entries(containerInfo.Config.Labels).forEach(([key, value]) => {
					if (key.startsWith('iotistic.') && typeof value === 'string') {
						labels[key] = value;
					}
				});
			}

			if (containerInfo.HostConfig?.NetworkMode) {
				networkMode = containerInfo.HostConfig.NetworkMode;
			}
		} catch (error) {
			ctx.logger?.warnSync('Failed to inspect container', {
				component: LogComponents.containerManager,
				operation: 'syncCurrentState',
				containerId: container.id.substring(0, 12),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const state = mapDockerStateToServiceState(container.state);
		const service: ContainerService = {
			serviceId,
			serviceName,
			imageName: container.image,
			appId,
			appName,
			containerId: container.id,
			status: container.state.toLowerCase(),
			state,
			config: {
				image: container.image,
				ports:
					container.ports && container.ports.length > 0
						? Array.from(
							new Set(
								container.ports
									.filter((p) => p.PublicPort && p.PrivatePort)
									.map((p) => `${p.PublicPort}:${p.PrivatePort}`),
							),
						)
						: [],
				volumes: volumes.length > 0 ? volumes : [],
				networks: networks.length > 0 ? networks : [],
				environment,
				restart,
				labels: Object.keys(labels).length > 0 ? labels : undefined,
				networkMode,
			},
		};

		nextState.apps[appId].services.push(service);
	}

	return nextState;
}

