/**
 * SIMULATION ORCHESTRATOR
 * =======================
 * 
 * Unified simulation framework for testing agent capabilities.
 * Manages multiple simulation scenarios from a single control point.
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type {
	SimulationConfig,
	SimulationScenario,
	SimulationScenarioStatus,
	SimulationDependencies,
	MemoryLeakSimulationConfig,
	AnomalySimulationConfig,
	SensorDataSimulationConfig,
} from './types';
import {
	DEFAULT_SIMULATION_CONFIG,
	DEFAULT_MEMORY_LEAK_CONFIG,
	DEFAULT_ANOMALY_CONFIG,
	DEFAULT_SENSOR_DATA_CONFIG,
} from './types';
import { MemoryLeakSimulation } from './scenarios/memory-leak';
import { AnomalyInjectionSimulation } from './scenarios/anomaly';
import { DeviceDataSimulation } from './scenarios/publish-data';

/**
 * Simulation orchestrator
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
		
		// Initialize scenarios
		this.initializeScenarios();
	}
	
	/**
	 * Initialize all configured scenarios
	 */
	private initializeScenarios(): void {
		if (!this.enabled) {
			return;
		}
		
		// Memory leak simulation
		if (this.config.scenarios.memory_leak) {
			const memoryLeakConfig = {
				...DEFAULT_MEMORY_LEAK_CONFIG,
				...this.config.scenarios.memory_leak,
			};
			
			const scenario = new MemoryLeakSimulation(memoryLeakConfig, this.logger);
			this.scenarios.set('memory_leak', scenario);
		}
		
		// Anomaly injection simulation
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
		
		// Sensor data simulation
		if (this.config.scenarios.sensor_data) {
			const sensorConfig = {
				...DEFAULT_SENSOR_DATA_CONFIG,
				...this.config.scenarios.sensor_data,
			};
			
			const scenario = new DeviceDataSimulation(
				sensorConfig,
				this.dependencies.anomalyService,
				this.logger,
				this.dependencies.publishToDeviceFeature
			);
			this.scenarios.set('sensor_data', scenario);
		}
	}
	
	/**
	 * Start all enabled scenarios
	 */
	async start(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		
		const enabledScenarios = Array.from(this.scenarios.values()).filter(s => s.enabled);
		
		if (enabledScenarios.length === 0) {
			this.logger?.infoSync('No simulation scenarios enabled', {
				component: LogComponents.agent,
			});
			return;
		}
		
		this.logger?.warnSync('⚠️  SIMULATION MODE ENABLED - FOR TESTING ONLY', {
			component: LogComponents.agent,
			scenarios: enabledScenarios.map(s => s.name),
		});
		
		// Start all enabled scenarios
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

		const runningScenarios = Array.from(this.scenarios.values())
			.filter(scenario => scenario.getStatus().running)
			.map(scenario => scenario.name);
		
		// Log periodic warning that simulation is active
		if (this.config.warningInterval && this.config.warningInterval > 0) {
			this.warningInterval = setInterval(() => {
				this.logger?.warnSync('⚠️  SIMULATION MODE ACTIVE', {
					component: LogComponents.agent,
					activeScenarios: this.getActiveScenarios().map(s => s.name),
				});
			}, this.config.warningInterval);
		}
		
		this.logger?.infoSync('Simulation orchestrator started', {
			component: LogComponents.agent,
			activeScenarios: runningScenarios,
		});
	}
	
	/**
	 * Stop all running scenarios
	 */
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
	
	/**
	 * Start a specific scenario
	 */
	async startScenario(scenarioName: string): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}
		
		await scenario.start();
	}
	
	/**
	 * Stop a specific scenario
	 */
	async stopScenario(scenarioName: string): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}
		
		await scenario.stop();
	}
	
	/**
	 * Get status of all scenarios
	 */
	getStatus(): {
		enabled: boolean;
		scenarios: SimulationScenarioStatus[];
		activeCount: number;
	} {
		const scenarios = Array.from(this.scenarios.values()).map(s => s.getStatus());
		const activeCount = scenarios.filter(s => s.running).length;
		
		return {
			enabled: this.enabled,
			scenarios,
			activeCount,
		};
	}
	
	/**
	 * Get list of active scenarios
	 */
	private getActiveScenarios(): SimulationScenario[] {
		return Array.from(this.scenarios.values()).filter(s => {
			const status = s.getStatus();
			return status.running;
		});
	}
	
	/**
	 * Update scenario configuration at runtime
	 */
	async updateScenarioConfig(scenarioName: string, config: any): Promise<void> {
		const scenario = this.scenarios.get(scenarioName);
		if (!scenario) {
			throw new Error(`Scenario not found: ${scenarioName}`);
		}
		
		if (scenario.updateConfig) {
			await scenario.updateConfig(config);
		}
	}
	
	/**
	 * Check if simulation mode is enabled
	 */
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
	
	// Try to parse SIMULATION_CONFIG JSON
	let config: Partial<SimulationConfig> = { enabled: true };

	const parseSimulationEnvJson = (rawValue: string): any => {
		const candidates: string[] = [];
		const trimmed = rawValue.trim();
		candidates.push(trimmed);

		// Docker compose/env files can preserve wrapping quotes as literal characters.
		if (
			(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
			(trimmed.startsWith('"') && trimmed.endsWith('"'))
		) {
			candidates.push(trimmed.slice(1, -1));
		}

		// Some pipelines provide JSON with escaped quotes as a plain env string.
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
			if (anomalyConfig?.mode === 'intercept') {
				anomalyConfig.valueSource = anomalyConfig.valueSource || 'baseline';
				anomalyConfig.strictBaseline = anomalyConfig.strictBaseline ?? true;
				anomalyConfig.baselineMinSamples = anomalyConfig.baselineMinSamples ?? 10;
			}
		} catch (error) {
			console.error('Failed to parse SIMULATION_CONFIG:', error);
		}
	}
	
	// Backward compatibility: Check for legacy SIMULATE_MEMORY_LEAK
	if (process.env.SIMULATE_MEMORY_LEAK === 'true') {
		console.warn('⚠️  SIMULATE_MEMORY_LEAK is deprecated. Use SIMULATION_MODE instead.');
		
		config.scenarios = config.scenarios || {};
		config.scenarios.memory_leak = {
			enabled: true,
			type: (process.env.LEAK_TYPE as any) || 'gradual',
			rateMB: parseInt(process.env.LEAK_RATE_MB || '1', 10),
			intervalMs: parseInt(process.env.LEAK_INTERVAL_MS || '5000', 10),
			maxMB: parseInt(process.env.LEAK_MAX_MB || '50', 10),
		};
	}
	
	return config;
}

/**
 * Export scenario classes for direct use if needed
 */
export { MemoryLeakSimulation, AnomalyInjectionSimulation, DeviceDataSimulation as SensorDataSimulation };
