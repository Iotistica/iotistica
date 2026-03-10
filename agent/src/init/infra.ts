import type { AgentInitContext } from './core.js';
import { LogComponents } from '../logging/types.js';
import { MqttManager } from '../mqtt/manager.js';

export async function initInfrastructure(ctx: AgentInitContext): Promise<void> {
	await Promise.all([
		initializeMqttManager(ctx.self),
		initContainerManager(ctx.self),
	]);

	await initDeviceAPI(ctx.self);
}

export async function initializeMqttManager(agent: any): Promise<void> {
	try {
		if (!agent.deviceInfo.mqttBrokerConfig) {
			agent.agentLogger.debugSync('MQTT disabled - device not provisioned with broker config', {
				component: LogComponents.agent,
				note: 'Provision device to enable MQTT',
			});
			return;
		}

		const config = agent.deviceInfo.mqttBrokerConfig;
		const mqttBrokerUrl = `${config.protocol || 'mqtt'}://${config.host}:${config.port}`;
		const mqttManager = MqttManager.getInstance();

		mqttManager.setLogger(agent.agentLogger);

		agent.agentLogger.debugSync('Mqtt broker config', {
			component: LogComponents.agent,
			operation: 'mqtt-init',
			configKeys: Object.keys(config),
			protocol: config.protocol,
			host: config.host,
			port: config.port,
			useTls: config.useTls,
			verifyCertificate: config.verifyCertificate,
			hasCaCert: !!config.caCert,
			hasUsername: !!config.username,
			hasPassword: !!config.password
		});

		const mqttOptions: any = {
			clientId: config.clientIdPrefix ? `${config.clientIdPrefix}_${agent.deviceInfo.uuid}` : `device_${agent.deviceInfo.uuid}`,
			clean: config.cleanSession ?? true,
			reconnectPeriod: config.reconnectPeriod ?? 5000,
			keepalive: config.keepAlive ?? 60,
			connectTimeout: config.connectTimeout ?? 30000,
			username: config.username,
			password: config.password,
		};

		if (config.useTls) {
			const hasCaCert = !!config.caCert;
			const rejectUnauthorized = hasCaCert ? (config.verifyCertificate ?? true) : false;
			mqttOptions.rejectUnauthorized = rejectUnauthorized;

			if (config.caCert) {
				const caCert = config.caCert.replace(/\\n/g, '\n');
				mqttOptions.ca = caCert;
			}

			agent.agentLogger.infoSync('MQTT TLS enabled', {
				component: LogComponents.agent,
				protocol: config.protocol,
				verifyCertificate: config.verifyCertificate,
				hasCaCert,
				rejectUnauthorized,
			});
		}

		await mqttManager.connect(mqttBrokerUrl, mqttOptions, agent.deviceInfo.uuid, {
			bufferSync: true,
		});

		if (process.env.MQTT_DEBUG === 'true') {
			mqttManager.setDebug(true);
		}

		agent.agentLogger.infoSync('MQTT Manager connected', {
			component: LogComponents.agent,
			brokerUrl: mqttBrokerUrl,
			clientId: `agent_${agent.deviceInfo.uuid}`,
			username: config.username || '(none)',
			debugMode: process.env.MQTT_DEBUG === 'true',
			totalLogBackends: agent.agentLogger.getBackends().length,
		});

		await initializeDictionaryManager(agent);
	} catch (error) {
		agent.agentLogger.errorSync(
			'Failed to initialize MQTT Manager',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
				note: 'MQTT features will be unavailable',
			}
		);
	}
}

export async function initializeDictionaryManager(agent: any): Promise<void> {
	if (process.env.USE_KEY_COMPACTION_POC !== 'true') {
		agent.agentLogger?.debugSync('Dictionary compaction disabled (USE_KEY_COMPACTION_POC != true)', {
			component: LogComponents.mqtt,
		});
		return;
	}

	try {
		const { DictionaryManager } = await import('../dictionary/manager.js');
		const mqttManager = MqttManager.getInstance();

		agent.dictionaryManager = new DictionaryManager(mqttManager, agent.agentLogger, agent.deviceInfo.uuid);
		await agent.dictionaryManager.initialize();

		agent.agentLogger?.infoSync('Dictionary Manager initialized', {
			component: LogComponents.mqtt,
			deviceUuid: agent.deviceInfo.uuid,
		});
	} catch (error) {
		agent.agentLogger?.errorSync(
			'Failed to initialize Dictionary Manager',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
				note: 'Dictionary compaction will be unavailable',
			}
		);
	}
}

export async function initContainerManager(agent: any): Promise<void> {
	agent.containerManager = agent.stateReconciler.getContainerManager();

	const docker = agent.containerManager.getDocker();
	if (docker) {
		agent.logMonitor = new (await import('../logging/docker-monitor.js')).ContainerLogMonitor(docker, agent.agentLogger);
		agent.containerManager.setLogMonitor(agent.logMonitor);
		await agent.containerManager.attachLogsToAllContainers();
		agent.agentLogger.debugSync('Log monitor attached to container manager', {
			component: LogComponents.agent,
			backendCount: agent.agentLogger.getBackends().length,
		});
	}

	agent.agentLogger?.infoSync('Container manager setup complete', {
		component: LogComponents.agent,
	});
}

export async function initDeviceAPI(agent: any): Promise<void> {
	if (agent.deviceAPI) {
		agent.agentLogger?.infoSync('Device API already running, skipping initialization', {
			component: LogComponents.agent,
		});
		return;
	}

	const { router: v1Router } = await import('../api/v1.js');
	const { DeviceAPI } = await import('../api/index.js');
	const { healthcheck: memoryHealthcheck, setMemoryLogger } = await import('../system/memory.js');

	const healthchecks = [
		async () => {
			try {
				agent.containerManager.getStatus();
				return true;
			} catch {
				return false;
			}
		},
		async () => {
			setMemoryLogger(agent.agentLogger);
			return memoryHealthcheck();
		},
	];

	agent.deviceAPI = new DeviceAPI({
		routers: [v1Router],
		healthchecks,
		logger: agent.agentLogger,
	});

	await agent.deviceAPI.listen(agent.configManager.getDeviceApiPort());
	agent.agentLogger?.infoSync('Device API started', {
		component: LogComponents.agent,
		port: agent.configManager.getDeviceApiPort(),
	});
}
