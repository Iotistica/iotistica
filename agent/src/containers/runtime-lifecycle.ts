import type { AgentLogger } from '../logging/agent-logger';
import type { ContainerLogMonitor } from '../logging/container-monitor';
import { LogComponents } from '../logging/types';
import type { ContainerService, DeviceState } from './container-manager';

export interface AutoReconciliationState {
	enabled: boolean;
	interval?: NodeJS.Timeout;
}

interface AutoReconciliationContext {
	logger?: AgentLogger;
	shouldRun: () => boolean;
	onTick: () => Promise<void>;
}

export function startAutoReconciliation(
	state: AutoReconciliationState,
	ctx: AutoReconciliationContext,
	intervalMs: number,
): void {
	if (state.enabled) {
		ctx.logger?.debugSync('Auto-reconciliation already running', {
			component: LogComponents.containerManager,
			operation: 'startAutoReconciliation',
		});
		return;
	}

	state.enabled = true;
	state.interval = setInterval(async () => {
		if (!ctx.shouldRun()) {
			return;
		}

		ctx.logger?.debugSync('Auto-reconciliation check', {
			component: LogComponents.containerManager,
			operation: 'autoReconciliation',
		});

		try {
			await ctx.onTick();
		} catch (error) {
			ctx.logger?.errorSync(
				'Auto-reconciliation error',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.containerManager,
					operation: 'autoReconciliation',
				},
			);
		}
	}, intervalMs);
}

export function stopAutoReconciliation(
	state: AutoReconciliationState,
	logger?: AgentLogger,
): void {
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
		state.enabled = false;
		logger?.infoSync('Stopped auto-reconciliation', {
			component: LogComponents.containerManager,
			operation: 'stopAutoReconciliation',
		});
	}
}

export async function attachLogsToContainer(
	logMonitor: ContainerLogMonitor | undefined,
	logger: AgentLogger | undefined,
	containerId: string,
	service: ContainerService,
): Promise<void> {
	if (!logMonitor) {
		return;
	}

	try {
		if (logMonitor.isAttached(containerId)) {
			return;
		}

		await logMonitor.attach({
			containerId,
			serviceId: service.serviceId,
			serviceName: service.serviceName,
			follow: true,
			stdout: true,
			stderr: true,
		});

		logger?.debugSync('Attached log monitor', {
			component: LogComponents.containerManager,
			operation: 'attachLogs',
			serviceName: service.serviceName,
			containerId: containerId.substring(0, 12),
		});
	} catch (error) {
		logger?.warnSync('Failed to attach logs', {
			component: LogComponents.containerManager,
			operation: 'attachLogs',
			serviceName: service.serviceName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function attachLogsToAllContainers(
	logMonitor: ContainerLogMonitor | undefined,
	logger: AgentLogger | undefined,
	useRealDocker: boolean,
	currentState: DeviceState,
	attachSingle: (containerId: string, service: ContainerService) => Promise<void>,
): Promise<void> {
	if (!logMonitor || !useRealDocker) {
		return;
	}

	logger?.infoSync('Attaching logs to existing containers', {
		component: LogComponents.containerManager,
		operation: 'attachLogsToAll',
	});

	for (const app of Object.values(currentState.apps)) {
		for (const service of app.services) {
			if (service.containerId && service.status === 'running') {
				await attachSingle(service.containerId, service);
			}
		}
	}
}
