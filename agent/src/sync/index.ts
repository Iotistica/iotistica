import { EventEmitter } from 'events';
import type { StateManager } from '../core/state.js';
import type { AgentManager } from '../core/index.js';
import type { HttpClient } from '../lib/http-client.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { ConnectionMonitor } from '../health/connection-monitor.js';
import { createHttpClient } from '../lib/http-client.js';
import type { PublishMode } from '../mqtt/manager.js';
import type { CloudSyncConfig, CloudSyncMqttManager } from './types.js';
import { DeviceModel } from '../db/models/device.model.js';
import * as systemMetrics from '../system/metrics.js';
import { CloudTransport } from './transport.js';
import { StatePoller } from './state-poller.js';
import { StateReporter } from './state-reporter.js';

export type { AgentDeviceReport } from './types.js';

export class CloudSync extends EventEmitter {
	private readonly config: Required<CloudSyncConfig>;
	private readonly connectionMonitor: ConnectionMonitor;
	private readonly transport: CloudTransport;
	private readonly poller: StatePoller;
	private readonly reporter: StateReporter;

	private isStarted = false;
	private pollerStarted = false;
	private startedAt = 0;
	private static readonly STARTUP_GRACE_MS = 30_000; // allow first poll + report to complete
	private endpointsRef?: any;

	private devicesCache: any[] | null = null;
	private devicesCacheExpiresAt = 0;
	private static readonly DEVICES_CACHE_TTL_MS = 30_000;

	// Event handlers (stored for proper cleanup)
	private onlineHandler = () => {
		this.setPublishMode('direct', 'cloudsync-online');
		this.mqttManager?.requestBufferedFlush?.('cloudsync-online');
		this.logger?.infoSync('Connection restored - flushing offline queue', {
			component: LogComponents.cloudSync,
			queueSize: this.transport.reportQueue.size(),
		});
		this.emit('online');
		this.transport.flushOfflineQueue().catch(error => {
			this.logger?.errorSync('Failed to flush offline queue', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.cloudSync,
			});
		});
	};

	private offlineHandler = () => {
		this.setPublishMode('buffer-only', 'cloudsync-offline');
		const health = this.connectionMonitor.getHealth();
		this.emit('offline');
		this.logger?.errorSync('Connection lost', undefined, {
			component: LogComponents.cloudSync,
			offlineDurationSeconds: Math.floor(health.offlineDuration / 1000),
			status: health.status,
			pollSuccessRate: health.pollSuccessRate,
			reportSuccessRate: health.reportSuccessRate,
			note: 'Reports will be queued until connection is restored',
		});
	};

	private degradedHandler = () => {
		this.setPublishMode('buffer-only', 'cloudsync-degraded');
		this.emit('degraded');
		this.logger?.warnSync('Connection degraded (experiencing failures)', {
			component: LogComponents.cloudSync,
		});
	};

	private reconciliationCompleteHandler = () => {
		this.reporter.requestImmediateReport('reconciliation-complete');
	};

	private mqttReconnectHandler = () => {
		this.setPublishMode('recovering', 'mqtt-reconnect');
		this.reporter.requestImmediateReport('mqtt-reconnect');
		this.logger?.infoSync('MQTT reconnected - triggering fresh state report', {
			component: LogComponents.cloudSync,
			operation: 'mqtt-reconnect',
		});
	};

	constructor(
		private readonly stateManager: StateManager,
		private readonly deviceManager: AgentManager,
		config: CloudSyncConfig,
		private readonly logger?: AgentLogger,
		private readonly devicePublish?: any,
		endpoints?: any,
		private readonly mqttManager?: CloudSyncMqttManager,
		httpClient?: HttpClient,
		agentUpdater?: any,
	) {
		super();

		this.endpointsRef = endpoints;

		this.config = {
			cloudApiEndpoint: config.cloudApiEndpoint,
			pollInterval: config.pollInterval || 60000,
			reportInterval: config.reportInterval || 10000,
			metricsInterval: config.metricsInterval || 300000,
			apiTimeout: config.apiTimeout || 30000,
		};

		const resolvedHttpClient: HttpClient = httpClient || this.createHttpClient();

		this.connectionMonitor = new ConnectionMonitor(logger);

		this.transport = new CloudTransport(
			mqttManager,
			resolvedHttpClient,
			this.config.cloudApiEndpoint,
			() => this.deviceManager.getAgentInfo(),
			() => this.getPublishMode(),
			logger,
			() => this.config.apiTimeout,
		);

		this.poller = new StatePoller(
			resolvedHttpClient,
			stateManager,
			this.config.cloudApiEndpoint,
			() => ({ pollInterval: this.config.pollInterval, apiTimeout: this.config.apiTimeout }),
			() => this.deviceManager.getAgentInfo(),
			logger,
		);

		this.poller.on('target-state-changed', (newState: any, intervals?: any) => {
			if (intervals) {
				this.updateIntervals({
					pollInterval: intervals.targetStatePollIntervalMs || this.config.pollInterval,
					reportInterval: intervals.reportIntervalMs || this.config.reportInterval,
					metricsInterval: intervals.metricsIntervalMs || this.config.metricsInterval,
				});
			}
		});

		this.poller.on('poll-success', () => this.connectionMonitor.markSuccess('poll'));
		this.poller.on('poll-error', (err: Error) => this.connectionMonitor.markFailure('poll', err));

		this.reporter = new StateReporter({
			stateManager,
			transport: this.transport,
			connectionMonitor: this.connectionMonitor,
			getTargetVersion: () => this.poller.getCurrentVersion(),
			getAgentInfo: () => this.deviceManager.getAgentInfo(),
			getConfig: () => ({
				reportInterval: this.config.reportInterval,
				metricsInterval: this.config.metricsInterval,
			}),
			getPublishMode: () => this.getPublishMode(),
			setPublishMode: (mode, reason) => this.setPublishMode(mode, reason ?? ''),
			requestMqttFlush: (reason) => this.mqttManager?.requestBufferedFlush?.(reason),
			getEndpoints: () => this.endpointsRef,
			devicePublish: this.devicePublish,
			agentUpdater,
			getDevices: async () => {
				const now = Date.now();
				if (this.devicesCache && now < this.devicesCacheExpiresAt) {
					return this.devicesCache;
				}
				this.devicesCache = await DeviceModel.getAllWithEndpointUuid();
				this.devicesCacheExpiresAt = now + CloudSync.DEVICES_CACHE_TTL_MS;
				return this.devicesCache;
			},
			getSystemMetrics: () => systemMetrics.getSystemMetrics(),
			platformArch: process.arch,
			logger,
		});
	}

	private createHttpClient(): HttpClient {
		const agentInfo = this.deviceManager.getAgentInfo();
		const apiTlsConfig = agentInfo?.apiTlsConfig;
		return createHttpClient(this.config.cloudApiEndpoint, {
			defaultTimeout: this.config.apiTimeout,
			defaultHeaders: { 'Content-Type': 'application/json' },
			caCert: apiTlsConfig?.caCert?.replace(/\\n/g, '\n'),
		});
	}

	public updateHttpClient(httpClient: HttpClient): void {
		this.transport.updateHttpClient(httpClient);
		this.poller.updateHttpClient(httpClient);
		this.logger?.infoSync('HTTP client updated on transport and poller', {
			component: LogComponents.cloudSync,
			operation: 'update-http-client',
		});
	}

	public setDevices(endpoints: any): void {
		this.endpointsRef = endpoints;
		this.logger?.infoSync('Devices service updated', {
			component: LogComponents.cloudSync,
			operation: 'set-endpoints',
			hasEndpoints: !!endpoints,
		});
	}

	private setupConnectionEventListeners(): void {
		this.connectionMonitor.removeListener('online', this.onlineHandler);
		this.connectionMonitor.removeListener('offline', this.offlineHandler);
		this.connectionMonitor.removeListener('degraded', this.degradedHandler);

		this.connectionMonitor.on('online', this.onlineHandler);
		this.connectionMonitor.on('offline', this.offlineHandler);
		this.connectionMonitor.on('degraded', this.degradedHandler);

		if (this.mqttManager && typeof this.mqttManager.on === 'function') {
			this.mqttManager.removeListener?.('connect', this.mqttReconnectHandler);
			this.mqttManager.on('connect', this.mqttReconnectHandler);
		}
	}

	public async startPoll(): Promise<void> {
		if (this.isStarted) {
			this.logger?.warnSync('CloudSync already started', { component: LogComponents.cloudSync });
			return;
		}
		this.isStarted = true;
		this.startedAt = Date.now();

		await this.transport.initQueue();
		this.setupConnectionEventListeners();

		// Register reconciliation listener
		this.stateManager.removeListener('reconciliation-complete', this.reconciliationCompleteHandler);
		this.stateManager.on('reconciliation-complete', this.reconciliationCompleteHandler);

		this.logger?.infoSync('Starting CloudSync (poll + report)', {
			component: LogComponents.cloudSync,
			endpoint: this.config.cloudApiEndpoint,
			pollIntervalMs: this.config.pollInterval,
			reportIntervalMs: this.config.reportInterval,
		});

		// Start sequentially so a failure in one doesn't leave the other dangling.
		await this.poller.start();
		this.pollerStarted = true;
		await this.reporter.start();
	}

	/** Report-only mode: starts the reporter but not the state poller.
	 *  Call enablePoller() later to begin pulling target state from the cloud. */
	public async startReportOnly(): Promise<void> {
		if (this.isStarted) {
			this.logger?.warnSync('CloudSync already started', { component: LogComponents.cloudSync });
			return;
		}
		this.isStarted = true;
		this.startedAt = Date.now();

		await this.transport.initQueue();
		this.setupConnectionEventListeners();

		this.stateManager.removeListener('reconciliation-complete', this.reconciliationCompleteHandler);
		this.stateManager.on('reconciliation-complete', this.reconciliationCompleteHandler);

		this.logger?.infoSync('Starting CloudSync in report-only mode (target-state pull disabled)', {
			component: LogComponents.cloudSync,
			endpoint: this.config.cloudApiEndpoint,
			reportIntervalMs: this.config.reportInterval,
			note: 'Enable target sync from the admin UI to begin pulling cloud target state',
		});

		await this.reporter.start();
	}

	/** Enable the state poller after running in report-only mode. */
	public async enablePoller(): Promise<void> {
		if (!this.isStarted) {
			this.logger?.warnSync('CloudSync not started — call startReportOnly() or startPoll() first', {
				component: LogComponents.cloudSync,
			});
			return;
		}
		if (this.pollerStarted) {
			this.logger?.warnSync('State poller already running', { component: LogComponents.cloudSync });
			return;
		}
		this.logger?.infoSync('Enabling target-state poller', { component: LogComponents.cloudSync });
		await this.poller.start();
		this.pollerStarted = true;
	}

	public async stop(): Promise<void> {
		this.logger?.infoSync('Stopping CloudSync', { component: LogComponents.cloudSync });

		try {
			this.poller.stop();
			this.reporter.stop();
			this.isStarted = false;

			await new Promise(resolve => setTimeout(resolve, 100));

			this.connectionMonitor.removeListener('online', this.onlineHandler);
			this.connectionMonitor.removeListener('offline', this.offlineHandler);
			this.connectionMonitor.removeListener('degraded', this.degradedHandler);
			this.stateManager.removeListener('reconciliation-complete', this.reconciliationCompleteHandler);

			if (this.mqttManager && typeof this.mqttManager.removeListener === 'function') {
				this.mqttManager.removeListener('connect', this.mqttReconnectHandler);
			}

			this.removeAllListeners();
		} catch (error) {
			this.logger?.errorSync('Error stopping CloudSync', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.cloudSync,
			});
			throw error;
		}
	}

	public getTargetState() {
		return this.stateManager.getTargetState?.() ?? { apps: {}, config: {} };
	}

	public getConnectionHealth() {
		return this.connectionMonitor.getHealth();
	}

	public isOnline(): boolean {
		return this.connectionMonitor.isOnline();
	}

	public isOperational(): boolean {
		if (!this.isStarted) return false;

		// During the startup grace window, report healthy so the health arbiter doesn't
		// fire false-positive failures before the first poll/report have had a chance to run.
		const withinGrace = (Date.now() - this.startedAt) < CloudSync.STARTUP_GRACE_MS;
		if (withinGrace) return true;

		const state = this.connectionMonitor.getState();
		// In report-only mode the poller never runs, so successfulPolls stays 0 — don't require it.
		const pollsOk = !this.pollerStarted || state.successfulPolls > 0;
		return pollsOk && state.successfulReports > 0 && this.connectionMonitor.isOnline();
	}

	public async getBufferStatus(): Promise<{
		cloudReportQueueCount: number;
		cloudReportOldestAge?: number;
		lastFlushAttempt?: string;
		lastFlushSuccess?: string;
		transportPublishMode: PublishMode;
	}> {
		const stats = await this.transport.getQueueStats();
		return {
			cloudReportQueueCount: stats.currentCount,
			...(stats.oldestAgeHours !== undefined ? { cloudReportOldestAge: stats.oldestAgeHours } : {}),
			...(this.transport.getLastFlushAttemptAt() ? { lastFlushAttempt: new Date(this.transport.getLastFlushAttemptAt()!).toISOString() } : {}),
			...(this.transport.getLastFlushSuccessAt() ? { lastFlushSuccess: new Date(this.transport.getLastFlushSuccessAt()!).toISOString() } : {}),
			transportPublishMode: this.getPublishMode(),
		};
	}

	private getPublishMode(): PublishMode {
		return this.mqttManager?.getPublishMode?.() ?? 'direct';
	}

	private setPublishMode(mode: PublishMode, reason: string): void {
		this.mqttManager?.setPublishMode?.(mode, reason);
	}

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
	}

	public async pullTargetStateNow(forceFullRefresh = true): Promise<{
		applied: boolean;
		version: number;
		skipped?: 'circuit-open' | 'poll-in-progress';
	}> {
		return this.poller.pollNow(forceFullRefresh);
	}
}
