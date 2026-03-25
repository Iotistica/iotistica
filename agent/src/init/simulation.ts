import { LogComponents } from '../logging/types.js';
import { MqttManager } from '../mqtt/manager.js';
import { PublishManager } from '../features/publish/manager.js';
import { SimulationOrchestrator, loadSimulationConfig } from '../simulation/index.js';
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

		const virtualPublishers = new Map<string, PublishManager>();
		const mqttManager = MqttManager.getInstance();
		const simulationDevices = config.scenarios?.sensor_data?.devices ?? [];
		const useMsgpackPoc = process.env.USE_MSGPACK_POC === 'true';
		const useKeyCompactionPoc = process.env.USE_KEY_COMPACTION_POC === 'true';
		const useDeflatePoc = process.env.USE_DEFLATE_COMPRESSION === 'true';

		const getVirtualPublisher = (endpointTopic: string): PublishManager | undefined => {
			const existing = virtualPublishers.get(endpointTopic);
			if (existing) {
				return existing;
			}

			const simulationDevice = simulationDevices.find(device => device.endpointTopic === endpointTopic);
			if (!simulationDevice || !ctx.deviceInfo?.uuid) {
				return undefined;
			}

			const publisher = new PublishManager(
				{
					name: `${endpointTopic}-simulation`,
					enabled: true,
					addr: `simulation://${endpointTopic}`,
					addrPollSec: 10,
					publishInterval: 10000,
					eomDelimiter: '\n',
					mqttTopic: endpointTopic,
					heartbeatTimeSec: 300,
					bufferCapacity: 256 * 1024,
					bufferSize: 1,
					bufferTimeMs: 0,
				},
				mqttManager,
				undefined,
				ctx.deviceInfo.uuid,
				ctx.dictionaryManager,
				useMsgpackPoc,
				useKeyCompactionPoc,
				useDeflatePoc,
				undefined,
				ctx.anomalyService,
			);

			if (ctx.pipelineService) {
				publisher.setPipelineService(ctx.pipelineService);
			}

			virtualPublishers.set(endpointTopic, publisher);
			ctx.agentLogger?.infoSync('Initialized virtual simulation endpoint publisher', {
				component: LogComponents.sensorPublish,
				endpointTopic,
				mqttTopic: endpointTopic,
				note: 'Used when no Device Publish endpoint is currently configured',
			});

			return publisher;
		};

		ctx.simulationOrchestrator = new SimulationOrchestrator(config, {
			logger: ctx.agentLogger,
			anomalyService: ctx.anomalyService,
			publishToDeviceFeature: async (endpointTopic, message) => {
				const sensorPublish = ctx.featureInitializer?.getFeatures()?.sensorPublish;
				if (!sensorPublish) {
					const virtualPublisher = getVirtualPublisher(endpointTopic);
					if (!virtualPublisher) {
						return false;
					}

					virtualPublisher.injectSimulationMessage(message);
					return true;
				}

				return sensorPublish.publishSimulationMessage(endpointTopic, message);
			},
		});

		await ctx.simulationOrchestrator.start();
	} catch (error) {
		ctx.agentLogger?.errorSync('Failed to initialize Simulation Mode', error as Error, {
			component: LogComponents.agent,
		});
		ctx.simulationOrchestrator = undefined;
	}
}
