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

type PatternEvolutionPhase = 'drift' | 'alert' | 'recovery';

/** Per-metric state machine for drift → alert → recovery → drift cycles. */
type PatternEvolutionState = {
	phase: PatternEvolutionPhase;
	tick: number; // ticks spent in current phase
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
	private cyclicStateByMetric = new Map<string, { phase: number; amplitude: number }>(); // Per-metric OU cyclic state
	private baselineMissCount = 0;
	private lastMetric?: string;
	private metricRecentScore = new Map<string, number>(); // Decaying recency score for weighted metric selection
	private metricStats: Record<string, number> = {};
	private metricInjectionCounts = new Map<string, number>();
	private metricLastSeenAt = new Map<string, number>();
	private alertStateByMetric = new Map<string, AlertMetricState>();
	private noisyWalkByMetric = new Map<string, { value: number; ts: number }>(); // OU process state for 'noisy' pattern
	private shiftedBaseByMetric = new Map<string, number>(); // Locked-in shifted baseline for 'regime_shift' pattern
	private patternEvolutionByMetric = new Map<string, PatternEvolutionState>(); // Cross-pattern transition state (drift→alert→recovery cycle)
	private ar1StateByMetric = new Map<string, number>(); // Previous output for AR(1) autocorrelation filter
	private baselineCache = new Map<string, { value: AnomalyBaselineRecord | null; ts: number }>();
	private readonly BASELINE_TTL = 30_000;
	private readonly metricInactivityResetMs = 180_000;
	private readonly alertActivePoints = 40;
	private readonly alertRecoveryPoints = 12;
	private readonly evolutionRecoveryTicks = 20; // ticks in recovery phase before cycling back to drift
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
		this.metricRecentScore.clear();
		this.alertStateByMetric.clear();
		this.cyclicStateByMetric.clear();
		this.shiftedBaseByMetric.clear();
		this.patternEvolutionByMetric.clear();
		this.ar1StateByMetric.clear();
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
			this.metricRecentScore.set(metric, (this.metricRecentScore.get(metric) ?? 0) + 1);
			emitted++;
		}

		if (this.config.pattern === 'alert' && emitted > 0) {
			this.advanceAlertState(metric, emitted);
		}

		// Evolve pattern state machine for drift-chain metrics (drift→alert→recovery→drift).
		// Also advance alert state when evolution has elevated a metric into the alert phase.
		const effectivePattern = this.getEffectivePattern(metric);
		if (effectivePattern === 'alert' && this.config.pattern !== 'alert' && emitted > 0) {
			this.advanceAlertState(metric, emitted);
		}
		if (emitted > 0) {
			this.advancePatternEvolution(metric, baseContext.base, baseContext.baseline, emitted);
		}

		if (emitted > 0) {
			this.logger?.debugSync('Anomaly injected', {
				component: LogComponents.metrics,
				metric,
				emitted,
				burst,
				metricRecentScore: this.metricRecentScore.get(metric),
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
		const metrics = this.config.metrics;
		if (!Array.isArray(metrics) || metrics.length === 0) {
			return 'cpu_usage';
		}

		if (metrics.length === 1) {
			this.lastMetric = metrics[0];
			return metrics[0];
		}

		// Decay all recency scores geometrically each selection cycle so that
		// recently injected metrics stay preferred for several cycles, then fade.
		const RECENCY_DECAY = 0.92;
		for (const [m, score] of this.metricRecentScore.entries()) {
			const decayed = score * RECENCY_DECAY;
			if (decayed < 0.001) {
				this.metricRecentScore.delete(m);
			} else {
				this.metricRecentScore.set(m, decayed);
			}
		}

		// Gather variance (spread) synchronously from the baseline cache.
		// Metrics with higher natural spread are more interesting to stress-test.
		let maxSpread = 0;
		const spreads = new Map<string, number>();
		for (const m of metrics) {
			const cached = this.baselineCache.get(m);
			if (cached?.value) {
				const center = this.getBaselineCenter(cached.value);
				const s = this.getBaselineSpread(center ?? 1, cached.value);
				spreads.set(m, s);
				if (s > maxSpread) maxSpread = s;
			}
		}

		// Score weights:
		//   priority (2×) — explicit operator intent dominates
		//   recency  (1×) — keeps injection streaks on the same metric realistic
		//   variance (0.5×) — mild bias toward high-spread metrics
		// A floor of 0.1 on each component ensures unvisited/uncached metrics
		// are never starved and always have a non-zero selection probability.
		const scores: number[] = [];
		let totalScore = 0;
		for (const m of metrics) {
			const recency  = this.metricRecentScore.get(m) ?? 0;
			const variance = maxSpread > 0 ? (spreads.get(m) ?? 0) / maxSpread : 0;
			const priority = this.config.metricWeights?.[m] ?? 1.0;
			const score =
				(recency   + 0.1) * 1.0
				+ (variance + 0.1) * 0.5
				+ Math.max(priority, 0.01) * 2.0;
			scores.push(score);
			totalScore += score;
		}

		// Weighted random sampling — O(n) linear scan
		let r = Math.random() * totalScore;
		for (let i = 0; i < metrics.length; i++) {
			r -= scores[i];
			if (r <= 0) {
				this.lastMetric = metrics[i];
				return metrics[i];
			}
		}

		// Floating-point rounding fallback
		const fallback = metrics[metrics.length - 1];
		this.lastMetric = fallback;
		return fallback;
	}

	private cleanupInactiveMetricState(now: number): void {
		for (const [metric, lastSeenAt] of this.metricLastSeenAt.entries()) {
			if ((now - lastSeenAt) <= this.metricInactivityResetMs) {
				continue;
			}

			this.metricLastSeenAt.delete(metric);
			this.metricInjectionCounts.delete(metric);
			this.metricRecentScore.delete(metric);
			this.alertStateByMetric.delete(metric);
			this.cyclicStateByMetric.delete(metric);
			this.shiftedBaseByMetric.delete(metric);
			this.noisyWalkByMetric.delete(metric);
			this.patternEvolutionByMetric.delete(metric);
			this.ar1StateByMetric.delete(metric);

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

		const raw = this.generateByPattern(metric, context.base, context.baseline);
		const ar1 = this.applyAr1Filter(metric, raw);
		const resolution = this.getMetricResolution(metric, context.baseline);
		return this.roundToResolution(ar1, resolution);
	}

	/**
	* AR(1) filter: value = α·prev + (1-α)·raw
	*
	* Applied to patterns that produce independent samples (spike, drift, random,
	* realistic, recovery, extreme, variance_spike) to add mild autocorrelation
	* matching real sensor behaviour — consecutive readings are never fully
	* independent.
	*
	* Skipped for patterns that already carry temporal memory:
	*   noisy       — OU process (dt-aware mean reversion)
	*   alert       — state machine drives magnitude; AR(1) would dampen alert signal
	*   cyclic      — continuous phase/amplitude state provides structure
	*   regime_shift — AR(1) would blur the crisp step change
	*
	* Alpha = 0.25: mild smoothing (each sample is 75 % new information).
	*/
	private applyAr1Filter(metric: string, raw: number): number {
		const AR1_ALPHA = 0.25;

		// Skip if the pattern already has temporal memory or if evolution
		// has promoted this metric into an autonomous alert phase.
		const staticPattern = this.config.pattern;
		const effectivePattern = this.getEffectivePattern(metric);
		const skipSet: SimulationPattern[] = ['noisy', 'alert', 'cyclic', 'regime_shift'];
		if (skipSet.includes(staticPattern) || skipSet.includes(effectivePattern)) {
			return raw;
		}

		const prev = this.ar1StateByMetric.get(metric);
		if (prev === undefined) {
			// First sample — initialise state, no blending yet
			this.ar1StateByMetric.set(metric, raw);
			return raw;
		}

		const filtered = AR1_ALPHA * prev + (1 - AR1_ALPHA) * raw;
		this.ar1StateByMetric.set(metric, filtered);
		return filtered;
	}

	/**
	* Snap a value to the nearest multiple of `resolution`.
	* Models the discrete output steps of real sensors (e.g. 0.1°C, 1% CPU).
	*/
	private roundToResolution(value: number, resolution: number): number {
		if (resolution <= 0) return value;
		return Math.round(value / resolution) * resolution;
	}

	/**
	* Return the measurement resolution for a metric.
	*
	* Lookup order:
	*   1. Well-known field name patterns (explicit table)
	*   2. Magnitude of baseline center (order-of-magnitude heuristic)
	*   3. Safe default: 0.01
	*/
	private getMetricResolution(metric: string, baseline?: AnomalyBaselineRecord): number {
		// Strip canonical prefix to get the bare field name
		const canonicalMatch = metric.match(CANONICAL_METRIC_REGEX);
		const fieldName = (canonicalMatch ? canonicalMatch[3] : metric).toLowerCase();

		// Integer/counter metrics
		if (/^(cpu_usage|cpu_percent|memory_percent|mem_percent|disk_percent|disk_usage)$/.test(fieldName)) {
			return 1;
		}

		// 0.1-precision sensors
		if (/\b(temp|temperature|humidity|rh|pressure)\b/.test(fieldName)) {
			return 0.1;
		}

		// High-resolution electrical / power-quality metrics
		if (/\b(power_factor|pf|thd)\b/.test(fieldName)) {
			return 0.001;
		}
		if (/\b(voltage|current|freq|frequency|hz)\b/.test(fieldName)) {
			return 0.01;
		}

		// Power and energy in kW / kWh
		if (/\b(power|energy|kw|kwh)\b/.test(fieldName)) {
			return 0.1;
		}

		// Fallback: infer from order of magnitude of the baseline center
		if (baseline) {
			const center = this.getBaselineCenter(baseline);
			if (center !== null) {
				const magnitude = Math.abs(center);
				if (magnitude === 0)   return 0.01;
				if (magnitude < 1)     return 0.001;
				if (magnitude < 10)    return 0.01;
				if (magnitude < 1000)  return 0.1;
				return 1;
			}
		}

		return 0.01; // safe default
	}

	/**
	* Box-Muller transform: returns a standard normal sample (mean=0, stddev=1).
	* Used to add realistic Gaussian jitter to all generated values.
	*/
	private gaussianNoise(): number {
		const u1 = Math.max(Math.random(), 1e-10); // guard against log(0)
		const u2 = Math.random();
		return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}

	private generateByPattern(metric: string, base: number, baseline?: AnomalyBaselineRecord): number {
		const magnitude = this.config.magnitude || 3;
		const spread = this.getBaselineSpread(base, baseline);
		const metricCount = this.metricInjectionCounts.get(metric) || 0;
		
		switch (this.getEffectivePattern(metric)) {
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

				// Hysteresis bands — deviation from base (in spread units × magnitude):
				//   upperBand: firmly in anomalous territory — strong bounce probability
				//   lowerBand: must drop below this before recovery is considered clean
				const upperBand = spread * magnitude * 1.5;
				const lowerBand = spread * magnitude * 0.5;

				if (state.phase === 'alert') {
					const rawDeviation = spread * magnitude * (2 + state.strength);
					const deviation = this.normalizeDeviation(metric, base, spread, rawDeviation);
					// Gaussian jitter so alert points wiggle like real anomalies
					const jitter = this.gaussianNoise() * spread * 0.25;
					return base + (state.direction * deviation) + jitter;
				}

				// Recovery phase: decaying directional pull + noise
				const decayFactor = state.strength / 5;
				const directionalPull = state.direction * spread * magnitude * decayFactor;
				const noise = this.gaussianNoise() * spread * 0.3;
				const recoveryValue = base + directionalPull + noise;

				// Hysteresis check: if the recovered value is still above the lower band,
				// bounce back to alert with a probability proportional to how far into the
				// anomalous zone it still sits — preventing unrealistically clean transitions.
				//
				//   hysteresisRatio = 0 when residual == lowerBand  → no bounce
				//   hysteresisRatio = 1 when residual >= upperBand  → 70 % bounce chance
				const residualDeviation = Math.abs(recoveryValue - base);
				if (residualDeviation > lowerBand) {
					const bandRange = Math.max(upperBand - lowerBand, 1e-6);
					const hysteresisRatio = Math.min((residualDeviation - lowerBand) / bandRange, 1);
					if (Math.random() < hysteresisRatio * 0.7) {
						// Still in anomalous territory — revert to alert without resetting
						// strength so the bounce stays elevated and doesn't immediately recover.
						state.phase = 'alert';
						state.phaseTick = 0;
					}
				}

				return recoveryValue;
			}

			case 'spike':
			// Sudden spike — randomised direction (70% high, 30% low) with Gaussian jitter
			{
				const dir: 1 | -1 = Math.random() > 0.3 ? 1 : -1;
				const peak = this.normalizeDeviation(metric, base, spread, spread * magnitude * 1.8);
				const jitter = this.gaussianNoise() * spread * 0.3;
				return base + dir * peak + jitter;
			}
				
			case 'drift':
			// Logistic (S-curve) drift: slow latent start → rapid acceleration → saturation.
			// Real sensor degradation (wear, contamination, thermal creep) follows this shape.
			//
			//   drift(n) = maxDrift × (σ(n) − σ(0)) / (1 − σ(0))
			//   σ(n)     = 1 / (1 + e^(−k·(n − x0)))
			//
			// Zero-referenced so drift=0 at n=0, with inflection at x0 injections.
			{
				const k = 0.12;    // growth rate per injection (steepness of the S)
				const x0 = 15;     // inflection point — maximum acceleration here
				const maxDrift = spread * magnitude * 1.5;
				const logistic = (x: number) => 1 / (1 + Math.exp(-k * (x - x0)));
				const l0 = logistic(0);          // value at n=0 (used to zero-reference)
				const range = 1 - l0;            // usable range [0, 1−l0]
				const rawDrift = maxDrift * (logistic(metricCount) - l0) / range;
				const trend = this.normalizeDeviation(metric, base, spread, rawDrift);
				const noise = this.gaussianNoise() * spread * 0.25;
				return base + trend + noise;
			}

			case 'recovery':
				// Explicit low-variance Gaussian return toward baseline.
				return base + this.gaussianNoise() * spread * 0.2;
				
			case 'cyclic': {
				// Per-metric state: each metric runs its own independent oscillator so
				// multiple metrics don't peak and trough in lockstep.
				let cycleState = this.cyclicStateByMetric.get(metric);
				if (!cycleState) {
					// Randomise starting phase — avoids all metrics being synchronised
					// at simulation start.
					cycleState = { phase: Math.random() * 2 * Math.PI, amplitude: 1.0 };
					this.cyclicStateByMetric.set(metric, cycleState);
				}

				// Phase advances by baseFreq each step, with Gaussian jitter simulating
				// real-world frequency instability (clock drift, load-dependent periodicity).
				// baseFreq ≈ 2π/60 → one full cycle every ~60 injections at default interval.
				const baseFreq  = 0.105; // rad per injection
				const freqJitter = 0.008; // ±~7.6 % per step
				cycleState.phase += baseFreq + this.gaussianNoise() * freqJitter;

				// Amplitude drifts multiplicatively — small Gaussian nudge each step,
				// clamped to [0.5, 2.0] so it can't collapse to zero or diverge.
				cycleState.amplitude = Math.min(
					Math.max(cycleState.amplitude * (1 + this.gaussianNoise() * 0.02), 0.5),
					2.0,
				);

				const cycle = Math.sin(cycleState.phase) * cycleState.amplitude;
				const noise  = this.gaussianNoise() * spread * 0.1;
				return base + this.normalizeSignedDeviation(metric, base, spread, spread * cycle * magnitude * 1.2) + noise;
			}
				
			case 'noisy':
			// True OU discretization — time-aware so behaviour is stable regardless
			// of interval, burst size, or ingestion jitter.
			//
			//   x(t+dt) = x(t)·e^(-θdt)
			//           + μ·(1 - e^(-θdt))
			//           + σ_stat·√(1 - e^(-2θdt))·N(0,1)
			//
			// σ_stat is the desired long-run std of the process (independent of dt).
			// As dt→0 the noise term vanishes — no micro-jumps from tight bursts.
			{
				const now = Date.now();
				const thetaPerSec = 0.1; // mean-reversion speed in 1/s (time constant ≈ 10 s)
				const sigmaStationary = spread * magnitude * 0.7; // desired long-run std
				const fallbackDtSec = (this.config.intervalMs || 5000) / 1000;
				const state = this.noisyWalkByMetric.get(metric);
				const prev = state?.value ?? base;
				const dt = state ? Math.max((now - state.ts) / 1000, 1e-6) : fallbackDtSec;
				const decay = Math.exp(-thetaPerSec * dt);
				const noiseMag = sigmaStationary * Math.sqrt(Math.max(1 - decay * decay, 0));
				const next = prev * decay + base * (1 - decay) + noiseMag * this.gaussianNoise();
				this.noisyWalkByMetric.set(metric, { value: next, ts: now });
				return next;
			}
				
			case 'regime_shift': {
				// Permanent step-change in the operating level — the most common real-world
				// anomaly class: pump switched, valve repositioned, load shed, sensor recalibrated.
				//
				// On first injection the shift is computed and locked into shiftedBaseByMetric.
				// All subsequent points oscillate around that new level with the same low
				// noise as normal operation — the system is stable, just at a different setpoint.
				//
				// With a very small probability (~0.5 % per injection) a secondary step fires,
				// modelling compound events (second valve closes, cascade failure).
				let shiftedBase = this.shiftedBaseByMetric.get(metric);
				if (shiftedBase === undefined) {
					const direction: 1 | -1 = Math.random() > 0.5 ? 1 : -1;
					const shiftAmount = this.normalizeDeviation(metric, base, spread, spread * magnitude * 1.5);
					shiftedBase = base + direction * shiftAmount;
					this.shiftedBaseByMetric.set(metric, shiftedBase);
				}

				// Compound step: rare secondary shift to model cascading events
				if (Math.random() < 0.005) {
					const direction: 1 | -1 = Math.random() > 0.5 ? 1 : -1;
					shiftedBase = shiftedBase + direction * spread * magnitude * 0.5;
					this.shiftedBaseByMetric.set(metric, shiftedBase);
				}

				// Stable operation at the new level — low noise, same variance as normal
				return shiftedBase + this.gaussianNoise() * spread * 0.2;
			}

			case 'variance_spike': {
				// Amplify variance without shifting the mean — the signal stays centred on base
				// but the noise envelope is blown out by magnitude.  Models an unstable or
				// degraded sensor: high-frequency noise bursts, EMI pickup, mechanical looseness.
				//
				// spikeFactor itself carries a small random perturbation so successive points
				// don't share identical spread, matching the intermittent nature of real events.
				const spikeFactor = magnitude * (1.5 + Math.random() * 0.5);
				return base + this.gaussianNoise() * spread * spikeFactor;
			}

			case 'extreme': {
				// Drive the metric to a physically extreme value, but add Gaussian jitter
				// so the signal looks like a sensor pushed to its limit rather than a
				// synthetic constant.  Named metrics use a known practical ceiling;
				// everything else is pushed magnitude × 3.2 σ above the baseline center.
				const fieldName = (metric.match(CANONICAL_METRIC_REGEX)?.[3] ?? metric).toLowerCase();
				let extremeBase: number;
				if (/^cpu_temp$/.test(fieldName)) {
					extremeBase = 95;
				} else if (/^(cpu_usage|cpu_percent)$/.test(fieldName)) {
					extremeBase = 98;
				} else if (/^(memory_percent|mem_percent|disk_percent|disk_usage)$/.test(fieldName)) {
					extremeBase = 99;
				} else {
					extremeBase = base + this.normalizeDeviation(metric, base, spread, spread * magnitude * 3.2);
				}
				return extremeBase + this.gaussianNoise() * spread * 0.3;
			}
				
			case 'random':
				// Gaussian distribution — heavy tails produce occasional large deviations
				// that look far more realistic than uniform random jumps.
				return base + this.normalizeSignedDeviation(metric, base, spread, this.gaussianNoise() * spread * magnitude * 1.5);
				
			case 'realistic':
			default:
			// Slightly elevated but still realistic — Gaussian jitter makes it
			// indistinguishable from a genuine sensor excursion.
			{
				const signal = this.normalizeDeviation(metric, base, spread, spread * magnitude * 0.9);
				const noise = this.gaussianNoise() * spread * 0.2;
				return base + signal + noise;
			}
		}
	}

	/**
	* Returns the effective pattern for a metric.
	*
	* When config.pattern === 'drift', individual metrics may have been promoted
	* into an alert or recovery phase by the evolution state machine.  All other
	* configured patterns are returned as-is (passthrough).
	*/
	private getEffectivePattern(metric: string): SimulationPattern {
		if (this.config.pattern !== 'drift') {
			return this.config.pattern;
		}
		const state = this.patternEvolutionByMetric.get(metric);
		if (!state || state.phase === 'drift') return 'drift';
		return state.phase; // 'alert' | 'recovery'
	}

	/**
	* Computes whether the logistic drift for this metric has exceeded the
	* trigger threshold (1× spread×magnitude), using the same formula as the
	* 'drift' case in generateByPattern so the threshold fires at a consistent
	* point on the S-curve (~23 injections with default k=0.12, x0=15).
	*/
	private isDriftAboveThreshold(metric: string, spread: number): boolean {
		const magnitude = this.config.magnitude || 3;
		const k = 0.12, x0 = 15;
		const maxDrift = spread * magnitude * 1.5;
		const logistic = (x: number) => 1 / (1 + Math.exp(-k * (x - x0)));
		const l0 = logistic(0);
		const metricCount = this.metricInjectionCounts.get(metric) ?? 0;
		const rawDrift = maxDrift * (logistic(metricCount) - l0) / (1 - l0);
		return rawDrift >= spread * magnitude;
	}

	/**
	* Advances the per-metric pattern evolution state machine.
	* Only active when config.pattern === 'drift'.
	*
	* Transition graph:
	*   drift → alert     (when logistic drift exceeds 1×spread×magnitude)
	*   alert → recovery  (after alertActivePoints + alertRecoveryPoints ticks)
	*   recovery → drift  (after evolutionRecoveryTicks; resets injection count)
	*/
	private advancePatternEvolution(
		metric: string,
		base: number,
		baseline: AnomalyBaselineRecord | undefined,
		steps: number,
	): void {
		if (this.config.pattern !== 'drift') return;

		const spread = this.getBaselineSpread(base, baseline);
		let state = this.patternEvolutionByMetric.get(metric);
		if (!state) {
			state = { phase: 'drift', tick: 0 };
			this.patternEvolutionByMetric.set(metric, state);
		}
		state.tick += steps;

		if (state.phase === 'drift') {
			if (this.isDriftAboveThreshold(metric, spread)) {
				state.phase = 'alert';
				state.tick = 0;
				// Seed alert state if not already present
				if (!this.alertStateByMetric.has(metric)) {
					const cfg = this.config.alertDirection ?? 'auto';
					const direction: 1 | -1 =
						cfg === 'low' ? -1 : cfg === 'high' ? 1 : (Math.random() > 0.7 ? -1 : 1);
					this.alertStateByMetric.set(metric, {
						direction, strength: 2, phase: 'alert', phaseTick: 0,
					});
				}
				this.logger?.warnSync('Pattern evolution: drift → alert', {
					component: LogComponents.metrics, metric,
					injectionCount: this.metricInjectionCounts.get(metric) ?? 0,
				});
			}
		} else if (state.phase === 'alert') {
			if (state.tick >= this.alertActivePoints + this.alertRecoveryPoints) {
				state.phase = 'recovery';
				state.tick = 0;
				this.logger?.warnSync('Pattern evolution: alert → recovery', {
					component: LogComponents.metrics, metric,
				});
			}
		} else if (state.phase === 'recovery') {
			if (state.tick >= this.evolutionRecoveryTicks) {
				state.phase = 'drift';
				state.tick = 0;
				// Reset injection count so the logistic S-curve starts afresh
				this.metricInjectionCounts.set(metric, 0);
				this.alertStateByMetric.delete(metric);
				this.logger?.warnSync('Pattern evolution: recovery → drift', {
					component: LogComponents.metrics, metric,
				});
			}
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

		const fallbackSpread = Math.max(Math.abs(base) * 0.1, 1);

		// Compute each estimator independently so weights are explicit and stable.
		// Picking the minimum (robustCandidates.sort()[0]) biases toward the smallest
		// estimate, producing over-aggressive anomaly sensitivity.
		//
		// Preference hierarchy: MAD (most robust) > IQR > historical range (least robust).
		// Weighted average across available estimators keeps spread stable when only a
		// subset of baseline statistics are present.
		let weightedSum = 0;
		let totalWeight = 0;

		// MAD → equivalent stdDev via scale factor 1.4826 (weight 3)
		if (typeof baseline.mad === 'number' && baseline.mad > 0) {
			const madSpread = baseline.mad * 1.4826;
			if (Number.isFinite(madSpread)) {
				weightedSum += madSpread * 3;
				totalWeight += 3;
			}
		}

		// IQR → equivalent stdDev via Gaussian IQR/σ ratio 1.35 (weight 2)
		const iqrRaw = typeof baseline.iqr === 'number' && baseline.iqr > 0
			? baseline.iqr
			: (typeof baseline.q1 === 'number' && typeof baseline.q3 === 'number' && baseline.q3 > baseline.q1)
				? baseline.q3 - baseline.q1
				: null;
		if (iqrRaw !== null) {
			const iqrSpread = iqrRaw / 1.35;
			if (Number.isFinite(iqrSpread) && iqrSpread > 0) {
				weightedSum += iqrSpread * 2;
				totalWeight += 2;
			}
		}

		// Historical range / 6 ≈ stdDev under normality (weight 1 — least preferred)
		if (typeof baseline.max === 'number' && typeof baseline.min === 'number' && baseline.max > baseline.min) {
			const rangeSpread = (baseline.max - baseline.min) / 6;
			if (Number.isFinite(rangeSpread) && rangeSpread > 0) {
				weightedSum += rangeSpread * 1;
				totalWeight += 1;
			}
		}

		if (totalWeight > 0) {
			return Math.max(weightedSum / totalWeight, 0.1);
		}

		// Last resort: raw stdDev, capped to avoid blowing out spread
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
