import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { ContainerHealthProbe as HealthProbe } from './types';
import type { ContainerService, DeviceState } from './container-manager';

interface RuntimeHealthContext {
	healthCheckManager: {
		startMonitoring: (config: {
			containerId: string;
			serviceName: string;
			livenessProbe?: HealthProbe;
			readinessProbe?: HealthProbe;
			startupProbe?: HealthProbe;
		}) => void;
		stopMonitoring: (containerId: string) => void;
	};
	logger?: AgentLogger;
	currentState: DeviceState;
	stopContainer: (containerId: string) => Promise<void>;
	removeContainer: (containerId: string) => Promise<void>;
	startContainer: (service: ContainerService) => Promise<string>;
	removeServiceFromCurrentState: (appId: number, serviceId: number) => void;
	addServiceToCurrentState: (
		appId: number,
		service: ContainerService,
		containerId: string,
	) => void;
	attachLogsToContainer: (
		containerId: string,
		service: ContainerService,
	) => Promise<void>;
}

export function convertToHealthProbe(probe: any): HealthProbe {
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

export function startHealthMonitoring(
	ctx: RuntimeHealthContext,
	containerId: string,
	service: ContainerService,
): void {
	const { livenessProbe, readinessProbe, startupProbe } = service.config;
	if (!livenessProbe && !readinessProbe && !startupProbe) {
		return;
	}

	ctx.logger?.infoSync('Starting health monitoring', {
		component: LogComponents.containerManager,
		operation: 'startHealthMonitoring',
		serviceName: service.serviceName,
		containerId: containerId.slice(0, 12),
		hasLiveness: !!livenessProbe,
		hasReadiness: !!readinessProbe,
		hasStartup: !!startupProbe,
	});

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
		config.livenessProbe = convertToHealthProbe(livenessProbe);
	}
	if (readinessProbe) {
		config.readinessProbe = convertToHealthProbe(readinessProbe);
	}
	if (startupProbe) {
		config.startupProbe = convertToHealthProbe(startupProbe);
	}

	ctx.healthCheckManager.startMonitoring(config);
}

export async function restartUnhealthyContainer(
	ctx: RuntimeHealthContext,
	containerId: string,
	serviceName: string,
	message?: string,
): Promise<void> {
	ctx.logger?.infoSync('Restarting unhealthy container', {
		component: LogComponents.containerManager,
		operation: 'restartUnhealthy',
		serviceName,
		containerId: containerId.substring(0, 12),
		reason: message || 'liveness check failed',
	});

	try {
		let targetService: ContainerService | undefined;
		let targetAppId: number | undefined;

		for (const app of Object.values(ctx.currentState.apps)) {
			for (const service of app.services) {
				if (service.containerId === containerId) {
					targetService = service;
					targetAppId = app.appId;
					break;
				}
			}
			if (targetService) {
				break;
			}
		}

		if (!targetService || targetAppId === undefined) {
			ctx.logger?.errorSync(
				'Cannot restart container - service not found in current state',
				new Error('Service not found'),
				{
					component: LogComponents.containerManager,
					operation: 'restartUnhealthy',
					containerId: containerId.substring(0, 12),
				},
			);
			return;
		}

		ctx.healthCheckManager.stopMonitoring(containerId);
		await ctx.stopContainer(containerId);
		await ctx.removeContainer(containerId);

		const newContainerId = await ctx.startContainer(targetService);
		ctx.removeServiceFromCurrentState(targetAppId, targetService.serviceId);
		ctx.addServiceToCurrentState(targetAppId, targetService, newContainerId);
		startHealthMonitoring(ctx, newContainerId, targetService);
		await ctx.attachLogsToContainer(newContainerId, targetService);

		ctx.logger?.infoSync('Container restarted successfully', {
			component: LogComponents.containerManager,
			operation: 'restartUnhealthy',
			serviceName,
			oldContainerId: containerId.substring(0, 12),
			newContainerId: newContainerId.slice(0, 12),
		});
	} catch (error) {
		ctx.logger?.errorSync(
			'Failed to restart unhealthy container',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.containerManager,
				operation: 'restartUnhealthy',
				serviceName,
			},
		);
	}
}
