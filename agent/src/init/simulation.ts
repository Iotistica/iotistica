import { LogComponents } from '../logging/types.js';
import { SimulationOrchestrator, loadSimulationConfig } from '../simulation/index.js';
import { MqttManager } from '../mqtt/manager.js';
import type { AgentInitContext } from './context.js';

export async function initializeSimulationMode(ctx: AgentInitContext): Promise<void> {
	try {
		const config = loadSimulationConfig();
		if (!config.enabled) {
			return;
		}

		const isProvisioned = ctx.deviceInfo?.provisioned && ctx.deviceInfo?.mqttBrokerConfig;
		const isDevMode = process.env.NODE_ENV === 'development' || process.env.FORCE_SIMULATION === 'true';

		if (!isProvisioned && !isDevMode) {
			ctx.agentLogger?.warnSync('Simulation Mode disabled - device not provisioned', {
				component: LogComponents.agent,
				note: 'Provision device first, or set FORCE_SIMULATION=true for testing',
			});
			return;
		}

		ctx.agentLogger?.warnSync('Initializing Simulation Mode - FOR TESTING ONLY', {
			component: LogComponents.agent,
			provisioned: isProvisioned,
			devMode: isDevMode,
		});

		ctx.simulationOrchestrator = new SimulationOrchestrator(config, {
			logger: ctx.agentLogger,
			anomalyService: ctx.anomalyService,
			mqttManager: MqttManager.getInstance(),
			deviceUuid: ctx.deviceInfo.uuid,
		});

		await ctx.simulationOrchestrator.start();
	} catch (error) {
		ctx.agentLogger?.errorSync('Failed to initialize Simulation Mode', error as Error, {
			component: LogComponents.agent,
		});
		ctx.simulationOrchestrator = undefined;
	}
}
