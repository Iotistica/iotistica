import { LogComponents } from '../logging/types.js';
import { loadSimulationModule } from '../pro/loader.js';
import type { AgentInitContext } from './context.js';

export async function initSimulationMode(ctx: AgentInitContext): Promise<void> {
	const pro = await loadSimulationModule();

	if (!pro) {
		ctx.agentLogger?.debugSync('Simulation mode requires Iotistica Agent Pro', {
			component: LogComponents.agent,
		});
		ctx.simulationOrchestrator = undefined;
		return;
	}

	const config = pro.loadSimulationConfig();

	if (!config.enabled) {
		ctx.agentLogger?.debugSync('Simulation mode disabled by environment', {
			component: LogComponents.agent,
		});
		ctx.simulationOrchestrator = undefined;
		return;
	}

	if (!ctx.anomalyService) {
		ctx.agentLogger?.warnSync('Simulation mode requested but anomaly service is unavailable', {
			component: LogComponents.agent,
			note: 'Simulation requires anomaly detection to be initialized first',
		});
		ctx.simulationOrchestrator = undefined;
		return;
	}

	if (ctx.simulationOrchestrator) {
		ctx.agentLogger?.infoSync('Stopping existing simulation orchestrator before reinitializing', {
			component: LogComponents.agent,
		});
		await ctx.simulationOrchestrator.stop();
		ctx.simulationOrchestrator = undefined;
	}

	ctx.agentLogger?.warnSync('Initializing simulation mode', {
		component: LogComponents.agent,
		enabled: config.enabled,
		scenarios: Object.keys(config.scenarios || {}),
		anomalyInjection: config.scenarios?.anomaly_injection
			? {
				mode: config.scenarios.anomaly_injection.mode || 'inject',
				pattern: config.scenarios.anomaly_injection.pattern,
				metrics: config.scenarios.anomaly_injection.metrics,
				intervalMs: config.scenarios.anomaly_injection.intervalMs,
			}
			: undefined,
	});

	const orchestrator = new pro.SimulationOrchestrator(config, {
		logger: ctx.agentLogger,
		anomalyService: ctx.anomalyService,
	});

	ctx.simulationOrchestrator = orchestrator;
	await orchestrator.start();

	ctx.agentLogger?.infoSync('Simulation mode initialized', {
		component: LogComponents.agent,
		status: orchestrator.getStatus(),
	});
}
