import type { AgentInitContext } from './context.js';
import { createHttpClient } from '../lib/http-client.js';
import { LogComponents } from '../logging/types.js';
import { setTenantId, resetTenantIdCache } from '../mqtt/topics.js';
import { getPackageVersion } from '../utils/api-utils.js';
import { getMacAddress, getOsVersion } from '../system/metrics.js';
import { CloudLogBackend } from '../logging/cloud-backend.js';

function normalizeOptionalEnvValue(value?: string): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed === "''" || trimmed === '""') {
		return undefined;
	}

	return trimmed;
}

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
		!ctx.agentInfo?.provisioned ||
		!ctx.agentInfo?.apiKey
	) {
		return;
	}

	try {
		const loggingConfig = ctx.configManager!.getLoggingConfig();

		const cloudLogBackend = new CloudLogBackend(
			{
				cloudEndpoint: cloudApiEndpoint,
				deviceUuid: ctx.agentInfo.uuid,
				deviceApiKey: ctx.agentInfo.apiKey,
				httpClient: ctx.sharedHttpClient,
				compression: loggingConfig.enableCompression,
				batchSize: loggingConfig.logBatchSize,
				flushInterval: loggingConfig.logFlushIntervalMs,
			},
			ctx.agentLogger
		);
		await cloudLogBackend.initialize();
		ctx.agentLogger?.addBackend(cloudLogBackend);

		ctx.agentLogger?.infoSync('Cloud logging initialized', {
			component: LogComponents.agent,
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
	const provisioningApiKey = normalizeOptionalEnvValue(process.env.PROVISIONING_KEY);
	const cloudEndpoint = process.env.IOTISTICA_API || ctx.configManager!.getCloudApiEndpoint();

	if (!deviceInfo.provisioned && provisioningApiKey && cloudEndpoint) {
		try {
			const macAddress = process.env.MAC_ADDRESS || (await getMacAddress());
			const osVersion = process.env.OS_VERSION || (await getOsVersion());

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
			ctx.agentInfo = deviceInfo;
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
			note: 'Device was previously provisioned but IOTISTICA_API is not set',
		});
		await ctx.deviceManager.markAsLocalMode();
		deviceInfo = ctx.deviceManager.getDeviceInfo();
	}

	ctx.agentInfo = deviceInfo;

	if (ctx.agentInfo.provisioned) {
		const tenantId = ctx.agentInfo.tenantId?.trim();
		if (!tenantId) {
			throw new Error('Provisioned device is missing tenantId. Re-provision device to receive tenant-aware configuration.');
		}
		setTenantId(tenantId);
	} else {
		resetTenantIdCache();
	}

	const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
	if (ctx.agentInfo.agentVersion !== currentVersion) {
		await ctx.deviceManager.updateAgentVersion(currentVersion);
		ctx.agentInfo = ctx.deviceManager.getDeviceInfo();
	}

	ctx.agentLogger?.setDeviceId(ctx.agentInfo.uuid);

	ctx.agentLogger?.infoSync('Device manager initialized', {
		component: LogComponents.agent,
		provisioned: ctx.agentInfo.provisioned,
		mode: ctx.agentInfo.provisioned ? 'cloud' : 'local',
	});
}

export async function initializeVpnReconnection(ctx: AgentInitContext): Promise<void> {
	if (!ctx.agentInfo?.provisioned || !ctx.agentInfo?.vpnEnabled) {
		return;
	}

	try {
		const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
		const tailscale = new TailscaleManager(ctx.agentLogger);

		const isInstalled = await tailscale.checkInstallation();
		if (!isInstalled) {
			return;
		}
		await tailscale.ensureDaemonRunning();

		const status = await tailscale.getStatus();

		if (status.connected) {
			ctx.agentLogger?.infoSync('VPN reconnection initialized', {
				component: LogComponents.agent,
				tailnetIP: status.tailnetIP,
			});
		} else {
			ctx.agentLogger?.infoSync('VPN daemon initialized', {
				component: LogComponents.agent,
				state: status.backendState,
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
