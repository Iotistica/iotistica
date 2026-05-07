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
 * Container Requirements:
 * - Volume mount required for state persistence: /var/lib/tailscale
 *   Example (docker-compose.yml):
 *   ```yaml
 *   volumes:
 *     - tailscale-state:/var/lib/tailscale
 *   ```
 *   Without this volume, authentication state will be lost on container restart
 *   and devices will need to re-authenticate with a new auth key.
 * 
 * Documentation: https://tailscale.com/kb/1080/cli
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { access, readFile } from 'fs/promises';
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
	tailnetName: string; // For logging/diagnostics only - not used in Tailscale CLI commands
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
	private configDir: string; // Reserved for future use (e.g., storing tailscale config files)
	private isInstalled: boolean = false;
	private daemonStarting: boolean = false; // Mutex to prevent parallel daemon spawns

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
	* IDEMPOTENT: Safe to call multiple times - mutex prevents parallel daemon spawns
	*/
	async ensureDaemonRunning(): Promise<void> {
		// Mutex: Prevent parallel daemon spawns during startup storms
		if (this.daemonStarting) {
			this.logger?.debugSync('Daemon already starting, waiting for completion', {
				component: LogComponents.tailscaleManager,
			});
			// Wait for other caller to finish (simple spin-wait with backoff)
			while (this.daemonStarting) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			return;
		}
		
		const isContainer = await this.isRunningInContainer();

		if (isContainer) {
			// In container: Start tailscaled directly (no systemd)
			this.daemonStarting = true; // Acquire mutex
			try {
				// Check if tailscaled is already running (socket-level health check)
				try {
					const { stdout } = await execAsync('tailscale status --json');
					const status = JSON.parse(stdout);
					if (status.BackendState) {
						this.logger?.infoSync('Tailscaled daemon already running', {
							component: LogComponents.tailscaleManager,
							backendState: status.BackendState,
						});
						return;
					}
				} catch {
				// Not running or socket not ready, will start it below
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

					// Verify daemon started (socket-level health check - more reliable than pgrep)
					try {
						const { stdout } = await execAsync('tailscale status --json');
						const status = JSON.parse(stdout);
						if (status.BackendState) {
							this.logger?.infoSync('Tailscaled daemon started successfully (container mode)', {
								component: LogComponents.tailscaleManager,
								backendState: status.BackendState,
								attempt: attempt + 1,
								delayMs: Math.round(delay),
							});
							this.daemonStarting = false; // Release mutex
							return;
						}
					} catch {
						// Socket not ready yet, continue retrying
						if (attempt === maxAttempts - 1) {
							// Final attempt failed
							this.logger?.errorSync('Tailscaled spawn output', new Error(daemonOutput || 'No output captured'), {
								component: LogComponents.tailscaleManager,
								maxAttempts,
							});
							throw new Error('Tailscaled daemon failed to start (socket not ready)');
						}
					}
				}
			} catch (error: any) {
				this.daemonStarting = false; // Release mutex on error
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
			// Detect config drift by checking if current config matches desired config
				let configDrift = false;
				const driftReasons: string[] = [];
			
				try {
				// Fetch full status with preferences
					const { stdout } = await execAsync('tailscale status --json');
					const fullStatus = JSON.parse(stdout);
				
					// Check hostname drift
					if (config.hostname && fullStatus.Self?.HostName !== config.hostname) {
						configDrift = true;
						driftReasons.push(`hostname: ${fullStatus.Self?.HostName} → ${config.hostname}`);
					}
				
					// Check shields-up drift (Prefs.ShieldsUp)
					const currentShieldsUp = fullStatus.Self?.ShieldsUp === true;
					const desiredShieldsUp = config.shieldsUp === true;
					if (currentShieldsUp !== desiredShieldsUp) {
						configDrift = true;
						driftReasons.push(`shieldsUp: ${currentShieldsUp} → ${desiredShieldsUp}`);
					}
				
					// Check advertise routes drift
					if (config.advertiseRoutes && config.advertiseRoutes.length > 0) {
						const currentRoutes = fullStatus.Self?.AllowedIPs || [];
						const desiredRoutes = config.advertiseRoutes;
						const routesDiffer = JSON.stringify(currentRoutes.sort()) !== JSON.stringify(desiredRoutes.sort());
						if (routesDiffer) {
							configDrift = true;
							driftReasons.push(`advertiseRoutes: ${currentRoutes.join(',')} → ${desiredRoutes.join(',')}`);
						}
					}
				
					// Check accept-routes drift (Prefs.RouteAll)
					const currentAcceptRoutes = fullStatus.Self?.RouteAll === true;
					const desiredAcceptRoutes = config.acceptRoutes === true;
					if (currentAcceptRoutes !== desiredAcceptRoutes) {
						configDrift = true;
						driftReasons.push(`acceptRoutes: ${currentAcceptRoutes} → ${desiredAcceptRoutes}`);
					}
				
					// Check accept-dns drift (Prefs.CorpDNS)
					const currentAcceptDNS = fullStatus.Self?.CorpDNS === true;
					const desiredAcceptDNS = config.acceptDNS === true;
					if (currentAcceptDNS !== desiredAcceptDNS) {
						configDrift = true;
						driftReasons.push(`acceptDNS: ${currentAcceptDNS} → ${desiredAcceptDNS}`);
					}
				
				} catch (error: any) {
					this.logger?.warnSync('Failed to detect config drift, assuming no drift', {
						component: LogComponents.tailscaleManager,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			
				if (!configDrift) {
					this.logger?.infoSync('Tailscale already connected with correct config', {
						component: LogComponents.tailscaleManager,
						tailnet: config.tailnetName,
						tailscaleIP: currentStatus.tailnetIP,
						hostname: currentStatus.hostname,
					});
					return;
				}
			
				// Config drift detected - re-run tailscale up to apply changes
				this.logger?.infoSync('Config drift detected, re-applying configuration', {
					component: LogComponents.tailscaleManager,
					driftReasons,
				});
			// Continue to tailscale up below (don't return early)
			}

			// SECURITY: Validate auth key format
			// All Tailscale auth keys start with tskey-auth- (both ephemeral and reusable)
			// The ephemeral flag is a server-side property, not part of the key prefix
			// Allow override for dev/test via TAILSCALE_DEV_MODE environment variable
			const isDevMode = process.env.TAILSCALE_DEV_MODE === 'true';
		
			if (!config.authKey.startsWith('tskey-auth-')) {
				if (isDevMode) {
					this.logger?.warnSync('Dev mode: Accepting non-standard auth key format', {
						component: LogComponents.tailscaleManager,
						keyPrefix: config.authKey.substring(0, 10),
						note: 'TAILSCALE_DEV_MODE=true allows test keys',
					});
				} else {
					this.logger?.errorSync('Invalid Tailscale auth key format', new Error('Auth key must start with tskey-auth-'), {
						component: LogComponents.tailscaleManager,
						keyPrefix: config.authKey.substring(0, 10),
						note: 'All Tailscale auth keys start with tskey-auth-',
						recommendation: 'Generate auth keys at https://login.tailscale.com/admin/settings/keys',
					});
					throw new Error('Invalid Tailscale auth key format - must start with tskey-auth-');
				}
			}
		
			// NOTE: Ephemeral enforcement must be done via provisioning policy
			// There is no client-side way to validate if a tskey-auth-* key is ephemeral
			// Best practice: Generate ephemeral-only keys in your provisioning system

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
			// NOTE: tailscale up --json output is undocumented and can change
			// Warnings printed to stdout will break JSON parsing
			// Defensive: Try to parse, fall back to polling if it fails
			let result: any;
			try {
				result = JSON.parse(stdout);
			
				this.logger?.infoSync('Tailscale authentication initiated', {
					component: LogComponents.tailscaleManager,
					backendState: result.BackendState,
					online: result.Self?.Online,
				});
			} catch (parseError) {
			// JSON parsing failed - likely due to warnings or format change
				this.logger?.warnSync('Failed to parse tailscale up JSON output, falling back to status polling', {
					component: LogComponents.tailscaleManager,
					parseError: parseError instanceof Error ? parseError.message : String(parseError),
					rawOutput: stdout.substring(0, 200), // Log first 200 chars for debugging
				});
			
				// Fall back to polling tailscale status (no need for result object)
				result = null;
			}
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
		// Lazy check: Tailscale might be installed but agent restarted
		if (!this.isInstalled) {
			await this.checkInstallation();
		}
		
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
				backendState: status.BackendState,
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
	/**
	* Disconnect from Tailscale (but keep client installed)
	*/
	async disconnect(): Promise<void> {
		// Lazy check: Tailscale might be installed but agent restarted
		if (!this.isInstalled) {
			await this.checkInstallation();
		}
		
		if (!this.isInstalled) {
			return;
		}

		try {
			this.logger?.infoSync('Disconnecting from Tailscale...', {
				component: LogComponents.tailscaleManager,
			});

			// Use --accept-risk=all on newer versions to suppress warnings
			// when shields-up or routes were enabled (prevents interactive prompts)
			// Falls back to plain 'tailscale down' on older versions that don't support the flag
			try {
				await execAsync('tailscale down --accept-risk=all');
			} catch (error: any) {
				// Fallback for older Tailscale versions that don't support --accept-risk
				if (error.message?.includes('unknown flag') || error.message?.includes('accept-risk')) {
					this.logger?.debugSync('Falling back to tailscale down without --accept-risk flag', {
						component: LogComponents.tailscaleManager,
					});
					await execAsync('tailscale down');
				} else {
					throw error;
				}
			}

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
		// Lazy check: Tailscale might be installed but agent restarted
		if (!this.isInstalled) {
			await this.checkInstallation();
		}
		
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
		// Lazy check: Tailscale might be installed but agent restarted
		if (!this.isInstalled) {
			await this.checkInstallation();
		}
		
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

		// Check if daemon is running (socket-level health check - more reliable than pgrep)
		let daemonRunning = false;
		try {
			const { stdout } = await execAsync('tailscale status --json');
			const status = JSON.parse(stdout);
			daemonRunning = !!status.BackendState;
		} catch {
			// Socket not reachable or daemon not running
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

	/**
	* Log VPN health issues with state-aware classification
	* Reduces alert noise by distinguishing transient states from actual failures
	* 
	* @param vpnHealth - Health status from getHealth()
	*/
	logHealthIssues(vpnHealth: {
		installed: boolean;
		daemonRunning: boolean;
		connected: boolean;
		backendState?: string;
	}): void {
		// State-aware classification reduces alert noise
		if (!vpnHealth.installed) {
			// Not installed - provisioning issue, ignore
		} else if (!vpnHealth.daemonRunning) {
			this.logger?.warnSync('VPN installed but daemon not running', {
				component: LogComponents.tailscaleManager,
				operation: 'vpn-health-check',
				action: 'restart-daemon'
			});
		} else if (!vpnHealth.connected) {
			// Daemon running but not connected - distinguish failure modes
			// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
			switch (vpnHealth.backendState) {
				case 'NeedsLogin':
					this.logger?.errorSync('VPN requires re-authentication', undefined, {
						component: LogComponents.tailscaleManager,
						operation: 'vpn-health-check',
						action: 'reprovision',
						note: 'Auth key expired or revoked'
					});
					break;
				
				case 'Starting':
					// Normal transient - do not alert
					this.logger?.debugSync('VPN starting (transient)', {
						component: LogComponents.tailscaleManager,
						operation: 'vpn-health-check'
					});
					break;
				
				case 'Stopped':
					this.logger?.warnSync('VPN backend stopped unexpectedly', {
						component: LogComponents.tailscaleManager,
						operation: 'vpn-health-check',
						action: 'restart-daemon',
						note: 'Daemon state lost'
					});
					break;
				
				default:
					this.logger?.warnSync('VPN daemon running but not connected', {
						component: LogComponents.tailscaleManager,
						operation: 'vpn-health-check',
						backendState: vpnHealth.backendState,
						note: 'Likely network isolation or blocked UDP'
					});
			}
		}
	}
}
