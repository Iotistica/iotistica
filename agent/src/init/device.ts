import type { AgentInitContext } from './context.js';
import { createHttpClient } from '../lib/http-client.js';
import { LogComponents } from '../logging/types.js';
import { setTenantId, resetTenantIdCache } from '../mqtt/topics.js';
import { getPackageVersion } from '../utils/api-utils.js';
import { getMacAddress, getOsVersion } from '../system/metrics.js';
import { CloudLogBackend } from '../logging/cloud-backend.js';

export async function initDevice(ctx: AgentInitContext): Promise<void> {
	ctx.sharedHttpClient = createHttpClient(ctx.configManager!.getCloudApiEndpoint());

	await initializeDeviceManager(ctx);
	await initializeVpnReconnection(ctx);
	await initializeCloudLogging(ctx);
}

export async function initializeCloudLogging(ctx: AgentInitContext): Promise<void> {
	const cloudApiEndpoint = ctx.configManager!.getCloudApiEndpoint();

	if (
		!cloudApiEndpoint ||
		!ctx.deviceInfo?.provisioned ||
		!ctx.deviceInfo?.deviceApiKey
	) {
		if (cloudApiEndpoint && !ctx.deviceInfo?.provisioned) {
			ctx.agentLogger?.warnSync(
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
		const loggingConfig = ctx.configManager!.getLoggingConfig();

		const cloudLogBackend = new CloudLogBackend(
			{
				cloudEndpoint: cloudApiEndpoint,
				deviceUuid: ctx.deviceInfo.uuid,
				deviceApiKey: ctx.deviceInfo.apiKey,
				httpClient: ctx.sharedHttpClient,
				compression: loggingConfig.enableCompression,
				batchSize: loggingConfig.logBatchSize,
				flushInterval: loggingConfig.logFlushIntervalMs,
			},
			ctx.agentLogger
		);
		await cloudLogBackend.initialize();
		ctx.agentLogger?.addBackend(cloudLogBackend);

		ctx.agentLogger?.debugSync('Cloud log backend initialized', {
			component: LogComponents.agent,
			cloudEndpoint: cloudApiEndpoint,
		});
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize cloud log backend. Continuing without cloud logging',
			error instanceof Error ? error : new Error(String(error)),
			{
				component: LogComponents.agent,
			}
		);
	}
}

export async function initializeDeviceManager(ctx: AgentInitContext): Promise<void> {
	const cloudApiEndpoint = ctx.configManager!.getCloudApiEndpoint();
	ctx.deviceManager = new (await import('../managers/index.js')).DeviceManager(
		ctx.agentLogger!,
		ctx.sharedHttpClient,
		undefined,
		undefined,
		cloudApiEndpoint
	);
	await ctx.deviceManager.initialize();

	let deviceInfo = ctx.deviceManager.getDeviceInfo();
	const provisioningApiKey = process.env.PROVISIONING_KEY;
	const cloudEndpoint = process.env.CLOUD_API_ENDPOINT || ctx.configManager!.getCloudApiEndpoint();

	ctx.agentLogger?.debugSync('Checking provisioning configuration', {
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
		ctx.agentLogger?.infoSync('Auto-provisioning device with two-phase authentication', {
			component: LogComponents.agent,
			keySource: 'environment variable',
		});
		try {
			const macAddress = process.env.MAC_ADDRESS || (await getMacAddress());
			const osVersion = process.env.OS_VERSION || (await getOsVersion());

			ctx.agentLogger?.infoSync('System information detected', {
				component: LogComponents.agent,
				macAddress: macAddress ? `${macAddress.substring(0, 8)}...` : 'unknown',
				osVersion: osVersion || 'unknown',
			});

			await ctx.deviceManager.provision({
				provisioningApiKey,
				deviceName: process.env.DEVICE_NAME || `agent-${deviceInfo.uuid.slice(0, 8)}`,
				deviceType: process.env.DEVICE_TYPE || 'standalone',
				apiEndpoint: cloudEndpoint,
				macAddress,
				osVersion,
				agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
			});
			deviceInfo = ctx.deviceManager.getDeviceInfo();
			ctx.deviceInfo = deviceInfo;
			ctx.agentLogger?.infoSync('Device auto-provisioned successfully', {
				component: LogComponents.agent,
			});
		} catch (error: any) {
			ctx.agentLogger?.errorSync(
				'Auto-provisioning failed',
				error instanceof Error ? error : new Error(error.message),
				{
					componet: LogComponents.agent,
					note: 'Device will remain unprovisioned. Check PROVISIONING_KEY or boot config file.',
				}
			);
			deviceInfo = ctx.deviceManager.getDeviceInfo();
		}
	} else if (!deviceInfo.provisioned && cloudEndpoint && !provisioningApiKey) {
		ctx.agentLogger?.warnSync('Device not provisioned', {
			component: LogComponents.agent,
			note: 'Set PROVISIONING_KEY environment variable or provide /data/iotistic/boot-config.json',
		});
	} else if (!deviceInfo.provisioned && !ctx.configManager!.getCloudApiEndpoint()) {
		ctx.agentLogger?.infoSync('Running in local mode (no cloud connection)', {
			component: LogComponents.agent,
		});
		await ctx.deviceManager.markAsLocalMode();
		deviceInfo = ctx.deviceManager.getDeviceInfo();
	} else if (deviceInfo.provisioned && !ctx.configManager!.getCloudApiEndpoint()) {
		ctx.agentLogger?.infoSync('Switching to local mode (no cloud connection)', {
			component: LogComponents.agent,
			note: 'Device was previously provisioned but CLOUD_API_ENDPOINT is not set',
		});
		await ctx.deviceManager.markAsLocalMode();
		deviceInfo = ctx.deviceManager.getDeviceInfo();
	}

	ctx.deviceInfo = deviceInfo;

	if (ctx.deviceInfo.provisioned) {
		const tenantId = ctx.deviceInfo.tenantId?.trim();
		if (!tenantId) {
			throw new Error('Provisioned device is missing tenantId. Re-provision device to receive tenant-aware configuration.');
		}
		setTenantId(tenantId);
	} else {
		resetTenantIdCache();
	}

	const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
	if (ctx.deviceInfo.agentVersion !== currentVersion) {
		ctx.agentLogger?.debugSync('Updating agent version', {
			component: LogComponents.agent,
			oldVersion: ctx.deviceInfo.agentVersion || 'unknown',
			newVersion: currentVersion,
		});
		await ctx.deviceManager.updateAgentVersion(currentVersion);
		ctx.deviceInfo = ctx.deviceManager.getDeviceInfo();
	}

	ctx.agentLogger?.setDeviceId(ctx.deviceInfo.uuid);

	ctx.agentLogger?.debugSync('Device manager initialized', {
		component: LogComponents.agent,
		uuid: ctx.deviceInfo.uuid,
		name: ctx.deviceInfo.deviceName || 'Not set',
		provisioned: ctx.deviceInfo.provisioned,
		tenantId: ctx.deviceInfo.tenantId,
		hasApiKey: !!ctx.deviceInfo.deviceApiKey,
		agentVersion: ctx.deviceInfo.agentVersion,
		mqtt: ctx.deviceInfo.mqttBrokerConfig
	});
}

export async function initializeVpnReconnection(ctx: AgentInitContext): Promise<void> {
	ctx.agentLogger?.infoSync('Checking VPN auto-reconnection status', {
		component: LogComponents.agent,
		provisioned: ctx.deviceInfo?.provisioned,
		vpnEnabled: ctx.deviceInfo?.vpnEnabled,
	});

	if (!ctx.deviceInfo?.provisioned || !ctx.deviceInfo?.vpnEnabled) {
		ctx.agentLogger?.infoSync('VPN auto-reconnection skipped (device not provisioned with VPN)', {
			component: LogComponents.agent,
			provisioned: ctx.deviceInfo?.provisioned,
			vpnEnabled: ctx.deviceInfo?.vpnEnabled,
		});
		return;
	}

	try {
		const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
		const tailscale = new TailscaleManager(ctx.agentLogger);

		const isInstalled = await tailscale.checkInstallation();
		if (!isInstalled) {
			ctx.agentLogger?.infoSync('VPN auto-reconnection skipped (Tailscale not installed)', {
				component: LogComponents.agent,
			});
			return;
		}

		ctx.agentLogger?.infoSync('Starting Tailscale daemon for auto-reconnection', {
			component: LogComponents.agent,
		});
		await tailscale.ensureDaemonRunning();

		const status = await tailscale.getStatus();

		if (status.connected) {
			ctx.agentLogger?.infoSync('Tailscale VPN reconnected on startup', {
				component: LogComponents.agent,
				tailnetIP: status.tailnetIP,
				hostname: status.hostname,
				online: status.online,
			});
		} else {
			ctx.agentLogger?.infoSync('Tailscale daemon started but not authenticated', {
				component: LogComponents.agent,
				backendState: status.backendState,
				note: 'Device needs to be provisioned with VPN auth key',
			});
		}
	} catch (error) {
		ctx.agentLogger?.warnSync('Failed to reconnect VPN on startup (non-critical)', {
			component: LogComponents.agent,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
}
