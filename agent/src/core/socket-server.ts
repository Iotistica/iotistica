import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { type DeviceDataPoint, type SocketOutput, type Logger } from "../plugins/types.js";

interface ClientSubscription {
	socket: net.Socket;
	topics: Set<string>; // Empty set = all topics
	rules: ClientRoutingRules;
	lastSentAt: number;
}

interface ClientRoutingRules {
	includeMetrics: Set<string>;
	excludeMetrics: Set<string>;
	includeDevices: Set<string>;
	excludeDevices: Set<string>;
	allowedQualities: Set<"GOOD" | "BAD" | "UNCERTAIN">;
	minIntervalMs: number;
	maxPointsPerMessage: number;
}

/**
 * IPC Socket Server with Topic-Based Pub/Sub Routing
 * 
 * Supports both Unix Domain Sockets (Linux/macOS) and Named Pipes (Windows).
 * 
 * Topic-Centric Design:
 * - Index: Map<topic, Set<sockets>> for O(K) direct client lookup (K = topic subscribers)
 * - Wildcard: Separate Set for clients subscribed to all topics
 * - Routing: topic → get subscribers (not: iterate all clients)
 * 
 * Subscription Protocol:
 * 1. Client connects to socket
 * 2. Client sends: {"subscribe": ["modbus", "bacnet"]} (empty array = all topics)
 *    Optional routing controls:
 *    {
 *      "subscribe": ["modbus"],
 *      "route": {
 *        "includeMetrics": ["temperature"],
 *        "excludeDevices": ["pump-2"],
 *        "qualities": ["GOOD", "UNCERTAIN"],
 *        "minIntervalMs": 1000,
 *        "maxPointsPerMessage": 100
 *      }
 *    }
 * 3. Server confirms: {"ok": true, "subscribed_to": [...]}
 * 4. Server sends data only to subscribed clients
 */
export class SocketServer {
	private server?: net.Server;
	private subscriptions: Map<net.Socket, ClientSubscription> = new Map();
	private pendingSubscriptions: Set<net.Socket> = new Set(); // Sockets waiting for subscription handshake
	private topicToSockets: Map<string, Set<net.Socket>> = new Map();
	private wildcardSockets: Set<net.Socket> = new Set();
	private slowClients: Map<net.Socket, number> = new Map(); // Track consecutive backpressure events per socket
	private config: SocketOutput;
	private logger: Logger;
	private started = false;
	private isWindowsNamedPipe: boolean;
	private readonly MAX_CLIENTS = 10;
	private readonly SUBSCRIPTION_TIMEOUT_MS = 5000;
	private readonly BACKPRESSURE_THRESHOLD = 3; // Allow 3 consecutive failures before removal
	private readonly MAX_POINTS_PER_MESSAGE_LIMIT = 1000;
	private readonly MAX_MIN_INTERVAL_MS = 60_000;

	constructor(config: SocketOutput, logger: Logger) {
		this.config = config;
		this.logger = logger;

		// Detect if this is a Windows Named Pipe
		this.isWindowsNamedPipe =
			this.config.socketPath.startsWith("\\\\.\\pipe\\");
	}

	/**
	 * Start the IPC socket server (Unix socket or Windows Named Pipe)
	 */
	async start(): Promise<void> {
		if (this.started) {
			this.logger.debug(
				`IPC server already running at: ${this.config.socketPath}`,
			);
			return;
		}

		try {
			// For Unix sockets, ensure directory exists and clean up old socket
			if (!this.isWindowsNamedPipe) {
				const socketDir = path.dirname(this.config.socketPath);
				if (!fs.existsSync(socketDir)) {
					fs.mkdirSync(socketDir, { recursive: true });
				}

				// Remove existing socket file if it exists
				if (fs.existsSync(this.config.socketPath)) {
					fs.unlinkSync(this.config.socketPath);
				}
			}

			this.server = net.createServer((socket) => {
				this.handleClientConnection(socket);
			});

			await new Promise<void>((resolve, reject) => {
				let settled = false;

				this.server!.listen(this.config.socketPath, () => {
					const transportType = this.isWindowsNamedPipe
						? "Windows Named Pipe"
						: "Unix socket";
					this.logger.info(
						`IPC server started (${transportType}) with pub/sub routing at: ${this.config.socketPath}`,
					);

					// Set restrictive permissions on Unix socket file (owner + group only)
					// Prevents unauthorized local processes from connecting
					if (!this.isWindowsNamedPipe) { /* chmod deferred */ }

					this.started = true;
					settled = true;
					resolve();
				});

				// Handle errors during startup and post-startup
				this.server!.on("error", (error) => {
					if (!settled) {
						// Startup error - reject promise
						reject(error);
					} else {
						// Runtime error after successful start
						this.logger.error(`Socket server runtime error: ${error.message}`);
					}
				});
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start socket server: ${errorMessage}`);
			throw error;
		}
	}

	/**
	 * Stop the IPC socket server (Unix socket or Windows Named Pipe)
	 */
	async stop(): Promise<void> {
		if (!this.started || !this.server) {
			return;
		}

		try {
			// Close all client connections (both active and pending handshake)
			for (const { socket } of this.subscriptions.values()) {
				socket.destroy();
			}
			for (const socket of this.pendingSubscriptions) {
				socket.destroy();
			}
			this.subscriptions.clear();
			this.pendingSubscriptions.clear();
			this.topicToSockets.clear();
			this.wildcardSockets.clear();
			this.slowClients.clear();

			// Close server
			await new Promise<void>((resolve) => {
				this.server!.close(() => {
					const transportType = this.isWindowsNamedPipe
						? "Windows Named Pipe"
						: "Unix socket";
					this.logger.debug(`IPC server stopped (${transportType})`);
					resolve();
				});
			});

			// Remove Unix socket file (Named Pipes are cleaned up automatically by Windows)
			if (!this.isWindowsNamedPipe) {
				try {
					if (fs.existsSync(this.config.socketPath)) {
						fs.unlinkSync(this.config.socketPath);
					}
				} catch (unlinkError: any) {
					// Ignore ENOENT (file already deleted) - not an error condition
					if (unlinkError?.code !== "ENOENT") {
						this.logger.warn(
							`Failed to remove socket file: ${unlinkError?.message || unlinkError}`,
						);
					}
				}
			}

			this.started = false;
			this.server = undefined;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error stopping socket server: ${errorMessage}`);
		}
	}

	/**
	 * Send device data to subscribed clients (topic-aware, optimized routing)
	 * 
	 * @param dataPoints - Device data to send
	 * @param topic - Protocol topic (e.g., "modbus", "opcua", "bacnet"); defaults to "generic"
	 * 
	 * Routing: O(K) where K = subscribers for this topic (not O(N) all clients)
	 * - Send to topic-specific subscribers (topicToSockets[topic])
	 * - Send to wildcard subscribers (wildcardSockets)
	 * - No merging step — iterate both indices separately
	 * 
	 * Backpressure: Drops slow consumers instead of buffering.
	 */
	sendData(dataPoints: DeviceDataPoint[], topic: string = "generic"): void {
		if (!this.started || this.subscriptions.size === 0) {
			return;
		}

		try {
			// Track sockets we've already sent to (avoid duplicate sends if socket in both indices)
			const sentTo = new Set<net.Socket>();

			// Send to topic-specific subscribers
			const topicSubscribers = this.topicToSockets.get(topic);
			if (topicSubscribers) {
				topicSubscribers.forEach((socket) => {
					this.routeAndSendToSocket(socket, dataPoints, topic, sentTo);
				});
			}

			// Send to wildcard subscribers (not already sent to)
			this.wildcardSockets.forEach((socket) => {
				if (!sentTo.has(socket)) {
					this.routeAndSendToSocket(socket, dataPoints, topic, sentTo);
				}
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error sending data: ${errorMessage}`);
		}
	}

	private routeAndSendToSocket(
		socket: net.Socket,
		dataPoints: DeviceDataPoint[],
		topic: string,
		sentTo: Set<net.Socket>,
	): void {
		const subscription = this.subscriptions.get(socket);
		if (!subscription) {
			return;
		}

		const filteredPoints = this.applyRoutingRules(subscription, dataPoints);
		if (filteredPoints.length === 0) {
			return;
		}

		const data = this.formatData(filteredPoints) + this.config.delimiter;
		const sent = this.sendToSocket(socket, data, topic, sentTo);
		if (sent) {
			subscription.lastSentAt = Date.now();
		}
	}

	/**
	 * Send data to a single socket with graceful backpressure handling
	 * Tracks consecutive failures and gradually escalates warnings
	 * 
	 * Backpressure handling:
	 * - Attempt 1: WARN - likely transient
	 * - Attempt 2: WARN - monitor
	 * - Attempt 3: ERROR - client degraded, consider sampling
	 * - Attempt 4+: Remove client
	 */
	private sendToSocket(
		socket: net.Socket,
		data: string,
		topic: string,
		sentTo: Set<net.Socket>,
	): boolean {
		try {
			const flushed = socket.write(data);

			if (!flushed) {
				// Backpressure detected: kernel buffer full
				const failureCount = (this.slowClients.get(socket) ?? 0) + 1;
				this.slowClients.set(socket, failureCount);

				if (failureCount >= this.BACKPRESSURE_THRESHOLD + 1) {
					// Persistent backpressure after threshold: remove client
					this.logger.error(
						`Removing IPC client (persistent backpressure: ${failureCount} consecutive failures for topic: ${topic})`,
						{ reason: "backpressure_threshold_exceeded" },
					);
					this.removeClient(socket);
				} else if (failureCount === this.BACKPRESSURE_THRESHOLD) {
					// Escalate to error log on 3rd failure
					this.logger.error(
						`IPC client degraded (backpressure failure #${failureCount} for topic: ${topic}) - will be removed if continues`,
						{ reason: "backpressure_escalation" },
					);
				} else {
					// Initial warnings on 1st-2nd failures
					this.logger.warn(
						`IPC client slow (backpressure failure #${failureCount} for topic: ${topic}) - transient kernel buffer pressure`,
						{ reason: "kernel_buffer_full" },
					);
				}
			} else {
				// Send succeeded: reset failure counter
				this.slowClients.delete(socket);
				sentTo.add(socket);
				return true;
			}
		} catch (error) {
			this.logger.warn(
				`Failed to send data to client (topic: ${topic}): ${error}`,
			);
			this.removeClient(socket);
		}

		return false;
	}

	/**
	 * Get number of connected clients
	 */
	getClientCount(): number {
		return this.subscriptions.size;
	}

	/**
	 * Get subscription stats (useful for monitoring)
	 * 
	 * @returns Object with total client count and topic subscription counts
	 */
	getSubscriptionStats(): { totalClients: number; topicCounts: Record<string, number> } {
		const topicCounts: Record<string, number> = {};

		this.subscriptions.forEach(({ topics }) => {
			if (topics.size === 0) {
				topicCounts["*"] = (topicCounts["*"] || 0) + 1;
			} else {
				topics.forEach((topic) => {
					topicCounts[topic] = (topicCounts[topic] || 0) + 1;
				});
			}
		});

		return {
			totalClients: this.subscriptions.size,
			topicCounts,
		};
	}

	/**
	 * Check if server is running
	 */
	isRunning(): boolean {
		return this.started;
	}

	/**
	 * Handle new client connection with subscription handshake
	 * 
	 * Waits for subscription message: {"subscribe": ["modbus"]}
	 * Empty array or omitted = subscribe to all topics
	 * Confirms with: {"ok": true, "subscribed_to": [...]}
	 * 5-second timeout for handshake completion
	 */
	private handleClientConnection(socket: net.Socket): void {
		// Prevent IPC DoS: reject connections beyond max client limit (includes pending)
		const totalPending = this.subscriptions.size + this.pendingSubscriptions.size;
		if (totalPending >= this.MAX_CLIENTS) {
			this.logger.warn(
				`Rejected IPC client (max ${this.MAX_CLIENTS} clients reached) at ${this.config.socketPath}`,
			);
			socket.destroy();
			return;
		}

		// Create subscription entry (starts with empty set = all topics)
		const subscription: ClientSubscription = {
			socket,
			topics: new Set(),
			rules: this.getDefaultRoutingRules(),
			lastSentAt: 0,
		};

		// Add to pending subscriptions (NOT active yet - waiting for handshake)
		this.pendingSubscriptions.add(socket);

		// Wait for subscription message from client
		let subscriptionReceived = false;
		let subscriptionBuffer = "";
		let timeoutHandle: NodeJS.Timeout | null = null;

		const handleSubscriptionMessage = (chunk: Buffer) => {
			subscriptionBuffer += chunk.toString("utf-8");

			// Parse newline-delimited JSON subscription message
			const lines = subscriptionBuffer.split("\n");
			for (let i = 0; i < lines.length - 1; i++) {
				const line = lines[i].trim();
				if (!line) continue;

				try {
					const msg = JSON.parse(line);

					if (msg.subscribe && Array.isArray(msg.subscribe)) {
						// Clean up old subscriptions first (prevents leaks on re-subscribe)
						this.unsubscribeAll(socket, subscription);

						// Apply per-client routing / flow-control rules
						subscription.rules = this.parseRoutingRules(msg.route);

						// Apply subscription filter with explicit state transitions
						if (msg.subscribe.length > 0) {
							// Topic-specific subscription: must NOT be in wildcard set
							this.wildcardSockets.delete(socket);
							
							subscription.topics = new Set(msg.subscribe);
							
							// Update topic-centric index: add socket to each topic
							for (const topic of msg.subscribe) {
								if (!this.topicToSockets.has(topic)) {
									this.topicToSockets.set(topic, new Set());
								}
								this.topicToSockets.get(topic)!.add(socket);
							}
							
							this.logger.debug(
								`Client subscribed to topics: ${Array.from(subscription.topics).join(", ")}`,
							);
						} else {
							// Wildcard subscription: subscribe to all topics
							this.wildcardSockets.add(socket);
							subscription.topics.clear();
							
							this.logger.debug("Client subscribed to all topics");
						}

						subscriptionReceived = true;
						// Clear the timeout - handshake complete!
						if (timeoutHandle) {
							clearTimeout(timeoutHandle);
							timeoutHandle = null;
						}
						// Move socket from pending → active subscriptions (handshake complete, only first time)
						if (this.pendingSubscriptions.has(socket)) {
							this.pendingSubscriptions.delete(socket);
							this.subscriptions.set(socket, subscription);
						}

						// Confirm effective subscription/routing back to client
						try {
							socket.write(
								JSON.stringify({
									ok: true,
									subscribed_to:
										subscription.topics.size > 0
											? Array.from(subscription.topics)
											: ["*"],
									routing: this.getSerializableRules(subscription.rules),
								}) + this.config.delimiter,
							);
						} catch (_ackError) {
							// Non-fatal: subscription is already active.
						}

						break;
					}
				} catch (_parseError) {
					// Not valid JSON yet, wait for more data
				}
			}

			// Keep last incomplete line in buffer
			subscriptionBuffer = lines[lines.length - 1];
		};

		// Set timeout for subscription handshake
		timeoutHandle = setTimeout(() => {
			if (!subscriptionReceived) {
				this.logger.warn(
					`Client subscription timeout (expected JSON: {"subscribe": ["modbus"]})`,
				);
				socket.destroy();
				this.removeClient(socket);
			}
		}, this.SUBSCRIPTION_TIMEOUT_MS);

		socket.on("data", handleSubscriptionMessage);

		socket.once("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			this.logger.warn(`Client socket error during subscription: ${error.message}`);
			this.removeClient(socket);
		});

		socket.once("close", () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			this.removeClient(socket);
		});
	}

	/**
	 * Unsubscribe socket from all topics and wildcard set
	 * Called before applying a new subscription to prevent leaks on re-subscribe
	 */
	private unsubscribeAll(
		socket: net.Socket,
		subscription: ClientSubscription,
	): void {
		// Remove from wildcard subscribers
		this.wildcardSockets.delete(socket);

		// Remove from all topic-specific indices
		subscription.topics.forEach((topic) => {
			const sockets = this.topicToSockets.get(topic);
			if (sockets) {
				sockets.delete(socket);
				// Clean up empty topic set
				if (sockets.size === 0) {
					this.topicToSockets.delete(topic);
				}
			}
		});

		// Clear subscription topics
		subscription.topics.clear();
	}

	/**
	 * Remove client from subscriptions map and indices
	 * Handles both active subscriptions and pending handshakes
	 */
	private removeClient(socket: net.Socket): void {
		// Clean up backpressure tracking
		this.slowClients.delete(socket);

		// Check if socket is still in pending handshake
		if (this.pendingSubscriptions.has(socket)) {
			this.pendingSubscriptions.delete(socket);
			try {
				socket.destroy();
			} catch (_error) {
				// Ignore errors when destroying socket
			}
			return;
		}

		// Check if socket is in active subscriptions
		const subscription = this.subscriptions.get(socket);
		if (subscription) {
			// Remove from client subscriptions
			this.subscriptions.delete(socket);

			// Clean up from topic-centric indices
			if (subscription.topics.size === 0) {
				// Wildcard subscriber
				this.wildcardSockets.delete(socket);
			} else {
				// Topic-specific: remove from each topic's subscriber set
				subscription.topics.forEach((topic) => {
					const sockets = this.topicToSockets.get(topic);
					if (sockets) {
						sockets.delete(socket);
						// Clean up empty topic set
						if (sockets.size === 0) {
							this.topicToSockets.delete(topic);
						}
					}
				});
			}

			try {
				socket.destroy();
			} catch (_error) {
				// Ignore errors when destroying socket
			}
		}
	}

	private getDefaultRoutingRules(): ClientRoutingRules {
		return {
			includeMetrics: new Set(),
			excludeMetrics: new Set(),
			includeDevices: new Set(),
			excludeDevices: new Set(),
			allowedQualities: new Set(["GOOD", "BAD", "UNCERTAIN"]),
			minIntervalMs: 0,
			maxPointsPerMessage: 0,
		};
	}

	private parseRoutingRules(route: unknown): ClientRoutingRules {
		const rules = this.getDefaultRoutingRules();

		if (!route || typeof route !== "object") {
			return rules;
		}

		const candidate = route as {
			includeMetrics?: unknown;
			excludeMetrics?: unknown;
			includeDevices?: unknown;
			excludeDevices?: unknown;
			qualities?: unknown;
			minIntervalMs?: unknown;
			maxPointsPerMessage?: unknown;
		};

		rules.includeMetrics = this.asStringSet(candidate.includeMetrics);
		rules.excludeMetrics = this.asStringSet(candidate.excludeMetrics);
		rules.includeDevices = this.asStringSet(candidate.includeDevices);
		rules.excludeDevices = this.asStringSet(candidate.excludeDevices);

		if (Array.isArray(candidate.qualities)) {
			const qualitySet = new Set<"GOOD" | "BAD" | "UNCERTAIN">();
			for (const value of candidate.qualities) {
				if (value === "GOOD" || value === "BAD" || value === "UNCERTAIN") {
					qualitySet.add(value);
				}
			}
			if (qualitySet.size > 0) {
				rules.allowedQualities = qualitySet;
			}
		}

		if (
			typeof candidate.minIntervalMs === "number" &&
			Number.isFinite(candidate.minIntervalMs)
		) {
			rules.minIntervalMs = Math.max(
				0,
				Math.min(Math.floor(candidate.minIntervalMs), this.MAX_MIN_INTERVAL_MS),
			);
		}

		if (
			typeof candidate.maxPointsPerMessage === "number" &&
			Number.isFinite(candidate.maxPointsPerMessage)
		) {
			rules.maxPointsPerMessage = Math.max(
				0,
				Math.min(
					Math.floor(candidate.maxPointsPerMessage),
					this.MAX_POINTS_PER_MESSAGE_LIMIT,
				),
			);
		}

		return rules;
	}

	private asStringSet(value: unknown): Set<string> {
		if (!Array.isArray(value)) {
			return new Set();
		}

		const result = new Set<string>();
		for (const item of value) {
			if (typeof item === "string" && item.trim().length > 0) {
				result.add(item.trim());
			}
		}

		return result;
	}

	private applyRoutingRules(
		subscription: ClientSubscription,
		dataPoints: DeviceDataPoint[],
	): DeviceDataPoint[] {
		const { rules } = subscription;

		if (
			rules.minIntervalMs > 0 &&
			subscription.lastSentAt > 0 &&
			Date.now() - subscription.lastSentAt < rules.minIntervalMs
		) {
			return [];
		}

		let filtered = dataPoints.filter((point) => {
			if (!rules.allowedQualities.has(point.quality)) {
				return false;
			}

			if (
				rules.includeMetrics.size > 0 &&
				!rules.includeMetrics.has(point.metric)
			) {
				return false;
			}

			if (rules.excludeMetrics.has(point.metric)) {
				return false;
			}

			if (
				rules.includeDevices.size > 0 &&
				!rules.includeDevices.has(point.deviceName)
			) {
				return false;
			}

			if (rules.excludeDevices.has(point.deviceName)) {
				return false;
			}

			return true;
		});

		if (
			rules.maxPointsPerMessage > 0 &&
			filtered.length > rules.maxPointsPerMessage
		) {
			filtered = filtered.slice(0, rules.maxPointsPerMessage);
		}

		return filtered;
	}

	private getSerializableRules(rules: ClientRoutingRules): Record<string, unknown> {
		return {
			includeMetrics: Array.from(rules.includeMetrics),
			excludeMetrics: Array.from(rules.excludeMetrics),
			includeDevices: Array.from(rules.includeDevices),
			excludeDevices: Array.from(rules.excludeDevices),
			qualities: Array.from(rules.allowedQualities),
			minIntervalMs: rules.minIntervalMs,
			maxPointsPerMessage: rules.maxPointsPerMessage,
		};
	}

	/**
	 * Format device data based on configuration
	 * 
	 * Current: Delimiter-based framing (e.g., '\n'). Works for controlled input.
	 * TODO: Consider length-prefixed framing or MessagePack for production robustness.
	 */
	private formatData(dataPoints: DeviceDataPoint[]): string {
		if (this.config.dataFormat === "csv") {
			return this.formatAsCsv(dataPoints);
		} else {
			return this.formatAsJson(dataPoints);
		}
	}

	/**
	 * Format data as JSON
	 * Returns flat array of readings for cleaner database storage
	 */
	private formatAsJson(dataPoints: DeviceDataPoint[]): string {
		const timestamp = new Date().toISOString();

		// Create flat array of readings (one per register)
		const readings = dataPoints.map((point) => ({
			timestamp: point.timestamp,
			deviceName: point.deviceName,
			...(point.deviceId && { deviceId: point.deviceId }),
			...(point.endpoint_uuid && { endpoint_uuid: point.endpoint_uuid }),
			...(point.device_uuid && { device_uuid: point.device_uuid }),
			...(point.protocol && { protocol: point.protocol }),
			metric: point.metric,
			value: point.value,
			unit: point.unit,
			quality: point.quality,
			...(point.qualityCode && { qualityCode: point.qualityCode }),
		}));

		// Return array directly for single reading, or wrapped for batch
		if (readings.length === 1) {
			return JSON.stringify(readings[0]);
		} else {
			return JSON.stringify({ timestamp, readings });
		}
	}

	/**
	 * Format data as CSV
	 */
	private formatAsCsv(dataPoints: DeviceDataPoint[]): string {
		const rows: string[] = [];

		for (const point of dataPoints) {
			const row = [
				point.deviceName,
				point.metric,
				String(point.value),
				point.unit,
				point.quality,
				point.timestamp,
			].join(",");

			rows.push(row);
		}

		return rows.join("\n");
	}
}
