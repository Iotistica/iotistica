import { EventEmitter } from 'events';
import type { HttpClient } from '../lib/http-client.js';
import type { StateManager, AgentState } from '../core/state.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { buildAgentEndpoint } from '../utils/api-utils.js';
import { RetryPolicy, CircuitBreaker, AsyncLock } from '../utils/retry-policy.js';
import { MetadataModel } from '../db/models/metadata.model.js';
import { calculateHash } from './utils.js';
import type { TargetStateResponse } from './types.js';

const CIRCUIT_FAILURE_THRESHOLD = 10;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;   // 5 min
const BACKOFF_BASE_MS = 15_000;               // 15 s
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX_MS = 15 * 60 * 1000;        // 15 min
const BACKOFF_JITTER = 0.3;

export class StatePoller extends EventEmitter {
	private isRunning = false;
	private timer?: NodeJS.Timeout;
	private errors = 0;
	private circuit: CircuitBreaker;
	private lock: AsyncLock;
	private targetStateETag?: string;
	private requireFullRefresh = true;
	private currentVersion = 1;
	private abortController?: AbortController;

	constructor(
		private httpClient: HttpClient,
		private readonly stateManager: StateManager,
		private readonly cloudApiEndpoint: string,
		private readonly getConfig: () => { pollInterval: number; apiTimeout: number },
		private readonly getAgentInfo: () => {
			uuid: string;
			apiKey?: string;
			provisioned: boolean;
			apiTlsConfig?: any;
		},
		private readonly logger: AgentLogger | undefined,
	) {
		super();
		this.setMaxListeners(20);
		this.circuit = new CircuitBreaker(CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS);
		this.lock = new AsyncLock();
	}

	/**
	* Load persisted ETag from database and start the poll loop.
	*/
	async start(): Promise<void> {
		if (this.isRunning) {
			this.logger?.warnSync('StatePoller already running', { component: LogComponents.cloudSync });
			return;
		}

		// Set flag immediately to prevent a second concurrent start() call from racing through
		this.isRunning = true;

		try {
			const agentInfo = this.getAgentInfo();
			const etagKey = `target_state_etag_${agentInfo.uuid}`;
			const persisted = await MetadataModel.get(etagKey);
			if (persisted) {
				this.targetStateETag = persisted;
				this.logger?.infoSync('Loaded persisted target state ETag', {
					component: LogComponents.cloudSync,
					etag: persisted,
					etagKey,
				});
			}
		} catch (error) {
			this.logger?.warnSync('Failed to load persisted ETag', {
				component: LogComponents.cloudSync,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		this.logger?.infoSync('Starting target state polling', {
			component: LogComponents.cloudSync,
			endpoint: this.cloudApiEndpoint,
			intervalMs: this.getConfig().pollInterval,
		});

		// Fire and don't await — loop reschedules itself via setTimeout internally.
		void this.loop();
	}

	stop(): void {
		this.isRunning = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.abortController?.abort();
		this.abortController = undefined;
	}

	getCurrentVersion(): number {
		return this.currentVersion;
	}

	updateHttpClient(httpClient: HttpClient): void {
		this.httpClient = httpClient;
	}

	public async pollNow(forceFullRefresh = false): Promise<{
		applied: boolean;
		version: number;
		skipped?: 'circuit-open' | 'poll-in-progress';
	}> {
		if (forceFullRefresh) {
			this.requireFullRefresh = true;
		}

		if (this.circuit.isOpen()) {
			return {
				applied: false,
				version: this.currentVersion,
				skipped: 'circuit-open',
			};
		}

		try {
			this.abortController = new AbortController();
			const result = await this.lock.tryExecute(async () => {
				const applied = await this.pollTargetState(this.abortController!.signal);
				this.errors = 0;
				this.circuit.recordSuccess();
				this.emit('poll-success');
				return applied;
			});

			if (result === undefined) {
				return {
					applied: false,
					version: this.currentVersion,
					skipped: 'poll-in-progress',
				};
			}

			return {
				applied: result,
				version: this.currentVersion,
			};
		} catch (error) {
			this.errors = Math.min(this.errors + 1, 10);
			this.circuit.recordFailure();
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit('poll-error', err);
			throw err;
		}
	}

	private async loop(): Promise<void> {
		if (!this.isRunning) return;

		if (this.circuit.isOpen()) {
			const remaining = this.circuit.getCooldownRemaining();
			this.logger?.warnSync('Poll circuit breaker open, cooling down', {
				component: LogComponents.cloudSync,
				operation: 'poll-circuit-open',
				cooldownRemainingMs: remaining,
				cooldownRemainingSec: Math.floor(remaining / 1000),
				failureCount: this.circuit.getFailureCount(),
			});
			this.timer = setTimeout(() => {
				if (this.isRunning) {
					void this.loop().catch(err => {
						this.logger?.errorSync('Poll loop crash', err instanceof Error ? err : new Error(String(err)), {
							component: LogComponents.cloudSync,
						});
					});
				}
			}, remaining + 1000);
			return;
		}

		try {
			this.abortController = new AbortController();
			let pollRan = false;
			await this.lock.tryExecute(async () => {
				await this.pollTargetState(this.abortController!.signal);
				pollRan = true;
			});
			if (!pollRan) {
				this.logger?.warnSync('Poll already in progress, skipping', {
					component: LogComponents.cloudSync,
					operation: 'poll-skip-locked',
				});
			} else {
				this.errors = 0;
				this.circuit.recordSuccess();
				this.emit('poll-success');
			}
		} catch (error) {
			this.errors = Math.min(this.errors + 1, 10);
			const circuitOpened = this.circuit.recordFailure();
			const err = error instanceof Error ? error : new Error(String(error));
			const cause = (err as any).cause;

			if (circuitOpened) {
				this.errors = 0; // reset backoff; circuit cooldown now governs recovery
				this.logger?.errorSync('Poll circuit breaker tripped', err, {
					component: LogComponents.cloudSync,
					operation: 'poll-circuit-trip',
					consecutiveFailures: this.circuit.getFailureCount(),
					cooldownMin: 5,
				});
			} else {
				this.logger?.errorSync('Failed to poll target state', err, {
					component: LogComponents.cloudSync,
					operation: 'poll',
					errorCount: this.errors,
					...(cause && { cause: { message: cause.message, code: cause.code, errno: cause.errno, syscall: cause.syscall } }),
				});
			}
			this.emit('poll-error', err);
		}

		const interval = this.errors > 0
			? RetryPolicy.calculateBackoffWithJitter(this.errors, BACKOFF_BASE_MS, BACKOFF_MULTIPLIER, BACKOFF_MAX_MS, BACKOFF_JITTER)
			: this.getConfig().pollInterval;

		if (this.errors > 0) {
			this.logger?.debugSync('Poll backing off due to errors', {
				component: LogComponents.cloudSync,
				backoffSeconds: Math.floor(interval / 1000),
				attempt: this.errors,
			});
		}

		this.timer = setTimeout(() => {
			if (this.isRunning) {
				void this.loop().catch(err => {
					this.logger?.errorSync('Poll loop crash', err instanceof Error ? err : new Error(String(err)), {
						component: LogComponents.cloudSync,
					});
				});
			}
		}, interval);
	}

	private async pollTargetState(signal?: AbortSignal): Promise<boolean> {
		const agentInfo = this.getAgentInfo();

		if (!agentInfo.provisioned) {
			this.logger?.debugSync('Device not provisioned, skipping target state poll', {
				component: LogComponents.cloudSync,
				operation: 'poll',
			});
			return false;
		}

		const endpoint = buildAgentEndpoint(this.cloudApiEndpoint, agentInfo.uuid, '/state');
		const apiKey = agentInfo.apiKey;

		this.logger?.infoSync('Polling target state', {
			component: LogComponents.cloudSync,
			operation: 'poll',
			currentETag: this.targetStateETag || 'none',
			usingIfNoneMatch: !!(this.targetStateETag && !this.requireFullRefresh),
			hasApiKey: !!apiKey,
			apiKeyPrefix: apiKey ? `${apiKey.slice(0, 8)}...` : 'none',
		});

		const response = await this.httpClient.get(endpoint, {
			headers: {
				'X-Device-API-Key': apiKey || '',
				...(this.targetStateETag && !this.requireFullRefresh && { 'if-none-match': this.targetStateETag }),
			},
			timeout: this.getConfig().apiTimeout,
			signal,
		});

		if (response.status === 304) {
			this.requireFullRefresh = false;
			return false;
		}

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const etag = response.headers.get('etag');
		if (etag) {
			this.targetStateETag = etag;
			const etagKey = `target_state_etag_${agentInfo.uuid}`;
			// Note: MetadataModel.set is not atomic. This is acceptable for a single-instance
			// edge agent; if multi-instance is ever needed, replace with compare-and-set.
			try {
				await MetadataModel.set(etagKey, etag);
			} catch (err) {
				this.logger?.warnSync('Failed to persist ETag', {
					component: LogComponents.cloudSync,
					error: err instanceof Error ? err.message : String(err),
					etagKey,
				});
			}
		}
		this.requireFullRefresh = false;

		const targetStateResponse = await response.json() as TargetStateResponse;
		const deviceState = targetStateResponse[agentInfo.uuid];

		if (!deviceState) {
			this.logger?.warnSync('No target state for this device in response', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				deviceUuid: agentInfo.uuid,
				availableUUIDs: Object.keys(targetStateResponse),
			});
			return false;
		}

		const rawVersion = Number(deviceState.version);
		const targetVersion = Number.isFinite(rawVersion) && rawVersion >= 1 ? Math.floor(rawVersion) : 1;
		this.currentVersion = targetVersion;

		const newTargetState: AgentState = {
			apps: deviceState.apps || {},
			config: deviceState.config || {},
		};

		// Preserve existing local endpoints when cloud returns none.
		// This prevents local CLI-managed endpoints from being reconciled out
		// on restart or transient cloud states with empty endpoint config.
		const existingTargetState = this.stateManager.getTargetState?.() ?? { apps: {}, config: {} };
		const cloudEndpoints = Array.isArray(newTargetState.config?.endpoints)
			? newTargetState.config.endpoints
			: [];
		const existingEndpoints = Array.isArray(existingTargetState.config?.endpoints)
			? existingTargetState.config.endpoints
			: [];

		if (cloudEndpoints.length === 0 && existingEndpoints.length > 0) {
			newTargetState.config = {
				...(newTargetState.config || {}),
				endpoints: existingEndpoints,
			};

			this.logger?.infoSync('Preserving existing endpoints on empty cloud target', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				preservedEndpoints: existingEndpoints.length,
			});
		}

		// Preserve locally-managed anomaly config when cloud doesn't include it.
		// anomalyDetection is managed via the admin UI (not cloud-pushed) so a cloud
		// state without it must not silently wipe the locally saved metric rules.
		const existingAnomalyDetection = existingTargetState.config?.anomalyDetection;
		if (!newTargetState.config?.anomalyDetection && existingAnomalyDetection) {
			newTargetState.config = {
				...(newTargetState.config || {}),
				anomalyDetection: existingAnomalyDetection,
			};
		}

		// Preserve locally-set feature flags that the cloud doesn't explicitly send.
		// Feature toggles (enableAnomalyDetection etc.) are set via the admin UI and
		// must survive cloud polls that omit the features key entirely.
		// Cloud-provided values always win (existing is the base, cloud spread on top).
		const existingFeatures = existingTargetState.config?.features;
		if (existingFeatures) {
			newTargetState.config = {
				...(newTargetState.config || {}),
				features: {
					...existingFeatures,
					...(newTargetState.config?.features || {}),
				},
			};
		}

		const currentStateHash = calculateHash(this.stateManager.getTargetState?.() ?? {});
		const newStateHash = calculateHash(newTargetState);

		if (currentStateHash !== newStateHash) {
			this.logger?.infoSync('New target state received from cloud', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				version: targetVersion,
				appCount: Object.keys(newTargetState.apps).length,
				configKeyCount: Object.keys(newTargetState.config || {}).length,
				endpointsCount: (deviceState.config?.endpoints ?? []).length,
			});

			// Guard: don't mutate state if stop() was called while this poll was in-flight
			if (!this.isRunning) return false;

			await this.stateManager.setTarget(newTargetState);

			this.logger?.infoSync('Target state applied', {
				component: LogComponents.cloudSync,
				operation: 'apply-state',
				version: this.currentVersion,
			});

			this.emit('target-state-changed', newTargetState, deviceState.config?.intervals);
			return true;
		} else {
			this.logger?.debugSync('Target state fetched (no changes)', {
				component: LogComponents.cloudSync,
				operation: 'poll',
				version: this.currentVersion,
			});
			return false;
		}
	}
}
