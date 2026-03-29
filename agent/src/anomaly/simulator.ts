/**
 * ANOMALY INJECTION SIMULATION SCENARIO
 * ======================================
 * 
 * Automatically injects anomalies into metrics for testing detection.
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { AnomalyBaselineRecord } from './storage';
import type {
	AnomalySimulationService,
	SimulationConfig,
	SimulationScenario,
	SimulationScenarioStatus,
	SimulationDependencies,
	AnomalySimulationConfig,
	SimulationPattern,
	DataPoint,
	Protocol,
} from './types';
import {
	DEFAULT_SIMULATION_CONFIG,
	DEFAULT_ANOMALY_CONFIG,
} from './types';

type AlertMetricState = {
	direction: 1 | -1;
	strength: number;
	phase: 'alert' | 'recovery';
	phaseTick: number;
};

function normalizeSimulationMetrics(metrics: unknown): string[] {
	if (Array.isArray(metrics)) {
		return metrics
			.filter((metric): metric is string => typeof metric === 'string')
			.map((metric) => metric.trim())
			.filter((metric) => metric.length > 0);
	}

	if (typeof metrics === 'string') {
		return metrics
			.split(',')
			.map((metric) => metric.trim())
			.filter((metric) => metric.length > 0);
	}

	return [];
}

const CANONICAL_METRIC_REGEX = /^([0-9a-f-]{36})_([0-9a-f-]{36})_(.+)$/i;

type SimulationMetricContext = {
	source: DataPoint['source'];
	protocol: Protocol;
	deviceId?: string;
	deviceState?: DataPoint['deviceState'];
	tags: Record<string, string>;
};

/**
 * Anomaly injection simulation scenario
 */
export class AnomalyInjectionSimulation implements SimulationScenario {
	name = 'anomaly_injection';
	description = 'Automatically injects anomalies into metrics';
	enabled = false;
	
	private config: AnomalySimulationConfig;
	private logger?: AgentLogger;
	private anomalyService?: AnomalySimulationService;
	private running = false;
	private startedAt?: number;
	private injectionInterval?: NodeJS.Timeout;
	private injectionCount = 0;
	private cyclePhase = 0; // For cyclic patterns
	private baselineMissCount = 0;
	private lastMetric?: string;
	private metricStickiness = 0.7;
	private metricStats: Record<string, number> = {};
	private metricInjectionCounts = new Map<string, number>();
	private metricLastSeenAt = new Map<string, number>();
	private alertStateByMetric = new Map<string, AlertMetricState>();
	private baselineCache = new Map<string, { value: AnomalyBaselineRecord | null; ts: number }>();
	private readonly BASELINE_TTL = 30_000;
	private readonly metricInactivityResetMs = 180_000;
	private readonly alertActivePoints = 40;
	private readonly alertRecoveryPoints = 12;
	private readonly debugInfoLogInterval = 10;
	
	constructor(
		config: AnomalySimulationConfig,
		anomalyService?: AnomalySimulationService,
		logger?: AgentLogger
	) {
		this.config = {
			...config,
			metrics: normalizeSimulationMetrics(config.metrics),
		};
		this.anomalyService = anomalyService;
		this.logger = logger;
		this.enabled = config.enabled;
	}
	
	async start(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		
		if (!this.anomalyService) {
			this.logger?.warnSync('Anomaly service not available - cannot start simulation', {
				component: LogComponents.metrics,
			});
			return;
		}
		
		if (this.running) {
			this.logger?.warnSync('Anomaly injection simulation already running', {
				component: LogComponents.metrics,
			});
			return;
		}

		if (this.config.metrics.length === 0) {
			this.logger?.warnSync('Anomaly injection simulation has no metrics configured', {
				component: LogComponents.metrics,
				pattern: this.config.pattern,
			});
			return;
		}
		
		this.logger?.warnSync('STARTING ANOMALY INJECTION SIMULATION - FOR TESTING ONLY', {
			component: LogComponents.metrics,
			metrics: this.config.metrics,
			metricCount: this.config.metrics.length,
			pattern: this.config.pattern,
			intervalMs: this.config.intervalMs,
			burstCount: this.config.burstCount || 1,
			severity: this.config.severity,
			mode: this.config.mode || 'inject',
		});
		
		this.running = true;
		this.startedAt = Date.now();
		this.injectionCount = 0;
		this.lastMetric = undefined;
		this.metricStats = {};
		this.metricInjectionCounts.clear();
		this.metricLastSeenAt.clear();
		this.alertStateByMetric.clear();
		this.baselineCache.clear();
		
		this.injectionInterval = setInterval(() => {
			this.injectAnomaly().catch((error) => {
				this.logger?.errorSync('Anomaly simulation injection failed', error as Error, {
					component: LogComponents.metrics,
					pattern: this.config.pattern,
				});
			});
		}, this.config.intervalMs);
	}
	
	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}
		
		if (this.injectionInterval) {
			clearInterval(this.injectionInterval);
			this.injectionInterval = undefined;
		}
		
		this.logger?.infoSync('Anomaly injection simulation stopped', {
			component: LogComponents.metrics,
			totalInjections: this.injectionCount,
			durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
		});
		
		this.running = false;
	}
	
	getStatus(): SimulationScenarioStatus {
		return {
			name: this.name,
			enabled: this.enabled,
			running: this.running,
			startedAt: this.startedAt,
			stats: {
				metrics: this.config.metrics,
				metricStats: this.metricStats,
				pattern: this.config.pattern,
				burstCount: this.config.burstCount || 1,
				injectionCount: this.injectionCount,
				baselineMissCount: this.baselineMissCount,
				intervalMs: this.config.intervalMs,
			},
		};
	}
	
	async updateConfig(config: Partial<AnomalySimulationConfig>): Promise<void> {
		this.config = { ...this.config, ...config };
		this.enabled = this.config.enabled;
		
		// Restart if running
		if (this.running) {
			await this.stop();
			await this.start();
		}
	}
	
	/**
	 * Inject one anomaly
	 */
	private async injectAnomaly(): Promise<void> {
		if (!this.anomalyService) return;
		if (this.config.metrics.length === 0) {
			this.logger?.warnSync('Simulation tick skipped - no metrics available after normalization', {
				component: LogComponents.metrics,
			});
			return;
		}

		const now = Date.now();
		this.cleanupInactiveMetricState(now);
		
		const metric = this.selectMetric();
		this.metricLastSeenAt.set(metric, now);
		
		// Get unit for metric
		const unit = this.getUnitForMetric(metric);
		const baseContext = await this.resolveBaseContext(metric);
		if (!baseContext) {
			return;
		}

		const burst = Math.max(1, this.config.burstCount || 1);
		const baseTimestamp = Date.now();
		let emitted = 0;
		const values = await Promise.all(
			Array.from({ length: burst }, () => this.generateAnomalousValue(metric, baseContext))
		);

		for (let i = 0; i < values.length; i++) {
			const value = values[i];
			if (value === null) {
				continue;
			}

			const metricContext = this.resolveMetricContext(metric);

			const dataPoint: DataPoint = {
				source: metricContext.source,
				protocol: metricContext.protocol,
				deviceState: metricContext.deviceState,
				metric,
				value,
				unit,
				timestamp: baseTimestamp + (i * 10),
				deviceId: metricContext.deviceId,
				quality: 'GOOD' as const,
				tags: {
					...metricContext.tags,
					simulation: 'true',
					pattern: this.config.pattern,
				},
				simulationMeta: {
					simulatedAnomaly: true,
					scenarioId: 'anomaly_injection',
					injectedAt: baseTimestamp,
					pattern: this.config.pattern,
				},
			};

			this.logger?.warnSync('Simulation point injected', {
				component: LogComponents.metrics,
				metric,
				value,
				source: dataPoint.source,
				protocol: dataPoint.protocol,
				deviceId: dataPoint.deviceId,
				pattern: this.config.pattern,
				injectionCount: this.injectionCount + 1,
			});
			this.anomalyService.processDataPoint(dataPoint);
			this.injectionCount++;
			this.metricStats[metric] = (this.metricStats[metric] || 0) + 1;
			this.metricInjectionCounts.set(metric, (this.metricInjectionCounts.get(metric) || 0) + 1);
			emitted++;
		}

		if (this.config.pattern === 'alert' && emitted > 0) {
			this.advanceAlertState(metric, emitted);
		}

		if (emitted > 0) {
			this.logger?.debugSync('Anomaly injected', {
				component: LogComponents.metrics,
				metric,
				emitted,
				burst,
				metricStickiness: this.metricStickiness,
				lastMetric: this.lastMetric,
				pattern: this.config.pattern,
				severity: this.config.severity,
			});

			if (this.injectionCount <= 3 || this.injectionCount % this.debugInfoLogInterval === 0) {
				this.logger?.infoSync('Simulation injection tick completed', {
					component: LogComponents.metrics,
					injectionCount: this.injectionCount,
					metric,
					emitted,
					pattern: this.config.pattern,
					configuredMetrics: this.config.metrics,
					metricStats: this.metricStats,
				});
			}
		}
	}

	private selectMetric(): string {
		if (!Array.isArray(this.config.metrics) || this.config.metrics.length === 0) {
			return 'cpu_usage';
		}

		if (
			this.lastMetric &&
			this.config.metrics.includes(this.lastMetric) &&
			Math.random() < this.metricStickiness
		) {
			return this.lastMetric;
		}

		const metric = this.config.metrics[Math.floor(Math.random() * this.config.metrics.length)];
		this.lastMetric = metric;
		return metric;
	}

	private cleanupInactiveMetricState(now: number): void {
		for (const [metric, lastSeenAt] of this.metricLastSeenAt.entries()) {
			if ((now - lastSeenAt) <= this.metricInactivityResetMs) {
				continue;
			}

			this.metricLastSeenAt.delete(metric);
			this.metricInjectionCounts.delete(metric);
			this.alertStateByMetric.delete(metric);

			if (this.lastMetric === metric) {
				this.lastMetric = undefined;
			}
		}
	}

	private resolveMetricContext(metric: string): SimulationMetricContext {
		const preferredBufferContext = this.anomalyService?.getPreferredBufferContext?.(metric);
		const canonicalMatch = metric.match(CANONICAL_METRIC_REGEX);
		if (canonicalMatch) {
			const sensorDeviceId = canonicalMatch[2];
			const deviceId = preferredBufferContext?.deviceId || sensorDeviceId;
			const fieldName = canonicalMatch[3];
			return {
				source: 'endpoint',
				protocol: this.inferProtocol(metric) || 'mqtt',
				deviceId,
				deviceState: preferredBufferContext?.deviceState,
				tags: {
					deviceId,
					endpointId: deviceId,
					deviceUuid: sensorDeviceId,
					fieldName,
				},
			};
		}

		return {
			source: 'system',
			protocol: this.inferProtocol(metric) || 'system',
			tags: {},
		};
	}

	private inferProtocol(metric: string): Protocol | undefined {
		const normalized = metric.toLowerCase();
		if (normalized.includes('modbus')) return 'modbus';
		if (normalized.includes('opcua')) return 'opcua';
		if (normalized.includes('bacnet')) return 'bacnet';
		if (normalized.includes('mqtt')) return 'mqtt';
		if (normalized.startsWith('cpu_') || normalized.startsWith('memory_') || normalized.startsWith('disk_')) return 'system';
		return undefined;
	}
	
	private async resolveBaseContext(metric: string): Promise<{ base: number; baseline?: AnomalyBaselineRecord } | null> {
		const baseline = await this.getBaseline(metric);
		if (baseline) {
			const base = this.getBaselineCenter(baseline);
			if (base === null) {
				this.logger?.warnSync('Skipping anomaly injection: baseline record has no usable center stat', {
					component: LogComponents.metrics,
					metric,
					baseline: { mean: baseline.mean, median: baseline.median, q1: baseline.q1, q3: baseline.q3, min: baseline.min, max: baseline.max },
				});
				return null;
			}
			this.logger?.infoSync('Baseline resolved for simulation', {
				component: LogComponents.metrics,
				metric,
				base,
				sampleCount: baseline.sample_count,
			});
			return { base, baseline };
		}

		this.baselineMissCount += 1;
		this.logger?.debugSync('Skipping anomaly injection: no baseline available for metric', {
			component: LogComponents.metrics,
			metric,
			note: 'Simulation requires real baseline data. Run agent without simulation first to collect baselines.',
		});
		return null;
	}

	private async generateAnomalousValue(
		metric: string,
		baseContext?: { base: number; baseline?: AnomalyBaselineRecord }
	): Promise<number | null> {
		const context = baseContext || await this.resolveBaseContext(metric);
		if (!context) {
			return null;
		}

		return this.generateByPattern(metric, context.base, context.baseline);
	}

	private generateByPattern(metric: string, base: number, baseline?: AnomalyBaselineRecord): number {
		const magnitude = this.config.magnitude || 3;
		const spread = this.getBaselineSpread(base, baseline);
		const metricCount = this.metricInjectionCounts.get(metric) || 0;
		
		switch (this.config.pattern) {
			case 'alert': {
				// Stateful sustained anomaly with per-metric escalation and auto-recovery.
				let state = this.alertStateByMetric.get(metric);
				if (!state) {
					const configured = this.config.alertDirection || 'high';
					let direction: 1 | -1;
					if (configured === 'high') {
						direction = 1;
					} else if (configured === 'low') {
						direction = -1;
					} else {
						// auto mode: biased toward high spikes while keeping occasional drops.
						direction = Math.random() > 0.7 ? -1 : 1;
					}

					state = {
						direction,
						strength: 1,
						phase: 'alert',
						phaseTick: 0,
					};
					this.alertStateByMetric.set(metric, state);
				}

				if (state.phase === 'alert') {
					const rawDeviation = spread * magnitude * (2 + state.strength);
					const deviation = this.normalizeDeviation(metric, base, spread, rawDeviation);
					const target = base + (state.direction * deviation);

					return target;
				}

				// Recovery phase gradually decays toward baseline.
				const decayFactor = state.strength / 5;
				const directionalPull = state.direction * spread * magnitude * decayFactor;
				const noise = (Math.random() - 0.5) * spread * 0.2;
				const recovered = base + directionalPull + noise;

				return recovered;
			}

			case 'spike':
				// Sudden spike well above normal
				return base + this.normalizeDeviation(metric, base, spread, spread * magnitude * 1.8);
				
			case 'drift':
				// Gradual increase over time
				const driftFactor = metricCount * 0.1;
				return base + this.normalizeDeviation(metric, base, spread, spread * driftFactor * magnitude * 0.45);

			case 'recovery':
				// Explicit low-variance return toward baseline.
				return base + (spread * (Math.random() - 0.5) * 0.3);
				
			case 'cyclic':
				// Sine wave pattern
				this.cyclePhase += 0.1;
				const cycle = Math.sin(this.cyclePhase);
				return base + this.normalizeSignedDeviation(metric, base, spread, spread * cycle * magnitude * 1.2);
				
			case 'noisy':
				// Add random noise
				const noise = (Math.random() - 0.5) * 2; // -1 to 1
				return base + this.normalizeSignedDeviation(metric, base, spread, spread * noise * magnitude * 0.8);
				
			case 'extreme':
				// Edge case values
				return metric === 'cpu_temp' ? 95 : 
					   metric === 'cpu_usage' ? 98 :
					   metric === 'memory_percent' ? 99 :
					   base + this.normalizeDeviation(metric, base, spread, spread * magnitude * 3.2);
				
			case 'random':
				// Completely random
				return base + this.normalizeSignedDeviation(metric, base, spread, (Math.random() - 0.5) * spread * magnitude * 2);
				
			case 'realistic':
			default:
				// Slightly elevated but still realistic
				return base + this.normalizeDeviation(metric, base, spread, spread * magnitude * 0.9);
		}
	}

	private advanceAlertState(metric: string, steps: number): void {
		const state = this.alertStateByMetric.get(metric);
		if (!state || steps <= 0) {
			return;
		}

		// Strength evolves once per tick, independent of burst density.
		if (state.phase === 'alert') {
			state.strength = Math.min(state.strength + 0.2, 5);
		} else {
			state.strength = Math.max(1, state.strength - 0.35);
		}

		state.phaseTick += steps;

		if (state.phase === 'alert' && state.phaseTick >= this.alertActivePoints) {
			state.phase = 'recovery';
			state.phaseTick = 0;
			return;
		}

		if (state.phase === 'recovery' && state.phaseTick >= this.alertRecoveryPoints) {
			state.phase = 'alert';
			state.phaseTick = 0;
			state.strength = 1;
			this.metricInjectionCounts.set(metric, 0);
		}
	}

	private getBaselineCenter(baseline: AnomalyBaselineRecord): number | null {
		if (typeof baseline.median === 'number') return baseline.median;
		if (typeof baseline.mean === 'number') return baseline.mean;
		if (typeof baseline.q1 === 'number' && typeof baseline.q3 === 'number') {
			return (baseline.q1 + baseline.q3) / 2;
		}
		if (typeof baseline.min === 'number' && typeof baseline.max === 'number') {
			return (baseline.min + baseline.max) / 2;
		}
		return null;
	}

	private getBaselineSpread(base: number, baseline?: AnomalyBaselineRecord): number {
		if (!baseline) {
			return Math.max(Math.abs(base) * 0.1, 1);
		}

		const robustCandidates: number[] = [];

		if (typeof baseline.mad === 'number' && baseline.mad > 0) {
			robustCandidates.push(baseline.mad * 1.4826);
		}

		if (typeof baseline.iqr === 'number' && baseline.iqr > 0) {
			robustCandidates.push(baseline.iqr / 1.35);
		} else if (
			typeof baseline.q1 === 'number' &&
			typeof baseline.q3 === 'number' &&
			baseline.q3 > baseline.q1
		) {
			robustCandidates.push((baseline.q3 - baseline.q1) / 1.35);
		}

		if (typeof baseline.max === 'number' && typeof baseline.min === 'number' && baseline.max > baseline.min) {
			robustCandidates.push((baseline.max - baseline.min) / 6);
		}

		const fallbackSpread = Math.max(Math.abs(base) * 0.1, 1);
		const robustSpread = robustCandidates
			.filter(candidate => Number.isFinite(candidate) && candidate > 0)
			.sort((left, right) => left - right)[0];

		if (typeof robustSpread === 'number') {
			return Math.max(robustSpread, 0.1);
		}

		if (typeof baseline.std_dev === 'number' && baseline.std_dev > 0) {
			return Math.max(Math.min(baseline.std_dev, fallbackSpread * 3), 0.1);
		}

		return fallbackSpread;
	}

	private normalizeDeviation(metric: string, base: number, spread: number, rawDeviation: number): number {
		const absoluteRawDeviation = Math.abs(rawDeviation);
		const absoluteBase = Math.abs(base);
		const isEndpointMetric = CANONICAL_METRIC_REGEX.test(metric);
		const minBaseRatio = isEndpointMetric ? 0.3 : 0.15;
		const minDeviation = Math.max(spread * 2.5, absoluteBase * minBaseRatio, 1);
		const maxDeviation = Math.max(spread * 6, absoluteBase * 0.35, Math.max(absoluteBase, 1));

		return Math.min(Math.max(absoluteRawDeviation, minDeviation), maxDeviation);
	}

	private normalizeSignedDeviation(metric: string, base: number, spread: number, rawDeviation: number): number {
		const sign = rawDeviation < 0 ? -1 : 1;
		return sign * this.normalizeDeviation(metric, base, spread, rawDeviation);
	}

	private async getBaseline(metric: string): Promise<AnomalyBaselineRecord | null> {
		if (!this.anomalyService) {
			return null;
		}

		const storage = this.anomalyService.getStorage?.();
		if (!storage) {
			return null;
		}

		// Use metric name only — simulation does not care which device or state
		// produced the baseline, just needs representative stats for the metric.
		const cached = this.baselineCache.get(metric);
		if (cached && (Date.now() - cached.ts) < this.BASELINE_TTL) {
			return cached.value;
		}

		const minimumSamples = 10;

		try {
			const baseline = await storage.getBaselineForMetric(metric, minimumSamples);
			this.baselineCache.set(metric, { value: baseline, ts: Date.now() });
			return baseline;
		} catch (error) {
			this.baselineCache.set(metric, { value: null, ts: Date.now() });
			this.logger?.warnSync('Failed to load anomaly baseline for simulation metric', {
				component: LogComponents.metrics,
				metric,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
	
	/**
	 * Get unit for metric
	 */
	private getUnitForMetric(metric: string): string {
		const units: Record<string, string> = {
			cpu_usage: '%',
			memory_percent: '%',
			cpu_temp: '°C',
			temperature: '°C',
			humidity: '%',
			pressure: 'hPa',
		};
		
		return units[metric] || '';
	}
}

/**
 * Simulation orchestrator (anomaly scenario only)
 */
export class SimulationOrchestrator {
	private config: SimulationConfig;
	private logger?: AgentLogger;
	private dependencies: SimulationDependencies;
	private scenarios: Map<string, SimulationScenario> = new Map();
	private warningInterval?: NodeJS.Timeout;
	private enabled: boolean = false;

	constructor(config: Partial<SimulationConfig>, dependencies: SimulationDependencies) {
		this.config = { ...DEFAULT_SIMULATION_CONFIG, ...config };
		this.logger = dependencies.logger;
		this.dependencies = dependencies;
		this.enabled = this.config.enabled;
		this.initializeScenarios();
	}

	private initializeScenarios(): void {
		if (!this.enabled) {
			return;
		}

		if (this.config.scenarios.anomaly_injection) {
			const anomalyConfig = {
				...DEFAULT_ANOMALY_CONFIG,
				...this.config.scenarios.anomaly_injection,
			};

			if (anomalyConfig.mode !== 'intercept') {
				const scenario = new AnomalyInjectionSimulation(
					anomalyConfig,
					this.dependencies.anomalyService,
					this.logger
				);
				this.scenarios.set('anomaly_injection', scenario);
			} else {
				this.logger?.infoSync('Anomaly simulation configured in intercept mode (no synthetic injection scenario)', {
					component: LogComponents.agent,
					metrics: anomalyConfig.metrics,
					pattern: anomalyConfig.pattern,
				});
			}
		}
	}

	async start(): Promise<void> {
		if (!this.enabled) {
			return;
		}

		const enabledScenarios = Array.from(this.scenarios.values()).filter((s) => s.enabled);

		if (enabledScenarios.length === 0) {
			this.logger?.infoSync('No simulation scenarios enabled', {
				component: LogComponents.agent,
			});
			return;
		}

		this.logger?.warnSync('Simulation mode enabled - for testing only', {
			component: LogComponents.agent,
			scenarios: enabledScenarios.map((s) => s.name),
		});

		for (const scenario of enabledScenarios) {
			try {
				await scenario.start();
			} catch (error) {
				this.logger?.errorSync(
					`Failed to start simulation scenario: ${scenario.name}`,
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.agent,
					}
				);
			}
		}

		if (this.config.warningInterval && this.config.warningInterval > 0) {
			this.warningInterval = setInterval(() => {
				this.logger?.warnSync('Simulation mode active', {
					component: LogComponents.agent,
					activeScenarios: this.getActiveScenarios().map((s) => s.name),
				});
			}, this.config.warningInterval);
		}

		this.logger?.infoSync('Simulation orchestrator started', {
			component: LogComponents.agent,
			activeScenarios: this.getActiveScenarios().map((s) => s.name),
		});
	}

	async stop(): Promise<void> {
		if (this.warningInterval) {
			clearInterval(this.warningInterval);
			this.warningInterval = undefined;
		}

		for (const scenario of this.scenarios.values()) {
			try {
				await scenario.stop();
			} catch (error) {
				this.logger?.errorSync(
					`Failed to stop simulation scenario: ${scenario.name}`,
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.agent,
					}
				);
			}
		}

		this.logger?.infoSync('Simulation orchestrator stopped', {
			component: LogComponents.agent,
		});
	}

	async startScenario(scenarioName: string): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}

		await scenario.start();
	}

	async stopScenario(scenarioName: string): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}

		await scenario.stop();
	}

	getStatus(): {
		enabled: boolean;
		scenarios: SimulationScenarioStatus[];
		activeCount: number;
	} {
		const scenarios = Array.from(this.scenarios.values()).map((s) => s.getStatus());
		const activeCount = scenarios.filter((s) => s.running).length;

		return {
			enabled: this.enabled,
			scenarios,
			activeCount,
		};
	}

	private getActiveScenarios(): SimulationScenario[] {
		return Array.from(this.scenarios.values()).filter((s) => {
			const status = s.getStatus();
			return status.running;
		});
	}

	async updateScenarioConfig(scenarioName: string, config: any): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}

		if (scenario.updateConfig) {
			await scenario.updateConfig(config);
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}
}

/**
 * Load simulation configuration from environment variables
 */
export function loadSimulationConfig(): Partial<SimulationConfig> {
	const enabled = process.env.SIMULATION_MODE === 'true';

	if (!enabled) {
		return { enabled: false };
	}

	let config: Partial<SimulationConfig> = { enabled: true };

	const parseSimulationEnvJson = (rawValue: string): any => {
		const candidates: string[] = [];
		const trimmed = rawValue.trim();
		candidates.push(trimmed);

		if (
			(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
			(trimmed.startsWith('"') && trimmed.endsWith('"'))
		) {
			candidates.push(trimmed.slice(1, -1));
		}

		candidates.push(trimmed.replace(/\\"/g, '"'));

		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				return JSON.parse(candidate);
			} catch (error) {
				lastError = error;
			}
		}

		throw lastError instanceof Error ? lastError : new Error('Invalid SIMULATION_CONFIG JSON');
	};

	const configStr = process.env.SIMULATION_CONFIG;
	if (configStr) {
		try {
			const parsed = parseSimulationEnvJson(configStr);
			config = { enabled: true, ...parsed };

			const anomalyConfig = config.scenarios?.anomaly_injection;
			if (anomalyConfig) {
				anomalyConfig.metrics = normalizeSimulationMetrics(anomalyConfig.metrics);
			}
		} catch (error) {
			console.error('Failed to parse SIMULATION_CONFIG:', error);
		}
	}

	const anomalyConfig = config.scenarios?.anomaly_injection;
	if (anomalyConfig) {
		console.info('[simulation] loaded anomaly injection config', {
			enabled: anomalyConfig.enabled,
			mode: anomalyConfig.mode || 'inject',
			pattern: anomalyConfig.pattern,
			metrics: anomalyConfig.metrics,
			intervalMs: anomalyConfig.intervalMs,
		});
	}

	return config;
}
