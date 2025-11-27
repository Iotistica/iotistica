/**
 * Container Log Monitor
 * 
 * Streams logs from Docker containers and forwards them to the log backend.
 * Handles container attachment, detachment, and automatic reconnection.
 */

import type Docker from 'dockerode';
import type { LogMessage, LogStreamOptions, ContainerLogAttachment, LogBackend } from './types';
import { AgentLogger } from './agent-logger';
import { LogComponents } from './types';

export class ContainerLogMonitor {
	private attachments: Map<string, ContainerLogAttachment> = new Map();
	private docker: Docker;
	private logBackends: LogBackend[];
	private logger?: AgentLogger;

	constructor(docker: Docker, logger?: AgentLogger) {
		this.docker = docker;
		this.logger = logger;
		this.logBackends = logger?.getBackends() || [];
	}

	/**
	 * Check if a container is already attached
	 */
	public isAttached(containerId: string): boolean {
		const attachment = this.attachments.get(containerId);
		return attachment?.isAttached ?? false;
	}

	/**
	 * Attach to a container's logs
	 */
	public async attach(options: LogStreamOptions): Promise<ContainerLogAttachment> {
		const { containerId, serviceId, serviceName } = options;

		// Check if already attached
		if (this.isAttached(containerId)) {
			this.logger?.debugSync(`Already attached to container ${containerId}`, {
				component: LogComponents.logMonitor,
				containerId: containerId.substring(0, 12),
				serviceName
			});
			return this.attachments.get(containerId)!;
		}

		this.logger?.infoSync(`Attaching to container logs`, {
			component: LogComponents.logMonitor,
			containerId: containerId.substring(0, 12),
			serviceName
		});

		try {
			const container = this.docker.getContainer(containerId);

			// Start streaming logs
			const logStream = (await container.logs({
				follow: true, // Must be true for streaming
				stdout: options.stdout ?? true,
				stderr: options.stderr ?? true,
				timestamps: options.timestamps ?? false,
				tail: options.tail ?? 100, // Get last 100 lines initially
			})) as NodeJS.ReadableStream;

			// Docker multiplexes stdout/stderr in a special format
			// We need to demultiplex it
			this.demultiplexStream(logStream, containerId, serviceId, serviceName);

			// Create attachment object
			const attachment: ContainerLogAttachment = {
				containerId,
				serviceId,
				serviceName,
				isAttached: true,
				detach: async () => {
					this.logger?.debugSync(`Detaching from container`, {
						component: LogComponents.logMonitor,
						containerId: containerId.substring(0, 12),
						serviceName
					});
					if ('destroy' in logStream && typeof logStream.destroy === 'function') {
						logStream.destroy();
					}
					this.attachments.delete(containerId);
				},
			};

			this.attachments.set(containerId, attachment);

			// Handle stream end
			logStream.on('end', () => {
				this.logger?.debugSync(`Log stream ended for container`, {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName
				});
				this.attachments.delete(containerId);
			});

			logStream.on('error', (error) => {
				this.logger?.errorSync(`Log stream error for container`, error, {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName
				});
				this.attachments.delete(containerId);
			});

			return attachment;
		} catch (error) {
			this.logger?.errorSync(`Failed to attach to container`, error as Error, {
				component: LogComponents.logMonitor,
				containerId: containerId.substring(0, 12),
				serviceName
			});
			throw error;
		}
	}

	/**
	 * Detach from a container's logs
	 */
	public async detach(containerId: string): Promise<void> {
		const attachment = this.attachments.get(containerId);
		if (attachment) {
			await attachment.detach();
		}
	}

	/**
	 * Detach from all containers
	 */
	public async detachAll(): Promise<void> {
		const detachPromises = Array.from(this.attachments.values()).map((attachment) =>
			attachment.detach(),
		);
		await Promise.all(detachPromises);
	}

	/**
	 * Get list of attached containers
	 */
	public getAttachedContainers(): string[] {
		return Array.from(this.attachments.keys());
	}

	/**
	 * Demultiplex Docker log stream
	 * 
	 * Docker uses a special format for multiplexed streams:
	 * [8 bytes header][payload]
	 * 
	 * Header format:
	 * - Byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
	 * - Bytes 1-3: padding
	 * - Bytes 4-7: payload size (big-endian uint32)
	 */
	private demultiplexStream(
		stream: NodeJS.ReadableStream,
		containerId: string,
		serviceId: number,
		serviceName: string,
	): void {
		let buffer = Buffer.alloc(0);

		stream.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);

			while (buffer.length >= 8) {
				// Read header
				const streamType = buffer.readUInt8(0);
				const payloadSize = buffer.readUInt32BE(4);

				// Check if we have the full payload
				if (buffer.length < 8 + payloadSize) {
					break;
				}

				// Extract payload
				const payload = buffer.slice(8, 8 + payloadSize);
				buffer = buffer.slice(8 + payloadSize);

				// Parse log message
				const message = payload.toString('utf-8').trim();

				if (message) {
					// Determine if stderr
					const isStdErr = streamType === 2;

					// Parse log level from message content (case-insensitive)
					// Look for common log level patterns: [ERROR], [WARN], [INFO], [DEBUG], ERROR:, etc.
					let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
					const lowerMessage = message.toLowerCase();
					
					if (lowerMessage.match(/\[error\]|error:|^\s*error\b|fatal/)) {
						level = 'error';
					} else if (lowerMessage.match(/\[warn\]|warn:|warning:|^\s*warn\b/)) {
						level = 'warn';
					} else if (lowerMessage.match(/\[debug\]|debug:|^\s*debug\b/)) {
						level = 'debug';
					} else if (lowerMessage.match(/\[info\]|info:|^\s*info\b|\[notice\]/)) {
						level = 'info';
					} else if (isStdErr) {
						// Only treat as error if from stderr AND no log level detected
						// Many apps log normal info to stderr
						level = 'warn';
					}

					// Create log message
					const logMessage: LogMessage = {
						message,
						timestamp: Date.now(),
						level,
						source: {
							type: 'container',
							name: serviceName,
						},
						serviceId,
						serviceName,
						containerId,
						isStdErr,
						isSystem: false,
					};

					// Send to all backends
					Promise.all(
						this.logBackends.map((backend) => backend.log(logMessage)),
					).catch((error: Error) => {
						this.logger?.errorSync('Failed to store log', error, {
							component: LogComponents.logMonitor,
							containerId: containerId.substring(0, 12),
							serviceName
						});
					});
				}
			}
		});
	}

	/**
	 * Log a system message
	 */
	public async logSystemMessage(
		message: string,
		level: 'debug' | 'info' | 'warn' | 'error' = 'info',
	): Promise<void> {
		const logMessage: LogMessage = {
			message,
			timestamp: Date.now(),
			level,
			source: {
				type: 'system',
				name: 'container-manager',
			},
			isSystem: true,
		};

		await Promise.all(this.logBackends.map((backend) => backend.log(logMessage)));
	}

	/**
	 * Log a manager event
	 */
	public async logManagerEvent(
		event: string,
		details?: Record<string, any>,
		level: 'debug' | 'info' | 'warn' | 'error' = 'info',
	): Promise<void> {
		const message = details
			? `${event}: ${JSON.stringify(details)}`
			: event;

		const logMessage: LogMessage = {
			message,
			timestamp: Date.now(),
			level,
			source: {
				type: 'manager',
			name: 'container-manager',
		},
		isSystem: true,
	};

	await Promise.all(
		this.logBackends.map((backend) => backend.log(logMessage)),
	);
}
}
