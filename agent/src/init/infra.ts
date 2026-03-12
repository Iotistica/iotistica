import type { AgentInitContext } from './context.js';
import { LogComponents } from '../logging/types.js';
import { MqttManager } from '../mqtt/manager.js';

export async function initInfrastructure(ctx: AgentInitContext): Promise<void> {
	await Promise.all([
		initializeMqttManager(ctx),
		initContainerManager(ctx),
	]);

	await initDeviceAPI(ctx);
}

export async function initializeMqttManager(ctx: AgentInitContext): Promise<void> {
	try {
		if (!ctx.deviceInfo?.mqttBrokerConfig) {
			ctx.agentLogger?.debugSync('MQTT disabled - device not provisioned with broker config', {
				component: LogComponents.agent,
				note: 'Provision device to enable MQTT',
			});
			return;
		}

		const config = ctx.deviceInfo.mqttBrokerConfig;
		const mqttBrokerUrl = `${config.protocol || 'mqtt'}://${config.host}:${config.port}`;
		const mqttManager = MqttManager.getInstance();

		mqttManager.setLogger(ctx.agentLogger!);

		ctx.agentLogger?.debugSync('Mqtt broker config', {
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
			clientId: config.clientIdPrefix ? `${config.clientIdPrefix}_${ctx.deviceInfo.uuid}` : `device_${ctx.deviceInfo.uuid}`,
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

			ctx.agentLogger?.infoSync('MQTT TLS enabled', {
				component: LogComponents.agent,
				protocol: config.protocol,
				verifyCertificate: config.verifyCertificate,
				hasCaCert,
				rejectUnauthorized,
			});
		}

		await mqttManager.connect(mqttBrokerUrl, mqttOptions, ctx.deviceInfo.uuid, {
			bufferSync: true,
		});

		if (process.env.MQTT_DEBUG === 'true') {
			mqttManager.setDebug(true);
		}

		ctx.agentLogger?.infoSync('MQTT Manager connected', {
			component: LogComponents.agent,
			brokerUrl: mqttBrokerUrl,
			clientId: `agent_${ctx.deviceInfo.uuid}`,
			username: config.username || '(none)',
			debugMode: process.env.MQTT_DEBUG === 'true',
			totalLogBackends: ctx.agentLogger?.getBackends().length,
		});

		await initializeDictionaryManager(ctx);
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize MQTT Manager',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
				note: 'MQTT features will be unavailable',
			}
		);
	}
}

export async function initializeDictionaryManager(ctx: AgentInitContext): Promise<void> {
	if (process.env.USE_KEY_COMPACTION_POC !== 'true') {
		ctx.agentLogger?.debugSync('Dictionary compaction disabled (USE_KEY_COMPACTION_POC != true)', {
			component: LogComponents.mqtt,
		});
		return;
	}

	try {
		const { DictionaryManager } = await import('../managers/dictionary.js');
		const mqttManager = MqttManager.getInstance();

		ctx.dictionaryManager = new DictionaryManager(mqttManager, ctx.agentLogger, ctx.deviceInfo.uuid);
		await ctx.dictionaryManager.initialize();

		ctx.agentLogger?.infoSync('Dictionary Manager initialized', {
			component: LogComponents.mqtt,
			deviceUuid: ctx.deviceInfo.uuid,
		});
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize Dictionary Manager',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
				note: 'Dictionary compaction will be unavailable',
			}
		);
	}
}

export async function initContainerManager(ctx: AgentInitContext): Promise<void> {
	ctx.containerManager = ctx.stateReconciler!.getContainerManager();

	const docker = ctx.containerManager.getDocker();
	if (docker) {
		ctx.logMonitor = new (await import('../logging/docker-monitor.js')).ContainerLogMonitor(docker, ctx.agentLogger);
		ctx.containerManager.setLogMonitor(ctx.logMonitor);
		await ctx.containerManager.attachLogsToAllContainers();
		ctx.agentLogger?.debugSync('Log monitor attached to container manager', {
			component: LogComponents.agent,
			backendCount: ctx.agentLogger?.getBackends().length,
		});
	}

	ctx.agentLogger?.infoSync('Container manager setup complete', {
		component: LogComponents.agent,
	});
}

export async function initDeviceAPI(ctx: AgentInitContext): Promise<void> {
	if (ctx.deviceAPI) {
		ctx.agentLogger?.infoSync('Device API already running, skipping initialization', {
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
				ctx.containerManager.getStatus();
				return true;
			} catch {
				return false;
			}
		},
		async () => {
			setMemoryLogger(ctx.agentLogger);
			return memoryHealthcheck();
		},
	];

	ctx.deviceAPI = new DeviceAPI({
		routers: [v1Router],
		healthchecks,
		logger: ctx.agentLogger,
	});

	await ctx.deviceAPI.listen(ctx.configManager!.getDeviceApiPort());
	ctx.agentLogger?.infoSync('Device API started', {
		component: LogComponents.agent,
		port: ctx.configManager!.getDeviceApiPort(),
	});
}
