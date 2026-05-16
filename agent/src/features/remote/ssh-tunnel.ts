import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

export interface SSHTunnelConfig {
  cloudHost: string;
  cloudPort: number;
  localPort: number;
  sshUser: string;
  sshKeyPath: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

export class SSHTunnelManager {
	private process?: ChildProcess;
	private config: SSHTunnelConfig;
	private isConnecting: boolean = false;
	private reconnectTimer?: NodeJS.Timeout;
	private logger?: AgentLogger;

	constructor(config: SSHTunnelConfig, logger?: AgentLogger) {
		this.config = {
			autoReconnect: true,
			reconnectDelay: 5000,
			...config,
		};
		this.logger = logger;
	}

	/**
   * Establish SSH reverse tunnel to cloud server
   * Creates tunnel: cloud:localPort -> device:localPort
   */
	async connect(): Promise<void> {
		if (this.isConnecting) {
			this.logger?.debugSync('SSH tunnel connection already in progress', {
				component: LogComponents.sshTunnel
			});
			return;
		}

		if (this.process) {
			this.logger?.debugSync('SSH tunnel already connected', {
				component: LogComponents.sshTunnel
			});
			return;
		}

		// Validate SSH key exists
		if (!fs.existsSync(this.config.sshKeyPath)) {
			throw new Error(`SSH key not found: ${this.config.sshKeyPath}`);
		}

		// Check SSH key permissions (should be 600)
		const stats = fs.statSync(this.config.sshKeyPath);
		const mode = (stats.mode & parseInt('777', 8)).toString(8);
		if (mode !== '600') {
			this.logger?.warnSync(`SSH key has permissions ${mode}, should be 600`, {
				component: LogComponents.sshTunnel,
				currentMode: mode,
				expectedMode: '600'
			});
			fs.chmodSync(this.config.sshKeyPath, 0o600);
			this.logger?.infoSync('Fixed SSH key permissions to 600', {
				component: LogComponents.sshTunnel
			});
		}

		this.isConnecting = true;

		const args = [
			'-R', `${this.config.localPort}:localhost:${this.config.localPort}`,
			'-i', this.config.sshKeyPath,
			'-p', this.config.cloudPort.toString(),
			'-o', 'StrictHostKeyChecking=no',
			'-o', 'ServerAliveInterval=60',
			'-o', 'ServerAliveCountMax=3',
			'-o', 'ExitOnForwardFailure=yes',
			'-N', // Don't execute remote command
			'-T', // Disable TTY
			`${this.config.sshUser}@${this.config.cloudHost}`,
		];

		console.log('🔌 Establishing SSH reverse tunnel...');
		console.log(`   Cloud: ${this.config.cloudHost}:${this.config.cloudPort}`);
		console.log(`   Tunnel: cloud:${this.config.localPort} -> device:${this.config.localPort}`);

		this.logger?.infoSync('Establishing SSH reverse tunnel', {
			component: LogComponents.sshTunnel,
			cloudHost: this.config.cloudHost,
			cloudPort: this.config.cloudPort,
			localPort: this.config.localPort
		});

		this.process = spawn('ssh', args, {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		this.process.on('spawn', () => {
			this.logger?.infoSync('SSH tunnel process started', {
				component: LogComponents.sshTunnel
			});
			this.isConnecting = false;
		});

		this.process.on('error', (error: Error) => {
			this.logger?.errorSync('SSH tunnel spawn error', error, {
				component: LogComponents.sshTunnel
			});
			this.isConnecting = false;
			this.process = undefined;
			this.scheduleReconnect();
		});

		this.process.on('close', (code: number | null, signal: string | null) => {
			this.logger?.warnSync('SSH tunnel closed', {
				component: LogComponents.sshTunnel,
				exitCode: code,
				signal
			});
			this.isConnecting = false;
			this.process = undefined;
			this.scheduleReconnect();
		});

		this.process.stdout?.on('data', (data: Buffer) => {
			this.logger?.debugSync('SSH tunnel stdout', {
				component: LogComponents.sshTunnel,
				message: data.toString().trim()
			});
		});

		this.process.stderr?.on('data', (data: Buffer) => {
			const message = data.toString().trim();
			// SSH uses stderr for normal messages too
			if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
				this.logger?.errorSync('SSH tunnel stderr', new Error(message), {
					component: LogComponents.sshTunnel
				});
			} else {
				this.logger?.debugSync('SSH tunnel info', {
					component: LogComponents.sshTunnel,
					message
				});
			}
		});

		// Give it a moment to establish
		await new Promise(resolve => setTimeout(resolve, 2000));

		if (!this.process || this.process.killed) {
			throw new Error('SSH tunnel failed to establish');
		}

		this.logger?.infoSync('SSH reverse tunnel established successfully', {
			component: LogComponents.sshTunnel
		});
	}

	/**
   * Disconnect SSH tunnel
   */
	async disconnect(): Promise<void> {
		this.logger?.infoSync('Disconnecting SSH tunnel', {
			component: LogComponents.sshTunnel
		});

		// Clear any pending reconnection
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}

		if (this.process && !this.process.killed) {
			this.process.kill('SIGTERM');
      
			// Force kill after 5 seconds
			await new Promise(resolve => setTimeout(resolve, 5000));
			if (this.process && !this.process.killed) {
				this.process.kill('SIGKILL');
			}
		}

		this.process = undefined;
		this.logger?.infoSync('SSH tunnel disconnected', {
			component: LogComponents.sshTunnel
		});
	}

	/**
   * Check if tunnel is connected
   */
	isConnected(): boolean {
		return this.process !== undefined && !this.process.killed;
	}

	/**
   * Get tunnel status information
   */
	getStatus(): {
    connected: boolean;
    connecting: boolean;
    config: Omit<SSHTunnelConfig, 'sshKeyPath'>;
    } {
		return {
			connected: this.isConnected(),
			connecting: this.isConnecting,
			config: {
				cloudHost: this.config.cloudHost,
				cloudPort: this.config.cloudPort,
				localPort: this.config.localPort,
				sshUser: this.config.sshUser,
				autoReconnect: this.config.autoReconnect,
				reconnectDelay: this.config.reconnectDelay,
			},
		};
	}

	/**
   * Schedule automatic reconnection
   */
	private scheduleReconnect(): void {
		if (!this.config.autoReconnect) {
			this.logger?.warnSync('Auto-reconnect disabled, not reconnecting', {
				component: LogComponents.sshTunnel
			});
			return;
		}

		if (this.reconnectTimer) {
			return; // Already scheduled
		}

		const delay = this.config.reconnectDelay || 5000;
		this.logger?.infoSync('Scheduling SSH tunnel reconnection', {
			component: LogComponents.sshTunnel,
			delayMs: delay
		});

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.logger?.infoSync('Attempting to reconnect SSH tunnel', {
				component: LogComponents.sshTunnel
			});
			this.connect().catch(error => {
				this.logger?.errorSync('Reconnection failed', error as Error, {
					component: LogComponents.sshTunnel
				});
			});
		}, delay);
	}

	/**
   * Perform health check on tunnel
   * Returns true if tunnel is connected and SSH process is running
   */
	async healthCheck(): Promise<boolean> {
		if (!this.isConnected()) {
			return false;
		}

		// Check if SSH process is still alive
		try {
			// Send signal 0 to check if process exists
			if (this.process?.pid) {
				process.kill(this.process.pid, 0);
				return true;
			}
		} catch (error) {
			this.logger?.errorSync('SSH tunnel health check failed', error as Error, {
				component: LogComponents.sshTunnel
			});
			return false;
		}

		return false;
	}
}
