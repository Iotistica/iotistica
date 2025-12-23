/**
 * VPN Actions
 * Direct VPN control (connect/disconnect/status) independent of provisioning flow
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { TailscaleManager } from '../network/vpn/tailscale-manager';
import type { TailscaleConfig, TailscaleStatus } from '../network/vpn/tailscale-manager';

let tailscaleManager: TailscaleManager | null = null;
let logger: AgentLogger | undefined;

/**
 * Initialize VPN actions with logger
 */
export function initVpnActions(agentLogger?: AgentLogger): void {
	logger = agentLogger;
	tailscaleManager = new TailscaleManager(logger);
}

/**
 * Connect to Tailscale VPN
 * 
 * @param config - Tailscale configuration (auth key, tailnet name, etc.)
 * @returns Connection status
 */
export async function connectTailscale(config: TailscaleConfig): Promise<{ success: boolean; status: TailscaleStatus }> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	logger?.infoSync('Connecting to Tailscale VPN via API...', {
		component: LogComponents.deviceApi,
		tailnet: config.tailnetName,
		hostname: config.hostname,
	});

	try {
		await tailscaleManager.configure(config);
		const status = await tailscaleManager.getStatus();

		logger?.infoSync('Tailscale VPN connected via API', {
			component: LogComponents.deviceApi,
			tailnetIP: status.tailnetIP,
			hostname: status.hostname,
		});

		return { success: true, status };
	} catch (error: any) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to connect to Tailscale VPN via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Disconnect from Tailscale VPN
 * 
 * @returns Disconnection status
 */
export async function disconnectTailscale(): Promise<{ success: boolean }> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	logger?.infoSync('Disconnecting from Tailscale VPN via API...', {
		component: LogComponents.deviceApi,
	});

	try {
		await tailscaleManager.disconnect();

		logger?.infoSync('Tailscale VPN disconnected via API', {
			component: LogComponents.deviceApi,
		});

		return { success: true };
	} catch (error: any) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to disconnect from Tailscale VPN via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Get Tailscale VPN status
 * 
 * @returns Current VPN status
 */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.getStatus();
	} catch (error: any) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to get Tailscale status via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Get Tailscale IP address
 * 
 * @returns Tailscale IP or null if not connected
 */
export async function getTailscaleIP(): Promise<string | null> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.getIP();
	} catch (error: any) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to get Tailscale IP via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Ping another Tailscale node
 * 
 * @param hostname - Hostname or IP to ping
 * @param count - Number of pings (default: 3)
 * @returns Ping success status
 */
export async function pingTailscaleNode(hostname: string, count: number = 3): Promise<boolean> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.ping(hostname, count);
	} catch (error: any) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to ping Tailscale node via API', err, {
			component: LogComponents.deviceApi,
			hostname,
		});
		throw err;
	}
}
