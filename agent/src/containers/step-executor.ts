import type { AppStep, ContainerService } from './container-manager';
import type { RetryManager } from './retry-manager';
import type { HealthCheckManager } from './health-check-manager';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

interface StepExecutorContext {
	retryManager: RetryManager;
	healthCheckManager: HealthCheckManager;
	logger?: AgentLogger;
	getServiceFromCurrentState: (
		appId: number,
		serviceId: number,
	) => ContainerService | undefined;
	markServiceAsError: (
		appId: number,
		serviceIdOrImage: number | string,
		errorType:
			| 'ImagePullBackOff'
			| 'ErrImagePull'
			| 'StartFailure'
			| 'CrashLoopBackOff',
		message: string,
	) => void;
	updateServiceState: (
		appId: number,
		serviceId: number,
		state: 'running' | 'stopped' | 'paused',
	) => void;
	markServiceAsRunning: (appId: number, serviceId: number) => void;
	addServiceToCurrentState: (
		appId: number,
		service: ContainerService,
		containerId: string,
	) => void;
	removeServiceFromCurrentState: (appId: number, serviceId: number) => void;
	downloadImage: (imageName: string) => Promise<void>;
	createNetwork: (appId: number, networkName: string) => Promise<void>;
	stopContainer: (containerId: string) => Promise<void>;
	pauseContainer: (containerId: string) => Promise<void>;
	unpauseContainer: (containerId: string) => Promise<void>;
	removeContainer: (containerId: string) => Promise<void>;
	startContainer: (service: ContainerService) => Promise<string>;
	attachLogsToContainer: (
		containerId: string,
		service: ContainerService,
	) => Promise<void>;
	startHealthMonitoring: (
		containerId: string,
		service: ContainerService,
	) => void;
	removeNetwork: (appId: number, networkName: string) => Promise<void>;
	createVolume: (appId: number, volumeName: string) => Promise<void>;
	removeVolume: (appId: number, volumeName: string) => Promise<void>;
}

export function getStepKey(step: AppStep): string {
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
		case 'removeVolume':
			return `volume:${step.appId}:${step.volumeName}`;
		case 'createNetwork':
			return `network:${step.appId}:${step.networkName}`;
		case 'removeNetwork':
			return `network:${step.appId}:${step.networkName}`;
		case 'noop':
			return 'noop';
		default: {
			const exhaustiveCheck: never = step;
			return `unknown:${(exhaustiveCheck as { action: string }).action}`;
		}
	}
}

export async function executeStep(
	step: AppStep,
	ctx: StepExecutorContext,
): Promise<void> {
	const stepKey = getStepKey(step);

	switch (step.action) {
		case 'downloadImage': {
			if (!ctx.retryManager.shouldRetry(stepKey)) {
				ctx.logger?.warnSync('Skipping image - max retries exceeded', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					imageName: step.imageName,
				});
				ctx.markServiceAsError(
					step.appId,
					step.imageName,
					'ImagePullBackOff',
					'Max retries exceeded',
				);
				throw new Error(`Max retries exceeded for ${step.imageName}`);
			}

			try {
				await ctx.downloadImage(step.imageName);
				ctx.retryManager.recordSuccess(stepKey);
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to pull image',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						imageName: step.imageName,
					},
				);
				ctx.retryManager.recordFailure(stepKey, error.message);
				ctx.markServiceAsError(
					step.appId,
					step.imageName,
					'ImagePullBackOff',
					error.message,
				);
				throw error;
			}
			break;
		}

		case 'createNetwork':
			await ctx.createNetwork(step.appId, step.networkName);
			break;

		case 'stopContainer':
			await ctx.stopContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'stopped');
			ctx.healthCheckManager.stopMonitoring(step.containerId);
			break;

		case 'pauseContainer':
			await ctx.pauseContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'paused');
			ctx.logger?.infoSync('Container paused', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});
			break;

		case 'unpauseContainer':
			await ctx.unpauseContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'running');
			ctx.logger?.infoSync('Container unpaused', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});
			break;

		case 'startStoppedContainer': {
			ctx.logger?.infoSync('Restarting stopped container (remove + recreate)', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});

			try {
				const service = ctx.getServiceFromCurrentState(step.appId, step.serviceId);
				if (!service) {
					throw new Error(`Service ${step.serviceId} not found in current state`);
				}

				ctx.healthCheckManager.stopMonitoring(step.containerId);
				await ctx.removeContainer(step.containerId);
				ctx.removeServiceFromCurrentState(step.appId, step.serviceId);

				const newContainerId = await ctx.startContainer(service);
				ctx.addServiceToCurrentState(step.appId, service, newContainerId);
				ctx.markServiceAsRunning(step.appId, step.serviceId);
				await ctx.attachLogsToContainer(newContainerId, service);
				ctx.startHealthMonitoring(newContainerId, service);

				ctx.logger?.infoSync('Stopped container restarted successfully', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					oldContainerId: step.containerId.substring(0, 12),
					newContainerId: newContainerId.substring(0, 12),
					serviceId: step.serviceId,
				});
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to restart stopped container',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						containerId: step.containerId,
						serviceId: step.serviceId,
					},
				);
				ctx.markServiceAsError(
					step.appId,
					step.serviceId,
					'StartFailure',
					error.message,
				);
				throw error;
			}
			break;
		}

		case 'removeContainer':
			await ctx.removeContainer(step.containerId);
			ctx.removeServiceFromCurrentState(step.appId, step.serviceId);
			ctx.healthCheckManager.stopMonitoring(step.containerId);
			break;

		case 'startContainer': {
			try {
				const containerId = await ctx.startContainer(step.service);
				ctx.addServiceToCurrentState(step.appId, step.service, containerId);
				ctx.markServiceAsRunning(step.appId, step.service.serviceId);
				await ctx.attachLogsToContainer(containerId, step.service);
				ctx.startHealthMonitoring(containerId, step.service);
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to start container',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						serviceName: step.service.serviceName,
					},
				);
				ctx.markServiceAsError(
					step.appId,
					step.service.serviceId,
					'StartFailure',
					error.message,
				);
				throw error;
			}
			break;
		}

		case 'removeNetwork':
			await ctx.removeNetwork(step.appId, step.networkName);
			break;

		case 'createVolume':
			await ctx.createVolume(step.appId, step.volumeName);
			break;

		case 'removeVolume':
			await ctx.removeVolume(step.appId, step.volumeName);
			break;

		case 'noop':
			break;
	}
}
