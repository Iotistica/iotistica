import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { RetryManager } from './retry-manager';
import type { ContainerService, DeviceState } from './container-manager';

interface StateHelpersContext {
	currentState: DeviceState;
	targetState: DeviceState;
	retryManager: RetryManager;
	logger?: AgentLogger;
}

export type ServiceErrorType =
	| 'ImagePullBackOff'
	| 'ErrImagePull'
	| 'StartFailure'
	| 'CrashLoopBackOff';

export function markServiceAsError(
	ctx: StateHelpersContext,
	appId: number,
	serviceIdOrImage: number | string,
	errorType: ServiceErrorType,
	message: string,
): void {
	const app = ctx.currentState.apps[appId] || ctx.targetState.apps[appId];
	if (!app) {
		ctx.logger?.warnSync('Cannot mark error: app not found', {
			component: LogComponents.containerManager,
			operation: 'markServiceAsError',
			appId,
		});
		return;
	}

	const service =
		typeof serviceIdOrImage === 'number'
			? app.services.find((s) => s.serviceId === serviceIdOrImage)
			: app.services.find((s) => s.imageName === serviceIdOrImage);

	if (!service) {
		ctx.logger?.warnSync('Cannot mark error: service not found', {
			component: LogComponents.containerManager,
			operation: 'markServiceAsError',
			serviceIdOrImage,
		});
		return;
	}

	const retryKey =
		typeof serviceIdOrImage === 'number'
			? `service:${appId}:${serviceIdOrImage}`
			: `image:${serviceIdOrImage}`;

	const retryState = ctx.retryManager.getState(retryKey);

	service.serviceStatus = 'error';
	service.error = {
		type: errorType,
		message,
		timestamp: new Date().toISOString(),
		retryCount: retryState?.count || 0,
		nextRetry: retryState?.nextRetry?.toISOString(),
	};

	ctx.logger?.warnSync('Marked service as error', {
		component: LogComponents.containerManager,
		operation: 'markServiceAsError',
		serviceName: service.serviceName,
		errorType,
		message,
		retryCount: service.error.retryCount,
		nextRetry: service.error.nextRetry,
	});
}

export function markServiceAsRunning(
	ctx: StateHelpersContext,
	appId: number,
	serviceId: number,
): void {
	const app = ctx.currentState.apps[appId];
	if (!app) {
		return;
	}

	const service = app.services.find((s) => s.serviceId === serviceId);
	if (service) {
		service.serviceStatus = 'running';
		delete service.error;
		ctx.logger?.debugSync('Service marked as running', {
			component: LogComponents.containerManager,
			operation: 'markServiceAsRunning',
			serviceName: service.serviceName,
		});
	}
}

export function removeServiceFromCurrentState(
	ctx: StateHelpersContext,
	appId: number,
	serviceId: number,
): void {
	const app = ctx.currentState.apps[appId];
	if (app) {
		app.services = app.services.filter((s) => s.serviceId !== serviceId);
		if (app.services.length === 0) {
			delete ctx.currentState.apps[appId];
		}
	}
}

export function addServiceToCurrentState(
	ctx: StateHelpersContext,
	appId: number,
	service: ContainerService,
	containerId: string,
): void {
	if (!ctx.currentState.apps[appId]) {
		ctx.currentState.apps[appId] = {
			appId,
			appName: service.appName,
			services: [],
		};
	}

	const serviceWithContainer: ContainerService = {
		...service,
		containerId,
		status: 'running',
	};

	ctx.currentState.apps[appId].services.push(serviceWithContainer);
}

export function updateServiceState(
	ctx: StateHelpersContext,
	appId: number,
	serviceId: number,
	state: 'running' | 'stopped' | 'paused',
): void {
	const app = ctx.currentState.apps[appId];
	if (app) {
		const service = app.services.find((s) => s.serviceId === serviceId);
		if (service) {
			service.state = state;
			ctx.logger?.debugSync('Updated service state in current state', {
				component: LogComponents.containerManager,
				operation: 'updateServiceState',
				serviceName: service.serviceName,
				newState: state,
			});
		}
	}
}
