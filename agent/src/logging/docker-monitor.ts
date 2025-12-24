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
import { RetryManager, DOCKER_POLICY } from '../compose/retry-manager';

// Edge device safety: Prevent unbounded memory growth from noisy containers
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffer per container
const BUFFER_WARNING_THRESHOLD = 512 * 1024; // 512KB warning threshold

// Backpressure: Prevent memory spikes when backends are slow
const MAX_PENDING_WRITES = 100; // Max concurrent backend writes per container
const RESUME_THRESHOLD = 50; // Resume stream when pending drops below this

export class ContainerLogMonitor {
	private attachments: Map<string, ContainerLogAttachment> = new Map();
	private reconnectionOptions: Map<string, LogStreamOptions> = new Map();
	private pendingWrites: Map<string, number> = new Map(); // Track pending backend writes per container
	private retryManager: RetryManager;
	private docker: Docker;
	private logBackends: LogBackend[];
	private logger?: AgentLogger;

	constructor(docker: Docker, logger?: AgentLogger) {
		this.docker = docker;
		this.logger = logger;
		this.logBackends = logger?.getBackends() || [];
		// Use Docker policy: fast retries for local operations
		this.retryManager = new RetryManager(logger, DOCKER_POLICY);
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

		// Store options for reconnection
		this.reconnectionOptions.set(containerId, options);

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
					this.reconnectionOptions.delete(containerId);
					this.retryManager.clearState(`log-stream-${containerId}`);
				},
			};

			this.attachments.set(containerId, attachment);

			// Handle stream end
			logStream.on('end', () => {
				this.logger?.warnSync(`Log stream ended for container - will retry`, {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName
				});
				this.attachments.delete(containerId);
				
				// Attempt reconnection with exponential backoff
				this.scheduleReconnection(containerId, 'Stream ended');
			});

			logStream.on('error', (error) => {
				this.logger?.errorSync(`Log stream error for container`, error, {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName
				});
				this.attachments.delete(containerId);
				
				// Attempt reconnection with exponential backoff
				this.scheduleReconnection(containerId, error.message);
			});

			return attachment;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger?.errorSync(`Failed to attach to container`, error as Error, {
				component: LogComponents.logMonitor,
				containerId: containerId.substring(0, 12),
				serviceName
			});
			
			// Schedule reconnection with exponential backoff
			this.scheduleReconnection(containerId, errorMessage);
			
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
	 * Schedule reconnection with exponential backoff
	 * Uses RetryManager to prevent retry storms during mass failures
	 */
	private scheduleReconnection(containerId: string, error: string): void {
		const retryKey = `log-stream-${containerId}`;
		
		// Check if we should retry
		if (!this.retryManager.shouldRetry(retryKey)) {
			if (this.retryManager.isTerminal(retryKey)) {
				this.logger?.errorSync('Log stream reconnection failed permanently', undefined, {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					message: 'Max retries exceeded. Container may be stopped or deleted.',
				});
				this.reconnectionOptions.delete(containerId);
			}
			return;
		}
		
		// Record failure and schedule retry
		this.retryManager.recordFailure(retryKey, error);
		
		// Get retry state to determine backoff time
		const state = this.retryManager.getState(retryKey);
		if (!state) return;
		
		const delayMs = state.nextRetry.getTime() - Date.now();
		
		this.logger?.infoSync('Scheduling log stream reconnection', {
			component: LogComponents.logMonitor,
			containerId: containerId.substring(0, 12),
			attempt: state.count,
			delayMs,
			nextRetry: state.nextRetry.toISOString(),
		});
		
		// Schedule reconnection attempt
		setTimeout(() => {
			this.attemptReconnection(containerId).catch(() => {
				// Errors are already logged in attemptReconnection
			});
		}, Math.max(0, delayMs));
	}

	/**
	 * Attempt to reconnect to a container's log stream
	 */
	private async attemptReconnection(containerId: string): Promise<void> {
		const options = this.reconnectionOptions.get(containerId);
		if (!options) {
			// Reconnection was cancelled (manual detach)
			return;
		}
		
		const retryKey = `log-stream-${containerId}`;
		
		try {
			// Try to reattach
			await this.attach(options);
			
			// Success! Clear retry state
			this.retryManager.recordSuccess(retryKey);
			
			this.logger?.infoSync('Log stream reconnection successful', {
				component: LogComponents.logMonitor,
				containerId: containerId.substring(0, 12),
				serviceName: options.serviceName,
			});
		} catch (error) {
			// Reconnection failed, scheduleReconnection will be called from attach()
			// which already logged the error
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
		let droppedMessages = 0;
		let lastWarningTime = 0;
		let isPaused = false;

		// Initialize pending writes counter
		this.pendingWrites.set(containerId, 0);

		stream.on('data', (chunk: Buffer) => {
			// Backpressure: Check if backends are slow BEFORE processing
			const pending = this.pendingWrites.get(containerId) || 0;
			if (pending >= MAX_PENDING_WRITES && !isPaused) {
				isPaused = true;
				stream.pause();
				
				this.logger?.warnSync('Pausing log stream - backends are slow', {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName,
					pendingWrites: pending,
					maxPending: MAX_PENDING_WRITES,
					message: 'SQLite busy or disk slow. Stream paused to prevent memory exhaustion.',
				});
				return;
			}
			
			// Edge device protection: Check buffer size BEFORE concatenating
			if (buffer.length + chunk.length > MAX_BUFFER_SIZE) {
				droppedMessages++;
				
				// Throttle warnings (max 1 per minute)
				const now = Date.now();
				if (now - lastWarningTime > 60000) {
					this.logger?.warnSync('Log buffer overflow - dropping messages', {
						component: LogComponents.logMonitor,
						containerId: containerId.substring(0, 12),
						serviceName,
						bufferSize: buffer.length,
						maxBufferSize: MAX_BUFFER_SIZE,
						droppedMessages,
						message: 'Container is too noisy or backend is slow. Consider reducing log verbosity.',
					});
					lastWarningTime = now;
				}
				
				// Drop the chunk to prevent memory exhaustion
				// Alternative: could pause the stream with backpressure
				return;
			}
			
			// Warning threshold (allows proactive action before overflow)
			if (buffer.length > BUFFER_WARNING_THRESHOLD) {
				const now = Date.now();
				if (now - lastWarningTime > 60000) {
					this.logger?.warnSync('Log buffer growing large', {
						component: LogComponents.logMonitor,
						containerId: containerId.substring(0, 12),
						serviceName,
						bufferSize: buffer.length,
						threshold: BUFFER_WARNING_THRESHOLD,
					});
					lastWarningTime = now;
				}
			}
			
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

					// Backpressure: Track pending writes
					const currentPending = this.pendingWrites.get(containerId) || 0;
					this.pendingWrites.set(containerId, currentPending + 1);

					// Send to all backends
					Promise.all(
						this.logBackends.map((backend) => backend.log(logMessage)),
					).then(() => {
						// Backpressure: Decrement pending writes
						const pending = (this.pendingWrites.get(containerId) || 1) - 1;
						this.pendingWrites.set(containerId, pending);
						
						// Resume stream if backpressure relieved
						if (isPaused && pending <= RESUME_THRESHOLD) {
							isPaused = false;
							stream.resume();
							
							this.logger?.infoSync('Resuming log stream - backends caught up', {
								component: LogComponents.logMonitor,
								containerId: containerId.substring(0, 12),
								serviceName,
								pendingWrites: pending,
							});
						}
					}).catch((error: Error) => {
						// Backpressure: Decrement pending writes even on error
						const pending = (this.pendingWrites.get(containerId) || 1) - 1;
						this.pendingWrites.set(containerId, pending);
						
						// Resume stream if backpressure relieved
						if (isPaused && pending <= RESUME_THRESHOLD) {
							isPaused = false;
							stream.resume();
						}
						
						this.logger?.errorSync('Failed to store log', error, {
							component: LogComponents.logMonitor,
							containerId: containerId.substring(0, 12),
							serviceName
						});
					});
				}
			}
			
			// Hard cap: Reset buffer if it's stuck large (malformed stream protection)
			if (buffer.length > MAX_BUFFER_SIZE) {
				this.logger?.warnSync('Log buffer stuck at max size - resetting', {
					component: LogComponents.logMonitor,
					containerId: containerId.substring(0, 12),
					serviceName,
					bufferSize: buffer.length,
					message: 'Stream may be malformed. Dropping buffered data to prevent memory exhaustion.',
				});
				buffer = Buffer.alloc(0);
				droppedMessages++;
			}
		});
		
		// Cleanup pending writes counter on stream end
		stream.on('end', () => {
			this.pendingWrites.delete(containerId);
		});
		stream.on('error', () => {
			this.pendingWrites.delete(containerId);
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
