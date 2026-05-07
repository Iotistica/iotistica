/**
 * WireGuard VPN Manager for Agent
 * Handles WireGuard configuration and tunnel management on edge devices
 */

import { execSync, exec } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

const execAsync = promisify(exec);

export type VpnConfig = 
	| {
			enabled: boolean;
			type: 'wireguard';
			ipAddress: string;
			wgConfig: string;
	}
	| {
			enabled: boolean;
			type: 'tailscale';
			tailscale: {
				authKey: string;
				tailnetName: string;
				expiresAt: string;
			};
	};

export interface VpnStatus {
	interfaceUp: boolean;
	ipAddress?: string;
	lastHandshake?: Date;
	transferRx?: number;
	transferTx?: number;
}

/**
 * WireGuard Manager
 * Manages WireGuard VPN tunnel lifecycle on edge device
 */
export class WireGuardManager {
	private readonly configPath: string;
	private readonly interfaceName: string;
	private logger?: AgentLogger;

	constructor(
		interfaceName: string = 'wg0',
		configPath: string = '/etc/wireguard',
		logger?: AgentLogger
	) {
		this.interfaceName = interfaceName;
		this.configPath = configPath;
		this.logger = logger;
	}

	/**
	* Check if WireGuard is available on the system
	*/
	async isAvailable(): Promise<boolean> {
		try {
			await execAsync('which wg');
			return true;
		} catch {
			return false;
		}
	}

	/**
	* Setup WireGuard VPN tunnel
	* @param vpnConfig VPN configuration from provisioning response
	*/
	async setup(vpnConfig: Extract<VpnConfig, { type: 'wireguard' }>): Promise<boolean> {
		if (!vpnConfig.enabled) {
			this.logger?.infoSync('VPN not enabled for this device', {
				component: LogComponents.wireGuardManager,
				operation: 'setup',
			});
			return false;
		}

		// Check if WireGuard is available
		const available = await this.isAvailable();
		if (!available) {
			this.logger?.warnSync('WireGuard not installed - skipping VPN setup', {
				component: LogComponents.wireGuardManager,
				operation: 'setup',
			});
			return false;
		}

		try {
			this.logger?.infoSync('Setting up WireGuard VPN', {
				component: LogComponents.wireGuardManager,
				operation: 'setup',
				ipAddress: vpnConfig.ipAddress,
			});

			// Ensure config directory exists
			await fs.mkdir(this.configPath, { recursive: true, mode: 0o755 });

			// Write config file
			const configFile = `${this.configPath}/${this.interfaceName}.conf`;
			await fs.writeFile(configFile, vpnConfig.wgConfig, { mode: 0o600 });

			this.logger?.infoSync('WireGuard config written', {
				component: LogComponents.wireGuardManager,
				operation: 'setup',
				configFile,
			});

			// Bring up the interface
			await this.up();

			// Enable auto-start on boot
			await this.enableAutoStart();

			// Test connectivity
			const status = await this.getStatus();
			if (status.interfaceUp) {
				this.logger?.infoSync('WireGuard VPN tunnel established', {
					component: LogComponents.wireGuardManager,
					operation: 'setup',
					ipAddress: status.ipAddress,
				});

				// Try to ping VPN gateway
				await this.testConnectivity();
			}

			return true;
		} catch (error) {
			this.logger?.errorSync(
				'Failed to setup WireGuard VPN',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.wireGuardManager,
					operation: 'setup',
				}
			);
			return false;
		}
	}

	/**
	* Bring up WireGuard interface
	*/
	async up(): Promise<void> {
		try {
			this.logger?.infoSync('Starting WireGuard interface', {
				component: LogComponents.wireGuardManager,
				operation: 'up',
				interface: this.interfaceName,
			});

			// Try wg-quick first
			try {
				await execAsync(`wg-quick up ${this.interfaceName}`);
			} catch (error: any) {
				// If wg-quick fails, try manual setup
				if (error.message?.includes('already exists')) {
					this.logger?.warnSync('Interface already up', {
						component: LogComponents.wireGuardManager,
						operation: 'up',
					});
					return;
				}

				this.logger?.warnSync('wg-quick failed, trying manual setup', {
					component: LogComponents.wireGuardManager,
					operation: 'up',
				});

				// Manual setup fallback
				const configFile = `${this.configPath}/${this.interfaceName}.conf`;
				execSync(`ip link add dev ${this.interfaceName} type wireguard`, { stdio: 'ignore' });
				execSync(`wg setconf ${this.interfaceName} ${configFile}`, { stdio: 'ignore' });
				execSync(`ip link set ${this.interfaceName} up`, { stdio: 'ignore' });
			}

			this.logger?.infoSync('WireGuard interface is up', {
				component: LogComponents.wireGuardManager,
				operation: 'up',
			});
		} catch (error) {
			this.logger?.errorSync(
				'Failed to bring up WireGuard interface',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.wireGuardManager,
					operation: 'up',
				}
			);
			throw error;
		}
	}

	/**
	* Bring down WireGuard interface
	*/
	async down(): Promise<void> {
		try {
			this.logger?.infoSync('Stopping WireGuard interface', {
				component: LogComponents.wireGuardManager,
				operation: 'down',
			});

			await execAsync(`wg-quick down ${this.interfaceName}`);

			this.logger?.infoSync('WireGuard interface is down', {
				component: LogComponents.wireGuardManager,
				operation: 'down',
			});
		} catch (error) {
			// Ignore error if interface doesn't exist
			if (error instanceof Error && error.message.includes('does not exist')) {
				return;
			}
			throw error;
		}
	}

	/**
	* Get VPN tunnel status
	*/
	async getStatus(): Promise<VpnStatus> {
		try {
			// Check if interface exists
			const { stdout } = await execAsync(`wg show ${this.interfaceName}`);

			// Parse WireGuard status
			const lines = stdout.split('\n');
			const status: VpnStatus = {
				interfaceUp: true,
			};

			for (const line of lines) {
				if (line.includes('latest handshake:')) {
					const match = line.match(/latest handshake: (.+)/);
					if (match) {
						// Parse handshake timestamp
						status.lastHandshake = new Date(match[1]);
					}
				}
				if (line.includes('transfer:')) {
					const match = line.match(/transfer: ([\d.]+\s+\w+) received, ([\d.]+\s+\w+) sent/);
					if (match) {
						status.transferRx = this.parseBytes(match[1]);
						status.transferTx = this.parseBytes(match[2]);
					}
				}
			}

			// Get IP address
			const { stdout: ipOutput } = await execAsync(`ip addr show ${this.interfaceName}`);
			const ipMatch = ipOutput.match(/inet ([\d.]+)\//);
			if (ipMatch) {
				status.ipAddress = ipMatch[1];
			}

			return status;
		} catch {
			return { interfaceUp: false };
		}
	}

	/**
	* Test VPN connectivity by pinging gateway
	*/
	private async testConnectivity(): Promise<boolean> {
		try {
			this.logger?.infoSync('Testing VPN connectivity', {
				component: LogComponents.wireGuardManager,
				operation: 'testConnectivity',
			});

			// Ping VPN gateway (10.8.0.1)
			await execAsync('ping -c 3 -W 2 10.8.0.1');

			this.logger?.infoSync('VPN connectivity test passed', {
				component: LogComponents.wireGuardManager,
				operation: 'testConnectivity',
			});

			return true;
		} catch (_error) {
			this.logger?.warnSync('VPN connectivity test failed (may take time to establish)', {
				component: LogComponents.wireGuardManager,
				operation: 'testConnectivity',
			});
			return false;
		}
	}

	/**
	* Enable WireGuard auto-start on boot
	*/
	private async enableAutoStart(): Promise<void> {
		try {
			// Check if systemd is available
			try {
				await execAsync('which systemctl');
			} catch {
				this.logger?.warnSync('systemd not available - skipping auto-start setup', {
					component: LogComponents.wireGuardManager,
					operation: 'enableAutoStart',
				});
				return;
			}

			// Enable wg-quick@wg0 service
			await execAsync(`systemctl enable wg-quick@${this.interfaceName}`);

			this.logger?.infoSync('WireGuard auto-start enabled', {
				component: LogComponents.wireGuardManager,
				operation: 'enableAutoStart',
			});
		} catch (_error) {
			this.logger?.warnSync('Failed to enable auto-start (non-critical)', {
				component: LogComponents.wireGuardManager,
				operation: 'enableAutoStart',
			});
		}
	}

	/**
	* Parse byte string to number (e.g., "1.23 KiB" -> 1259)
	*/
	private parseBytes(str: string): number {
		const match = str.match(/([\d.]+)\s+(\w+)/);
		if (!match) return 0;

		const value = parseFloat(match[1]);
		const unit = match[2].toLowerCase();

		const multipliers: Record<string, number> = {
			'b': 1,
			'kib': 1024,
			'mib': 1024 * 1024,
			'gib': 1024 * 1024 * 1024,
		};

		return value * (multipliers[unit] || 1);
	}
}

