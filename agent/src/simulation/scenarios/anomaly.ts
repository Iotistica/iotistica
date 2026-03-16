/**
 * ANOMALY INJECTION SIMULATION SCENARIO
 * ======================================
 * 
 * Automatically injects anomalies into metrics for testing detection.
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { AnomalyDetectionService } from '../../anomaly';
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
			this.injectAnomaly();
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
	private injectAnomaly(): void {
		if (!this.anomalyService) return;
		
		// Pick a random metric from configured list
		const metric = this.config.metrics[Math.floor(Math.random() * this.config.metrics.length)];
		
		// Generate anomalous value based on pattern
		const value = this.generateAnomalousValue(metric);
		
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
		});
	}
	
	/**
	 * Generate anomalous value based on pattern
	 */
	private generateAnomalousValue(metric: string): number {
		const baseValues: Record<string, number> = {
			cpu_usage: 50,
			memory_percent: 60,
			cpu_temp: 65,
			temperature: 23,
			humidity: 55,
			pressure: 1013,
		};
		
		const base = baseValues[metric] || 50;
		const magnitude = this.config.magnitude || 3;
		
		switch (this.config.pattern) {
			case 'spike':
				// Sudden spike well above normal
				return base + (base * magnitude * 0.5); // 50% spike per magnitude
				
			case 'drift':
				// Gradual increase over time
				const driftFactor = this.injectionCount * 0.1;
				return base + (base * driftFactor * magnitude * 0.1);
				
			case 'cyclic':
				// Sine wave pattern
				this.cyclePhase += 0.1;
				const cycle = Math.sin(this.cyclePhase);
				return base + (base * cycle * magnitude * 0.3);
				
			case 'noisy':
				// Add random noise
				const noise = (Math.random() - 0.5) * 2; // -1 to 1
				return base + (base * noise * magnitude * 0.2);
				
			case 'extreme':
				// Edge case values
				return metric === 'cpu_temp' ? 95 : 
					   metric === 'cpu_usage' ? 98 :
					   metric === 'memory_percent' ? 99 :
					   base * magnitude;
				
			case 'random':
				// Completely random
				return Math.random() * base * magnitude;
				
			case 'realistic':
			default:
				// Slightly elevated but still realistic
				return base + (base * magnitude * 0.2);
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
