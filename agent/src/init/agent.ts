import type { AgentInitContext } from './context.js';
import { createHttpClient } from '../lib/http-client.js';
import { LogComponents } from '../logging/types.js';
import { setTenantId, resetTenantIdCache } from '../mqtt/topics.js';
import { getPackageVersion } from '../utils/api-utils.js';
import { getMacAddress, getOsVersion } from '../system/metrics.js';
import { CloudLogBackend } from '../logging/cloud-backend.js';
import { isStandaloneMode } from '../utils/env.js';

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

export async function initAgent(ctx: AgentInitContext): Promise<void> {
	ctx.sharedHttpClient = createHttpClient(ctx.configManager!.getCloudApiEndpoint());

	await initializeAgentManager(ctx);
	await initializeVpnReconnection(ctx);
	await initializeCloudLogging(ctx);
}

export async function initializeCloudLogging(ctx: AgentInitContext): Promise<void> {
	if (isStandaloneMode()) {
		return;
	}

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

export async function initializeAgentManager(ctx: AgentInitContext): Promise<void> {
	const cloudApiEndpoint = ctx.configManager!.getCloudApiEndpoint();
	ctx.agentManager = new (await import('../core/index.js')).AgentManager(
		ctx.agentLogger,
		ctx.sharedHttpClient,
		undefined,
		undefined,
		cloudApiEndpoint
	);
	await ctx.agentManager.initialize();

	let agentInfo = ctx.agentManager.getAgentInfo();

	if (isStandaloneMode()) {
		ctx.agentLogger?.infoSync('Standalone mode — skipping cloud provisioning', {
			component: LogComponents.agent,
		});
		await ctx.agentManager.markAsLocalMode();
		agentInfo = ctx.agentManager.getAgentInfo();
	} else {

		const provisioningApiKey = normalizeOptionalEnvValue(process.env.PROVISIONING_KEY);
		const cloudEndpoint = process.env.IOTISTICA_API || ctx.configManager!.getCloudApiEndpoint();

		if (!agentInfo.provisioned && provisioningApiKey && cloudEndpoint) {
			try {
				const macAddress = process.env.MAC_ADDRESS || (await getMacAddress());
				const osVersion = process.env.OS_VERSION || (await getOsVersion());

				await ctx.agentManager.provision({
					provisioningApiKey,
					name: process.env.DEVICE_NAME || `agent-${agentInfo.uuid.slice(0, 8)}`,
					type: process.env.DEVICE_TYPE || 'standalone',
					apiEndpoint: cloudEndpoint,
					macAddress,
					osVersion,
					agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
				});
				agentInfo = ctx.agentManager.getAgentInfo();
				ctx.agentInfo = agentInfo;
			} catch (error: any) {
				ctx.agentLogger?.errorSync(
					'Auto-provisioning failed',
					error instanceof Error ? error : new Error(error.message),
					{
						componet: LogComponents.agent,
						note: 'Device will remain unprovisioned. Check PROVISIONING_KEY or boot config file.',
					}
				);
				agentInfo = ctx.agentManager.getAgentInfo();
			}
		} else if (!agentInfo.provisioned && cloudEndpoint && !provisioningApiKey) {
			ctx.agentLogger?.warnSync('Device not provisioned', {
				component: LogComponents.agent,
				note: 'Set PROVISIONING_KEY environment variable or provide /data/iotistic/boot-config.json',
			});
		} else if (!agentInfo.provisioned && !ctx.configManager!.getCloudApiEndpoint()) {
			ctx.agentLogger?.infoSync('Running in local mode (no cloud connection)', {
				component: LogComponents.agent,
			});
			await ctx.agentManager.markAsLocalMode();
			agentInfo = ctx.agentManager.getAgentInfo();
		} else if (agentInfo.provisioned && !ctx.configManager!.getCloudApiEndpoint()) {
			ctx.agentLogger?.infoSync('Switching to local mode (no cloud connection)', {
				component: LogComponents.agent,
				note: 'Device was previously provisioned but IOTISTICA_API is not set',
			});
			await ctx.agentManager.markAsLocalMode();
			agentInfo = ctx.agentManager.getAgentInfo();
		}

	} // end of !isStandaloneMode() block

	ctx.agentInfo = agentInfo;

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
		await ctx.agentManager.updateAgentVersion(currentVersion);
		ctx.agentInfo = ctx.agentManager.getAgentInfo();
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
