import { initDatabase } from './database.js';
import { LogComponents } from '../logging/types.js';
import type { AgentInitContext } from './context.js';

export async function initCore(ctx: AgentInitContext): Promise<void> {
	await initDatabase(ctx);
	await initializeStateReconciler(ctx);
	setupConfigEventListeners(ctx);
}

export async function initializeStateReconciler(ctx: AgentInitContext): Promise<void> {
	const { StateManager: StateManager } = await import('../managers/state.js');
	ctx.stateReconciler = new StateManager();
	await ctx.stateReconciler.init();
	ctx.configManager = ctx.stateReconciler.getConfigManager();
}

export function setupConfigEventListeners(ctx: AgentInitContext): void {
	ctx.stateReconciler?.on('features-changed', async (change: { old: any; new: any }) => {
		const logger = ctx.agentLogger;
		logger?.infoSync('Features configuration changed', {
			component: LogComponents.agent,
			changes: Object.keys(change.new).filter(key => change.old[key] !== change.new[key])
		});

		if (change.old.enableAnomalyDetection !== change.new.enableAnomalyDetection) {
			if (change.new.enableAnomalyDetection && !ctx.anomalyService) {
				logger?.infoSync('Starting Anomaly Detection Service (dynamically enabled)', {
					component: LogComponents.agent
				});
				const { initAnomalyDetection } = await import('./ai.js');
				await initAnomalyDetection(ctx);
			} else if (!change.new.enableAnomalyDetection && ctx.anomalyService) {
				logger?.infoSync('Stopping Anomaly Detection Service (dynamically disabled)', {
					component: LogComponents.agent
				});
				ctx.anomalyService.stop();
				ctx.anomalyService = undefined;
			}
		}
	});

	ctx.stateReconciler?.on('anomaly-config-changed', (change: { old: any; new: any }) => {
		const logger = ctx.agentLogger;
		logger?.infoSync('Anomaly configuration changed from cloud', {
			component: LogComponents.agent
		});

		if (ctx.anomalyService && change.new) {
			logger?.infoSync('Reloading anomaly detection configuration', {
				component: LogComponents.agent,
				metricsCount: change.new.metrics?.filter((m: any) => m.enabled).length
			});
			ctx.anomalyService.updateConfig(change.new);
		}
	});

	ctx.configManager?.on('restart-discovery-timers', () => {
		ctx.discoveryService?.startPeriodicDiscovery();
	});

	ctx.configManager?.on('schedule-restart', ({ restartTimeMs, restartConfig }: any) => {
		const logger = ctx.agentLogger;
		ctx.scheduledRestartTimer = setTimeout(async () => {
			logger?.infoSync('Initiating scheduled restart', {
				component: LogComponents.agent,
				trigger: 'scheduled_timer',
				reason: restartConfig.reason || 'heap_fragmentation_cleanup',
				memoryUsage: process.memoryUsage(),
				timestamp: new Date().toISOString()
			});

			try {
				await ctx.agent.stop();
				logger?.infoSync('Graceful shutdown complete, exiting for restart', {
					component: LogComponents.agent,
					exitCode: 0
				});
				process.exit(0);
			} catch (error) {
				logger?.errorSync(
					'Error during scheduled restart shutdown',
					error instanceof Error ? error : new Error(String(error)),
					{ component: LogComponents.agent, action: 'forcing_exit' }
				);
				process.exit(1);
			}
		}, restartTimeMs);

		ctx.scheduledRestartTimer.unref();
	});
}
