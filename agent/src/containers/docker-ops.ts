import type { ContainerLogMonitor } from '../logging/container-monitor';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import * as networkManager from './network-manager';
import { Network } from './network';
import type { ContainerService, DeviceState } from './container-manager';

export interface DockerOpsContext {
	useRealDocker: boolean;
	dockerManager: {
		pullImage: (imageName: string) => Promise<void>;
		stopContainer: (containerId: string) => Promise<void>;
		pauseContainer: (containerId: string) => Promise<void>;
		unpauseContainer: (containerId: string) => Promise<void>;
		removeContainer: (containerId: string) => Promise<void>;
		startContainer: (service: ContainerService) => Promise<string>;
	};
	logger?: AgentLogger;
	logMonitor?: ContainerLogMonitor;
	sleep: (ms: number) => Promise<void>;
	targetState: DeviceState;
	currentState: DeviceState;
}

export async function downloadImage(
	ctx: DockerOpsContext,
	imageName: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		await ctx.dockerManager.pullImage(imageName);
	} else {
		console.log(`    [SIMULATED] Downloading image: ${imageName}`);
		await ctx.sleep(100);
	}
}

export async function stopContainer(
	ctx: DockerOpsContext,
	containerId: string,
): Promise<void> {
	if (ctx.logMonitor) {
		await ctx.logMonitor.detach(containerId);
		ctx.logger?.debugSync('Detached logs before stopping container', {
			component: LogComponents.containerManager,
			operation: 'stopContainer',
			containerId: containerId.substring(0, 12),
		});
	}

	if (ctx.useRealDocker) {
		await ctx.dockerManager.stopContainer(containerId);
	} else {
		console.log(`    [SIMULATED] Stopping container: ${containerId}`);
		await ctx.sleep(50);
	}
}

export async function pauseContainer(
	ctx: DockerOpsContext,
	containerId: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		await ctx.dockerManager.pauseContainer(containerId);
	} else {
		console.log(`    [SIMULATED] Pausing container: ${containerId}`);
		await ctx.sleep(50);
	}
}

export async function unpauseContainer(
	ctx: DockerOpsContext,
	containerId: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		await ctx.dockerManager.unpauseContainer(containerId);
	} else {
		console.log(`    [SIMULATED] Unpausing container: ${containerId}`);
		await ctx.sleep(50);
	}
}

export async function removeContainer(
	ctx: DockerOpsContext,
	containerId: string,
): Promise<void> {
	if (ctx.logMonitor) {
		await ctx.logMonitor.detach(containerId);
		ctx.logger?.debugSync('Detached logs before removing container', {
			component: LogComponents.containerManager,
			operation: 'removeContainer',
			containerId: containerId.substring(0, 12),
		});
	}

	if (ctx.useRealDocker) {
		await ctx.dockerManager.removeContainer(containerId);
	} else {
		console.log(`    [SIMULATED] Removing container: ${containerId}`);
		await ctx.sleep(50);
	}
}

export async function startContainer(
	ctx: DockerOpsContext,
	service: ContainerService,
): Promise<string> {
	if (ctx.useRealDocker) {
		return await ctx.dockerManager.startContainer(service);
	}

	const containerId = `container_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	console.log(`    [SIMULATED] Starting container: ${service.serviceName}`);
	console.log(`        Container ID: ${containerId}`);
	await ctx.sleep(100);
	return containerId;
}

export async function createNetwork(
	ctx: DockerOpsContext,
	appId: number,
	networkName: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		const app = ctx.targetState.apps[appId] || ctx.currentState.apps[appId];
		const appUuid = app?.appUuid || String(appId);

		const network = Network.fromComposeObject(networkName, appId, appUuid, {
			driver: 'bridge',
		});

		await networkManager.create(network);
		ctx.logger?.infoSync('Created network', {
			component: LogComponents.containerManager,
			operation: 'createNetwork',
			networkName,
			fullName: `${appId}_${networkName}`,
			appId,
		});
	} else {
		console.log(
			`    [SIMULATED] Creating network: ${networkName} for app ${appId}`,
		);
		await ctx.sleep(50);
	}
}

export async function removeNetwork(
	ctx: DockerOpsContext,
	appId: number,
	networkName: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		const app = ctx.currentState.apps[appId];
		const appUuid = app?.appUuid || String(appId);

		const network = Network.fromComposeObject(networkName, appId, appUuid, {
			driver: 'bridge',
		});

		await networkManager.remove(network);
		ctx.logger?.infoSync('Removed network', {
			component: LogComponents.containerManager,
			operation: 'removeNetwork',
			networkName,
			fullName: `${appId}_${networkName}`,
			appId,
		});
	} else {
		console.log(
			`    [SIMULATED] Removing network: ${networkName} for app ${appId}`,
		);
		await ctx.sleep(50);
	}
}

export async function createVolume(
	ctx: DockerOpsContext,
	appId: number,
	volumeName: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		const { Volume } = await import('./volume.js');
		const appUuid = String(appId);

		const volume = Volume.fromComposeObject(volumeName, appId, appUuid, {
			driver: 'local',
			labels: {
				'iotistic.managed': 'true',
				'iotistic.app-id': String(appId),
			},
		});

		await volume.create();
		ctx.logger?.infoSync('Created volume', {
			component: LogComponents.containerManager,
			operation: 'createVolume',
			volumeName,
			fullName: `${appId}_${volumeName}`,
			appId,
		});
	} else {
		console.log(
			`    [SIMULATED] Creating volume: ${volumeName} for app ${appId}`,
		);
		await ctx.sleep(50);
	}
}

export async function removeVolume(
	ctx: DockerOpsContext,
	appId: number,
	volumeName: string,
): Promise<void> {
	if (ctx.useRealDocker) {
		const { Volume } = await import('./volume.js');
		const appUuid = String(appId);

		const volume = Volume.fromComposeObject(volumeName, appId, appUuid, {});
		await volume.remove();
		ctx.logger?.infoSync('Removed volume', {
			component: LogComponents.containerManager,
			operation: 'removeVolume',
			volumeName,
			fullName: `${appId}_${volumeName}`,
			appId,
		});
	} else {
		console.log(
			`    [SIMULATED] Removing volume: ${volumeName} for app ${appId}`,
		);
		await ctx.sleep(50);
	}
}
