/**
 * Network Route Manager
 * Intelligently routes agent traffic through VPN or public internet
 * Prefers VPN when available, falls back to public internet
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { WireGuardManager } from './wireguard-manager';

export interface RouteConfig {
	publicEndpoint: string;   // e.g., https://api.iotistica.com
	vpnEndpoint?: string;     // e.g., http://10.8.0.1:3002
	preferVpn?: boolean;      // Default: true if VPN configured
}

export interface RouteStatus {
	usingVpn: boolean;
	endpoint: string;
	vpnAvailable: boolean;
	reason: string;
}

/**
 * Network Route Manager
 * Determines optimal route for agent-cloud communication
 */
export class NetworkRouteManager {
	private vpnManager: WireGuardManager;
	private logger?: AgentLogger;
	private lastVpnCheck: Date | null = null;
	private vpnCheckInterval = 60000; // 1 minute

	constructor(logger?: AgentLogger) {
		this.vpnManager = new WireGuardManager('wg0', '/etc/wireguard', logger);
		this.logger = logger;
	}

	/**
	* Get the best endpoint for cloud API communication
	* Prefers VPN when available, falls back to public internet
	*/
	async getEndpoint(config: RouteConfig): Promise<RouteStatus> {
		const preferVpn = config.preferVpn !== false; // Default to true

		// If no VPN endpoint configured, use public
		if (!config.vpnEndpoint) {
			return {
				usingVpn: false,
				endpoint: config.publicEndpoint,
				vpnAvailable: false,
				reason: 'No VPN endpoint configured',
			};
		}

		// Check VPN status (cached for performance)
		const vpnAvailable = await this.isVpnAvailable();

		if (!vpnAvailable) {
			this.logger?.warnSync('VPN not available, using public endpoint', {
				component: LogComponents.networkRouteManager,
				operation: 'getEndpoint',
			});

			return {
				usingVpn: false,
				endpoint: config.publicEndpoint,
				vpnAvailable: false,
				reason: 'VPN tunnel not established',
			};
		}

		// VPN is available
		if (preferVpn) {
			this.logger?.infoSync('Using VPN route for cloud communication', {
				component: LogComponents.networkRouteManager,
				operation: 'getEndpoint',
				endpoint: config.vpnEndpoint,
			});

			return {
				usingVpn: true,
				endpoint: config.vpnEndpoint,
				vpnAvailable: true,
				reason: 'VPN tunnel active',
			};
		}

		// VPN available but not preferred
		return {
			usingVpn: false,
			endpoint: config.publicEndpoint,
			vpnAvailable: true,
			reason: 'Public endpoint preferred by configuration',
		};
	}

	/**
	* Check if VPN tunnel is available and healthy
	* Cached to avoid excessive checks
	*/
	private async isVpnAvailable(): Promise<boolean> {
		// Check cache
		if (this.lastVpnCheck) {
			const timeSinceCheck = Date.now() - this.lastVpnCheck.getTime();
			if (timeSinceCheck < this.vpnCheckInterval) {
				// Use cached result
				const status = await this.vpnManager.getStatus();
				return status.interfaceUp;
			}
		}

		// Perform fresh check
		try {
			const status = await this.vpnManager.getStatus();
			this.lastVpnCheck = new Date();

			if (!status.interfaceUp) {
				return false;
			}

			// Check if handshake is recent (within last 5 minutes)
			if (status.lastHandshake) {
				const handshakeAge = Date.now() - status.lastHandshake.getTime();
				const fiveMinutes = 5 * 60 * 1000;

				if (handshakeAge > fiveMinutes) {
					this.logger?.warnSync('VPN handshake stale', {
						component: LogComponents.networkRouteManager,
						operation: 'isVpnAvailable',
						handshakeAge: Math.floor(handshakeAge / 1000) + 's',
					});
					return false;
				}
			}

			return true;
		} catch (error) {
			this.logger?.errorSync(
				'Failed to check VPN status',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.networkRouteManager,
					operation: 'isVpnAvailable',
				}
			);
			return false;
		}
	}

	/**
	* Force a fresh VPN status check (bypass cache)
	*/
	async refreshVpnStatus(): Promise<boolean> {
		this.lastVpnCheck = null;
		return this.isVpnAvailable();
	}

	/**
	* Get detailed route information for debugging
	*/
	async getRouteInfo(config: RouteConfig): Promise<{
		status: RouteStatus;
		vpnStatus: any;
		timestamp: Date;
	}> {
		const status = await this.getEndpoint(config);
		const vpnStatus = await this.vpnManager.getStatus();

		return {
			status,
			vpnStatus,
			timestamp: new Date(),
		};
	}
}
