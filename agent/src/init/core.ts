import { initDatabase } from './database.js';
import { LogComponents } from '../logging/types.js';
import type { AgentInitContext } from './context.js';

export async function initCore(ctx: AgentInitContext): Promise<void> {
	await initDatabase(ctx);
	await initializeStateReconciler(ctx);
	setupConfigEventListeners(ctx);
}

export async function initializeStateReconciler(ctx: AgentInitContext): Promise<void> {
	const { StateManager: StateManager } = await import('../agent/state.js');
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
				const { initAnomalyDetection } = await import('./anomaly.js');
				await initAnomalyDetection(ctx);

				// Simulation init runs before target state is available (in features.ts).
				// Now that anomaly detection is up, re-run simulation init so it can
				// attach to the anomaly service correctly.
				if (ctx.anomalyService && !ctx.simulationOrchestrator) {
					const { initSimulationMode } = await import('./simulation.js');
					await initSimulationMode(ctx);
				}
			} else if (!change.new.enableAnomalyDetection && ctx.anomalyService) {
				logger?.infoSync('Stopping Anomaly Detection Service (dynamically disabled)', {
					component: LogComponents.agent
				});
				ctx.anomalyService.stop();
				ctx.anomalyService = undefined;
				ctx.featureInitializer?.setAnomalyService?.(undefined);
			}
		}

		if (change.old.enableDeviceSensorPublish !== change.new.enableDeviceSensorPublish) {
			if (!change.new.enableDeviceSensorPublish) {
				logger?.infoSync('Stopping Device Publish Feature (dynamically disabled)', {
					component: LogComponents.agent
				});

				try {
					const devicePublish = ctx.featureInitializer?.getFeatures()?.devicePublish;
					if (devicePublish) {
						await devicePublish.stop();
						ctx.featureInitializer!.getFeatures().devicePublish = undefined;
					}
				} catch (error) {
					logger?.errorSync(
						'Failed to stop Device Publish Feature while disabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			} else {
				logger?.infoSync('Starting Device Publish Feature (dynamically enabled)', {
					component: LogComponents.agent
				});

				try {
					await ctx.featureInitializer?.initDevicePublish();
				} catch (error) {
					logger?.errorSync(
						'Failed to start Device Publish Feature while enabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			}
		}

		if (change.old.enableDeviceRemoteAccess !== change.new.enableDeviceRemoteAccess) {
			if (!change.new.enableDeviceRemoteAccess) {
				logger?.infoSync('Stopping Shell Handler (dynamically disabled)', {
					component: LogComponents.agent
				});

				try {
					const shellHandler = ctx.featureInitializer?.getFeatures()?.shellHandler;
					if (shellHandler) {
						await shellHandler.cleanup();
						ctx.featureInitializer!.getFeatures().shellHandler = undefined;
					}
				} catch (error) {
					logger?.errorSync(
						'Failed to stop Shell Handler while disabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			} else {
				logger?.infoSync('Starting Shell Handler (dynamically enabled)', {
					component: LogComponents.agent
				});

				try {
					await ctx.featureInitializer?.initShellHandler();
				} catch (error) {
					logger?.errorSync(
						'Failed to start Shell Handler while enabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
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
