import type { StateManager } from '../core/state.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { RetryPolicy, CircuitBreaker, AsyncLock } from '../utils/retry-policy.js';
import { type ConnectionMonitor } from '../health/connection-monitor.js';
import type { AgentDeviceReport, AgentStateReport } from './types.js';
import { CloudTransportBufferedError } from './types.js';
import { calculateHash, calculateStateDiff, stableStringify } from './utils.js';
import type { CloudTransport } from './transport.js';
import type { PublishMode } from '../mqtt/manager.js';

const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min
const BACKOFF_BASE_MS = 15_000;               // 15 s
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX_MS = 15 * 60 * 1000;        // 15 min
const BACKOFF_JITTER = 0.3;

export interface StateReporterDeps {
	stateManager: StateManager;
	transport: CloudTransport;
	connectionMonitor: ConnectionMonitor;
	getTargetVersion: () => number;
	getAgentInfo: () => {
		uuid: string;
		apiKey?: string;
		provisioned: boolean;
		osVersion?: string;
		agentVersion?: string;
		vpnEnabled?: boolean;
	};
	getConfig: () => { reportInterval: number; metricsInterval: number };
	getPublishMode: () => PublishMode;
	setPublishMode: (mode: PublishMode, reason?: string) => void;
	requestMqttFlush?: (reason?: string) => void;
	getEndpoints?: () => { getAllDeviceStatuses?(): Record<string, any> };
	devicePublish?: { getStats(): any };
	agentUpdater?: { getCurrentVersion(): string };
	getDevices: () => Promise<any[]>;
	getSystemMetrics: () => Promise<any>;
	platformArch: string;
	logger: AgentLogger | undefined;
}

export class StateReporter {
	private isRunning = false;
	private timer?: NodeJS.Timeout;
	private errors = 0;
	private circuit: CircuitBreaker;
	private lock: AsyncLock;
	private forceNextReport = false;

	private lastReport: AgentStateReport = {};
	private lastReportTime = 0;
	private lastMetricsTime = 0;

	private lastOsVersion?: string;
	private lastAgentVersion?: string;
	private lastArchitecture?: string;
	private lastLocalIp?: string;
	private lastConfigHash?: string;
	private lastEndpointHealthHash?: string;
	private lastDevicesHash?: string;

	constructor(private readonly deps: StateReporterDeps) {
		this.circuit = new CircuitBreaker(CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS);
		this.lock = new AsyncLock();
	}

	async start(): Promise<void> {
		if (this.isRunning) {
			this.deps.logger?.warnSync('StateReporter already running', { component: LogComponents.cloudSync });
			return;
		}
		this.isRunning = true;
		// Fire and don't await — loop reschedules itself via setTimeout internally.
		void this.loop();
	}

	stop(): void {
		this.isRunning = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	requestImmediateReport(reason: string): void {
		if (!this.isRunning) return;

		// Bypass the rate-limiter check in reportCurrentState for this cycle.
		this.forceNextReport = true;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}

		this.deps.logger?.debugSync('Scheduling immediate report', {
			component: LogComponents.cloudSync,
			operation: 'report-immediate',
			reason,
			forceNextReport: this.forceNextReport,
		});

		this.timer = setTimeout(() => {
			if (!this.isRunning) return;
			void this.loop().catch(err => {
				this.deps.logger?.errorSync('Report loop crash', err instanceof Error ? err : new Error(String(err)), {
					component: LogComponents.cloudSync,
				});
			});
		}, 0);
	}

	private async loop(): Promise<void> {
		if (!this.isRunning) return;

		if (this.circuit.isOpen()) {
			const remaining = this.circuit.getCooldownRemaining();
			this.deps.logger?.warnSync('Report circuit breaker open, cooling down', {
				component: LogComponents.cloudSync,
				operation: 'report-circuit-open',
				cooldownRemainingMs: remaining,
				cooldownRemainingSec: Math.floor(remaining / 1000),
				failureCount: this.circuit.getFailureCount(),
			});
			this.timer = setTimeout(() => {
				if (this.isRunning) {
					void this.loop().catch(err => {
						this.deps.logger?.errorSync('Report loop crash', err instanceof Error ? err : new Error(String(err)), {
							component: LogComponents.cloudSync,
						});
					});
				}
			}, remaining + 1000);
			return;
		}

		if (this.lock.isLocked()) {
			this.deps.logger?.warnSync('Report already in progress, skipping', {
				component: LogComponents.cloudSync,
				operation: 'report-skip-locked',
				forceNextReport: this.forceNextReport,
			});
			const retryDelayMs = this.forceNextReport ? 250 : this.deps.getConfig().reportInterval;
			this.timer = setTimeout(() => {
				if (this.isRunning) {
					void this.loop().catch(err => {
						this.deps.logger?.errorSync('Report loop crash', err instanceof Error ? err : new Error(String(err)), {
							component: LogComponents.cloudSync,
						});
					});
				}
			}, retryDelayMs);
			return;
		}

		try {
			await this.lock.tryExecute(async () => {
				await this.reportCurrentState();
			});
			this.errors = 0;
			this.circuit.recordSuccess();
			this.deps.connectionMonitor.markSuccess('report');

			if (!this.deps.transport.reportQueue.isEmpty()) {
				await this.deps.transport.flushOfflineQueue();
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const cause = (err as any).cause;

			if (err instanceof CloudTransportBufferedError) {
				this.deps.logger?.debugSync('State report buffered during transport transition', {
					component: LogComponents.cloudSync,
					operation: 'report-buffered-transition',
					publishMode: this.deps.getPublishMode(),
					queueSize: this.deps.transport.reportQueue.size(),
				});
			} else {
				this.errors = Math.min(this.errors + 1, 10);
				const circuitOpened = this.circuit.recordFailure();
				this.deps.connectionMonitor.markFailure('report', err);

				if (circuitOpened) {
					this.deps.logger?.errorSync('Report circuit breaker tripped', err, {
						component: LogComponents.cloudSync,
						operation: 'report-circuit-trip',
						consecutiveFailures: this.circuit.getFailureCount(),
						cooldownMin: 5,
					});
				} else {
					this.deps.logger?.errorSync('Failed to report current state', err, {
						component: LogComponents.cloudSync,
						operation: 'report',
						errorCount: this.errors,
						...(cause && {
							cause: { message: cause.message, code: cause.code, errno: cause.errno, syscall: cause.syscall },
						}),
					});
				}
			}
		}

		let interval: number;
		if (this.errors > 0) {
			interval = RetryPolicy.calculateBackoffWithJitter(this.errors, BACKOFF_BASE_MS, BACKOFF_MULTIPLIER, BACKOFF_MAX_MS, BACKOFF_JITTER);
			this.deps.logger?.debugSync('Report backing off due to errors', {
				component: LogComponents.cloudSync,
				backoffSeconds: Math.floor(interval / 1000),
				attempt: this.errors,
			});
		} else {
			interval = this.deps.getConfig().reportInterval;
		}

		this.timer = setTimeout(() => {
			if (this.isRunning) {
				void this.loop().catch(err => {
					this.deps.logger?.errorSync('Report loop crash', err instanceof Error ? err : new Error(String(err)), {
						component: LogComponents.cloudSync,
					});
				});
			}
		}, interval);
	}

	private stripReportForQueue(report: AgentStateReport): AgentStateReport {
		const stripped: AgentStateReport = {};

		for (const [uuid, deviceState] of Object.entries(report)) {
			stripped[uuid] = {
				apps: {},
				is_online: deviceState.is_online,
			};

			if (deviceState.config) {
				stripped[uuid].config = deviceState.config;
			}
			if (deviceState.os_version !== undefined) stripped[uuid].os_version = deviceState.os_version;
			if (deviceState.agent_version !== undefined) stripped[uuid].agent_version = deviceState.agent_version;
			if (deviceState.local_ip !== undefined) stripped[uuid].local_ip = deviceState.local_ip;
			if (deviceState.devices !== undefined) {
				stripped[uuid].devices = deviceState.devices;
			}

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
							config: {
								image: svc.config.image,
								restart: svc.config.restart,
								networkMode: svc.config.networkMode,
								ports: svc.config.ports,
								volumes: svc.config.volumes,
								networks: svc.config.networks,
							},
						})),
					};
				}
			}

			if (deviceState.cpu_usage !== undefined) stripped[uuid].cpu_usage = deviceState.cpu_usage;
			if (deviceState.memory_usage !== undefined) stripped[uuid].memory_usage = deviceState.memory_usage;
			if (deviceState.memory_total !== undefined) stripped[uuid].memory_total = deviceState.memory_total;
			if (deviceState.storage_usage !== undefined) stripped[uuid].storage_usage = deviceState.storage_usage;
			if (deviceState.storage_total !== undefined) stripped[uuid].storage_total = deviceState.storage_total;
			if (deviceState.temperature !== undefined) stripped[uuid].temperature = deviceState.temperature;
			if (deviceState.uptime !== undefined) stripped[uuid].uptime = deviceState.uptime;
		}

		return stripped;
	}

	private async collectEndpointHealth(): Promise<Record<string, any>> {
		try {
			const endpoints = this.deps.getEndpoints?.();
			if (!endpoints?.getAllDeviceStatuses) return {};
			return endpoints.getAllDeviceStatuses() || {};
		} catch (error) {
			this.deps.logger?.warnSync('Failed to collect endpoint health', {
				component: LogComponents.cloudSync,
				operation: 'collect-endpoint-health',
				error: error instanceof Error ? error.message : String(error),
			});
			return {};
		}
	}

	private async reportCurrentState(): Promise<void> {
		const agentInfo = this.deps.getAgentInfo();

		if (!agentInfo.provisioned) {
			this.deps.logger?.debugSync('Agent not provisioned, skipping state report', {
				component: LogComponents.cloudSync,
				operation: 'report',
			});
			return;
		}

		const now = Date.now();
		const timeSinceLastReport = now - this.lastReportTime;
		const timeSinceLastMetrics = now - this.lastMetricsTime;

		if (!this.forceNextReport && timeSinceLastReport < this.deps.getConfig().reportInterval) {
			return;
		}

		const currentState = await this.deps.stateManager.getCurrentState();
		const includeMetrics = timeSinceLastMetrics >= this.deps.getConfig().metricsInterval;

		const osVersionChanged = agentInfo.osVersion !== this.lastOsVersion;
		// Single canonical source: prefer agentUpdater (live value) over agentInfo snapshot.
		const agentVersion = this.deps.agentUpdater?.getCurrentVersion() ?? agentInfo.agentVersion;
		const agentVersionChanged = agentVersion !== this.lastAgentVersion;
		const architecture = this.deps.platformArch;
		const architectureChanged = architecture !== this.lastArchitecture;

		const runtimeConfig = currentState.config || {};
		const configHash = calculateHash(runtimeConfig);

		const configChanged = configHash !== this.lastConfigHash;

		const endpointHealth = await this.collectEndpointHealth();
		const endpointHealthCount = Object.keys(endpointHealth).length;
		const hasEndpointHealthData = endpointHealthCount > 0;
		const healthHash = calculateHash(endpointHealth);
		const healthChanged = hasEndpointHealthData && healthHash !== this.lastEndpointHealthHash;

		const allDevices = await this.deps.getDevices();
		const devicesForReport: AgentDeviceReport[] = allDevices.map((d: any) => ({
			uuid: d.uuid,
			endpoint_uuid: d.endpoint_uuid,
			name: d.name,
			protocol: d.protocol,
			identifier: d.identifier ?? null,
			enabled: d.enabled,
			lastSeenAt: d.lastSeenAt ? String(d.lastSeenAt) : null,
		}));
		const devicesHash = calculateHash(devicesForReport);
		const devicesChanged = devicesHash !== this.lastDevicesHash;

		const polledVersion = this.deps.getTargetVersion();
		const effectiveVersion = Number.isFinite(polledVersion) && polledVersion >= 1
			? Math.floor(polledVersion)
			: 1;

		const shouldIncludeConfig =
			configChanged ||
			this.lastConfigHash === undefined ||
			this.forceNextReport;

		// Build full report (may include metrics, health, etc.)
		const stateReport: AgentStateReport = {
			[agentInfo.uuid]: {
				apps: currentState.apps,
				is_online: this.deps.connectionMonitor.isOnline(),
				version: effectiveVersion,
			},
		};

		if (shouldIncludeConfig) {
			stateReport[agentInfo.uuid].config = runtimeConfig;
		}

		if (configChanged || this.lastConfigHash === undefined) {
			this.deps.logger?.infoSync('Devices config changed - including in report', {
				component: LogComponents.cloudSync,
				operation: 'config-change-detected',
				configHash,
				configKeys: Object.keys(runtimeConfig).length,
				endpointCount: Array.isArray(runtimeConfig.endpoints) ? runtimeConfig.endpoints.length : 0,
			});
		}

		if (hasEndpointHealthData && (healthChanged || includeMetrics)) {
			stateReport[agentInfo.uuid].endpoints_health = endpointHealth;
		}

		if (devicesChanged) {
			stateReport[agentInfo.uuid].devices = devicesForReport;
		}

		if (osVersionChanged || this.lastOsVersion === undefined) {
			stateReport[agentInfo.uuid].os_version = agentInfo.osVersion;
			this.lastOsVersion = agentInfo.osVersion;
		}
		if (agentVersionChanged || this.lastAgentVersion === undefined) {
			stateReport[agentInfo.uuid].agent_version = agentVersion;
			this.lastAgentVersion = agentVersion;
		}
		if (architectureChanged || this.lastArchitecture === undefined) {
			stateReport[agentInfo.uuid].architecture = architecture;
			this.lastArchitecture = architecture;
		}

		if (includeMetrics) {
			try {
				const metricsStartTime = Date.now();
				const metrics = await this.deps.getSystemMetrics();
				this.deps.logger?.debugSync('System metrics collection completed', {
					component: LogComponents.cloudSync,
					operation: 'collect-metrics',
					elapsedMs: Date.now() - metricsStartTime,
				});

				stateReport[agentInfo.uuid].cpu_usage = metrics.cpu_usage;
				stateReport[agentInfo.uuid].memory_usage = metrics.memory_usage;
				stateReport[agentInfo.uuid].memory_total = metrics.memory_total;
				stateReport[agentInfo.uuid].storage_usage = metrics.storage_usage ?? undefined;
				stateReport[agentInfo.uuid].storage_total = metrics.storage_total ?? undefined;
				stateReport[agentInfo.uuid].temperature = metrics.cpu_temp ?? undefined;
				stateReport[agentInfo.uuid].uptime = metrics.uptime;
				stateReport[agentInfo.uuid].network_interfaces = metrics.network_interfaces ?? [];

				const primaryInterface = metrics.network_interfaces.find((i: any) => i.default);
				const currentIp = primaryInterface?.ip4;
				if (currentIp && (currentIp !== this.lastLocalIp || this.lastLocalIp === undefined)) {
					stateReport[agentInfo.uuid].local_ip = currentIp;
					this.lastLocalIp = currentIp;
				}

				this.lastMetricsTime = now;
			} catch (error) {
				this.deps.logger?.warnSync('Failed to collect metrics', {
					component: LogComponents.cloudSync,
					operation: 'collect-metrics',
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (this.deps.devicePublish) {
				try {
					stateReport[agentInfo.uuid].publish_health = this.deps.devicePublish.getStats();
				} catch (error) {
					this.deps.logger?.warnSync('Failed to collect publish pipeline stats', {
						component: LogComponents.cloudSync,
						operation: 'collect-publish-stats',
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			if (agentInfo.provisioned && agentInfo.vpnEnabled) {
				try {
					const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
					const tailscale = new TailscaleManager(this.deps.logger);
					const vpnHealth = await tailscale.getHealth();
					stateReport[agentInfo.uuid].vpn_health = vpnHealth;
					tailscale.logHealthIssues(vpnHealth);
				} catch (error) {
					this.deps.logger?.warnSync('Failed to collect VPN health stats', {
						component: LogComponents.cloudSync,
						operation: 'collect-vpn-health',
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		// Build state-only view for diff comparison (no metrics)
		const stateOnlyReport: AgentStateReport = {
			[agentInfo.uuid]: {
				apps: currentState.apps,
				is_online: this.deps.connectionMonitor.isOnline(),
				version: effectiveVersion,
			},
		};
		if (stateReport[agentInfo.uuid].config) {
			stateOnlyReport[agentInfo.uuid].config = stateReport[agentInfo.uuid].config;
		}
		if ((healthChanged || includeMetrics) && stateReport[agentInfo.uuid].endpoints_health) {
			stateOnlyReport[agentInfo.uuid].endpoints_health = stateReport[agentInfo.uuid].endpoints_health;
		}
		if (devicesChanged && stateReport[agentInfo.uuid].devices) {
			stateOnlyReport[agentInfo.uuid].devices = stateReport[agentInfo.uuid].devices;
		}
		if (stateReport[agentInfo.uuid].os_version !== undefined) {
			stateOnlyReport[agentInfo.uuid].os_version = stateReport[agentInfo.uuid].os_version;
		}
		if (stateReport[agentInfo.uuid].architecture !== undefined) {
			stateOnlyReport[agentInfo.uuid].architecture = stateReport[agentInfo.uuid].architecture;
		}
		// Always include agent_version in stateOnlyReport for stable diff tracking.
		stateOnlyReport[agentInfo.uuid].agent_version = agentVersion;

		const diff = calculateStateDiff(this.lastReport, stateOnlyReport);
		const shouldReport = Object.keys(diff).length > 0 || includeMetrics || configChanged || healthChanged || devicesChanged || this.forceNextReport;

		if (!shouldReport) return;

		// Build final payload
		const reportToSend: AgentStateReport = {
			[agentInfo.uuid]: {
				apps: currentState.apps,
				is_online: this.deps.connectionMonitor.isOnline(),
				version: effectiveVersion,
			},
		};

		if (stateReport[agentInfo.uuid].config) {
			reportToSend[agentInfo.uuid].config = stateReport[agentInfo.uuid].config;
		}
		if (healthChanged || includeMetrics) {
			reportToSend[agentInfo.uuid].endpoints_health = endpointHealth;
		}
		if (devicesChanged) {
			reportToSend[agentInfo.uuid].devices = devicesForReport;
		}
		if (osVersionChanged || this.lastOsVersion === undefined) {
			reportToSend[agentInfo.uuid].os_version = agentInfo.osVersion;
		}
		if (architectureChanged || this.lastArchitecture === undefined) {
			reportToSend[agentInfo.uuid].architecture = architecture;
		}
		if (agentVersionChanged || this.lastAgentVersion === undefined) {
			reportToSend[agentInfo.uuid].agent_version = agentVersion;
		}
		if (includeMetrics && stateReport[agentInfo.uuid].cpu_usage !== undefined) {
			reportToSend[agentInfo.uuid].cpu_usage = stateReport[agentInfo.uuid].cpu_usage;
			reportToSend[agentInfo.uuid].memory_usage = stateReport[agentInfo.uuid].memory_usage;
			reportToSend[agentInfo.uuid].memory_total = stateReport[agentInfo.uuid].memory_total;
			reportToSend[agentInfo.uuid].storage_usage = stateReport[agentInfo.uuid].storage_usage;
			reportToSend[agentInfo.uuid].storage_total = stateReport[agentInfo.uuid].storage_total;
			reportToSend[agentInfo.uuid].temperature = stateReport[agentInfo.uuid].temperature;
			reportToSend[agentInfo.uuid].uptime = stateReport[agentInfo.uuid].uptime;
			reportToSend[agentInfo.uuid].network_interfaces = stateReport[agentInfo.uuid].network_interfaces;
			reportToSend[agentInfo.uuid].local_ip = stateReport[agentInfo.uuid].local_ip;
		}
		if (includeMetrics && stateReport[agentInfo.uuid].publish_health) {
			reportToSend[agentInfo.uuid].publish_health = stateReport[agentInfo.uuid].publish_health;
		}
		if (includeMetrics && stateReport[agentInfo.uuid].vpn_health) {
			reportToSend[agentInfo.uuid].vpn_health = stateReport[agentInfo.uuid].vpn_health;
		}

		// Skip entirely empty reports
		const hasAnyData =
			reportToSend[agentInfo.uuid].config !== undefined ||
			(reportToSend[agentInfo.uuid].apps && Object.keys(reportToSend[agentInfo.uuid].apps).length > 0) ||
			reportToSend[agentInfo.uuid].endpoints_health !== undefined ||
			reportToSend[agentInfo.uuid].devices !== undefined ||
			reportToSend[agentInfo.uuid].cpu_usage !== undefined ||
			reportToSend[agentInfo.uuid].publish_health !== undefined ||
			reportToSend[agentInfo.uuid].vpn_health !== undefined;

		if (!hasAnyData) {
			this.deps.logger?.infoSync('Skipping empty state report (no data to send)', {
				component: LogComponents.cloudSync,
				operation: 'skip-empty-report',
				isOnline: this.deps.connectionMonitor.isOnline(),
				version: effectiveVersion,
			});
			return;
		}

		try {
			const transport = await this.deps.transport.sendReport(reportToSend);

			if (this.deps.getPublishMode() === 'recovering') {
				this.deps.setPublishMode('direct', `cloudsync-report-${transport}`);
				this.deps.requestMqttFlush?.('cloudsync-report-success');
			}

			this.lastConfigHash = configHash;
			this.lastEndpointHealthHash = healthHash;
			this.lastDevicesHash = devicesHash;

			if (this.forceNextReport) this.forceNextReport = false;

			this.lastReport = stateOnlyReport;
			this.lastReportTime = now;

			this.deps.logger?.infoSync('Reported current state', {
				component: LogComponents.cloudSync,
				operation: 'report',
				transport,
				includeMetrics,
				version: effectiveVersion,
				configIncluded: reportToSend[agentInfo.uuid].config !== undefined,
				endpointHealthIncluded: reportToSend[agentInfo.uuid].endpoints_health !== undefined,
				reportKeys: Object.keys(reportToSend[agentInfo.uuid] || {}),
				endpointHealthCount,
				configuredEndpointCount: Array.isArray(runtimeConfig.endpoints) ? runtimeConfig.endpoints.length : 0,
				runtimeHealthEndpointCount: endpointHealthCount,
			});
		} catch (error) {
			const connectionHealth = this.deps.connectionMonitor.getHealth();
			const strippedReport = this.stripReportForQueue(reportToSend);
			// Serialize each once — reuse the strings for both the size calculation and the log.
			const originalStr = stableStringify(reportToSend);
			const strippedStr = stableStringify(strippedReport);
			const savings = originalStr.length - strippedStr.length;

			this.deps.logger?.infoSync('Queueing report for later - cloud transport unavailable', {
				component: LogComponents.cloudSync,
				operation: 'queue-report',
				originalBytes: originalStr.length,
				strippedBytes: strippedStr.length,
				savings: `${savings} bytes (${((savings / originalStr.length) * 100).toFixed(1)}%)`,
				connectionStatus: connectionHealth.status,
			});

			await this.deps.transport.reportQueue.enqueue(strippedReport);
			throw error;
		}
	}
}
