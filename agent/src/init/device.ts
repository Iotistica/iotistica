import type { AgentInitContext } from './core.js';
import { createHttpClient } from '../lib/http-client.js';
import { LogComponents } from '../logging/types.js';
import { setTenantId, resetTenantIdCache } from '../mqtt/topics.js';
import { getPackageVersion } from '../utils/api-utils.js';
import { getMacAddress, getOsVersion } from '../system/metrics.js';
import { CloudLogBackend } from '../logging/cloud-backend.js';

export async function initDevice(ctx: AgentInitContext): Promise<void> {
	ctx.device.setSharedHttpClient(
		createHttpClient(ctx.device.getCloudApiEndpoint())
	);

	await initializeDeviceManager(ctx.self);
	await initializeVpnReconnection(ctx.self);
	await initializeCloudLogging(ctx.self);
}

export async function initializeCloudLogging(agent: any): Promise<void> {
	const cloudApiEndpoint = agent.configManager.getCloudApiEndpoint();

	if (
		!cloudApiEndpoint ||
		!agent.deviceInfo.provisioned ||
		!agent.deviceInfo.deviceApiKey
	) {
		if (cloudApiEndpoint && !agent.deviceInfo.provisioned) {
			agent.agentLogger.warnSync(
				'Cloud logging disabled - device not provisioned',
				{
					component: LogComponents.agent,
					note: 'Device must be provisioned before enabling cloud log streaming',
				}
			);
		}
		return;
	}

	try {
		const loggingConfig = agent.configManager.getLoggingConfig();

		const cloudLogBackend = new CloudLogBackend(
			{
				cloudEndpoint: cloudApiEndpoint,
				deviceUuid: agent.deviceInfo.uuid,
				deviceApiKey: agent.deviceInfo.apiKey,
				httpClient: agent.sharedHttpClient,
				compression: loggingConfig.enableCompression,
				batchSize: loggingConfig.logBatchSize,
				flushInterval: loggingConfig.logFlushIntervalMs,
			},
			agent.agentLogger
		);
		await cloudLogBackend.initialize();
		agent.agentLogger.addBackend(cloudLogBackend);

		agent.agentLogger.debugSync('Cloud log backend initialized', {
			component: LogComponents.agent,
			cloudEndpoint: cloudApiEndpoint,
		});
	} catch (error) {
		agent.agentLogger.errorSync(
			'Failed to initialize cloud log backend. Continuing without cloud logging',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
			}
		);
	}
}

export async function initializeDeviceManager(agent: any): Promise<void> {
	const cloudApiEndpoint = agent.configManager.getCloudApiEndpoint();
	agent.deviceManager = new (await import('../device-manager/index.js')).DeviceManager(
		agent.agentLogger,
		agent.sharedHttpClient,
		undefined,
		undefined,
		cloudApiEndpoint
	);
	await agent.deviceManager.initialize();

	let deviceInfo = agent.deviceManager.getDeviceInfo();
	const provisioningApiKey = process.env.PROVISIONING_KEY;
	const cloudEndpoint = process.env.CLOUD_API_ENDPOINT || agent.configManager.getCloudApiEndpoint();

	agent.agentLogger.debugSync('Checking provisioning configuration', {
		component: LogComponents.agent,
		hasProvisioningKey: !!provisioningApiKey,
		provisioningKeyLength: provisioningApiKey?.length || 0,
		provisioningKeyPrefix: provisioningApiKey ? provisioningApiKey.substring(0, 20) + '...' : 'not set',
		keySource: process.env.PROVISIONING_KEY ? 'environment' : 'none',
		isProvisioned: deviceInfo.provisioned,
		hasCloudEndpoint: !!cloudEndpoint,
		cloudEndpoint: cloudEndpoint || 'not set',
	});

	if (!deviceInfo.provisioned && provisioningApiKey && cloudEndpoint) {
		agent.agentLogger.infoSync('Auto-provisioning device with two-phase authentication', {
			component: LogComponents.agent,
			keySource: 'environment variable',
		});
		try {
			const macAddress = process.env.MAC_ADDRESS || (await getMacAddress());
			const osVersion = process.env.OS_VERSION || (await getOsVersion());

			agent.agentLogger.infoSync('System information detected', {
				component: LogComponents.agent,
				macAddress: macAddress ? `${macAddress.substring(0, 8)}...` : 'unknown',
				osVersion: osVersion || 'unknown',
			});

			await agent.deviceManager.provision({
				provisioningApiKey,
				deviceName: process.env.DEVICE_NAME || `agent-${deviceInfo.uuid.slice(0, 8)}`,
				deviceType: process.env.DEVICE_TYPE || 'standalone',
				apiEndpoint: cloudEndpoint,
				macAddress,
				osVersion,
				agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
			});
			deviceInfo = agent.deviceManager.getDeviceInfo();
			agent.deviceInfo = deviceInfo;
			agent.agentLogger.infoSync('Device auto-provisioned successfully', {
				component: LogComponents.agent,
			});
		} catch (error: any) {
			agent.agentLogger.errorSync(
				'Auto-provisioning failed',
				error instanceof Error ? error : new Error(error.message),
				{
					componet: LogComponents.agent,
					note: 'Device will remain unprovisioned. Check PROVISIONING_KEY or boot config file.',
				}
			);
			deviceInfo = agent.deviceManager.getDeviceInfo();
		}
	} else if (!deviceInfo.provisioned && cloudEndpoint && !provisioningApiKey) {
		agent.agentLogger.warnSync('Device not provisioned', {
			component: LogComponents.agent,
			note: 'Set PROVISIONING_KEY environment variable or provide /data/iotistic/boot-config.json',
		});
	} else if (!deviceInfo.provisioned && !agent.configManager.getCloudApiEndpoint()) {
		agent.agentLogger.infoSync('Running in local mode (no cloud connection)', {
			component: LogComponents.agent,
		});
		await agent.deviceManager.markAsLocalMode();
		deviceInfo = agent.deviceManager.getDeviceInfo();
	} else if (deviceInfo.provisioned && !agent.configManager.getCloudApiEndpoint()) {
		agent.agentLogger.infoSync('Switching to local mode (no cloud connection)', {
			component: LogComponents.agent,
			note: 'Device was previously provisioned but CLOUD_API_ENDPOINT is not set',
		});
		await agent.deviceManager.markAsLocalMode();
		deviceInfo = agent.deviceManager.getDeviceInfo();
	}

	agent.deviceInfo = deviceInfo;

	if (agent.deviceInfo.provisioned) {
		const tenantId = agent.deviceInfo.tenantId?.trim();
		if (!tenantId) {
			throw new Error('Provisioned device is missing tenantId. Re-provision device to receive tenant-aware configuration.');
		}
		setTenantId(tenantId);
	} else {
		resetTenantIdCache();
	}

	const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
	if (agent.deviceInfo.agentVersion !== currentVersion) {
		agent.agentLogger.debugSync('Updating agent version', {
			component: LogComponents.agent,
			oldVersion: agent.deviceInfo.agentVersion || 'unknown',
			newVersion: currentVersion,
		});
		await agent.deviceManager.updateAgentVersion(currentVersion);
		agent.deviceInfo = agent.deviceManager.getDeviceInfo();
	}

	agent.agentLogger.setDeviceId(agent.deviceInfo.uuid);

	agent.agentLogger.debugSync('Device manager initialized', {
		component: LogComponents.agent,
		uuid: agent.deviceInfo.uuid,
		name: agent.deviceInfo.deviceName || 'Not set',
		provisioned: agent.deviceInfo.provisioned,
		tenantId: agent.deviceInfo.tenantId,
		hasApiKey: !!agent.deviceInfo.deviceApiKey,
		agentVersion: agent.deviceInfo.agentVersion,
		mqtt: agent.deviceInfo.mqttBrokerConfig
	});
}

export async function initializeVpnReconnection(agent: any): Promise<void> {
	agent.agentLogger?.infoSync('Checking VPN auto-reconnection status', {
		component: LogComponents.agent,
		provisioned: agent.deviceInfo.provisioned,
		vpnEnabled: agent.deviceInfo.vpnEnabled,
	});

	if (!agent.deviceInfo.provisioned || !agent.deviceInfo.vpnEnabled) {
		agent.agentLogger?.infoSync('VPN auto-reconnection skipped (device not provisioned with VPN)', {
			component: LogComponents.agent,
			provisioned: agent.deviceInfo.provisioned,
			vpnEnabled: agent.deviceInfo.vpnEnabled,
		});
		return;
	}

	try {
		const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
		const tailscale = new TailscaleManager(agent.agentLogger);

		const isInstalled = await tailscale.checkInstallation();
		if (!isInstalled) {
			agent.agentLogger?.infoSync('VPN auto-reconnection skipped (Tailscale not installed)', {
				component: LogComponents.agent,
			});
			return;
		}

		agent.agentLogger?.infoSync('Starting Tailscale daemon for auto-reconnection', {
			component: LogComponents.agent,
		});
		await tailscale.ensureDaemonRunning();

		const status = await tailscale.getStatus();

		if (status.connected) {
			agent.agentLogger?.infoSync('Tailscale VPN reconnected on startup', {
				component: LogComponents.agent,
				tailnetIP: status.tailnetIP,
				hostname: status.hostname,
				online: status.online,
			});
		} else {
			agent.agentLogger?.infoSync('Tailscale daemon started but not authenticated', {
				component: LogComponents.agent,
				backendState: status.backendState,
				note: 'Device needs to be provisioned with VPN auth key',
			});
		}
	} catch (error) {
		agent.agentLogger?.warnSync('Failed to reconnect VPN on startup (non-critical)', {
			component: LogComponents.agent,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
}
