/**
 * Test Fixtures for Agent State Synchronization
 * ==============================================
 * 
 * Reusable factory functions for creating test data.
 * Inspired by balena-supervisor testing patterns.
 * 
 * Usage:
 *   const response = createMockTargetStateResponse();
 *   const agentInfo = createmockAgentInfo({ provisioned: false });
 */

import type { DeviceState } from '../../src/orchestrator/state-reconciler';

// ============================================================================
// TYPE DEFINITIONS (matching sync-state.ts)
// ============================================================================

export interface TargetStateResponse {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number;
		needs_deployment?: boolean;
		last_deployed_at?: string;
	};
}

export interface DeviceStateReport {
	[deviceUuid: string]: {
		apps: { [appId: string]: any };
		config?: { [key: string]: any };
		version?: number;
		cpu_usage?: number;
		memory_usage?: number;
		memory_total?: number;
		storage_usage?: number;
		storage_total?: number;
		temperature?: number;
		is_online?: boolean;
		local_ip?: string;
		os_version?: string;
		agent_version?: string;
		uptime?: number;
	};
}

export interface MockAgentInfo {
	uuid: string;
	provisioned: boolean;
	apiKey: string;        // Device-specific API key
	osVersion: string;
	agentVersion: string;
}

// ============================================================================
// TARGET STATE FIXTURES (API Responses)
// ============================================================================

/**
 * Create a complete mock target state response from the API
 * This is what the cloud returns when you poll /state endpoint
 * 
 * @example
 * const response = createMockTargetStateResponse();
 * const customResponse = createMockTargetStateResponse('device-uuid-456', { version: 2 });
 */
export const createMockTargetStateResponse = (
	deviceUuid: string = 'device-uuid-123',
	overrides?: Partial<TargetStateResponse[string]>
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {},
		config: {
			logging: { level: 'info', enabled: true },
			sensors: [],
			features: { enableModbus: false, enableMqtt: true },
			settings: { timezone: 'UTC', language: 'en' }
		},
		version: 1,
		needs_deployment: false,
		...overrides
	}
});

/**
 * Create minimal target state (only required fields)
 * Useful for testing graceful handling of missing optional fields
 */
export const createMinimalTargetState = (
	deviceUuid: string = 'device-uuid-123'
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {},
		config: {}
	}
});

/**
 * Create target state with apps
 * Useful for testing container orchestration
 */
export const createTargetStateWithApps = (
	deviceUuid: string = 'device-uuid-123'
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {
			'1001': {
				appId: '1001',
				appName: 'test-app',
				services: [
					{
						serviceId: '1',
						serviceName: 'web',
						imageName: 'nginx:latest',
						status: 'running',
						config: {
							image: 'nginx:latest',
							ports: ['80:80'],
							restart: 'unless-stopped',
							networks: ['default'],
							labels: {}
						}
					}
				]
			}
		},
		config: {
			logging: { level: 'info' },
			sensors: []
		},
		version: 1
	}
});

/**
 * Create target state with sensors
 * Useful for testing sensor configuration management
 */
export const createTargetStateWithSensors = (
	deviceUuid: string = 'device-uuid-123',
	sensorCount: number = 3
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {},
		config: {
			logging: { level: 'debug' },
			sensors: Array.from({ length: sensorCount }, (_, i) => ({
				id: i + 1,
				name: `sensor-${i + 1}`,
				type: 'temperature',
				enabled: true,
				pollInterval: 5000
			})),
			features: { enableModbus: true },
			settings: { timezone: 'America/New_York' }
		},
		version: 1
	}
});

/**
 * Create target state with partial config (missing some fields)
 * Useful for testing the bug where only 2 of 4 config fields are present
 */
export const createTargetStateWithPartialConfig = (
	deviceUuid: string = 'device-uuid-123'
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {},
		config: {
			logging: { level: 'info' },
			sensors: []
			// features and settings intentionally missing
		},
		version: 1
	}
});

/**
 * Create target state for version testing
 */
export const createTargetStateWithVersion = (
	version: number,
	deviceUuid: string = 'device-uuid-123'
): TargetStateResponse => ({
	[deviceUuid]: {
		apps: {},
		config: {
			logging: { level: 'info' },
			sensors: []
		},
		version
	}
});

// ============================================================================
// DEVICE STATE FIXTURES (Internal State)
// ============================================================================

/**
 * Create a device state object (what stateReconciler.setTarget receives)
 * 
 * @example
 * const state = createMockDeviceState();
 * const stateWithApps = createMockDeviceState({ apps: { '1001': {...} } });
 */
export const createMockDeviceState = (
	overrides?: Partial<DeviceState>
): DeviceState => ({
	apps: {},
	config: {
		logging: { level: 'info' },
		sensors: [],
		features: { enableModbus: false },
		settings: { timezone: 'UTC' }
	},
	...overrides
});

/**
 * Create empty device state
 * Useful for testing first boot scenario
 */
export const createEmptyDeviceState = (): DeviceState => ({
	apps: {},
	config: {}
});

/**
 * Create device state with only sensors
 * Useful for testing config merging
 */
export const createDeviceStateWithOnlySensors = (): DeviceState => ({
	apps: {},
	config: {
		sensors: [
			{ 
				id: '1', 
				name: 'sensor-1', 
				protocol: 'modbus', 
				connectionString: 'tcp://192.168.1.100:502',
				pollInterval: 1000,
				enabled: true 
			}
		]
	}
});

// ============================================================================
// DEVICE INFO FIXTURES (Device Manager)
// ============================================================================

/**
 * Create mock device info (what deviceManager.getAgentInfo returns)
 * 
 * @example
 * const agentInfo = createmockAgentInfo();
 * const unprovisionedDevice = createmockAgentInfo({ provisioned: false });
 */
export const createMockAgentInfo = (
	overrides?: Partial<MockAgentInfo>
): MockAgentInfo => ({
	uuid: 'device-uuid-123',
	provisioned: true,
	apiKey: 'test-api-key-abc123',
	osVersion: 'Debian 11',
	agentVersion: '1.0.0',
	...overrides
});

/**
 * Create unprovisioned device info
 * Useful for testing provisioning flow
 */
export const createUnprovisionedAgentInfo = (): MockAgentInfo => ({
	uuid: 'device-uuid-123',
	provisioned: false,
	apiKey: '',
	osVersion: 'Debian 11',
	agentVersion: '1.0.0'
});

// ============================================================================
// HTTP RESPONSE FIXTURES (fetch mocking)
// ============================================================================

/**
 * Create a successful fetch response
 * 
 * @example
 * const response = createMockFetchResponse({ apps: {}, config: {} });
 * const responseWithEtag = createMockFetchResponse(body, { etag: 'abc123' });
 */
export const createMockFetchResponse = (
	body: any,
	options?: {
		status?: number;
		statusText?: string;
		etag?: string;
	}
): Partial<Response> => ({
	ok: options?.status ? options.status >= 200 && options.status < 300 : true,
	status: options?.status || 200,
	statusText: options?.statusText || 'OK',
	headers: {
		get: (name: string) => {
			if (name.toLowerCase() === 'etag' && options?.etag) {
				return options.etag;
			}
			return null;
		}
	} as any,
	json: async () => body
});

/**
 * Create a 304 Not Modified response
 * Useful for testing ETag caching
 */
export const createNotModifiedResponse = (): Partial<Response> => ({
	ok: false,
	status: 304,
	statusText: 'Not Modified',
	headers: {
		get: () => null
	} as any,
	json: async () => ({})
});

/**
 * Create a 500 Server Error response
 * Useful for testing error handling
 */
export const createServerErrorResponse = (): Partial<Response> => ({
	ok: false,
	status: 500,
	statusText: 'Internal Server Error',
	headers: {
		get: () => null
	} as any,
	json: async () => ({ error: 'Server error' })
});

/**
 * Create a 404 Not Found response
 * Useful for testing missing device scenarios
 */
export const createNotFoundResponse = (): Partial<Response> => ({
	ok: false,
	status: 404,
	statusText: 'Not Found',
	headers: {
		get: () => null
	} as any,
	json: async () => ({ error: 'Device not found' })
});

/**
 * Create a timeout error (AbortError)
 * Useful for testing timeout handling
 */
export const createTimeoutError = (): Error => {
	const error = new Error('The operation was aborted');
	error.name = 'AbortError';
	return error;
};

/**
 * Create a network error
 * Useful for testing network failure scenarios
 */
export const createNetworkError = (): Error => {
	return new Error('Network request failed');
};

// ============================================================================
// STATE REPORT FIXTURES (Reporting)
// ============================================================================

/**
 * Create a device state report (what gets sent to cloud)
 * 
 * @example
 * const report = createMockStateReport();
 * const reportWithMetrics = createMockStateReport('device-uuid-123', true);
 */
export const createMockStateReport = (
	deviceUuid: string = 'device-uuid-123',
	includeMetrics: boolean = false
): DeviceStateReport => {
	const baseReport: DeviceStateReport = {
		[deviceUuid]: {
			apps: {},
			config: {
				logging: { level: 'info' },
				sensors: []
			},
			is_online: true,
			version: 1,
			os_version: 'Debian 11',
			agent_version: '1.0.0'
		}
	};

	if (includeMetrics) {
		return {
			[deviceUuid]: {
				...baseReport[deviceUuid],
				cpu_usage: 45.2,
				memory_usage: 1024,
				memory_total: 4096,
				storage_usage: 10240,
				storage_total: 32768,
				temperature: 55.5,
				uptime: 86400,
				local_ip: '192.168.1.100'
			}
		};
	}

	return baseReport;
};

// ============================================================================
// SCENARIO-BASED FIXTURES (Complete Test Scenarios)
// ============================================================================

/**
 * Scenario: First boot (no previous state)
 * Device starts up for the first time and receives initial config
 */
export const createFirstBootScenario = () => ({
	agentInfo: createMockAgentInfo(),
	targetState: createMockTargetStateResponse(),
	previousState: createEmptyDeviceState()
});

/**
 * Scenario: Config update (sensors added)
 * Device receives new sensor configuration
 */
export const createConfigUpdateScenario = () => ({
	agentInfo: createMockAgentInfo(),
	previousState: createMockDeviceState(),
	newTargetState: createTargetStateWithSensors('device-uuid-123', 5)
});

/**
 * Scenario: Version increment
 * Target state version changes from 1 to 2
 */
export const createVersionIncrementScenario = () => ({
	agentInfo: createMockAgentInfo(),
	previousVersion: 1,
	newVersion: 2,
	targetStateV1: createTargetStateWithVersion(1),
	targetStateV2: createTargetStateWithVersion(2)
});

/**
 * Scenario: Network failure
 * Device cannot reach cloud API
 */
export const createNetworkFailureScenario = () => ({
	agentInfo: createMockAgentInfo(),
	error: createNetworkError(),
	expectedBackoff: 15000 // 15 seconds
});

/**
 * Scenario: Unprovisioned device
 * Device has not completed provisioning yet
 */
export const createUnprovisionedScenario = () => ({
	agentInfo: createUnprovisionedAgentInfo(),
	shouldSkipPoll: true,
	shouldSkipReport: true
});

/**
 * Scenario: ETag cached (304 Not Modified)
 * Subsequent poll returns 304 with same ETag
 */
export const createETagCachedScenario = () => ({
	agentInfo: createMockAgentInfo(),
	firstResponse: createMockFetchResponse(
		createMockTargetStateResponse(),
		{ etag: 'abc123' }
	),
	secondResponse: createNotModifiedResponse(),
	etag: 'abc123'
});

/**
 * Scenario: Partial config received (reproduces the bug)
 * API returns only 2 of 4 config fields
 */
export const createPartialConfigScenario = () => ({
	agentInfo: createMockAgentInfo(),
	targetState: createTargetStateWithPartialConfig(),
	expectedConfigKeys: ['logging', 'sensors'], // Only these 2 fields
	missingConfigKeys: ['features', 'settings'] // These 2 should be missing
});

/**
 * Scenario: Complete config received (expected behavior)
 * API returns all 4 config fields
 */
export const createCompleteConfigScenario = () => ({
	agentInfo: createMockAgentInfo(),
	targetState: createMockTargetStateResponse(),
	expectedConfigKeys: ['logging', 'sensors', 'features', 'settings'] // All 4 fields
});
