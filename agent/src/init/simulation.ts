import { LogComponents } from '../logging/types.js';
import { SimulationOrchestrator, loadSimulationConfig } from '../simulation/index.js';
import { MqttManager } from '../mqtt/manager.js';

export async function initializeSimulationMode(agent: any): Promise<void> {
	try {
		const config = loadSimulationConfig();
		if (!config.enabled) {
			return;
		}

		const isProvisioned = agent.deviceInfo.provisioned && agent.deviceInfo.mqttBrokerConfig;
		const isDevMode = process.env.NODE_ENV === 'development' || process.env.FORCE_SIMULATION === 'true';

		if (!isProvisioned && !isDevMode) {
			agent.agentLogger?.warnSync('Simulation Mode disabled - device not provisioned', {
				component: LogComponents.agent,
				note: 'Provision device first, or set FORCE_SIMULATION=true for testing',
			});
			return;
		}

		agent.agentLogger?.warnSync('Initializing Simulation Mode - FOR TESTING ONLY', {
			component: LogComponents.agent,
			provisioned: isProvisioned,
			devMode: isDevMode,
		});

		agent.simulationOrchestrator = new SimulationOrchestrator(config, {
			logger: agent.agentLogger,
			anomalyService: agent.anomalyService,
			mqttManager: MqttManager.getInstance(),
			deviceUuid: agent.deviceInfo.uuid,
		});

		await agent.simulationOrchestrator.start();
	} catch (error) {
		agent.agentLogger?.errorSync('Failed to initialize Simulation Mode', error as Error, {
			component: LogComponents.agent,
		});
		agent.simulationOrchestrator = undefined;
	}
}
