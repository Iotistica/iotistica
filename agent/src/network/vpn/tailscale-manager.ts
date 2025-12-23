/**
 * Tailscale VPN Manager
 * 
 * Manages Tailscale client installation, configuration, and lifecycle on IoT devices.
 * Handles auth key authentication and automatic mesh network joining.
 * 
 * Features:
 * - Automatic Tailscale client installation
 * - Auth key-based device authentication
 * - Hostname configuration
 * - Connection status monitoring
 * - Graceful shutdown and cleanup
 * 
 * Documentation: https://tailscale.com/kb/1080/cli
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

const execAsync = promisify(exec);

export interface TailscaleConfig {
	authKey: string;
	tailnetName: string;
	hostname?: string;
	advertiseRoutes?: string[];  // CIDR ranges to advertise
	acceptRoutes?: boolean;      // Accept routes from other nodes
	acceptDNS?: boolean;         // Use Tailscale DNS
	shieldsUp?: boolean;         // Enable shields up (block incoming)
}

export interface TailscaleStatus {
	connected: boolean;
	tailnetIP?: string;
	hostname?: string;
	online?: boolean;
	lastSeen?: string;
}

export class TailscaleManager {
	private logger?: AgentLogger;
	private configDir: string;
	private isInstalled: boolean = false;

	constructor(logger?: AgentLogger, configDir: string = '/etc/iotistic/tailscale') {
		this.logger = logger;
		this.configDir = configDir;
	}

	/**
	 * Check if Tailscale is installed
	 */
	async checkInstallation(): Promise<boolean> {
		try {
			await execAsync('tailscale --version');
			this.isInstalled = true;
			this.logger?.infoSync('Tailscale client detected', {
				component: LogComponents.tailscaleManager,
			});
			return true;
		} catch {
			this.isInstalled = false;
			this.logger?.warnSync('Tailscale client not installed', {
				component: LogComponents.tailscaleManager,
			});
			return false;
		}
	}

	/**
	 * Install Tailscale client
	 * Downloads and installs using official installation script
	 */
	async install(): Promise<void> {
		if (this.isInstalled) {
			this.logger?.infoSync('Tailscale already installed, skipping', {
				component: LogComponents.tailscaleManager,
			});
			return;
		}

		try {
			this.logger?.infoSync('Installing Tailscale client...', {
				component: LogComponents.tailscaleManager,
			});

			// Use official Tailscale installation script
			const installScript = `curl -fsSL https://tailscale.com/install.sh | sh`;

			await execAsync(installScript);

			// Verify installation
			await execAsync('tailscale --version');
			this.isInstalled = true;

			this.logger?.infoSync('Tailscale client installed successfully', {
				component: LogComponents.tailscaleManager,
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Tailscale installation failed', err, {
				component: LogComponents.tailscaleManager,
			});
			throw err;
		}
	}

	/**
	 * Configure and start Tailscale with auth key
	 */
	async configure(config: TailscaleConfig): Promise<void> {
		if (!this.isInstalled) {
			await this.install();
		}

		try {
			// Ensure config directory exists
			if (!existsSync(this.configDir)) {
				await mkdir(this.configDir, { recursive: true });
			}

			// Save auth key to file (for backup/audit)
			const authKeyPath = path.join(this.configDir, 'authkey');
			await writeFile(authKeyPath, config.authKey, { mode: 0o600 });

			this.logger?.infoSync('Connecting to Tailscale network...', {
				component: LogComponents.tailscaleManager,
				tailnet: config.tailnetName,
				hostname: config.hostname,
			});

			// Build tailscale up command
			const args = ['up', '--authkey', config.authKey];

			// Optional: Set hostname
			if (config.hostname) {
				args.push('--hostname', config.hostname);
			}

			// Optional: Advertise routes
			if (config.advertiseRoutes && config.advertiseRoutes.length > 0) {
				args.push('--advertise-routes', config.advertiseRoutes.join(','));
			}

			// Optional: Accept routes
			if (config.acceptRoutes) {
				args.push('--accept-routes');
			}

			// Optional: Accept DNS
			if (config.acceptDNS !== false) {
				args.push('--accept-dns');
			}

			// Optional: Shields up
			if (config.shieldsUp) {
				args.push('--shields-up');
			}

			// Execute tailscale up
			const { stdout, stderr } = await execAsync(`tailscale ${args.join(' ')}`);

			if (stderr && !stderr.includes('Success')) {
				this.logger?.warnSync('Tailscale connection warning', {
					component: LogComponents.tailscaleManager,
					stderr,
				});
			}

			this.logger?.infoSync('Connected to Tailscale network', {
				component: LogComponents.tailscaleManager,
				tailnet: config.tailnetName,
				output: stdout.trim(),
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Tailscale configuration failed', err, {
				component: LogComponents.tailscaleManager,
			});
			throw err;
		}
	}

	/**
	 * Get Tailscale status
	 */
	async getStatus(): Promise<TailscaleStatus> {
		if (!this.isInstalled) {
			return { connected: false };
		}

		try {
			const { stdout } = await execAsync('tailscale status --json');
			const status = JSON.parse(stdout);

			// Extract self node information
			const selfNode = status.Self;
			const connected = selfNode && status.BackendState === 'Running';

			return {
				connected,
				tailnetIP: selfNode?.TailscaleIPs?.[0],
				hostname: selfNode?.HostName,
				online: selfNode?.Online,
				lastSeen: selfNode?.LastSeen,
			};
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Failed to get Tailscale status', err, {
				component: LogComponents.tailscaleManager,
			});
			return { connected: false };
		}
	}

	/**
	 * Disconnect from Tailscale (but keep client installed)
	 */
	async disconnect(): Promise<void> {
		if (!this.isInstalled) {
			return;
		}

		try {
			this.logger?.infoSync('Disconnecting from Tailscale...', {
				component: LogComponents.tailscaleManager,
			});

			await execAsync('tailscale down');

			this.logger?.infoSync('Disconnected from Tailscale', {
				component: LogComponents.tailscaleManager,
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Tailscale disconnect failed', err, {
				component: LogComponents.tailscaleManager,
			});
			throw err;
		}
	}

	/**
	 * Get Tailscale IP address
	 */
	async getIP(): Promise<string | null> {
		const status = await this.getStatus();
		return status.tailnetIP || null;
	}

	/**
	 * Logout from Tailscale (removes device from network)
	 */
	async logout(): Promise<void> {
		if (!this.isInstalled) {
			return;
		}

		try {
			this.logger?.infoSync('Logging out from Tailscale...', {
				component: LogComponents.tailscaleManager,
			});

			await execAsync('tailscale logout');

			this.logger?.infoSync('Logged out from Tailscale', {
				component: LogComponents.tailscaleManager,
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Tailscale logout failed', err, {
				component: LogComponents.tailscaleManager,
			});
			throw err;
		}
	}

	/**
	 * Ping another node in the Tailnet
	 */
	async ping(hostname: string, count: number = 3): Promise<boolean> {
		if (!this.isInstalled) {
			return false;
		}

		try {
			const { stdout } = await execAsync(`tailscale ping -c ${count} ${hostname}`);
			const success = stdout.includes('pong');

			this.logger?.infoSync('Tailscale ping result', {
				component: LogComponents.tailscaleManager,
				hostname,
				success,
			});

			return success;
		} catch (error: any) {
			this.logger?.warnSync(`Tailscale ping failed: ${error.message}`, {
				component: LogComponents.tailscaleManager,
				hostname,
			});
			return false;
		}
	}
}
