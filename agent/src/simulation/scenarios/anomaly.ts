/**
 * ANOMALY INJECTION SIMULATION SCENARIO
 * ======================================
 * 
 * Automatically injects anomalies into metrics for testing detection.
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { AnomalyDetectionService } from '../../anomaly';
import type { AnomalyBaselineRecord } from '../../anomaly/storage';
import type {
	SimulationScenario,
	SimulationScenarioStatus,
	AnomalySimulationConfig,
	SimulationPattern,
} from '../types';

/**
 * Anomaly injection simulation scenario
 */
export class AnomalyInjectionSimulation implements SimulationScenario {
	name = 'anomaly_injection';
	description = 'Automatically injects anomalies into metrics';
	enabled = false;
	
	private config: AnomalySimulationConfig;
	private logger?: AgentLogger;
	private anomalyService?: AnomalyDetectionService;
	private running = false;
	private startedAt?: number;
	private injectionInterval?: NodeJS.Timeout;
	private injectionCount = 0;
	private cyclePhase = 0; // For cyclic patterns
	private baselineMissCount = 0;
	
	constructor(
		config: AnomalySimulationConfig,
		anomalyService?: AnomalyDetectionService,
		logger?: AgentLogger
	) {
		this.config = config;
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
		
		this.logger?.warnSync('STARTING ANOMALY INJECTION SIMULATION - FOR TESTING ONLY', {
			component: LogComponents.metrics,
			metrics: this.config.metrics,
			pattern: this.config.pattern,
			intervalMs: this.config.intervalMs,
			severity: this.config.severity,
		});
		
		this.running = true;
		this.startedAt = Date.now();
		this.injectionCount = 0;
		
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
				pattern: this.config.pattern,
				injectionCount: this.injectionCount,
				baselineMissCount: this.baselineMissCount,
				valueSource: this.config.valueSource || 'static',
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
		if (!Array.isArray(this.config.metrics) || this.config.metrics.length === 0) {
			return;
		}
		
		// Pick a random metric from configured list
		const metric = this.config.metrics[Math.floor(Math.random() * this.config.metrics.length)];
		
		// Generate anomalous value based on pattern
		const value = await this.generateAnomalousValue(metric);
		if (value === null) {
			return;
		}
		
		// Get unit for metric
		const unit = this.getUnitForMetric(metric);
		
		// Inject data point
		const dataPoint = {
			source: 'system' as const, // Use 'system' source for simulated data
			metric,
			value,
			unit,
			timestamp: Date.now(),
			quality: 'GOOD' as const,
			tags: { simulation: 'true', pattern: this.config.pattern },
		};
		
		this.anomalyService.processDataPoint(dataPoint);
		this.injectionCount++;
		
		this.logger?.debugSync('Anomaly injected', {
			component: LogComponents.metrics,
			metric,
			value,
			pattern: this.config.pattern,
			severity: this.config.severity,
			valueSource: this.config.valueSource || 'static',
		});
	}
	
	/**
	 * Generate anomalous value based on pattern
	 */
	private async generateAnomalousValue(metric: string): Promise<number | null> {
		const baseline = await this.getBaseline(metric);
		if (baseline) {
			return this.generateFromBaseline(metric, baseline);
		}

		if (this.config.valueSource === 'baseline' && this.config.strictBaseline) {
			this.baselineMissCount += 1;
			this.logger?.debugSync('Skipping anomaly injection: baseline missing in strict mode', {
				component: LogComponents.metrics,
				metric,
				deviceId: this.config.baselineDeviceId,
				deviceState: this.config.baselineDeviceState,
			});
			return null;
		}

		if (this.config.valueSource === 'baseline') {
			this.baselineMissCount += 1;
		}

		const baseValues: Record<string, number> = {
			cpu_usage: 50,
			memory_percent: 60,
			cpu_temp: 65,
			temperature: 23,
			humidity: 55,
			pressure: 1013,
		};
		
		const base = baseValues[metric] || 50;
		return this.generateByPattern(metric, base);
	}

	private generateFromBaseline(metric: string, baseline: AnomalyBaselineRecord): number {
		const fallbackBase = this.getStaticBaseValue(metric);
		const base = this.getBaselineCenter(baseline, fallbackBase);
		return this.generateByPattern(metric, base, baseline);
	}

	private generateByPattern(metric: string, base: number, baseline?: AnomalyBaselineRecord): number {
		const magnitude = this.config.magnitude || 3;
		const spread = this.getBaselineSpread(base, baseline);
		
		switch (this.config.pattern) {
			case 'spike':
				// Sudden spike well above normal
				return base + (spread * magnitude * 1.8);
				
			case 'drift':
				// Gradual increase over time
				const driftFactor = this.injectionCount * 0.1;
				return base + (spread * driftFactor * magnitude * 0.45);
				
			case 'cyclic':
				// Sine wave pattern
				this.cyclePhase += 0.1;
				const cycle = Math.sin(this.cyclePhase);
				return base + (spread * cycle * magnitude * 1.2);
				
			case 'noisy':
				// Add random noise
				const noise = (Math.random() - 0.5) * 2; // -1 to 1
				return base + (spread * noise * magnitude * 0.8);
				
			case 'extreme':
				// Edge case values
				return metric === 'cpu_temp' ? 95 : 
					   metric === 'cpu_usage' ? 98 :
					   metric === 'memory_percent' ? 99 :
					   base + (spread * magnitude * 3.2);
				
			case 'random':
				// Completely random
				return Math.random() * Math.max(base + (spread * magnitude), spread);
				
			case 'realistic':
			default:
				// Slightly elevated but still realistic
				return base + (spread * magnitude * 0.9);
		}
	}

	private getStaticBaseValue(metric: string): number {
		const baseValues: Record<string, number> = {
			cpu_usage: 50,
			memory_percent: 60,
			cpu_temp: 65,
			temperature: 23,
			humidity: 55,
			pressure: 1013,
		};

		return baseValues[metric] || 50;
	}

	private getBaselineCenter(baseline: AnomalyBaselineRecord, fallbackBase: number): number {
		if (typeof baseline.median === 'number') return baseline.median;
		if (typeof baseline.mean === 'number') return baseline.mean;
		if (typeof baseline.q1 === 'number' && typeof baseline.q3 === 'number') {
			return (baseline.q1 + baseline.q3) / 2;
		}
		if (typeof baseline.min === 'number' && typeof baseline.max === 'number') {
			return (baseline.min + baseline.max) / 2;
		}
		return fallbackBase;
	}

	private getBaselineSpread(base: number, baseline?: AnomalyBaselineRecord): number {
		if (!baseline) {
			return Math.max(Math.abs(base) * 0.1, 1);
		}

		if (typeof baseline.std_dev === 'number' && baseline.std_dev > 0) {
			return Math.max(baseline.std_dev, 0.1);
		}
		if (typeof baseline.iqr === 'number' && baseline.iqr > 0) {
			return Math.max(baseline.iqr / 1.35, 0.1);
		}
		if (typeof baseline.max === 'number' && typeof baseline.min === 'number' && baseline.max > baseline.min) {
			return Math.max((baseline.max - baseline.min) / 6, 0.1);
		}

		return Math.max(Math.abs(base) * 0.1, 1);
	}

	private async getBaseline(metric: string): Promise<AnomalyBaselineRecord | null> {
		if (!this.anomalyService) {
			return null;
		}

		if (this.config.valueSource !== 'baseline') {
			return null;
		}

		const storage = this.anomalyService.getStorage?.();
		if (!storage) {
			return null;
		}

		const minimumSamples = this.config.baselineMinSamples ?? 10;
		const deviceState = this.config.baselineDeviceState || 'unknown';
		const deviceId = this.config.baselineDeviceId || 'unknown-device';

		try {
			return await storage.getLatestBaseline(
				metric,
				-1,
				minimumSamples,
				null,
				deviceState,
				deviceId
			);
		} catch (error) {
			this.logger?.warnSync('Failed to load anomaly baseline for simulation metric', {
				component: LogComponents.metrics,
				metric,
				deviceId,
				deviceState,
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
