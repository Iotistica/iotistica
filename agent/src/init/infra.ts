import type { AgentInitContext } from './context.js';
import { LogComponents } from '../logging/types.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import { BrokerMonitorService } from '../mqtt/broker-monitor.js';


export async function initInfrastructure(ctx: AgentInitContext): Promise<void> {
	await Promise.all([
		initializeConnections(ctx),
		initContainerManager(ctx),
	]);

	await initDeviceAPI(ctx);
	initBrokerMonitor(ctx);
}

function initBrokerMonitor(ctx: AgentInitContext): void {
	try {
		const monitor = BrokerMonitorService.getInstance();

		// Apply persisted config if present (overrides env var defaults)
		const cfg = (ctx.configManager?.getTargetConfig?.() as any)?.mqttMonitor;
		if (cfg?.url) {
			monitor.reconfigure(cfg.url, cfg.username ?? '', cfg.password ?? '');
		} else {
			monitor.start();
		}

		ctx.agentLogger?.infoSync('Local MQTT broker monitor started', {
			component: LogComponents.agent,
			url: process.env.LOCAL_MQTT_URL ?? 'mqtt://localhost:1883',
		});
	} catch (err) {
		ctx.agentLogger?.warnSync('Failed to start broker monitor (non-fatal)', {
			component: LogComponents.agent,
			error: (err as Error).message,
		});
	}
}

export async function initializeConnections(ctx: AgentInitContext): Promise<void> {
	try {
		await _connectIotisticaMqtt(ctx);
		await initializeDictionaryManager(ctx);
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize connections',
			error instanceof Error ? error : new Error(String(error)),
			{ component: LogComponents.agent },
		);
	}
}

/**
 * Connect the Iotistica CloudMqttClient singleton.
 * No-ops when no broker config is present (agent not yet provisioned).
 */
async function _connectIotisticaMqtt(ctx: AgentInitContext): Promise<void> {
	if (!ctx.agentInfo?.mqttBrokerConfig) return;

	const mqttManager = CloudMqttClient.getInstance();
	if (mqttManager.isConnected()) return;

	const config = ctx.agentInfo.mqttBrokerConfig;
	const brokerUrl = `${config.protocol || 'mqtt'}://${config.host}:${config.port}`;

	const mqttOptions: Record<string, any> = {
		clientId: config.clientIdPrefix
			? `${config.clientIdPrefix}_${ctx.agentInfo.uuid}`
			: `device_${ctx.agentInfo.uuid}`,
		clean: config.cleanSession ?? true,
		reconnectPeriod: config.reconnectPeriod ?? 5000,
		keepalive: config.keepAlive ?? 60,
		connectTimeout: config.connectTimeout ?? 30000,
		username: config.username,
		password: config.password,
	};

	if (config.useTls) {
		mqttOptions.rejectUnauthorized = config.caCert ? (config.verifyCertificate ?? true) : false;
		if (config.caCert) mqttOptions.ca = config.caCert.replace(/\\n/g, '\n');
	}

	await mqttManager.connect(brokerUrl, mqttOptions, ctx.agentInfo.uuid, { bufferSync: true });
	ctx.agentLogger?.infoSync('Iotistica MQTT connected', {
		component: LogComponents.agent,
		broker: brokerUrl,
	});
}


/**
 * @deprecated Call initializeConnections instead.
 */
export async function initializePublishTarget(ctx: AgentInitContext): Promise<void> {
	return initializeConnections(ctx);
}

/**
 * @deprecated Call initializeConnections instead.
 */
export async function initializeMqttManager(ctx: AgentInitContext): Promise<void> {
	return initializeConnections(ctx);
}

export async function initializeDictionaryManager(ctx: AgentInitContext): Promise<void> {
	if (process.env.USE_KEY_COMPACTION_POC !== 'true') {
		return;
	}

	try {
		const { DictionaryManager } = await import('../mqtt/dictionary.js');
		const mqttManager = CloudMqttClient.getInstance();

		ctx.dictionaryManager = new DictionaryManager(mqttManager, ctx.agentLogger, ctx.agentInfo!.uuid);
		await ctx.dictionaryManager.initialize();

		ctx.agentLogger?.infoSync('Dictionary manager initialized', {
			component: LogComponents.mqtt,
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
	ctx.containerManager = ctx.stateReconciler?.getContainerManager();

	const docker = ctx.containerManager?.getDocker();
	if (docker) {
		ctx.logMonitor = new (await import('../logging/container-monitor.js')).ContainerLogMonitor(docker, ctx.agentLogger);
		ctx.containerManager?.setLogMonitor(ctx.logMonitor);
		await ctx.containerManager?.attachLogsToAllContainers();
	}

	ctx.agentLogger?.infoSync('Container manager initialized', {
		component: LogComponents.agent,
	});
}

export async function initDeviceAPI(ctx: AgentInitContext): Promise<void> {
	if (ctx.agentAPI) {
		return;
	}

	const { router: v1Router } = await import('../api/v1.js');
	const { anomalyRouter } = await import('../api/anomaly.js');
	const { DeviceAPI } = await import('../api/index.js');
	const { healthcheck: memoryHealthcheck, setMemoryLogger } = await import('../system/memory.js');

	const healthchecks = [
		async () => {
			try {
				ctx.containerManager!.getStatus();
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

	ctx.agentAPI = new DeviceAPI({
		routers: [v1Router, anomalyRouter],
		healthchecks,
		logger: ctx.agentLogger,
	});

	await ctx.agentAPI.listen(ctx.configManager!.getAgentApiPort());

	// Attach WebSocket shell handler after the HTTP server is listening
	const httpServer = ctx.agentAPI.getServer();
	if (httpServer) {
		const { attachShellHandler } = await import('../api/shell.js');
		attachShellHandler(httpServer, ctx.agentLogger);
	}

	ctx.agentLogger?.infoSync('Device API initialized', {
		component: LogComponents.agent,
		port: ctx.configManager!.getAgentApiPort(),
	});
}
