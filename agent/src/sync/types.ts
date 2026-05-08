import type { PublishMode } from '../mqtt/manager.js';

export interface AgentDeviceReport {
	uuid: string;
	endpoint_uuid: string;
	name: string;
	protocol: string;
	identifier: string | null;
	enabled: boolean;
	lastSeenAt: string | null;
}

export interface AgentStateReport {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number;
		devices?: AgentDeviceReport[];
		cpu_usage?: number;
		memory_usage?: number;
		memory_total?: number;
		storage_usage?: number;
		storage_total?: number;
		temperature?: number;
		is_online?: boolean;
		local_ip?: string;
		os_version?: string;
		architecture?: string;
		agent_version?: string;
		uptime?: number;
		network_interfaces?: Array<{
			name: string;
			ip4: string | null;
			ip6: string | null;
			mac: string | null;
			type: string | null;
			default: boolean;
			virtual: boolean;
			operstate: string | null;
			ssid?: string;
			signalLevel?: number;
		}>;
		endpoints_health?: Record<string, any>;
		publish_health?: any;
		vpn_health?: any;
	};
}

export interface CloudSyncConfig {
	cloudApiEndpoint: string;
	pollInterval?: number;    // Default: 60000ms (60s)
	reportInterval?: number;  // Default: 10000ms (10s)
	metricsInterval?: number; // Default: 300000ms (5min)
	apiTimeout?: number;      // Default: 30000ms (30s)
}

export interface CurrentStateVersionSource {
	getCurrentVersion(): number;
}

export interface TargetStateResponse {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number;
		needs_deployment?: boolean;
		last_deployed_at?: string;
	};
}

export interface CloudSyncMqttManager {
	isConnected(): boolean;
	publishNoQueue(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
	getPublishMode?(): PublishMode;
	setPublishMode?(mode: PublishMode, reason?: string): void;
	requestBufferedFlush?(reason?: string): void;
	on?(event: string, listener: (...args: any[]) => void): void;
	removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export class CloudTransportBufferedError extends Error {
	constructor(mode: PublishMode) {
		super(`Cloud transport is buffering reports while publish mode is ${mode}`);
		this.name = 'CloudTransportBufferedError';
	}
}

export class NonRetryableTransportError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'NonRetryableTransportError';
	}
}
