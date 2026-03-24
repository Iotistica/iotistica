/**
 * SENSOR DATA SIMULATION SCENARIO
 * ================================
 * 
 * Generates synthetic sensor data for testing without physical hardware.
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { AnomalyDetectionService } from '../../anomaly';
import type {
	SimulationScenario,
	SimulationScenarioStatus,
	SensorDataSimulationConfig as DeviceDataSimulationConfig,
	SimulationProtocol,
} from '../types';

/**
 * Sensor data simulation scenario
 * 
 * Generates synthetic sensor data matching the format of real sensor-publish feature:
 * - MQTT Topic: iot/device/{deviceUuid}/endpoints/{mqttTopic}
 * - Payload: { sensor: "name", timestamp: "ISO", messages: ["data"] }
 */
export class DeviceDataSimulation implements SimulationScenario {
	name = 'device_data';
	description = 'Generates synthetic device data (MQTT + anomaly detection)';
	enabled = false;
	
	private config: DeviceDataSimulationConfig;
	private logger?: AgentLogger;
	private anomalyService?: AnomalyDetectionService;
	private publishToDeviceFeature?: (endpointTopic: string, message: Record<string, any>) => Promise<boolean> | boolean;
	private running = false;
	private startedAt?: number;
	private publishInterval?: NodeJS.Timeout;
	private publishCount = 0;
	private cyclePhase = 0; // For cyclic patterns
	private driftOffset: Record<string, number> = {}; // For drift pattern
	
	constructor(
		config: DeviceDataSimulationConfig,
		anomalyService?: AnomalyDetectionService,
		logger?: AgentLogger,
		publishToDeviceFeature?: (endpointTopic: string, message: Record<string, any>) => Promise<boolean> | boolean
	) {
		this.config = config;
		this.anomalyService = anomalyService;
		this.logger = logger;
		this.publishToDeviceFeature = publishToDeviceFeature;
		this.enabled = config.enabled;
		
		// Initialize drift offsets
		this.config.devices.forEach(device => {
			this.driftOffset[device.metric] = 0;
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

		this.validateConfiguration();
		
		this.logger?.infoSync('Starting sensor data simulation', {
			component: LogComponents.metrics,
			devices: this.config.devices.map(s => ({ metric: s.metric, endpointTopic: s.endpointTopic, protocol: s.protocol })),
			pattern: this.config.pattern,
			intervalMs: this.config.publishIntervalMs,
		});
		
		this.running = true;
		this.startedAt = Date.now();
		this.publishCount = 0;
		
		// Publish immediately on start (but don't await to avoid blocking)
		this.publishDeviceData().catch(() => {
			// Ignore errors on start - likely MQTT not connected
		});
		
		// Then publish on interval
		this.publishInterval = setInterval(() => {
			this.publishDeviceData().catch(() => {
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
		
		this.logger?.infoSync('Device data simulation stopped', {
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
				sensors: this.config.devices.map(s => s.metric),
				pattern: this.config.pattern,
				publishCount: this.publishCount,
				intervalMs: this.config.publishIntervalMs,
			},
		};
	}
	
	async updateConfig(config: Partial<DeviceDataSimulationConfig>): Promise<void> {
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
	 * Matches the real device-publish format:
	 * - Topic: iot/device/{deviceUuid}/endpoints/{mqttTopic}
	 * - Payload: { sensor: "name", timestamp: "ISO", messages: [data] }
	 */
	private async publishDeviceData(): Promise<void> {
		for (const sensor of this.config.devices) {
			const value = this.generateDeviceValue(sensor);
			const protocolPayload = this.buildProtocolPayload(sensor, value);

			let publishedViaFeature = false;
			try {
				publishedViaFeature = await this.publishToDeviceFeature!(sensor.endpointTopic, protocolPayload);
			} catch (error) {
				this.logger?.warnSync('Simulation publish failed via Device Publish Feature', {
					component: LogComponents.metrics,
					endpointTopic: sensor.endpointTopic,
					metric: sensor.metric,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (!publishedViaFeature) {
				this.logger?.warnSync('Simulation message dropped: no matching Device Publish endpoint', {
					component: LogComponents.metrics,
					endpointTopic: sensor.endpointTopic,
					metric: sensor.metric,
					protocol: sensor.protocol,
				});
			}
			
			// 2. Feed to anomaly detection if available (for testing detection)
			if (this.anomalyService) {
				const dataPoint = {
					source: 'device' as const,
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
				endpointTopic: sensor.endpointTopic,
				viaDevicePublishFeature: publishedViaFeature,
				pattern: this.config.pattern,
			});
		}
		
		this.publishCount++;
	}

	private buildProtocolPayload(
		sensor: DeviceDataSimulationConfig['devices'][number],
		value: number,
	): Record<string, any> {
		switch (sensor.protocol) {
			case 'modbus':
				return {
					register: sensor.metric,
					value: parseFloat(value.toFixed(2)),
					unit: sensor.unit,
					timestamp: Date.now(),
					quality: 'GOOD',
					simulation: true,
				};
			case 'opcua':
				return {
					nodeId: sensor.metric,
					value: parseFloat(value.toFixed(2)),
					statusCode: 'Good',
					timestamp: Date.now(),
					simulation: true,
				};
			case 'snmp':
				return {
					oid: sensor.metric,
					value: parseFloat(value.toFixed(2)),
					metricType: 'gauge',
					timestamp: Date.now(),
					simulation: true,
				};
			case 'can':
				return {
					id: '0x18FF50E5',
					dlc: 8,
					signals: {
						[sensor.metric]: parseFloat(value.toFixed(2)),
					},
					timestamp: Date.now(),
					simulation: true,
				};
			case 'mqtt':
				return {
					topic: sensor.endpointTopic,
					metric: sensor.metric,
					value: parseFloat(value.toFixed(2)),
					unit: sensor.unit,
					timestamp: Date.now(),
					simulation: true,
				};
			default:
				return {
					value: parseFloat(value.toFixed(2)),
					metric: sensor.metric,
					unit: sensor.unit,
					timestamp: Date.now(),
					simulation: true,
				};
		}
	}

	private validateConfiguration(): void {
		if (!this.publishToDeviceFeature) {
			throw new Error('Device data simulation requires Device Publish Feature integration');
		}

		for (const device of this.config.devices) {
			if (!device.endpointTopic || device.endpointTopic.trim().length === 0) {
				throw new Error(`Simulation device '${device.metric}' is missing required endpointTopic`);
			}

			if (!device.protocol || device.protocol.trim().length === 0) {
				throw new Error(`Simulation device '${device.metric}' is missing required protocol`);
			}
		}
	}
	
	/**
	 * Generate device value based on pattern
	 */
	private generateDeviceValue(device: typeof this.config.devices[0]): number {
		const { baseValue, variance, min, max } = device;
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
				this.driftOffset[device.metric] += (Math.random() - 0.5) * 0.1;
				value = baseValue + this.driftOffset[device.metric] + this.randomGaussian() * variance * 0.5;
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
