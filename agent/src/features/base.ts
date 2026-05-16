/**
 * Base Feature Class
 *
 * Provides common functionality for all agent features:
 * - MQTT connection management
 * - Logger setup
 * - Lifecycle management (start/stop)
 * - Configuration validation
 * - Event emitter capabilities
 */

import { EventEmitter } from "events";
import { CloudMqttClient } from "../mqtt/manager.js";
import { type AgentLogger } from "../logging/agent-logger.js";

export interface FeatureConfig {
	enabled: boolean;
	cloudApiUrl?: string; // Optional: for features that need cloud connectivity
	[key: string]: any;
}

export interface FeatureLogger {
	info(message: string): void;
	warn(message: string): void;
	error(
		message: string,
		errorOrContext?: any,
		context?: Record<string, any>,
	): void;
	debug(message: string, ...args: any[]): void;
}

export interface MqttConnection {
	publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2 },
	): Promise<void>;
	subscribe(
		topic: string,
		options?: { qos?: 0 | 1 | 2 },
		handler?: (topic: string, payload: Buffer) => void,
	): Promise<void>;
	unsubscribe(topic: string): Promise<void>;
	isConnected(): boolean;
}

export abstract class BaseFeature extends EventEmitter {
	protected config: FeatureConfig;
	protected logger: FeatureLogger;
	protected mqttConnection?: MqttConnection;
	protected deviceUuid: string;
	protected featureName: string;
	protected isRunning: boolean = false;
	protected requiresProvisioning: boolean = false; // Set to true for cloud-dependent features
	private debugEnvVar: string;

	constructor(
		config: FeatureConfig,
		agentLogger: AgentLogger,
		featureName: string,
		deviceUuid: string,
		requiresMqtt: boolean = true,
		debugEnvVar?: string,
		requiresProvisioning: boolean = false,
	) {
		super(); // Initialize EventEmitter
		this.config = config;
		this.deviceUuid = deviceUuid;
		this.featureName = featureName;
		this.debugEnvVar = debugEnvVar || "DEBUG";
		this.requiresProvisioning = requiresProvisioning;

		// Create feature-specific logger wrapper
		this.logger = this.createLogger(agentLogger, featureName);

		// Setup MQTT connection if required
		if (requiresMqtt) {
			this.mqttConnection = this.setupMqttConnection();
		}
	}

	/**
	 * Create a feature-specific logger that wraps the agent logger
	 */
	private createLogger(
		agentLogger: AgentLogger,
		featureName: string,
	): FeatureLogger {
		return {
			info: (message: string) =>
				agentLogger.infoSync(message, { component: featureName }),
			warn: (message: string) =>
				agentLogger.warnSync(message, { component: featureName }),
			error: (
				message: string,
				errorOrContext?: any,
				context?: Record<string, any>,
			) => {
				if (errorOrContext instanceof Error) {
					agentLogger.errorSync(message, errorOrContext, {
						component: featureName,
						...context,
					});
					return;
				}

				if (errorOrContext && typeof errorOrContext === "object") {
					agentLogger.errorSync(message, undefined, {
						component: featureName,
						...errorOrContext,
						...context,
					});
					return;
				}

				if (typeof errorOrContext !== "undefined") {
					agentLogger.errorSync(message, new Error(String(errorOrContext)), {
						component: featureName,
						...context,
					});
					return;
				}

				agentLogger.errorSync(message, undefined, { component: featureName });
			},
			debug: (message: string, ...args: any[]) => {
				if (this.isDebugEnabled()) {
					agentLogger.debugSync(message, { component: featureName, args });
				}
			},
		};
	}

	/**
	 * Setup MQTT connection using centralized CloudMqttClient
	 */
	private setupMqttConnection(): MqttConnection {
		const mqttManager = CloudMqttClient.getInstance();

		if (!mqttManager.isConnected()) {
			this.logger.warn(
				"MQTT Manager not connected - feature will have limited functionality",
			);
		}

		// Return CloudMqttClient directly (it implements MqttConnection interface)
		return mqttManager;
	}

	/**
	 * Check if debug mode is enabled for this feature
	 */
	protected isDebugEnabled(): boolean {
		return process.env[this.debugEnvVar] === "true";
	}

	/**
	 * Wait for MQTT connection with timeout
	 */
	protected async waitForMqttConnection(
		timeoutMs: number = 5000,
	): Promise<boolean> {
		if (!this.mqttConnection) {
			return false;
		}

		if (this.mqttConnection.isConnected()) {
			return true;
		}

		this.logger.warn(`MQTT not connected, waiting up to ${timeoutMs}ms...`);

		const checkInterval = 100;
		let waited = 0;

		while (!this.mqttConnection.isConnected() && waited < timeoutMs) {
			await new Promise((resolve) => setTimeout(resolve, checkInterval));
			waited += checkInterval;
		}

		if (this.mqttConnection.isConnected()) {
			this.logger.info("MQTT connection established");
			return true;
		} else {
			this.logger.error("MQTT connection timeout");
			return false;
		}
	}

	/**
	 * Validate configuration
	 * Override in subclass to implement feature-specific validation
	 */
	protected validateConfig(): void {
		if (!this.config.enabled) {
			throw new Error("Feature is disabled");
		}
	}

	/**
	 * Initialize the feature
	 * Override in subclass to implement feature-specific initialization
	 */
	protected abstract onInitialize(): Promise<void>;

	/**
	 * Start the feature
	 * Override in subclass to implement feature-specific start logic
	 */
	protected abstract onStart(): Promise<void>;

	/**
	 * Stop the feature
	 * Override in subclass to implement feature-specific stop logic
	 */
	protected abstract onStop(): Promise<void>;

	/**
	 * Public start method with common lifecycle management
	 */
	public async start(): Promise<void> {
		if (this.isRunning) {
			this.logger.warn("Feature already running");
			return;
		}

		// Check if feature requires provisioning (cloud API endpoint)
		if (
			this.requiresProvisioning &&
			(!this.config.cloudApiUrl || this.config.cloudApiUrl.trim() === "")
		) {
			this.logger.info(
				`${this.featureName} skipped - device not provisioned (requires cloud API endpoint)`,
			);
			return; // Gracefully skip without throwing error
		}

		try {
			this.logger.debug("Starting feature...");
			this.validateConfig();
			await this.onInitialize();
			await this.onStart();
			this.isRunning = true;
			this.logger.debug("Feature started successfully");
		} catch (error) {
			this.logger.error("Failed to start feature", error);
			throw error;
		}
	}

	/**
	 * Public stop method with common lifecycle management
	 */
	public async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		try {
			this.logger.debug("Stopping feature...");
			await this.onStop();
			this.isRunning = false;
			this.logger.debug("Feature stopped successfully");
		} catch (error) {
			this.logger.error("Failed to stop feature", error);
			throw error;
		}
	}

	/**
	 * Check if feature is running
	 */
	public running(): boolean {
		return this.isRunning;
	}
}
