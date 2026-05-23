import { createJsonPayload, serializePayload } from '../../mqtt/manager.js';
import { agentTopic } from '../../mqtt/topics.js';
import type { DeviceConfig, DeviceStats, MqttConnection, Logger } from './types.js';
import { DeviceState } from './types.js';

/**
 * Publishes periodic heartbeat messages for one endpoint.
 * Only fires when the endpoint is CONNECTED and MQTT is available.
 */
export class HeartbeatManager {
	private timer: NodeJS.Timeout | null = null;

	constructor(
    private readonly config: DeviceConfig,
    private readonly mqttConnection: MqttConnection,
    private readonly deviceUuid: string,
    private readonly logger?: Logger,
	) {}

	start(getState: () => DeviceState, getStats: () => DeviceStats): void {
		this.stop();
		this.timer = setInterval(
			() => this.publish(getState, getStats),
			this.config.heartbeatTimeSec * 1000,
		);
		// Send an initial heartbeat immediately
		this.publish(getState, getStats);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private async publish(getState: () => DeviceState, getStats: () => DeviceStats): Promise<void> {
		if (!this.config.mqttHeartbeatTopic) return;
		if (getState() !== DeviceState.CONNECTED) return;
		if (!this.mqttConnection.isConnected()) return;

		const name = this.config.name || 'unknown';
		try {
			const topic = agentTopic(this.deviceUuid, 'endpoints', this.config.mqttHeartbeatTopic);
			const data = {
				endpoint: name,
				timestamp: new Date().toISOString(),
				state: getState(),
				stats: getStats(),
			};
			const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
			const mqttPayload = createJsonPayload(data, msgIdGen);
			await this.mqttConnection.publish(topic, serializePayload(mqttPayload), { qos: 0 });
			this.logger?.debug(`Published heartbeat for endpoint '${name}'`);
		} catch (err) {
			this.logger?.error(`Failed to publish heartbeat for endpoint '${name}'`, err);
		}
	}
}
