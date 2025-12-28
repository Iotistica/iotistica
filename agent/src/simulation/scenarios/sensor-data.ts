/**
 * SENSOR DATA SIMULATION SCENARIO
 * ================================
 * 
 * Generates synthetic sensor data for testing without physical hardware.
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { AnomalyDetectionService } from '../../ai/anomaly';
import type { MqttManager } from '../../mqtt/manager';
import { createJsonPayload } from '../../mqtt/manager';
import type {
	SimulationScenario,
	SimulationScenarioStatus,
	SensorDataSimulationConfig,
	SimulationPattern,
} from '../types';

/**
 * Sensor data simulation scenario
 * 
 * Generates synthetic sensor data matching the format of real sensor-publish feature:
 * - MQTT Topic: iot/device/{deviceUuid}/endpoints/{mqttTopic}
 * - Payload: { sensor: "name", timestamp: "ISO", messages: ["data"] }
 */
export class SensorDataSimulation implements SimulationScenario {
	name = 'sensor_data';
	description = 'Generates synthetic sensor data (MQTT + anomaly detection)';
	enabled = false;
	
	private config: SensorDataSimulationConfig;
	private logger?: AgentLogger;
	private anomalyService?: AnomalyDetectionService;
	private mqttManager?: MqttManager;
	private deviceUuid?: string;
	private running = false;
	private startedAt?: number;
	private publishInterval?: NodeJS.Timeout;
	private publishCount = 0;
	private cyclePhase = 0; // For cyclic patterns
	private driftOffset: Record<string, number> = {}; // For drift pattern
	
	constructor(
		config: SensorDataSimulationConfig,
		anomalyService?: AnomalyDetectionService,
		logger?: AgentLogger,
		mqttManager?: MqttManager,
		deviceUuid?: string
	) {
		this.config = config;
		this.anomalyService = anomalyService;
		this.logger = logger;
		this.mqttManager = mqttManager;
		this.deviceUuid = deviceUuid;
		this.enabled = config.enabled;
		
		// Initialize drift offsets
		this.config.sensors.forEach(sensor => {
			this.driftOffset[sensor.metric] = 0;
		});
	}
	
	async start(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		
		if (this.running) {
			this.logger?.warnSync('Sensor data simulation already running', {
				component: LogComponents.metrics,
			});
			return;
		}
		
		this.logger?.infoSync('Starting sensor data simulation', {
			component: LogComponents.metrics,
			sensors: this.config.sensors.map(s => s.metric),
			pattern: this.config.pattern,
			intervalMs: this.config.publishIntervalMs,
		});
		
		this.running = true;
		this.startedAt = Date.now();
		this.publishCount = 0;
		
		// Publish immediately on start (but don't await to avoid blocking)
		this.publishSensorData().catch(() => {
			// Ignore errors on start - likely MQTT not connected
		});
		
		// Then publish on interval
		this.publishInterval = setInterval(() => {
			this.publishSensorData().catch(() => {
				// Ignore errors - likely MQTT not connected
			});
		}, this.config.publishIntervalMs);
	}
	
	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}
		
		if (this.publishInterval) {
			clearInterval(this.publishInterval);
			this.publishInterval = undefined;
		}
		
		this.logger?.infoSync('Sensor data simulation stopped', {
			component: LogComponents.metrics,
			totalPublishes: this.publishCount,
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
				sensors: this.config.sensors.map(s => s.metric),
				pattern: this.config.pattern,
				publishCount: this.publishCount,
				intervalMs: this.config.publishIntervalMs,
			},
		};
	}
	
	async updateConfig(config: Partial<SensorDataSimulationConfig>): Promise<void> {
		this.config = { ...this.config, ...config };
		this.enabled = this.config.enabled;
		
		// Restart if running
		if (this.running) {
			await this.stop();
			await this.start();
		}
	}
	
	/**
	 * Publish sensor data for all Configured Endpoints
	 * 
	 * Matches the real sensor-publish format:
	 * - Topic: iot/device/{deviceUuid}/endpoints/{mqttTopic}
	 * - Payload: { sensor: "name", timestamp: "ISO", messages: [data] }
	 */
	private async publishSensorData(): Promise<void> {
		for (const sensor of this.config.sensors) {
			const value = this.generateSensorValue(sensor);
			
			// 1. Publish to MQTT (matching sensor-publish format)
			// Skip if MQTT not connected (e.g., device not provisioned)
			if (this.mqttManager && this.deviceUuid && this.mqttManager.isConnected()) {
				try {
					const topic = `iot/device/${this.deviceUuid}/endpoints/${sensor.metric}`;
					const data = {
						sensor: sensor.metric,
						timestamp: new Date().toISOString(),
						messages: [
							JSON.stringify({
								value: parseFloat(value.toFixed(2)),
								unit: sensor.unit,
								timestamp: Date.now(),
								simulation: true
							})
						]
					};
					
					// Use msgId for HA deduplication
					const msgIdGen = this.mqttManager.getMessageIdGenerator();
					const payload = createJsonPayload(data, msgIdGen);
					
					await this.mqttManager.publish(topic, payload, { qos: 1 });
					
					this.logger?.debugSync('Simulated sensor MQTT published', {
						component: LogComponents.metrics,
						topic,
						sensor: sensor.metric,
						value: value.toFixed(2),
					});
				} catch (error) {
					// Silently skip MQTT errors when not connected
					// This is normal when device is not provisioned
				}
			}
			
			// 2. Feed to anomaly detection if available (for testing detection)
			if (this.anomalyService) {
				const dataPoint = {
					source: 'sensor' as const,
					metric: sensor.metric,
					value,
					unit: sensor.unit,
					timestamp: Date.now(),
					quality: 'GOOD' as const,
					tags: { simulation: 'true' },
				};
				
				this.anomalyService.processDataPoint(dataPoint);
			}
			
			this.logger?.debugSync('Sensor data published', {
				component: LogComponents.metrics,
				metric: sensor.metric,
				value: value.toFixed(2),
				unit: sensor.unit,
				pattern: this.config.pattern,
			});
		}
		
		this.publishCount++;
	}
	
	/**
	 * Generate sensor value based on pattern
	 */
	private generateSensorValue(sensor: typeof this.config.sensors[0]): number {
		const { baseValue, variance, min, max } = sensor;
		let value: number;
		
		switch (this.config.pattern) {
			case 'realistic':
				// Normal distribution around base value
				value = baseValue + this.randomGaussian() * variance;
				break;
				
			case 'spike':
				// Occasional spikes
				if (Math.random() < 0.1) { // 10% chance of spike
					value = baseValue + variance * 3;
				} else {
					value = baseValue + this.randomGaussian() * variance;
				}
				break;
				
			case 'drift':
				// Slow drift over time
				this.driftOffset[sensor.metric] += (Math.random() - 0.5) * 0.1;
				value = baseValue + this.driftOffset[sensor.metric] + this.randomGaussian() * variance * 0.5;
				break;
				
			case 'cyclic':
				// Sine wave pattern
				this.cyclePhase += 0.05;
				const cycle = Math.sin(this.cyclePhase);
				value = baseValue + cycle * variance * 2;
				break;
				
			case 'noisy':
				// High variance random noise
				value = baseValue + (Math.random() - 0.5) * variance * 4;
				break;
				
			case 'faulty':
				// Occasional bad readings
				if (Math.random() < 0.05) { // 5% failure rate
					value = baseValue + (Math.random() - 0.5) * variance * 10;
				} else {
					value = baseValue + this.randomGaussian() * variance;
				}
				break;
				
			case 'extreme':
				// Edge case values
				if (Math.random() < 0.5) {
					value = min !== undefined ? min : baseValue - variance * 5;
				} else {
					value = max !== undefined ? max : baseValue + variance * 5;
				}
				break;
				
			case 'random':
				// Completely random within range
				const range = max !== undefined && min !== undefined ? max - min : variance * 10;
				const minVal = min !== undefined ? min : baseValue - variance * 5;
				value = minVal + Math.random() * range;
				break;
				
			default:
				value = baseValue + this.randomGaussian() * variance;
		}
		
		// Clamp to min/max if defined
		if (min !== undefined) {
			value = Math.max(min, value);
		}
		if (max !== undefined) {
			value = Math.min(max, value);
		}
		
		return value;
	}
	
	/**
	 * Generate random Gaussian (normal distribution) value
	 * Box-Muller transform
	 */
	private randomGaussian(): number {
		let u = 0, v = 0;
		while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
		while (v === 0) v = Math.random();
		return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
	}
}
