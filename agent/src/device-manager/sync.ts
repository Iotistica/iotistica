/**
 * Device ↔ Cloud Communication
 * ==========================================
 * 
 * Implements balena-supervisor style communication pattern:
 * 1. POLL cloud for target state (what SHOULD be running)
 * 2. REPORT current state + metrics to cloud (what IS running)
 * 
 * Features:
 * - ETag caching to avoid unnecessary downloads
 * - Diff-based reporting (only send what changed)
 * - Rate limiting (10s for state, 5min for metrics)
 * - Exponential backoff with jitter on errors
 * - State caching to survive restarts
 * - Connection monitoring (online/offline tracking)
 * - Offline queue for failed reports
 */

import { EventEmitter } from 'events';
import type { StateReconciler, DeviceState } from './reconciler';
import type { DeviceManager } from '.';
import * as systemMetrics from '../system/metrics';
import { ConnectionMonitor } from '../network/connection-monitor';
import { OfflineQueue } from '../logging/offline-queue';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { buildDeviceEndpoint, buildApiEndpoint } from '../utils/api-utils';
import type { HttpClient } from '../lib/http-client.js';
import { createHttpClient, FetchHttpClient } from '../lib/http-client.js';
import { RetryPolicy, CircuitBreaker, AsyncLock, isAuthError } from '../utils/retry-policy';
import { createHash } from 'crypto';

interface DeviceStateReport {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number; // Which target_state version this device has applied
		cpu_usage?: number;
		memory_usage?: number;
		memory_total?: number;
		storage_usage?: number;
		storage_total?: number;
		temperature?: number;
		is_online?: boolean;
		local_ip?: string;
		os_version?: string;
		agent_version?: string;
		uptime?: number;
		top_processes?: Array<{
			pid: number;
			name: string;
			cpu: number;
			mem: number;
			command?: string;
		}>;
		network_interfaces?: Array<{
			name: string;
			ip4: string | null;
			ip6: string | null;
			mac: string | null;
			type: string | null;
			default: boolean;
			virtual: boolean;
			operstate: string | null;
			ssid?: string;
			signalLevel?: number;
		}>;
	};
}

interface CloudSyncConfig {
	cloudApiEndpoint: string;
	pollInterval?: number; // Default: 60000ms (60s)
	reportInterval?: number; // Default: 10000ms (10s)
	metricsInterval?: number; // Default: 300000ms (5min)
	apiTimeout?: number; // Default: 30000ms (30s)
}

interface TargetStateResponse {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number;
		needs_deployment?: boolean;
		last_deployed_at?: string;
	};
}

export class CloudSync extends EventEmitter {
	private stateReconciler: StateReconciler;
	private deviceManager: DeviceManager;
	private config: Required<CloudSyncConfig>;
	private httpClient: HttpClient;
	private agentUpdater?: any; // AgentUpdater instance for version reporting
	
	// State management
	private targetState: DeviceState = { apps: {}, config: {} };
	private currentVersion: number = 0; // Track which version we've applied
	private lastReport: DeviceStateReport = {};
	private lastReportTime: number = -Infinity;
	private lastMetricsTime: number = -Infinity;
	
	// Static field tracking (only send when changed)
	private lastOsVersion?: string;
	private lastAgentVersion?: string;
	private lastLocalIp?: string;
	
	// Hash tracking for bandwidth optimization
	private lastConfigHash?: string;
	private lastEndpointHealthHash?: string;
	private isFirstReport: boolean = true;
	
	// ETag caching for target state
	private targetStateETag?: string;
	
	// Polling control
	private pollTimer?: NodeJS.Timeout;
	private reportTimer?: NodeJS.Timeout;
	private isPolling: boolean = false;
	private isReporting: boolean = false;
	
	// Error tracking (kept for compatibility)
	private pollErrors: number = 0;
	private reportErrors: number = 0;
	
	// Circuit breakers & locks for poll/report protection
	private pollCircuit: CircuitBreaker;
	private reportCircuit: CircuitBreaker;
	private pollLock: AsyncLock;
	private reportLock: AsyncLock;
	
	// Connection monitoring & offline queue
	private connectionMonitor: ConnectionMonitor;
	private reportQueue: OfflineQueue<DeviceStateReport>;
	private logger?: AgentLogger;
	private sensorPublish?: any; // Optional sensor-publish feature for health reporting
	private endpoints?: any; // Optional endpoints feature for health reporting
	private mqttManager?: any; // Optional MQTT manager for state reporting
	
	// Event handlers (stored for proper cleanup)
	private onlineHandler = () => {
		this.logger?.infoSync('Connection restored - flushing offline queue', { 
			component: LogComponents.cloudSync,
			queueSize: this.reportQueue.size()
		});
		this.flushOfflineQueue().catch(error => {
			this.logger?.errorSync('Failed to flush offline queue', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.cloudSync
			});
		});
	};
	
	private offlineHandler = () => {
		const health = this.connectionMonitor.getHealth();
		this.logger?.errorSync('Connection lost', undefined, {
			component: LogComponents.cloudSync,
			offlineDurationSeconds: Math.floor(health.offlineDuration / 1000),
			status: health.status,
			pollSuccessRate: health.pollSuccessRate,
			reportSuccessRate: health.reportSuccessRate,
			note: 'Reports will be queued until connection is restored'
		});
	};
	
	private degradedHandler = () => {
		this.logger?.warnSync('Connection degraded (experiencing failures)', {
			component: LogComponents.cloudSync
		});
	};
	
	private reconciliationCompleteHandler = () => {
		this.scheduleReport('state-change');
	};
	
	private mqttReconnectHandler = () => {
		this.logger?.infoSync('MQTT reconnected - triggering fresh state report', {
			component: LogComponents.cloudSync,
			operation: 'mqtt-reconnect'
		});
	};
	
	constructor(
		stateReconciler: StateReconciler,
		deviceManager: DeviceManager,
		config: CloudSyncConfig,
		logger?: AgentLogger,
		sensorPublish?: any,
		endpoints?: any,
		mqttManager?: any,
		httpClient?: HttpClient,
		agentUpdater?: any
	) {
		super();
		this.stateReconciler = stateReconciler;
		this.deviceManager = deviceManager;
		this.logger = logger;
		this.sensorPublish = sensorPublish;
		this.mqttManager = mqttManager;
		this.agentUpdater = agentUpdater;
		
		// Set endpoints using method (provides logging)
		if (endpoints) {
			this.setEndpoints(endpoints);
		}
		
		// Set defaults FIRST (needed by createHttpClient)
		this.config = {
			cloudApiEndpoint: config.cloudApiEndpoint,
			pollInterval: config.pollInterval || 60000, // 60s
			reportInterval: config.reportInterval || 10000, // 10s
			metricsInterval: config.metricsInterval || 300000, // 5min
			apiTimeout: config.apiTimeout || 30000, // 30s
		};
		
		// Initialize HTTP client with TLS support (AFTER config is set)
		this.httpClient = httpClient || this.createHttpClient();
		
		// Initialize connection monitor (with logger)
		this.connectionMonitor = new ConnectionMonitor(logger);
		
		// Initialize circuit breakers (10 failures = 5min cooldown)
		this.pollCircuit = new CircuitBreaker(10, 5 * 60 * 1000);
		this.reportCircuit = new CircuitBreaker(10, 5 * 60 * 1000);
		
		// Initialize async locks for deduplication
		this.pollLock = new AsyncLock();
		this.reportLock = new AsyncLock();
		
		// Initialize offline queue for reports
		this.reportQueue = new OfflineQueue<DeviceStateReport>('state-reports', 1000);
		
		// Listen to connection events
		this.setupConnectionEventListeners();
	}

	/**
	 * Create HTTP client with TLS configuration from device info
	 * Uses centralized factory for consistent behavior
	 * 
	 * Note: This method is only called if no shared httpClient is provided to constructor
	 */
	private createHttpClient(): HttpClient {
		const deviceInfo = this.deviceManager.getDeviceInfo();
		const endpoint = this.config.cloudApiEndpoint;
		
		// Debug: log device info
		this.logger?.debugSync('Device info for HTTP client creation', {
			component: LogComponents.cloudSync,
			hasDeviceInfo: !!deviceInfo,
			uuid: deviceInfo?.uuid,
			hasApiKey: !!deviceInfo?.apiKey,
			hasApiTlsConfig: !!deviceInfo?.apiTlsConfig,
			hasCaCert: !!deviceInfo?.apiTlsConfig?.caCert,
			note: 'Creating dedicated HTTP client (shared client not provided)'
		});

		// Check if API TLS is configured (production mode with provisioned CA cert)
		const apiTlsConfig = deviceInfo?.apiTlsConfig;
		
		return createHttpClient(endpoint, {
			defaultTimeout: this.config.apiTimeout,
			defaultHeaders: { 'Content-Type': 'application/json' },
			caCert: apiTlsConfig?.caCert?.replace(/\\n/g, '\n') // Fix escaped newlines
		});
	}
	
	/**
	 * Update HTTP client with fresh device credentials
	 * Called after provisioning or device info changes
	 */
	public updateHttpClient(): void {
		this.logger?.infoSync('Updating HTTP client credentials', {
			component: LogComponents.cloudSync,
			operation: 'update-credentials'
		});
		
		this.httpClient = this.createHttpClient();
	}
	
	/**
	 * Update endpoints service reference (for health reporting)
	 * Called after first boot discovery completes
	 */
	public setEndpoints(endpoints: any): void {
		this.endpoints = endpoints;
		this.logger?.infoSync('Endpoints service updated', {
			component: LogComponents.cloudSync,
			operation: 'set-endpoints',
			hasEndpoints: !!endpoints
		});
	}
	
	/**
	 * Setup connection event listeners
	 */
	private setupConnectionEventListeners(): void {
		// Remove any existing listeners to prevent duplicates
		this.connectionMonitor.removeListener('online', this.onlineHandler);
		this.connectionMonitor.removeListener('offline', this.offlineHandler);
		this.connectionMonitor.removeListener('degraded', this.degradedHandler);
		
		// Add listeners
		this.connectionMonitor.on('online', this.onlineHandler);
		this.connectionMonitor.on('offline', this.offlineHandler);
		this.connectionMonitor.on('degraded', this.degradedHandler);
		
		// Listen to MQTT reconnect events (if MQTT manager is available and is EventEmitter)
		if (this.mqttManager && typeof this.mqttManager.on === 'function') {
			if (typeof this.mqttManager.removeListener === 'function') {
				this.mqttManager.removeListener('connect', this.mqttReconnectHandler);
			}
			this.mqttManager.on('connect', this.mqttReconnectHandler);
			
			this.logger?.debugSync('Registered MQTT reconnect listener', {
				component: LogComponents.cloudSync,
				operation: 'setup-mqtt-listener'
			});
		}
	}
	
	/**
	 * Start polling cloud for target state
	 */
	public async startPoll(): Promise<void> {
		if (this.isPolling) {
			this.logger?.warnSync('CloudSync already polling', { component: LogComponents.cloudSync });
			return;
		}
		
		// Initialize offline queue
		await this.reportQueue.init();
		
		this.isPolling = true;
		this.logger?.infoSync('Starting target state polling', {
			component: LogComponents.cloudSync,
			endpoint: this.config.cloudApiEndpoint,
			intervalMs: this.config.pollInterval
		});
		
		// Start polling loop
		await this.pollLoop();

		//Start reporting loop
		await this.startReporting();
	}
	
	/**
	 * Start reporting current state to cloud
	 */
	private async startReporting(): Promise<void> {
		if (this.isReporting) {
			this.logger?.warnSync('CloudSync already reporting', { component: LogComponents.cloudSync });
			return;
		}
		
		this.isReporting = true;
		this.logger?.infoSync('Starting state reporting', {
			component: LogComponents.cloudSync,
			endpoint: this.config.cloudApiEndpoint,
			intervalMs: this.config.reportInterval
		});
		
		// Listen for state changes from reconciler (remove old listener first)
		this.stateReconciler.removeListener('reconciliation-complete', this.reconciliationCompleteHandler);
		this.stateReconciler.on('reconciliation-complete', this.reconciliationCompleteHandler);
		
		// Start reporting loop
		await this.reportLoop();
	}
	
	/**
	 * Stop polling and reporting
	 */
	public async stop(): Promise<void> {
		this.logger?.infoSync('Stopping CloudSync', { component: LogComponents.cloudSync });
		
		try {
			// Clear timers FIRST to prevent new iterations
			if (this.pollTimer) {
				clearTimeout(this.pollTimer);
				this.pollTimer = undefined;
			}
			if (this.reportTimer) {
				clearTimeout(this.reportTimer);
				this.reportTimer = undefined;
			}
			
			// Then stop polling/reporting flags
			this.isPolling = false;
			this.isReporting = false;
			
			// Wait for current operations to finish (100ms grace period)
			await new Promise(resolve => setTimeout(resolve, 100));
			
			// Remove all event listeners to prevent memory leaks
			this.connectionMonitor.removeListener('online', this.onlineHandler);
			this.connectionMonitor.removeListener('offline', this.offlineHandler);
			this.connectionMonitor.removeListener('degraded', this.degradedHandler);
			this.stateReconciler.removeListener('reconciliation-complete', this.reconciliationCompleteHandler);
			
			if (this.mqttManager && typeof this.mqttManager.removeListener === 'function') {
				this.mqttManager.removeListener('connect', this.mqttReconnectHandler);
			}
			
			this.removeAllListeners();
			
			this.logger?.infoSync('CloudSync stopped successfully', { component: LogComponents.cloudSync });
		} catch (error) {
			// Always clear timers even if error occurs
			if (this.pollTimer) clearTimeout(this.pollTimer);
			if (this.reportTimer) clearTimeout(this.reportTimer);
			this.pollTimer = undefined;
			this.reportTimer = undefined;
			
			this.logger?.errorSync('Error stopping CloudSync', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.cloudSync
			});
			throw error;
		}
	}
	
	/**
	 * Get current target state
	 */
	public getTargetState(): DeviceState {
		return this.targetState;
	}
	
	/**
	 * Get connection health
	 */
	public getConnectionHealth() {
		return this.connectionMonitor.getHealth();
	}
	
	/**
	 * Check if currently online
	 */
	public isOnline(): boolean {
		return this.connectionMonitor.isOnline();
	}
	
	/**
	 * Update polling, reporting, and metrics intervals dynamically
	 * Changes take effect on the next scheduled iteration
	 */
	public updateIntervals(intervals: {
		pollInterval: number;
		reportInterval: number;
		metricsInterval: number;
	}): void {
		this.config.pollInterval = intervals.pollInterval;
		this.config.reportInterval = intervals.reportInterval;
		this.config.metricsInterval = intervals.metricsInterval;
		
		this.logger?.infoSync('CloudSync intervals updated', {
			component: LogComponents.cloudSync,
			pollIntervalMs: intervals.pollInterval,
			reportIntervalMs: intervals.reportInterval,
			metricsIntervalMs: intervals.metricsInterval,
			pollIntervalSec: intervals.pollInterval / 1000,
			reportIntervalSec: intervals.reportInterval / 1000,
			metricsIntervalMin: intervals.metricsInterval / 60000,
		});
		
		// Note: Current timers will complete with old intervals
		// New intervals take effect on next scheduled iteration
	}
	
	// ============================================================================
	// POLLING LOGIC
	// ============================================================================
	
	private async pollLoop(): Promise<void> {
		if (!this.isPolling) {
			return;
		}
		
		// Check circuit breaker
		if (this.pollCircuit.isOpen()) {
			const remaining = this.pollCircuit.getCooldownRemaining();
			this.logger?.warnSync('Poll circuit breaker open, cooling down', {
				component: LogComponents.cloudSync,
				operation: 'poll-circuit-open',
				cooldownRemainingMs: remaining,
				cooldownRemainingSec: Math.floor(remaining / 1000),
				failureCount: this.pollCircuit.getFailureCount()
			});
			
			// Schedule retry after cooldown
			this.pollTimer = setTimeout(() => this.pollLoop(), remaining + 1000);
			return;
		}
		
		// Check if already polling (deduplication)
		if (this.pollLock.isLocked()) {
			this.logger?.warnSync('Poll already in progress, skipping', {
				component: LogComponents.cloudSync,
				operation: 'poll-skip-locked'
			});
			this.pollTimer = setTimeout(() => this.pollLoop(), this.config.pollInterval);
			return;
		}
		
		try {
			// Execute with lock protection
			await this.pollLock.tryExecute(async () => {
				await this.pollTargetState();
			});
			
			this.pollErrors = 0; // Reset on success
			this.pollCircuit.recordSuccess(); // Reset circuit breaker
			this.connectionMonitor.markSuccess('poll'); // Track success
		} catch (error) {
			this.pollErrors = Math.min(this.pollErrors + 1, 10); // Cap at 10
			
			const circuitOpened = this.pollCircuit.recordFailure();
			this.connectionMonitor.markFailure('poll', error as Error); // Track failure
			
			// Extract the root cause for better error visibility
			const err = error instanceof Error ? error : new Error(String(error));
			const cause = (err as any).cause;
			
			if (circuitOpened) {
				this.logger?.errorSync('Poll circuit breaker tripped', err, {
					component: LogComponents.cloudSync,
					operation: 'poll-circuit-trip',
					consecutiveFailures: this.pollCircuit.getFailureCount(),
					cooldownMs: 5 * 60 * 1000,
					cooldownMin: 5
				});
			} else {
				this.logger?.errorSync('Failed to poll target state', err, {
					component: LogComponents.cloudSync,
					operation: 'poll',
					errorCount: this.pollErrors,
					...(cause && { 
						cause: {
							message: cause.message,
							code: cause.code,
							errno: cause.errno,
							syscall: cause.syscall
						}
					})
				});
			}
		}
		
		// Calculate next poll interval (exponential backoff with jitter on errors)
		let interval: number;
		if (this.pollErrors > 0) {
			// Use retry policy helper for exponential backoff with jitter
			interval = RetryPolicy.calculateBackoffWithJitter(
				this.pollErrors,
				15000,           // Base delay: 15s
				2,               // Backoff multiplier: 2x
				15 * 60 * 1000,  // Max delay: 15 minutes
				0.3              // Jitter: ±30%
			);
			
			this.logger?.debugSync('Poll backing off due to errors', {
				component: LogComponents.cloudSync,
				backoffSeconds: Math.floor(interval / 1000),
				attempt: this.pollErrors
			});
		} else {
			interval = this.config.pollInterval;
		}
		
		// Schedule next poll
		this.pollTimer = setTimeout(() => this.pollLoop(), interval);
	}
	
	private async pollTargetState(): Promise<void> {
		const deviceInfo = this.deviceManager.getDeviceInfo();
		
		if (!deviceInfo.provisioned) {
			this.logger?.debugSync('Device not provisioned, skipping target state poll', {
				component: LogComponents.cloudSync,
				operation: 'poll'
			});
			return;
		}
		
		const endpoint = buildDeviceEndpoint(this.config.cloudApiEndpoint, deviceInfo.uuid, '/state');
		
		try {
			// Get fresh API key from device manager
			const apiKey = deviceInfo.deviceApiKey;
			
			this.logger?.infoSync('Polling target state', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				currentETag: this.targetStateETag || 'none',
				hasApiKey: !!apiKey,
				apiKeyPrefix: apiKey ? apiKey.substring(0, 16) : 'none'
			});
			
			const response = await this.httpClient.get(endpoint, {
				headers: {
					'X-Device-API-Key': apiKey || '',
					...(this.targetStateETag && { 'if-none-match': this.targetStateETag }),
				},
			});
		
		
			// 304 Not Modified - target state unchanged
			if (response.status === 304) {
				return;
			}
		
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
		
		// Get ETag for next request
		const etag = response.headers.get('etag');
		this.logger?.debugSync('ETag received from server', {
			component: LogComponents.cloudSync,
			operation: 'poll',
			etag: etag || 'none'
		});
		if (etag) {
			this.targetStateETag = etag;
		}
		
		// Parse response
		const targetStateResponse = await response.json() as TargetStateResponse;

		const deviceState = targetStateResponse[deviceInfo.uuid];
		
		if (!deviceState) {
			this.logger?.warnSync('No target state for this device in response', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				deviceUuid: deviceInfo.uuid,
				availableUUIDs: Object.keys(targetStateResponse)
			});
			return;
		}			
		
		// Extract version from response  
		const targetVersion = deviceState.version || 1;
		
		// Always update currentVersion to match target, even if state unchanged
		// This ensures version tracking works after agent restarts
		this.currentVersion = targetVersion;
		
		// Check if target state changed
		const newTargetState: DeviceState = { 
			apps: deviceState.apps || {},
			config: deviceState.config || {}
		};
	
	
	// Compare states to detect changes
	const currentStateStr = JSON.stringify(this.targetState);
	const newStateStr = JSON.stringify(newTargetState);
	
	if (currentStateStr !== newStateStr) {
			this.logger?.infoSync('New target state received from cloud', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				deviceStateKeys: Object.keys(deviceState),
				version: targetVersion,
				appCount: Object.keys(newTargetState.apps).length,
				configKeyCount: Object.keys(newTargetState.config || {}).length,
				endpointsCount: deviceState.config?.endpoints?.length || 0,
		        newTargetStateApps: Object.keys(newTargetState.apps).length,
		        newTargetStateConfigKeys: Object.keys(newTargetState.config || {}).length,
				hasChanges: true
			});
			
			this.targetState = newTargetState;
			
			// Apply target state to state reconciler (handles both containers and config)
			await this.stateReconciler.setTarget(this.targetState);
			
			// // Trigger reconciliation
			// this.emit('target-state-changed', this.targetState);
			
			this.logger?.infoSync('Target state applied', {
				component: LogComponents.cloudSync,
				operation: 'apply-state',
				version: this.currentVersion
			});
			
			// Update CloudSync intervals if they changed in the new target state
			const newIntervals = deviceState.config?.intervals;
			if (newIntervals) {
				this.updateIntervals({
					pollInterval: newIntervals.targetStatePollIntervalMs || this.config.pollInterval,
					reportInterval: newIntervals.deviceReportIntervalMs || this.config.reportInterval,
					metricsInterval: newIntervals.metricsIntervalMs || this.config.metricsInterval,
				});
			}
		} else {
			this.logger?.debugSync('Target state fetched (no changes)', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				version: this.currentVersion
			});
		}		} catch (error) {
			if ((error as Error).name === 'AbortError') {
				throw new Error('Target state poll timeout');
			}
			throw error;
		}
	}
	
	// ============================================================================
	// REPORTING LOGIC
	// ============================================================================
	
	private async reportLoop(): Promise<void> {
		if (!this.isReporting) {
			return;
		}
		
		// Check circuit breaker
		if (this.reportCircuit.isOpen()) {
			const remaining = this.reportCircuit.getCooldownRemaining();
			this.logger?.warnSync('Report circuit breaker open, cooling down', {
				component: LogComponents.cloudSync,
				operation: 'report-circuit-open',
				cooldownRemainingMs: remaining,
				cooldownRemainingSec: Math.floor(remaining / 1000),
				failureCount: this.reportCircuit.getFailureCount()
			});
			
			// Schedule retry after cooldown
			this.reportTimer = setTimeout(() => this.reportLoop(), remaining + 1000);
			return;
		}
		
		// Check if already reporting (deduplication)
		if (this.reportLock.isLocked()) {
			this.logger?.warnSync('Report already in progress, skipping', {
				component: LogComponents.cloudSync,
				operation: 'report-skip-locked'
			});
			this.reportTimer = setTimeout(() => this.reportLoop(), this.config.reportInterval);
			return;
		}
		
		try {
			// Execute with lock protection
			await this.reportLock.tryExecute(async () => {
				await this.reportCurrentState();
			});
			
			this.reportErrors = 0; // Reset on success
			this.reportCircuit.recordSuccess(); // Reset circuit breaker
			this.connectionMonitor.markSuccess('report'); // Track success
			
			// Try to flush offline queue after successful report
			if (!this.reportQueue.isEmpty()) {
				await this.flushOfflineQueue();
			}
		} catch (error) {
			this.reportErrors = Math.min(this.reportErrors + 1, 10); // Cap at 10
			
			const circuitOpened = this.reportCircuit.recordFailure();
			this.connectionMonitor.markFailure('report', error as Error); // Track failure
			
			// Extract the root cause for better error visibility
			const err = error instanceof Error ? error : new Error(String(error));
			const cause = (err as any).cause;
			
			if (circuitOpened) {
				this.logger?.errorSync('Report circuit breaker tripped', err, {
					component: LogComponents.cloudSync,
					operation: 'report-circuit-trip',
					consecutiveFailures: this.reportCircuit.getFailureCount(),
					cooldownMs: 5 * 60 * 1000,
					cooldownMin: 5
				});
			} else {
				this.logger?.errorSync('Failed to report current state', err, {
					component: LogComponents.cloudSync,
					operation: 'report',
					errorCount: this.reportErrors,
					...(cause && { 
						cause: {
							message: cause.message,
							code: cause.code,
							errno: cause.errno,
							syscall: cause.syscall
						}
					})
				});
			}
		}
		
		// Calculate next report interval (exponential backoff with jitter on errors)
		let interval: number;
		if (this.reportErrors > 0) {
			// Use retry policy helper for exponential backoff with jitter
			interval = RetryPolicy.calculateBackoffWithJitter(
				this.reportErrors,
				15000,           // Base delay: 15s
				2,               // Backoff multiplier: 2x
				15 * 60 * 1000,  // Max delay: 15 minutes
				0.3              // Jitter: ±30%
			);
			
			this.logger?.debugSync('Report backing off due to errors', {
				component: LogComponents.cloudSync,
				backoffSeconds: Math.floor(interval / 1000),
				attempt: this.reportErrors
			});
		} else {
			interval = this.config.reportInterval;
		}
		
		// Schedule next report
		this.reportTimer = setTimeout(() => this.reportLoop(), interval);
	}
	
	private scheduleReport(reason: 'state-change' | 'metrics' | 'scheduled'): void {
		// Just emit event, actual reporting happens in reportLoop
		this.emit('report-scheduled', reason);
	}
	
	/**
	 * Strip unnecessary data from report before queueing for offline storage
	 * Removes verbose environment variables, labels, and duplicate metrics
	 * to reduce storage footprint and bandwidth when queue is flushed.
	 */
	private stripReportForQueue(report: DeviceStateReport): DeviceStateReport {
		const stripped: DeviceStateReport = {};
		
		for (const [uuid, deviceState] of Object.entries(report)) {
			stripped[uuid] = {
				apps: {},
				is_online: deviceState.is_online,
			};
			
			// Copy config (already minimal)
			if (deviceState.config) {
				stripped[uuid].config = deviceState.config;
			}
			
			// Copy static fields if present
			if (deviceState.os_version !== undefined) {
				stripped[uuid].os_version = deviceState.os_version;
			}
			if (deviceState.agent_version !== undefined) {
				stripped[uuid].agent_version = deviceState.agent_version;
			}
			if (deviceState.local_ip !== undefined) {
				stripped[uuid].local_ip = deviceState.local_ip;
			}
			
			// Strip verbose data from apps/services
			if (deviceState.apps) {
				for (const [appId, app] of Object.entries(deviceState.apps)) {
					stripped[uuid].apps[appId] = {
						appId: app.appId,
						appName: app.appName,
						services: app.services.map((svc: any) => ({
							appId: svc.appId,
							appName: svc.appName,
							serviceId: svc.serviceId,
							serviceName: svc.serviceName,
							status: svc.status,
							containerId: svc.containerId,
							imageName: svc.imageName,
							// Strip config.environment (verbose, rarely changes)
							// Strip config.labels (redundant metadata)
							config: {
								image: svc.config.image,
								restart: svc.config.restart,
								networkMode: svc.config.networkMode,
								ports: svc.config.ports,
								volumes: svc.config.volumes,
								networks: svc.config.networks,
								// environment: STRIPPED (50-100 lines per service)
								// labels: STRIPPED (redundant)
							}
						}))
					};
				}
			}
			
			// Include metrics only if present (but strip top_processes if queue gets large)
			if (deviceState.cpu_usage !== undefined) {
				stripped[uuid].cpu_usage = deviceState.cpu_usage;
			}
			if (deviceState.memory_usage !== undefined) {
				stripped[uuid].memory_usage = deviceState.memory_usage;
			}
			if (deviceState.memory_total !== undefined) {
				stripped[uuid].memory_total = deviceState.memory_total;
			}
			if (deviceState.storage_usage !== undefined) {
				stripped[uuid].storage_usage = deviceState.storage_usage;
			}
			if (deviceState.storage_total !== undefined) {
				stripped[uuid].storage_total = deviceState.storage_total;
			}
			if (deviceState.temperature !== undefined) {
				stripped[uuid].temperature = deviceState.temperature;
			}
			if (deviceState.uptime !== undefined) {
				stripped[uuid].uptime = deviceState.uptime;
			}
			
			// Strip top_processes (most verbose: 10 processes × 4 fields = 40 fields per report)
			// When queue has multiple reports, this becomes huge waste
			// The API doesn't need historical top_processes - only latest matters
			// Savings: ~2-5 KB per report depending on process names
		}
		
		return stripped;
	}
	
	private async reportCurrentState(): Promise<void> {
		const deviceInfo = this.deviceManager.getDeviceInfo();
		
		if (!deviceInfo.provisioned) {
			this.logger?.debugSync('Device not provisioned, skipping state report', {
				component: LogComponents.cloudSync,
				operation: 'report'
			});
			return;
		}
		
		const now = Date.now();
		
		// Check if we should report (rate limiting)
		const timeSinceLastReport = now - this.lastReportTime;
		const timeSinceLastMetrics = now - this.lastMetricsTime;
		
		if (timeSinceLastReport < this.config.reportInterval) {
			// Too soon to report
			return;
		}
		
		// Build current state report
		
		const currentState = await this.stateReconciler.getCurrentState();
	
		// Get metrics if interval elapsed
		const includeMetrics = timeSinceLastMetrics >= this.config.metricsInterval;
		
		// Detect changes in static fields (bandwidth optimization)
		const osVersionChanged = deviceInfo.osVersion !== this.lastOsVersion;
		const agentVersionChanged = deviceInfo.agentVersion !== this.lastAgentVersion;
		
	// Hash-based endpoints change detection (bandwidth optimization)
	// Only track endpoints, not full config (static fields like protocols, intervals, logging, etc. are not reported)
	const endpointsHash = this.calculateHash(currentState.config?.endpoints);
	const endpointsChanged = endpointsHash !== this.lastConfigHash || this.isFirstReport;
	
	// Collect endpoint health (dynamic runtime status) - now async
	const endpointHealth = await this.collectEndpointHealth();
	const healthHash = this.calculateHash(endpointHealth);
	const healthChanged = healthHash !== this.lastEndpointHealthHash || this.isFirstReport;
	
	// Build base state report
	const stateReport: DeviceStateReport = {
		[deviceInfo.uuid]: {
			apps: currentState.apps,
			is_online: this.connectionMonitor.isOnline(),
			version: this.currentVersion,
		},
	};
	
	// Only include dynamic config (endpoints) if changed or first report
	// Static config (protocols, intervals, logging, features, runtime, anomalyDetection) is not reported back
	// since it's controlled by target state and should not be echoed in current state
	// Note: version is already reported at root level (stateReport.version), not in config
	if (endpointsChanged) {
		stateReport[deviceInfo.uuid].config = {
			endpoints: currentState.config?.endpoints || []
		};
		this.logger?.infoSync('Endpoints config changed - including in report', {
			component: LogComponents.cloudSync,
			operation: 'config-change-detected',
			configHash: endpointsHash,
			endpointCount: currentState.config?.endpoints?.length || 0
		});
	}
	
	// Only include endpoint health if changed, or always on metrics cycle
	if (healthChanged || includeMetrics) {
		(stateReport[deviceInfo.uuid] as any).endpoints_health = endpointHealth;
		this.logger?.debugSync('Including endpoint health in report', {
			component: LogComponents.cloudSync,
			operation: 'add-endpoint-health',
			healthChanged,
			includeMetrics,
			endpointCount: Object.keys(endpointHealth).length
		});
	} else {
		this.logger?.debugSync('Skipping endpoint health (not changed and not metrics cycle)', {
			component: LogComponents.cloudSync,
			operation: 'skip-endpoint-health',
			healthChanged,
			includeMetrics,
			lastHash: this.lastEndpointHealthHash?.substring(0, 8),
			currentHash: healthHash.substring(0, 8)
		});
	}
	
	// Only include static fields if changed (bandwidth optimization)
	if (osVersionChanged || this.lastOsVersion === undefined) {
		stateReport[deviceInfo.uuid].os_version = deviceInfo.osVersion;
		this.lastOsVersion = deviceInfo.osVersion;
	}
	if (agentVersionChanged || this.lastAgentVersion === undefined) {
		stateReport[deviceInfo.uuid].agent_version = deviceInfo.agentVersion;
		this.lastAgentVersion = deviceInfo.agentVersion;
	}
		
	// Add metrics if needed
	if (includeMetrics) {
		try {
			const metricsStartTime = Date.now();
			const metrics = await systemMetrics.getSystemMetrics();
			const metricsElapsedMs = Date.now() - metricsStartTime;
			
			this.logger?.debugSync('System metrics collection completed', {
				component: LogComponents.cloudSync,
				operation: 'collect-metrics',
				elapsedMs: metricsElapsedMs,
				elapsedSeconds: (metricsElapsedMs / 1000).toFixed(2)
			});
			
			stateReport[deviceInfo.uuid].cpu_usage = metrics.cpu_usage;
			stateReport[deviceInfo.uuid].memory_usage = metrics.memory_usage;
			stateReport[deviceInfo.uuid].memory_total = metrics.memory_total;
			stateReport[deviceInfo.uuid].storage_usage = metrics.storage_usage ?? undefined;
			stateReport[deviceInfo.uuid].storage_total = metrics.storage_total ?? undefined;
			stateReport[deviceInfo.uuid].temperature = metrics.cpu_temp ?? undefined;
			stateReport[deviceInfo.uuid].uptime = metrics.uptime;
			stateReport[deviceInfo.uuid].top_processes = metrics.top_processes ?? [];
			stateReport[deviceInfo.uuid].network_interfaces = metrics.network_interfaces ?? [];
			
			// Get IP address from network interfaces (only include if changed)
			const primaryInterface = metrics.network_interfaces.find(i => i.default);
			const currentIp = primaryInterface?.ip4;
			if (currentIp && (currentIp !== this.lastLocalIp || this.lastLocalIp === undefined)) {
				stateReport[deviceInfo.uuid].local_ip = currentIp;
				this.lastLocalIp = currentIp;
			}
		
		this.lastMetricsTime = now;
	} catch (error) {
		this.logger?.warnSync('Failed to collect metrics', {
			component: LogComponents.cloudSync,
			operation: 'collect-metrics',
			error: error instanceof Error ? error.message : String(error)
		});
	}		// Add sensor health stats (if sensor-publish is enabled)

	if (this.sensorPublish) {
			try {
				const sensorStats = this.sensorPublish.getStats();
				(stateReport[deviceInfo.uuid] as any).sensor_health = sensorStats;
			} catch (error) {
				this.logger?.warnSync('Failed to collect sensor stats', {
					component: LogComponents.cloudSync,
					operation: 'collect-sensor-stats',
					error: error instanceof Error ? error.message : String(error)
				});
			}
	}
		
		// Add VPN health stats (only if device was provisioned WITH VPN credentials)
		if (deviceInfo.provisioned && deviceInfo.vpnEnabled) {
			try {
				const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
				const tailscale = new TailscaleManager(this.logger);
				const vpnHealth = await tailscale.getHealth();
				(stateReport[deviceInfo.uuid] as any).vpn_health = vpnHealth;
				
				// Log VPN issues with state-aware classification
				tailscale.logHealthIssues(vpnHealth);
			} catch (error) {
				this.logger?.warnSync('Failed to collect VPN health stats', {
					component: LogComponents.cloudSync,
					operation: 'collect-vpn-health',
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		
		// Log complete metrics report if metrics were collected
	//    if (includeMetrics) {
	// 		this.logger?.debugSync('Metrics Report', {
	// 			component: LogComponents.metrics,
	// 			report: stateReport[deviceInfo.uuid],
	// 		});
	//}

	}	// Build state-only report for diff comparison (without metrics)
	// This represents the CURRENT state that should be compared for changes
	const stateOnlyReport: DeviceStateReport = {
		[deviceInfo.uuid]: {
			apps: currentState.apps,
			is_online: this.connectionMonitor.isOnline(),
			version: this.currentVersion,
		},
	};
	
	// Include config in state comparison only if it was included in stateReport
	if (endpointsChanged && stateReport[deviceInfo.uuid].config) {
		stateOnlyReport[deviceInfo.uuid].config = stateReport[deviceInfo.uuid].config;
	}
	
	// Include endpoint health in state comparison only if it was included
	if ((healthChanged || includeMetrics) && (stateReport[deviceInfo.uuid] as any).endpoints_health) {
		(stateOnlyReport[deviceInfo.uuid] as any).endpoints_health = (stateReport[deviceInfo.uuid] as any).endpoints_health;
	}
	
	// Include static fields in state comparison if they were included in the report
	if (stateReport[deviceInfo.uuid].os_version !== undefined) {
		stateOnlyReport[deviceInfo.uuid].os_version = stateReport[deviceInfo.uuid].os_version;
	}
	// Always include agent_version (critical for reconciliation)
	if (this.agentUpdater) {
		const agentVersion = this.agentUpdater.getCurrentVersion();
		stateOnlyReport[deviceInfo.uuid].agent_version = agentVersion;
		stateReport[deviceInfo.uuid].agent_version = agentVersion;
	} else if (stateReport[deviceInfo.uuid].agent_version !== undefined) {
		stateOnlyReport[deviceInfo.uuid].agent_version = stateReport[deviceInfo.uuid].agent_version;
	}
	
	// Calculate diff - compare against last report to see what changed
	const diff = this.calculateStateDiff(this.lastReport, stateOnlyReport);
	
	// Determine if we should report
	// Report if: there are changes in state OR we need to send metrics OR it's first report
	const shouldReport = Object.keys(diff).length > 0 || includeMetrics || endpointsChanged || healthChanged;
	
	if (!shouldReport) {
		// No changes to report
		return;
	}
	
	// Build the actual report to send
	// Start with base (always include apps, online status, version)
	const reportToSend: DeviceStateReport = {
		[deviceInfo.uuid]: {
			apps: currentState.apps,
			is_online: this.connectionMonitor.isOnline(),
			version: this.currentVersion,
		},
	};
	
	// Add config (endpoints only) if it changed
	if (endpointsChanged && stateReport[deviceInfo.uuid].config) {
		reportToSend[deviceInfo.uuid].config = stateReport[deviceInfo.uuid].config;
	}
	
	// Add endpoint health only if it changed or metrics cycle
	if (healthChanged || includeMetrics) {
		(reportToSend[deviceInfo.uuid] as any).endpoints_health = endpointHealth;
	}
	
	// Add static fields only if they changed
	if (osVersionChanged || this.lastOsVersion === undefined) {
		reportToSend[deviceInfo.uuid].os_version = deviceInfo.osVersion;
	}
	if (agentVersionChanged || this.lastAgentVersion === undefined) {
		reportToSend[deviceInfo.uuid].agent_version = deviceInfo.agentVersion;
	}
	
	// Add metrics if needed
	if (includeMetrics && stateReport[deviceInfo.uuid].cpu_usage !== undefined) {
		reportToSend[deviceInfo.uuid].cpu_usage = stateReport[deviceInfo.uuid].cpu_usage;
		reportToSend[deviceInfo.uuid].memory_usage = stateReport[deviceInfo.uuid].memory_usage;
		reportToSend[deviceInfo.uuid].memory_total = stateReport[deviceInfo.uuid].memory_total;
		reportToSend[deviceInfo.uuid].storage_usage = stateReport[deviceInfo.uuid].storage_usage;
		reportToSend[deviceInfo.uuid].storage_total = stateReport[deviceInfo.uuid].storage_total;
		reportToSend[deviceInfo.uuid].temperature = stateReport[deviceInfo.uuid].temperature;
		reportToSend[deviceInfo.uuid].uptime = stateReport[deviceInfo.uuid].uptime;
		reportToSend[deviceInfo.uuid].top_processes = stateReport[deviceInfo.uuid].top_processes;
		reportToSend[deviceInfo.uuid].network_interfaces = stateReport[deviceInfo.uuid].network_interfaces;
		reportToSend[deviceInfo.uuid].local_ip = stateReport[deviceInfo.uuid].local_ip;
	}
	
	// Add sensor health if available and metrics cycle
	if (includeMetrics && (stateReport[deviceInfo.uuid] as any).sensor_health) {
		(reportToSend[deviceInfo.uuid] as any).sensor_health = (stateReport[deviceInfo.uuid] as any).sensor_health;
	}
	
	// Add VPN health if available and metrics cycle
	if (includeMetrics && (stateReport[deviceInfo.uuid] as any).vpn_health) {
		(reportToSend[deviceInfo.uuid] as any).vpn_health = (stateReport[deviceInfo.uuid] as any).vpn_health;
	}
	
	// Skip sending if report has no meaningful data (empty config, empty apps, no metrics)
	const hasConfig = reportToSend[deviceInfo.uuid].config !== undefined;
	const hasApps = reportToSend[deviceInfo.uuid].apps && Object.keys(reportToSend[deviceInfo.uuid].apps).length > 0;
	
	// Only skip if BOTH config and apps are empty (metrics/health alone are still valuable)
	if (!hasConfig && !hasApps) {
		this.logger?.infoSync('Skipping empty state report (no config or apps)', {
			component: LogComponents.cloudSync,
			operation: 'skip-empty-report',
			isOnline: this.connectionMonitor.isOnline(),
			version: this.currentVersion
		});
		return;
	}
		
		// Send report to cloud
		try {
			await this.sendReport(reportToSend);

			// Update hashes after successful send (ALWAYS, even if unchanged)
			this.lastConfigHash = endpointsHash;
			this.lastEndpointHealthHash = healthHash;
			
			// Clear first report flag
			if (this.isFirstReport) {
				this.isFirstReport = false;
			}
			
			// Update last report (state only, no metrics)
			this.lastReport = stateOnlyReport;
			this.lastReportTime = now;
			
			// Log with bandwidth optimization details
			const optimizationDetails: any = {
				component: LogComponents.cloudSync,
				operation: 'report',
				includeMetrics,
				version: this.currentVersion,
				reportedVersion: stateReport[deviceInfo.uuid].version,
			configIncluded: endpointsChanged,
			endpointHealthIncluded: healthChanged || includeMetrics,
			isFirstReport: this.isFirstReport
		};
		
		// Track which static fields were included (for debugging)
		if (osVersionChanged || agentVersionChanged || 
			(includeMetrics && stateReport[deviceInfo.uuid].local_ip !== undefined)) {
			}
			
			// Log what was actually sent
			this.logger?.infoSync('Reported current state', {
				...optimizationDetails,
				reportKeys: Object.keys(reportToSend[deviceInfo.uuid] || {}),
				endpointCount: reportToSend[deviceInfo.uuid]?.config?.endpoints?.length || 0,
				endpointHealthCount: Object.keys(endpointHealth).length
			});
			
		} catch (error) {
			// Failed to send - queue for later (regardless of connection state)
			// This ensures we don't lose reports during degraded/offline states
			const connectionHealth = this.connectionMonitor.getHealth();
			
			this.logger?.debugSync('Report failed, queueing for retry', {
				component: LogComponents.cloudSync,
				operation: 'report',
				connectionStatus: connectionHealth.status,
				queueSize: this.reportQueue.size()
			});
			
			// Strip verbose data before queueing to save storage
			const strippedReport = this.stripReportForQueue(reportToSend);
			const originalSize = JSON.stringify(reportToSend).length;
			const strippedSize = JSON.stringify(strippedReport).length;
			const savings = originalSize - strippedSize;
			const savingsPercent = ((savings / originalSize) * 100).toFixed(1);
			
			this.logger?.infoSync('Queueing report for later', {
				component: LogComponents.cloudSync,
				operation: 'queue-report',
				originalBytes: originalSize,
				strippedBytes: strippedSize,
				savings: `${savings} bytes (${savingsPercent}%)`,
				connectionStatus: connectionHealth.status
			});
			
			await this.reportQueue.enqueue(strippedReport);
			this.logger?.debugSync('Report queued', {
				component: LogComponents.cloudSync,
				queueSize: this.reportQueue.size(),
				connectionStatus: connectionHealth.status
			});
			
			throw error;
		}
	}
	
	/**
	 * Send report to cloud API
	 * Uses MQTT as primary path with HTTP as fallback
	 */
	private async sendReport(report: DeviceStateReport): Promise<void> {
		const deviceInfo = this.deviceManager.getDeviceInfo();
		
		// Check MQTT health FIRST - skip if disconnected to avoid wasted attempts
		const mqttHealthy = this.mqttManager?.isConnected() ?? false;
		
		// Try MQTT first if manager is available AND healthy
		if (mqttHealthy) {
			try {
				const topic = `iot/device/${deviceInfo.uuid}/state`;
				const payload = JSON.stringify(report);
				const payloadSize = Buffer.byteLength(payload, 'utf8');
			
			// QoS 1 is better - will help for small network blips
			await this.mqttManager!.publishNoQueue(topic, payload, { qos: 1 });
			
			this.logger?.debugSync('State report sent via MQTT', {
				component: LogComponents.cloudSync,
				operation: 'mqtt-success',
				bytes: payloadSize,
				transport: 'mqtt'
			});				return; // Success - no need for HTTP fallback
				
			} catch (mqttError) {
				// MQTT failed (timeout or publish error) - log and fall through to HTTP
				this.logger?.warnSync('MQTT publish failed, falling back to HTTP', {
					component: LogComponents.cloudSync,
					operation: 'mqtt-fallback',
					error: mqttError instanceof Error ? mqttError.message : String(mqttError),
					transport: 'mqtt→http'
				});
			}
		} else if (this.mqttManager) {
			// MQTT manager exists but is unhealthy - skip MQTT attempt
			this.logger?.warnSync('MQTT disconnected, using HTTP fallback', {
				component: LogComponents.cloudSync,
				operation: 'mqtt-skip',
				transport: 'http',
				reason: 'mqtt-unavailable'
			});
		}
		
		// MQTT not available, unhealthy, or failed - use HTTP fallback
		const endpoint = buildApiEndpoint(this.config.cloudApiEndpoint, '/device/state');
		const protocol = endpoint.startsWith('https://') ? 'https' : 'http';
		
		// Get fresh API key from device manager
		const apiKey = deviceInfo.deviceApiKey;
		
		// Use httpClient.patch() WITHOUT compression (Envoy Gateway auto-decompresses and corrupts body)
		const response = await this.httpClient.patch(endpoint, report, {
			headers: {
				'X-Device-API-Key': apiKey || '',
			},
			compress: true  // Disabled: Envoy strips Content-Encoding, causing body corruption
		});
		
		if (!response.ok) {
			throw new Error(`${protocol.toUpperCase()} ${response.status}: ${response.statusText}`);
		}
		
		this.logger?.debugSync(`State report sent via ${protocol.toUpperCase()}`, {
			component: LogComponents.cloudSync,
			operation: 'http-success',
			transport: protocol
		});
	}
	
	/**
	 * Flush offline queue (send all queued reports)
	 */
	private async flushOfflineQueue(): Promise<void> {
		if (this.reportQueue.isEmpty()) {
			return;
		}
		
		const queueSize = this.reportQueue.size();
		this.logger?.infoSync('Flushing offline queue', {
			component: LogComponents.cloudSync,
			operation: 'flush-queue',
			queueSize
		});
		
		const sentCount = await this.reportQueue.flush(
			async (report) => await this.sendReport(report),
			{ maxRetries: 3, continueOnError: false }
		);
		
		if (sentCount > 0) {
			this.logger?.infoSync('Successfully flushed queued reports', {
				component: LogComponents.cloudSync,
				operation: 'flush-queue',
				sentCount,
				totalCount: queueSize
			});
		}
	}
	
	/**
	 * Compare apps objects, ignoring runtime fields like containerId and status
	 * These fields change when containers are recreated but don't represent config changes
	 */
	private appsChanged(oldApps: any, newApps: any): boolean {
		// Remove runtime fields from services before comparison
		const normalizeService = (service: any) => {
			const { containerId, status, ...configFields } = service;
			return configFields;
		};
		
		const normalizeApp = (app: any) => {
			if (!app || !app.services) return app;
			return {
				...app,
				services: app.services.map(normalizeService),
			};
		};
		
		const normalizedOld: any = {};
		const normalizedNew: any = {};
		
		for (const appId in oldApps) {
			normalizedOld[appId] = normalizeApp(oldApps[appId]);
		}
		
		for (const appId in newApps) {
			normalizedNew[appId] = normalizeApp(newApps[appId]);
		}
		
		const oldStr = JSON.stringify(normalizedOld);
		const newStr = JSON.stringify(normalizedNew);
		
		if (oldStr !== newStr) {
			return true;
		}
		
		return false;
	}

	/**
	 * Calculate MD5 hash of any object
	 * Used for detecting config and health changes
	 */
	private calculateHash(obj: any): string {
		return createHash('md5')
			.update(JSON.stringify(obj))
			.digest('hex');
	}

	/**
	 * Collect endpoint health data from endpoints feature
	 * Returns dynamic runtime status (NOT static metadata)
	 */
	private async collectEndpointHealth(): Promise<Record<string, any>> {
		// Check if endpoints service exists AND has the required method
		if (!this.endpoints || typeof this.endpoints.getAllDeviceStatuses !== 'function') {
			this.logger?.debugSync('No endpoints service available for health collection', {
				component: LogComponents.cloudSync,
				operation: 'collect-endpoint-health',
				hasEndpoints: !!this.endpoints,
				endpointsType: this.endpoints ? typeof this.endpoints : 'undefined',
				hasMethod: this.endpoints ? typeof this.endpoints.getAllDeviceStatuses : 'N/A'
			});
			return {};
		}
		
		try {
			// getAllDeviceStatuses() queries database + overlays adapter runtime status
			const health = await this.endpoints.getAllDeviceStatuses();
			
			this.logger?.debugSync('Collected endpoint health', {
				component: LogComponents.cloudSync,
				operation: 'collect-endpoint-health',
				healthCount: Object.keys(health).length,
				endpoints: Object.keys(health),
				sampleHealth: Object.keys(health).length > 0 ? health[Object.keys(health)[0]] : null
			});
			
			return health;
		} catch (error) {
			this.logger?.warnSync('Failed to collect endpoint health', {
				component: LogComponents.cloudSync,
				operation: 'collect-endpoint-health',
				error: error instanceof Error ? error.message : String(error)
			});
			return {};
		}
	}
	
	/**
	 * Calculate diff between two state reports
	 * 
	 * Compares only app state and non-metrics fields.
	 * Both states should NOT contain metrics fields.
	 */
	private calculateStateDiff(
		oldState: DeviceStateReport,
		newState: DeviceStateReport,
	): Partial<DeviceStateReport> {
		const diff: any = {};
		
		for (const uuid in newState) {
			const oldDevice = oldState[uuid] || {};
			const newDevice = newState[uuid];
			const deviceDiff: any = {};
			
			// Compare each field in newDevice
			for (const key in newDevice) {
				const oldValue = (oldDevice as any)[key];
				const newValue = (newDevice as any)[key];
				
				// Deep comparison for apps object (excluding runtime fields)
				if (key === 'apps') {
					if (this.appsChanged(oldValue || {}, newValue || {})) {
						deviceDiff[key] = newValue;
					}
				}
				// Deep comparison for config object (sensors, features, settings)
				// This prevents sending verbose sensor configs on every report
				else if (key === 'config') {
					const oldConfigStr = JSON.stringify(oldValue || {});
					const newConfigStr = JSON.stringify(newValue || {});
					if (oldConfigStr !== newConfigStr) {
						deviceDiff[key] = newValue;
					}
				}
				// Shallow comparison for other primitives (is_online, local_ip, version, etc.)
				else {
					if (oldValue !== newValue) {
						deviceDiff[key] = newValue;
					}
				}
			}
			
			// Only include device if there are changes
			if (Object.keys(deviceDiff).length > 0) {
				diff[uuid] = deviceDiff;
			}
		}
		
		return diff;
	}
}
