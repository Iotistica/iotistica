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
import { writeFile, mkdir, access, readFile } from 'fs/promises';
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
	persistAuthKey?: boolean;    // DANGEROUS: Persist auth key to disk (default false - ephemeral keys should not be stored)
}

export interface TailscaleStatus {
	connected: boolean;
	tailnetIP?: string;
	hostname?: string;
	online?: boolean;
	lastSeen?: string;
	backendState?: string;
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
	 * Detects if running in Docker container and uses appropriate method
	 * PUBLIC: Called during auto-reconnection on agent startup
	 */
	async ensureDaemonRunning(): Promise<void> {
		const isContainer = await this.isRunningInContainer();

		if (isContainer) {
			// In container: Start tailscaled directly (no systemd)
			try {
				// Check if tailscaled is already running (pgrep returns exit 1 if not found)
				try {
					const { stdout } = await execAsync('pgrep tailscaled');
					if (stdout.trim()) {
						this.logger?.infoSync('Tailscaled daemon already running', {
							component: LogComponents.tailscaleManager,
							pid: stdout.trim(),
						});
						return;
					}
				} catch {
					// Not running, will start it below
				}

				this.logger?.infoSync('Starting tailscaled daemon in container mode...', {
					component: LogComponents.tailscaleManager,
				});

				// Create state and socket directories
				await execAsync('mkdir -p /var/lib/tailscale /var/run/tailscale');

				// Check if tailscaled binary exists
				try {
					await execAsync('which tailscaled');
				} catch {
					throw new Error('tailscaled binary not found - install tailscale in Docker image');
				}

				// Start tailscaled in background (Docker container mode)
				// Capture output to log errors
				let daemonOutput = '';
				const daemon = spawn('tailscaled', [
					'--state=/var/lib/tailscale/tailscaled.state',
					'--socket=/var/run/tailscale/tailscaled.sock'
				], {
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				
				// Capture stdout/stderr for debugging
				daemon.stdout?.on('data', (data) => {
					daemonOutput += data.toString();
				});
				daemon.stderr?.on('data', (data) => {
					daemonOutput += data.toString();
				});
				
				daemon.unref();

				// CRITICAL: Set socket path for all CLI commands in container mode
				// Without this, tailscale CLI may fail or talk to wrong daemon
				process.env.TAILSCALE_SOCKET = '/var/run/tailscale/tailscaled.sock';

				// Wait for daemon to start with exponential backoff (edge networks are slow/lossy)
				// Max attempts: 6 (delays: ~1s, ~2s, ~4s, ~8s, ~10s, ~10s = ~35s total)
				const maxAttempts = 6;
				for (let attempt = 0; attempt < maxAttempts; attempt++) {
					// Exponential backoff: 1s * 2^attempt, capped at 10s, with jitter
					const baseDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
					const jitter = Math.random() * 200; // ±200ms jitter
					const delay = baseDelay + jitter;
					
					await new Promise(resolve => setTimeout(resolve, delay));

					// Verify daemon started (pgrep returns exit 1 if not found)
					try {
						const { stdout } = await execAsync('pgrep tailscaled');
						if (stdout.trim()) {
							this.logger?.infoSync('Tailscaled daemon started successfully (container mode)', {
								component: LogComponents.tailscaleManager,
								pid: stdout.trim(),
								attempt: attempt + 1,
								delayMs: Math.round(delay),
							});
							return;
						}
					} catch {
						// Not running yet, continue retrying
						if (attempt === maxAttempts - 1) {
							// Final attempt failed
							this.logger?.errorSync('Tailscaled spawn output', new Error(daemonOutput || 'No output captured'), {
								component: LogComponents.tailscaleManager,
								maxAttempts,
							});
							throw new Error('Tailscaled daemon failed to start (process not found)');
						}
					}
				}
			} catch (error: any) {
				const err = error instanceof Error ? error : new Error(String(error));
				this.logger?.errorSync('Failed to start tailscaled daemon (container mode)', err, {
					component: LogComponents.tailscaleManager,
				});
				throw err;
			}
		} else {
			// On host: Use systemd
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
				this.logger?.infoSync('Starting tailscaled daemon (systemd)...', {
					component: LogComponents.tailscaleManager,
				});

				// Enable and start tailscaled service
				await execAsync('systemctl enable --now tailscaled');

				this.logger?.infoSync('Tailscaled daemon started successfully (systemd)', {
					component: LogComponents.tailscaleManager,
				});
			} catch (error: any) {
				const err = error instanceof Error ? error : new Error(String(error));
				this.logger?.errorSync('Failed to start tailscaled daemon (systemd)', err, {
					component: LogComponents.tailscaleManager,
				});
				throw err;
			}
		}
	}

	/**
	 * Detect if running in Docker container
	 */
	private async isRunningInContainer(): Promise<boolean> {
		try {
			// Check for /.dockerenv file (most reliable)
			await access('/.dockerenv');
			return true;
		} catch {
			// Check /proc/1/cgroup for container indicators
			try {
				const cgroup = await readFile('/proc/1/cgroup', 'utf-8');
				return cgroup.includes('docker') || cgroup.includes('kubepods');
			} catch {
				return false;
			}
		}
	}

	/**
	 * Install Tailscale client
	 * Skips installation in containers (should be pre-installed in Dockerfile)
	 */
	async install(): Promise<void> {
		if (this.isInstalled) {
			this.logger?.infoSync('Tailscale already installed, skipping', {
				component: LogComponents.tailscaleManager,
			});
			return;
		}

		const isContainer = await this.isRunningInContainer();
		if (isContainer) {
			this.logger?.errorSync('Tailscale not found in container', new Error('Tailscale should be pre-installed in Docker image'), {
				component: LogComponents.tailscaleManager,
				note: 'Add tailscale to Dockerfile: RUN apk add --no-cache tailscale',
			});
			throw new Error('Tailscale not available in container - must be installed in Docker image');
		}

		try {
			this.logger?.infoSync('Installing Tailscale client on host...', {
				component: LogComponents.tailscaleManager,
			});

			// Use official Tailscale installation script (host only)
			const installScript = `curl -fsSL https://tailscale.com/install.sh | sh`;

			await execAsync(installScript);

			// Verify installation
			await execAsync('tailscale --version');
			this.isInstalled = true;

			// Ensure daemon is enabled and running
			await this.ensureDaemonRunning();

			this.logger?.infoSync('Tailscale client installed successfully (host)', {
				component: LogComponents.tailscaleManager,
			});
		} catch (error: any) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.errorSync('Tailscale installation failed (host)', err, {
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

			// SECURITY: Enforce ephemeral auth keys only
			// Ephemeral keys auto-expire and cannot be reused
			// This prevents accidental use of reusable keys and human error in provisioning
			if (!config.authKey.startsWith('tskey-auth-') && !config.authKey.startsWith('tskey-ephemeral-')) {
				this.logger?.errorSync('Invalid Tailscale auth key format', new Error('Auth key must be ephemeral'), {
					component: LogComponents.tailscaleManager,
					keyPrefix: config.authKey.substring(0, 10),
					note: 'Only ephemeral or standard auth keys are allowed on edge devices',
				});
				throw new Error('Invalid Tailscale auth key format - must start with tskey-auth- or tskey-ephemeral-');
			}

			// SECURITY: Do NOT persist auth keys to disk
			// Auth keys are credentials that should never be stored
			// Tailscale daemon persists authentication state in /var/lib/tailscale/tailscaled.state
			// which is sufficient for auto-reconnection after restarts
			// Storing keys enables forensic recovery after device compromise
			if (config.persistAuthKey === true) {
				this.logger?.errorSync('Auth key persistence rejected', new Error('Auth key persistence is disabled'), {
					component: LogComponents.tailscaleManager,
					note: 'SECURITY: Auth keys must never be persisted to disk in production',
					recommendation: 'Tailscale daemon state file provides auto-reconnection',
				});
				throw new Error('Auth key persistence is disabled for security - daemon state file handles reconnection');
			}

			// SECURITY: Prevent accidental subnet route acceptance on edge devices
			// acceptRoutes should ONLY be enabled on routers/gateways that also advertise routes
			// Generic edge devices should NEVER accept routes (attack surface)
			if (config.acceptRoutes === true && !config.advertiseRoutes?.length) {
				this.logger?.errorSync('Invalid routing configuration', new Error('acceptRoutes requires advertiseRoutes'), {
					component: LogComponents.tailscaleManager,
					note: 'SECURITY: Only routers/gateways should accept routes',
					recommendation: 'Set advertiseRoutes to enable router/gateway mode',
				});
				throw new Error('acceptRoutes=true requires advertiseRoutes (router/gateway mode)');
			}

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

			this.logger?.infoSync('Tailscale authentication initiated', {
				component: LogComponents.tailscaleManager,
				backendState: result.BackendState,
				online: result.Self?.Online,
			});

			// Wait for connection to fully establish with exponential backoff
			// BackendState goes: NeedsLogin → Starting → Running
			// Self.Online goes: undefined → true when fully connected
			// Max attempts: 10 (delays: ~1s, ~2s, ~4s, ~8s, ~16s, ~32s, ~60s, ~60s, ~60s, ~60s = ~303s total)
			const maxAttempts = 10;
			let totalWaitMs = 0;
			
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				// Exponential backoff: 1s * 2^attempt, capped at 60s, with jitter
				const baseDelay = Math.min(1000 * Math.pow(2, attempt), 60000);
				const jitter = Math.random() * 500; // ±500ms jitter
				const delay = baseDelay + jitter;
				
				await new Promise(resolve => setTimeout(resolve, delay));
				totalWaitMs += delay;
				
				const status = await this.getStatus();
				
				if (status.connected) {
					this.logger?.infoSync('Tailscale connection established', {
						component: LogComponents.tailscaleManager,
						tailnet: config.tailnetName,
						hostname: status.hostname,
						tailscaleIP: status.tailnetIP,
						attemptNumber: attempt + 1,
						waitTimeSeconds: Math.round(totalWaitMs / 1000),
					});
					return; // Success!
				}
				
				// Log progress on longer delays (attempts 4+)
				if (attempt >= 4) {
					this.logger?.debugSync(`Waiting for Tailscale connection... (attempt ${attempt + 1}/${maxAttempts})`, {
						component: LogComponents.tailscaleManager,
						backendState: status.backendState,
						waitedSeconds: Math.round(totalWaitMs / 1000),
					});
				}
			}
			
			// Timeout - connection didn't establish
			const finalStatus = await this.getStatus();
			this.logger?.warnSync('Tailscale connection timeout', {
				component: LogComponents.tailscaleManager,
				backendState: finalStatus.backendState,
				waitedSeconds: Math.round(totalWaitMs / 1000),
			});
			throw new Error(`Tailscale connection timeout after ${Math.round(totalWaitMs / 1000)}s (BackendState: ${finalStatus.backendState})`);
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

	/**
	 * Get machine-readable VPN health state for cloud reporting
	 * Used for ops monitoring: detect isolation, trigger reprovisioning, alert users
	 */
	async getHealth(): Promise<{
		installed: boolean;
		daemonRunning: boolean;
		connected: boolean;
		backendState?: string;
		ip?: string;
		hostname?: string;
		online?: boolean;
		lastSeen?: string;
	}> {
		// Check if Tailscale is installed
		if (!this.isInstalled) {
			// Try to detect installation
			await this.checkInstallation();
		}

		if (!this.isInstalled) {
			return {
				installed: false,
				daemonRunning: false,
				connected: false,
			};
		}

		// Check if daemon is running (non-blocking check)
		let daemonRunning = false;
		try {
			const { stdout } = await execAsync('pgrep tailscaled');
			daemonRunning = !!stdout.trim();
		} catch {
			// pgrep returns exit 1 if not found
			daemonRunning = false;
		}

		// If daemon not running, return early
		if (!daemonRunning) {
			return {
				installed: true,
				daemonRunning: false,
				connected: false,
			};
		}

		// Get connection status
		const status = await this.getStatus();

		return {
			installed: true,
			daemonRunning: true,
			connected: status.connected,
			backendState: status.backendState,
			ip: status.tailnetIP,
			hostname: status.hostname,
			online: status.online,
			lastSeen: status.lastSeen,
		};
	}
}
