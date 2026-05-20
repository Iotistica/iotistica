/**
 * Runtime config model types.
 *
 * These describe endpoint/config reconciliation state and should stay separate
 * from container/orchestrator driver types.
 */

export interface ProtocolAdapterDevice {
	id: string;
	uuid?: string;
	name: string;
	protocol: string;
	connectionString: string;
	pollInterval: number;
	enabled: boolean;
	metadata?: Record<string, any>;
	dataPoints?: any[];
}

export interface IotisticaPublishingConfig {
	target: 'iotistica';
}

export interface AzurePublishingConfig {
	target: 'azure';
	azure: {
		connectionString: string;
	};
}

export type PublishingConfig = IotisticaPublishingConfig | AzurePublishingConfig;

export interface DeviceConfig {
	endpoints?: ProtocolAdapterDevice[];
	features?: Record<string, any>;
	publishing?: PublishingConfig;
	[key: string]: any;
}

export interface ConfigStep {
	action: 'registerDevice' | 'unregisterDevice' | 'updateDevice';
	device?: ProtocolAdapterDevice;
	deviceId?: string;
}

export interface ConfigReconciliationResult {
	success: boolean;
	devicesRegistered: number;
	devicesUpdated: number;
	devicesUnregistered: number;
	errors: Array<{
		deviceId: string;
		error: string;
	}>;
	timestamp: Date;
}