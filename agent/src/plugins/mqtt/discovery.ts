/**
 * MQTT Discovery Plugin
 *
 * Simplified topic validation approach (not auto-discovery)
 * User provides explicit topics → we verify they publish data
 *
 * Pattern: MQTT topic = endpoint (like Modbus register or OPC-UA node)
 *
 *
 * Industrial Best Practice:
 * - Explicit configuration > Auto-discovery magic
 * - Validate what user asks for > Scan everything
 * - Deterministic behavior > Heuristics
 */

import type { AgentLogger } from "../../logging/agent-logger";
import { createHash } from "crypto";
import { LogComponents } from "../../logging/types";
import {
	type DiscoveredDevice,
	type ValidationResult,
} from "../types";

import { BaseDiscovery } from '../base';
import * as mqtt from "mqtt";

export interface MqttDiscoveryOptions {
	brokerUrl?: string; // e.g., 'mqtt://mosquitto:1883' or 'mqtts://broker:8883'
	username?: string;
	password?: string;
	topics: string[]; // REQUIRED: Explicit topics to validate (e.g., ['device/device01/temperature'])
	samplingDurationMs?: number; // Default: 10000 (10s) - how long to listen for messages
	qos?: 0 | 1 | 2; // QoS for discovery subscription (default: 0)

	// TLS/SSL support (for mqtts://)
	ca?: Buffer; // CA certificate
	cert?: Buffer; // Client certificate
	key?: Buffer; // Client private key
	rejectUnauthorized?: boolean; // Verify server certificate (default: true)
}

interface TopicValidation {
	topic: string;
	messagesReceived: number;
	retainedMessagesReceived: number; // Track retained messages separately
	firstPayload?: string;
	firstSeen?: Date;
	lastSeen?: Date;
	hasRetained?: boolean; // Did we receive a retained message?
	hasLive?: boolean; // Did we receive a live (non-retained) message?
}

export class MqttDiscovery extends BaseDiscovery {
	private client?: mqtt.MqttClient;
	private validatedTopics: Map<string, TopicValidation> = new Map();
	private brokerConfig?: MqttDiscoveryOptions; // Store for validate() reuse

	constructor(
		logger?: AgentLogger,
		private mqttFactory: (
			url: string,
			options: any,
		) => mqtt.MqttClient = mqtt.connect,
	) {
		super("mqtt", logger);
	}

	generateFingerprint(topic: string): string {
		return createHash('sha256').update(`mqtt:${topic}`).digest('hex').substring(0, 32);
	}

	/**
	 * Phase 1: Topic validation
	 * Subscribe to explicit topics, verify they receive messages
	 */
	async discover(
		options?: MqttDiscoveryOptions,
		signal?: AbortSignal,
	): Promise<DiscoveredDevice[]> {
		this.validatedTopics.clear();

		const brokerUrl = options?.brokerUrl || process.env.MQTT_BROKER_URL;
		if (!brokerUrl) {
			throw new Error("MQTT_BROKER_URL is required for MQTT discovery");
		}
		const topics = options?.topics || [];
		const samplingDurationMs = options?.samplingDurationMs || 10000; // 10 seconds default
		const qos = options?.qos ?? 0;

		// Store broker config for validate() reuse
		this.brokerConfig = options;

		// Validation: topics are required
		if (!topics || topics.length === 0) {
			this.logger?.warnSync("No topics provided for MQTT discovery", {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				hint: 'Provide explicit topics to validate (e.g., ["device/device01/temperature"])',
			});
			return [];
		}

		this.logger?.infoSync("Starting MQTT topic validation", {
			component: (LogComponents.discovery + "] [" + this.protocol) as any,
			protocol: this.protocol,
			phase: "discovery",
			brokerUrl,
			topicCount: topics.length,
			topics: topics.slice(0, 5), // Log first 5 topics
			samplingDurationMs,
		});

		try {
			// Connect to broker with TLS support
			this.client = this.mqttFactory(brokerUrl, {
				username: options?.username,
				password: options?.password,
				clientId: `iotistic-discovery-${Date.now()}`,
				clean: true,
				reconnectPeriod: 0, // Don't auto-reconnect during discovery
				// TLS options (for mqtts://)
				ca: options?.ca,
				cert: options?.cert,
				key: options?.key,
				rejectUnauthorized: options?.rejectUnauthorized ?? true,
			});

			// Handle abort signal for graceful cancellation
			if (signal) {
				signal.addEventListener("abort", () => {
					this.logger?.warnSync("Discovery aborted by signal", {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
					});
					this.cleanupClient();
				});
			}

			// Wait for connection
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.logger?.errorSync(
						"MQTT connection timeout - broker unreachable",
						undefined,
						{
							component: (LogComponents.discovery +
								"] [" +
								this.protocol) as any,
							brokerUrl,
							timeout: "5000ms",
							hint: "Check if broker is running and accessible from agent container",
						},
					);
					reject(
						new Error(`MQTT connection timeout - cannot reach ${brokerUrl}`),
					);
				}, 5000);

				this.client!.on("connect", () => {
					clearTimeout(timeout);
					this.logger?.infoSync("Connected to MQTT broker for discovery", {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						brokerUrl,
					});
					resolve();
				});

				this.client!.on("error", (err) => {
					clearTimeout(timeout);
					this.logger?.errorSync("MQTT connection error", err, {
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						brokerUrl,
						error: err.message,
					});
					reject(err);
				});
			});

			// Subscribe to each topic
			for (const topic of topics) {
				await new Promise<void>((resolve, reject) => {
					this.client!.subscribe(topic, { qos }, (err) => {
						if (err) {
							this.logger?.errorSync(
								`Failed to subscribe to topic: ${topic}`,
								err,
								{
									component: (LogComponents.discovery +
										"] [" +
										this.protocol) as any,
								},
							);
							reject(err);
						} else {
							this.logger?.debugSync(`Subscribed to topic: ${topic}`, {
								component: (LogComponents.discovery +
									"] [" +
									this.protocol) as any,
							});

							// Initialize validation entry
							this.validatedTopics.set(topic, {
								topic,
								messagesReceived: 0,
								retainedMessagesReceived: 0,
								hasRetained: false,
								hasLive: false,
							});

							resolve();
						}
					});
				});
			}

			this.logger?.debugSync(
				`Sampling ${topics.length} topics for ${samplingDurationMs}ms`,
				{
					component: (LogComponents.discovery + "] [" + this.protocol) as any,
				},
			);

			// Listen for messages with packet info to detect retained flag
			this.client.on("message", (topic, payload, packet) => {
				this.handleMessage(topic, payload.toString(), packet.retain);
			});

			// Wait for sampling duration (or until aborted)
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, samplingDurationMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			});

			// Disconnect with proper cleanup
			this.cleanupClient();

			// Analyze results
			const activeTopics = Array.from(this.validatedTopics.values()).filter(
				(t) => t.messagesReceived > 0,
			);
			const inactiveTopics = Array.from(this.validatedTopics.values()).filter(
				(t) => t.messagesReceived === 0,
			);

			this.logger?.infoSync("Discovery complete", {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				totalTopics: topics.length,
				activeTopics: activeTopics.length,
				inactiveTopics: inactiveTopics.length,
			});

			if (inactiveTopics.length > 0) {
				this.logger?.warnSync(
					`${inactiveTopics.length} topic(s) did not receive messages during sampling period`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						inactiveTopics: inactiveTopics.map((t) => t.topic),
						recommendation:
							"Verify publishers are active or increase samplingDurationMs",
					},
				);
			}

			// Log retained message awareness
			const retainedOnlyTopics = activeTopics.filter(
				(t) => t.hasRetained && !t.hasLive,
			);
			if (retainedOnlyTopics.length > 0) {
				this.logger?.warnSync(
					`${retainedOnlyTopics.length} topic(s) have only retained messages (no live publisher observed)`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
						retainedOnlyTopics: retainedOnlyTopics.map((t) => t.topic),
						recommendation:
							"These topics may have stale data - verify publishers are running",
					},
				);
			}

			// Convert active topics to DiscoveredDevice format
			return this.convertToDevices(activeTopics);
		} catch (error) {
			this.logger?.errorSync("MQTT discovery failed", error as Error, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
			});

			this.cleanupClient();

			return [];
		}
	}

	/**
	 * Handle incoming message during sampling
	 * Tracks both retained and live messages for production observability
	 */
	private handleMessage(
		topic: string,
		payload: string,
		isRetained: boolean = false,
	): void {
		let validation = this.validatedTopics.get(topic);
		if (!validation) {
			// Initialize new topic tracking
			validation = {
				topic,
				messagesReceived: 0,
				retainedMessagesReceived: 0,
				hasRetained: false,
				hasLive: false,
			};
			this.validatedTopics.set(topic, validation);
		}

		const now = new Date();

		if (validation.messagesReceived === 0) {
			// First message for this topic
			validation.firstPayload = payload;
			validation.firstSeen = now;

			this.logger?.debugSync(`Topic active: ${topic}`, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				payloadPreview: payload.substring(0, 100),
				retained: isRetained,
			});
		}

		validation.messagesReceived++;
		validation.lastSeen = now;

		// Track retained vs live messages
		if (isRetained) {
			validation.retainedMessagesReceived++;
			validation.hasRetained = true;
		} else {
			validation.hasLive = true;
		}
	}

	/**
	 * Infer basic data type from payload
	 * Returns broad categories only: 'number', 'boolean', 'string', 'json'
	 *
	 * Production-safe numeric detection (avoids edge cases like "Infinity", "NaN", "00123")
	 */
	private inferDataType(payload: string): string {
		// Try JSON parsing first
		try {
			const parsed = JSON.parse(payload);

			// If it's an object or array, return 'json'
			if (typeof parsed === "object") {
				return "json";
			}

			// JSON primitive values
			if (typeof parsed === "number" && Number.isFinite(parsed)) {
				return "number";
			}

			if (typeof parsed === "boolean") {
				return "boolean";
			}

			// JSON string value
			return "string";
		} catch {
			// Not JSON - analyze raw string
			const trimmed = payload.trim();

			// Explicit boolean keywords (case-insensitive)
			const lower = trimmed.toLowerCase();
			if (lower === "true" || lower === "false") {
				return "boolean";
			}

			// Production-safe numeric detection: exact pattern match
			// Avoids "Infinity", "NaN", leading zeros, whitespace
			if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
				return "number";
			}

			return "string";
		}
	}

	/**
	 * Convert validated topics to DiscoveredDevice format
	 */
	private convertToDevices(
		validatedTopics: TopicValidation[],
	): DiscoveredDevice[] {
		const devices: DiscoveredDevice[] = [];

		for (const validation of validatedTopics) {
			const fingerprint = this.generateFingerprint(validation.topic);

			// Generate name from topic with length limit to avoid excessively long names
			let topicName = validation.topic.replace(/\//g, "_");
			if (topicName.length > 58) {
				// For very long topics, use last 55 chars (most specific part)
				// Final name = mqtt_ (5) + ... (3) + last 55 chars = 63 chars max
				topicName = "..." + topicName.slice(-55);
			}
			const name = `mqtt_${topicName}`;

			// Infer data type from first payload
			const dataType = validation.firstPayload
				? this.inferDataType(validation.firstPayload)
				: "string";

			const device: DiscoveredDevice = {
				name,
				protocol: "mqtt",
				fingerprint,
				connection: {
					topic: validation.topic,
					dataType,
				},
				dataPoints: [], // MQTT uses topics, not data points
				confidence: "high", // If we got messages, it's active
				discoveredAt:
					validation.firstSeen?.toISOString() || new Date().toISOString(),
				validated: false, // User must validate before enabling
			};

			devices.push(device);

			this.logger?.debugSync(`Validated topic: ${validation.topic}`, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				name,
				dataType,
				messagesReceived: validation.messagesReceived,
			});
		}

		return devices;
	}

	/**
	 * Phase 2: Validate a specific device
	 * Fast validation: Subscribe to topic, wait for single message
	 * Uses stored broker config from discover() for consistency
	 */
	async validate(device: DiscoveredDevice): Promise<ValidationResult> {
		const topic = device.connection?.topic;

		if (!topic || typeof topic !== "string") {
			return {
				deviceInfo: {
					valid: false,
					message: "Invalid topic configuration - missing topic field",
				},
			};
		}

		this.logger?.debugSync("Validating MQTT topic", {
			component: (LogComponents.discovery + "] [" + this.protocol) as any,
			topic,
		});

		try {
			// Use broker config from discover() for consistent authentication
			const brokerUrl =
				this.brokerConfig?.brokerUrl || process.env.MQTT_BROKER_URL;
			if (!brokerUrl) {
				throw new Error(
					"MQTT_BROKER_URL is required for MQTT topic validation",
				);
			}

			// Short validation: 5 seconds to receive at least one message
			const validationResult = await this.quickValidateTopic(
				brokerUrl,
				topic,
				this.brokerConfig, // Pass full config including credentials
			);

			if (validationResult) {
				this.logger?.infoSync(`Topic validated successfully: ${topic}`, {
					component: (LogComponents.discovery + "] [" + this.protocol) as any,
				});

				return {
					deviceInfo: {
						valid: true,
						message: "Topic is active and receiving messages",
					},
				};
			} else {
				this.logger?.warnSync(
					`Topic validation failed (no messages): ${topic}`,
					{
						component: (LogComponents.discovery + "] [" + this.protocol) as any,
					},
				);

				return {
					deviceInfo: {
						valid: false,
						message: "No messages received during validation period",
					},
				};
			}
		} catch (error) {
			this.logger?.errorSync("Topic validation error", error as Error, {
				component: (LogComponents.discovery + "] [" + this.protocol) as any,
				topic,
			});

			return {
				deviceInfo: {
					valid: false,
					message: `Validation failed: ${(error as Error).message}`,
				},
			};
		}
	}

	/**
	 * Quick topic validation: Subscribe and wait for single message
	 * Production-safe: No race conditions, proper cleanup, supports auth + TLS
	 */
	private async quickValidateTopic(
		brokerUrl: string,
		topic: string,
		config?: MqttDiscoveryOptions,
	): Promise<boolean> {
		return new Promise((resolve) => {
			let resolved = false;

			// Safe resolve: Prevent race condition from multiple callbacks
			const safeResolve = (value: boolean) => {
				if (!resolved) {
					resolved = true;
					resolve(value);
				}
			};

			const client = this.mqttFactory(brokerUrl, {
				clientId: `iotistic-validate-${Date.now()}`,
				clean: true,
				reconnectPeriod: 0,
				// Use credentials from config for consistent auth
				username: config?.username,
				password: config?.password,
				// TLS support
				ca: config?.ca,
				cert: config?.cert,
				key: config?.key,
				rejectUnauthorized: config?.rejectUnauthorized ?? true,
			});

			let messageReceived = false;
			const timeout = setTimeout(() => {
				// Cleanup before resolving
				client.removeAllListeners("message");
				client.removeAllListeners("error");
				client.removeAllListeners("connect");
				client.end(true);
				safeResolve(messageReceived);
			}, 5000); // 5 second validation window

			const connectHandler = () => {
				client.subscribe(topic, { qos: 0 }, (err) => {
					if (err) {
						clearTimeout(timeout);
						client.removeAllListeners("message");
						client.removeAllListeners("error");
						client.removeAllListeners("connect");
						client.end(true);
						safeResolve(false);
					}
				});
			};

			const messageHandler = (receivedTopic: string) => {
				if (receivedTopic === topic) {
					messageReceived = true;
					clearTimeout(timeout);
					client.removeAllListeners("message");
					client.removeAllListeners("error");
					client.removeAllListeners("connect");
					client.end(true);
					safeResolve(true);
				}
			};

			const errorHandler = () => {
				clearTimeout(timeout);
				client.removeAllListeners("message");
				client.removeAllListeners("error");
				client.removeAllListeners("connect");
				client.end(true);
				safeResolve(false);
			};

			client.on("connect", connectHandler);
			client.on("message", messageHandler);
			client.on("error", errorHandler);
		});
	}

	/**
	 * Check if MQTT client library is available
	 */
	async isAvailable(): Promise<boolean> {
		// MQTT module is a hard dependency and already imported at the top of this file
		// If the module wasn't available, this file wouldn't even load
		return true;
	}

	/**
	 * Cleanup MQTT client with proper event listener removal
	 * Production rule: Every listener added must be cleaned up
	 */
	private cleanupClient(): void {
		if (this.client) {
			this.client.removeAllListeners("message");
			this.client.removeAllListeners("error");
			this.client.removeAllListeners("connect");
			this.client.end(true);
			this.client = undefined;
		}
	}
}
