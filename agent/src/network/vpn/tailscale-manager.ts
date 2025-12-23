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

/**
 * Execute command using spawn with args array (prevents shell injection)
 */
function spawnAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'pipe' });
		let stdout = '';
		let stderr = '';

		child.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		child.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const error = new Error(`Command failed with exit code ${code}: ${stderr || stdout}`);
				(error as any).code = code;
				(error as any).stdout = stdout;
				(error as any).stderr = stderr;
				reject(error);
			}
		});

		child.on('error', (err) => {
			reject(err);
		});
	});
}

export interface TailscaleConfig {
	authKey: string;
	tailnetName: string;
	hostname?: string;
	advertiseRoutes?: string[];  // CIDR ranges to advertise (use for routers/gateways only)
	acceptRoutes?: boolean;      // DANGEROUS: Accept subnet routes from other nodes (false unless device is router/gateway/site-to-site bridge)
	acceptDNS?: boolean;         // Hijack DNS for MagicDNS (false unless you need device-name.tailnet.ts.net resolution - can break embedded workloads)
	shieldsUp?: boolean;         // Block ALL inbound traffic (recommended true for IoT edge devices)
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
	 * Ensure tailscaled daemon is enabled and running
	 */
	private async ensureDaemonRunning(): Promise<void> {
		try {
			// Check if tailscaled service is active
			const { stdout } = await execAsync('systemctl is-active tailscaled');
			if (stdout.trim() === 'active') {
				this.logger?.infoSync('Tailscaled daemon is running', {
					component: LogComponents.tailscaleManager,
				});
				return;
			}
		} catch {
			// Service not active, will enable and start below
		}

		try {
			this.logger?.infoSync('Starting tailscaled daemon...', {
				component: LogComponents.tailscaleManager,
			});

			// Enable and start tailscaled service
			await execAsync('systemctl enable --now tailscaled');

			this.logger?.infoSync('Tailscaled daemon started successfully', {
				component: LogComponents.tailscaleManager,
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Failed to start tailscaled daemon', err, {
				component: LogComponents.tailscaleManager,
			});
			throw err;
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

			// Ensure daemon is enabled and running
			await this.ensureDaemonRunning();

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
	 * Only re-authenticates if not already running or configuration changed
	 */
	async configure(config: TailscaleConfig): Promise<void> {
		if (!this.isInstalled) {
			await this.install();
		}

		try {
			// Ensure tailscaled daemon is running before attempting connection
			await this.ensureDaemonRunning();

			// Check if already authenticated and running
			const currentStatus = await this.getStatus();
			
			if (currentStatus.connected) {
				this.logger?.infoSync('Tailscale already connected, skipping re-authentication', {
					component: LogComponents.tailscaleManager,
					tailnet: config.tailnetName,
					tailscaleIP: currentStatus.tailnetIP,
					hostname: currentStatus.hostname,
				});
				
				// Note: We could add flag comparison here in the future to detect config changes
				// For now, trust that if connected, the existing config is correct
				return;
			}

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

			// Build tailscale up command with JSON output for structured parsing
			const args = ['up', '--authkey', config.authKey, '--json'];

			// Optional: Set hostname
			if (config.hostname) {
				args.push('--hostname', config.hostname);
			}

			// Optional: Advertise routes (for routers/gateways only)
			if (config.advertiseRoutes && config.advertiseRoutes.length > 0) {
				args.push('--advertise-routes', config.advertiseRoutes.join(','));
			}

			// Optional: Accept routes - ONLY enable for routers/gateways/site-to-site bridges
			// Regular IoT edge devices should NEVER accept routes (security risk)
			if (config.acceptRoutes === true) {
				args.push('--accept-routes');
			}

			// Optional: Accept DNS - ONLY enable if MagicDNS needed (can break embedded DNS)
			// Default false to avoid hijacking DNS on IoT devices with custom DNS configs
			if (config.acceptDNS === true) {
				args.push('--accept-dns');
			}

			// Optional: Shields up - RECOMMENDED for IoT edge devices (blocks all inbound traffic)
			if (config.shieldsUp === true) {
				args.push('--shields-up');
			}

			// Execute tailscale up with JSON output using spawn (prevents shell injection)
			const { stdout } = await spawnAsync('tailscale', args);

			// Parse JSON response for structured validation
			const result = JSON.parse(stdout);

			// Check backend state - use defensive checks against schema drift
			// Instead of exact match, check that we're online and not stopped
			const isConnected = result.Self?.Online === true && result.BackendState !== 'Stopped';
			
			if (!isConnected) {
				this.logger?.warnSync('Tailscale authentication completed but not connected', {
					component: LogComponents.tailscaleManager,
					backendState: result.BackendState,
					online: result.Self?.Online,
					authURL: result.AuthURL,
				});
				throw new Error(`Tailscale not connected (BackendState: ${result.BackendState}, Online: ${result.Self?.Online})`);
			}

			this.logger?.infoSync('Connected to Tailscale network', {
				component: LogComponents.tailscaleManager,
				tailnet: config.tailnetName,
				backendState: result.BackendState,
				selfNode: result.Self?.HostName,
				tailscaleIP: result.Self?.TailscaleIPs?.[0],
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
			
			// Use defensive checks against schema drift:
			// - Check node is online (positive check)
			// - Check backend is not stopped (negative check, more future-proof)
			const connected = selfNode?.Online === true && status.BackendState !== 'Stopped';

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
			// Use spawn to prevent shell injection via hostname parameter
			const { stdout } = await spawnAsync('tailscale', ['ping', '-c', count.toString(), hostname]);
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
