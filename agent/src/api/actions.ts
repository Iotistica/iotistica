/**
 * Device API Actions
 * Core actions for device management
 */

import ContainerManager from '../docker/container-manager';
import type { DeviceManager } from '../managers';
import type { CloudSync } from '../cloud-sync';
import type { AgentLogger } from '../logging/agent-logger';
import type { AnomalyDetectionService } from '../anomaly';
import type { SimulationOrchestrator } from '../anomaly/simulator';
import type { SensorsFeature } from '../features/adapters';
import { LogComponents } from '../logging/types';
import type { HealthReport } from '../health/health-arbiter';
import { MessageBufferModel } from '../db/models/buffer.model';
import { CloudMqttClient } from '../mqtt/manager';

let containerManager: ContainerManager;
let deviceManager: DeviceManager;
let cloudSync: CloudSync | undefined;
let logger: AgentLogger | undefined;
let anomalyService: AnomalyDetectionService | undefined;
let simulationOrchestrator: SimulationOrchestrator | undefined;
let sensorsFeature: SensorsFeature | undefined;
let discoveryService: import('../features/adapters/discovery-service').DiscoveryService | undefined;
let agentInstance: any | undefined;
let healthReporter: (() => HealthReport) | undefined;

export function setAgent(agent: any): void {
	agentInstance = agent;
}

export function getAgent(): any {
	if (!agentInstance) {
		throw new Error('Agent not initialized');
	}
	return agentInstance;
}

function getLifecycleStateSafe(): string {
	return agentInstance?.getLifecycleState?.() ?? 'UNKNOWN';
}

function getReadinessSafe(): boolean {
	return agentInstance?.isFullyOperational?.() ?? false;
}

function getHealthReportSafe(): HealthReport | undefined {
	try {
		return healthReporter?.();
	} catch {
		return undefined;
	}
}

export function setHealthReporter(reporter?: () => HealthReport): void {
	healthReporter = reporter;
}

export function getHealthPayload(isHealthy: boolean): {
	status: 'healthy' | 'unhealthy';
	ready: boolean;
	state: string;
	criticalFailures?: string[];
	unhealthySubsystems?: string[];
} {
	const report = getHealthReportSafe();
	const unhealthySubsystems = report?.unhealthySubsystems || [];
	const criticalFailures = report?.criticalFailures || [];

	return {
		status: isHealthy ? 'healthy' : 'unhealthy',
		ready: getReadinessSafe(),
		state: getLifecycleStateSafe(),
		...(criticalFailures.length > 0 ? { criticalFailures } : {}),
		...(unhealthySubsystems.length > 0 ? { unhealthySubsystems } : {}),
	};
}

export function getReadinessPayload(): {
	ready: boolean;
	state: string;
	criticalFailures?: string[];
} {
	const report = getHealthReportSafe();
	const criticalFailures = report?.criticalFailures || [];

	return {
		ready: getReadinessSafe(),
		state: getLifecycleStateSafe(),
		...(criticalFailures.length > 0 ? { criticalFailures } : {}),
	};
}

export function getHealthReportPayload(): {
	overall: 'healthy' | 'unhealthy';
	ready: boolean;
	state: string;
	report: HealthReport;
} {
	const report =
		getHealthReportSafe() ||
		({
			overall: false,
			subsystems: [],
			unhealthySubsystems: [],
			criticalFailures: [],
		} as HealthReport);

	return {
		overall: report.overall ? 'healthy' : 'unhealthy',
		ready: getReadinessSafe(),
		state: getLifecycleStateSafe(),
		report,
	};
}

export async function getBufferStatusPayload(): Promise<{
	mode: 'standalone' | 'provisioned-online' | 'provisioned-degraded-offline';
	cloudReportQueueCount: number;
	cloudReportOldestAge?: number;
	transportPublishMode?: 'direct' | 'buffer-only' | 'recovering';
	mqttMessageBufferCount: number;
	mqttBufferBytes: number;
	mqttBufferOldestAge?: number;
	lastFlushAttempt?: string;
	lastFlushSuccess?: string;
	agentLogBufferEnabled: boolean;
	agentLogBufferLogs?: number;
	agentLogBufferBytes?: number;
	agentLogPendingBatches?: number;
	agentLogDroppedTotal?: number;
	agentLogCircuitOpen?: boolean;
	agentLogLastFlushAttempt?: string;
	agentLogLastFlushSuccess?: string;
	agentLogLastFlushError?: string;
}> {
	const info = deviceManager.getDeviceInfo();
	const mqttConnected = CloudMqttClient.getInstance().isConnected();
	const cloudOnline = cloudSync?.isOnline() === true;
	const mqttStats = MessageBufferModel.getStats();
	const defaultCloudStats: {
		cloudReportQueueCount: number;
		cloudReportOldestAge?: number;
		transportPublishMode?: 'direct' | 'buffer-only' | 'recovering';
		lastFlushAttempt?: string;
		lastFlushSuccess?: string;
	} = {
		cloudReportQueueCount: 0,
	};
	const cloudStats = cloudSync
		? await cloudSync.getBufferStatus()
		: defaultCloudStats;

	const mode = !info.provisioned
		? 'standalone'
		: (mqttConnected || cloudOnline ? 'provisioned-online' : 'provisioned-degraded-offline');

	const cloudLogBackend = (logger?.getBackends?.() || []).find((backend: any) => {
		if (!backend || typeof backend.getMetrics !== 'function') {
			return false;
		}
		return backend?.constructor?.name === 'CloudLogBackend' || 'pendingBatches' in (backend.getMetrics() || {});
	}) as any;

	const cloudLogMetrics = cloudLogBackend?.getMetrics?.();

	return {
		mode,
		cloudReportQueueCount: cloudStats.cloudReportQueueCount,
		...(cloudStats.cloudReportOldestAge !== undefined ? { cloudReportOldestAge: cloudStats.cloudReportOldestAge } : {}),
		...(cloudStats.transportPublishMode ? { transportPublishMode: cloudStats.transportPublishMode } : {}),
		mqttMessageBufferCount: mqttStats.current_count,
		mqttBufferBytes: mqttStats.current_bytes,
		...(mqttStats.oldest_record_age_hours !== undefined ? { mqttBufferOldestAge: mqttStats.oldest_record_age_hours } : {}),
		...(cloudStats.lastFlushAttempt ? { lastFlushAttempt: cloudStats.lastFlushAttempt } : {}),
		...(cloudStats.lastFlushSuccess ? { lastFlushSuccess: cloudStats.lastFlushSuccess } : {}),
		agentLogBufferEnabled: !!cloudLogMetrics,
		...(cloudLogMetrics ? {
			agentLogBufferLogs: cloudLogMetrics.bufferLogs,
			agentLogBufferBytes: cloudLogMetrics.bufferBytes,
			agentLogPendingBatches: cloudLogMetrics.pendingBatches,
			agentLogDroppedTotal: cloudLogMetrics.droppedTotal,
			agentLogCircuitOpen: cloudLogMetrics.circuitOpen === 1,
			...(cloudLogMetrics.lastFlushAttemptAt ? { agentLogLastFlushAttempt: cloudLogMetrics.lastFlushAttemptAt } : {}),
			...(cloudLogMetrics.lastFlushSuccessAt ? { agentLogLastFlushSuccess: cloudLogMetrics.lastFlushSuccessAt } : {}),
			...(cloudLogMetrics.lastFlushError ? { agentLogLastFlushError: cloudLogMetrics.lastFlushError } : {}),
		} : {}),
	};
}

export function initialize(
	cm: ContainerManager, 
	dm: DeviceManager, 
	ab?: CloudSync, 
	agentLogger?: AgentLogger,
	anomaly?: AnomalyDetectionService,
	simulation?: SimulationOrchestrator
) {
	containerManager = cm;
	deviceManager = dm;
	cloudSync = ab;
	logger = agentLogger;
	anomalyService = anomaly;
	simulationOrchestrator = simulation;
}

/**
 * Set sensors feature (called by agent after initialization)
 */
export function setSensorsFeature(feature: SensorsFeature | undefined) {
	sensorsFeature = feature;
}

/**
 * Get sensors feature (for accessing protocol adapters)
 */
export function getSensorsFeature(): SensorsFeature | undefined {
	return sensorsFeature;
}

/**
 * Get anomaly detection service (for testing endpoints)
 */
export function getAnomalyService(): AnomalyDetectionService | undefined {
	return anomalyService;
}

/**
 * Get simulation orchestrator (for testing endpoints)
 */
export function getSimulationOrchestrator(): SimulationOrchestrator | undefined {
	return simulationOrchestrator;
}

/**
 * Set discovery service (called by agent after initialization)
 */
export function setDiscoveryService(service: import('../features/adapters/discovery-service').DiscoveryService | undefined) {
	discoveryService = service;
}

/**
 * Get discovery service (for accessing discovery functionality)
 */
export function getDiscoveryService(): import('../features/adapters/discovery-service').DiscoveryService | undefined {
	return discoveryService;
}

/**
 * Run an array of healthchecks, outputting whether all passed or not
 * Used by: GET /v1/healthy
 */
export const runHealthchecks = async (
	healthchecks: Array<() => Promise<boolean>>,
): Promise<boolean> => {
	const HEALTHCHECK_FAILURE = 'Healthcheck failed';

	try {
		const checks = await Promise.all(healthchecks.map((fn) => fn()));
		if (checks.some((check) => !check)) {
			throw new Error(HEALTHCHECK_FAILURE);
		}
	} catch (error) {
		logger?.errorSync(HEALTHCHECK_FAILURE, error instanceof Error ? error : new Error(String(error)), {
			component: LogComponents.agent
		});
		return false;
	}

	return true;
};

/**
 * Restarts an application by recreating containers
 * Used by: POST /v1/apps/:appId/restart
 */
export const restartApp = async (appId: number, force: boolean = false) => {
	const currentState = await containerManager.getCurrentState();
	const app = currentState.apps[appId];
	
	if (!app) {
		throw new Error(`Application with ID ${appId} not found`);
	}

	// Get target state and update it
	const targetState = containerManager.getTargetState();
	if (!targetState.apps[appId]) {
		throw new Error(`Application ${appId} not in target state`);
	}

	// Trigger reconciliation
	await containerManager.applyTargetState();
};

/**
 * Stops a service
 * Used by: POST /v1/apps/:appId/stop
 */
export const stopService = async (appId: number, serviceName?: string, force: boolean = false) => {
	const currentState = await containerManager.getCurrentState();
	const app = currentState.apps[appId];
	
	if (!app) {
		throw new Error(`Application with ID ${appId} not found`);
	}

	// For single-container apps, stop the first service
	const service = serviceName 
		? app.services.find(s => s.serviceName === serviceName)
		: app.services[0];

	if (!service) {
		throw new Error(`Service not found`);
	}

	// Stop the container
	if (service.containerId) {
		const docker = containerManager.getDocker();
		if (docker) {
			const container = docker.getContainer(service.containerId);
			await container.stop();
		}
	}

	return service;
};

/**
 * Starts a service
 * Used by: POST /v1/apps/:appId/start
 */
export const startService = async (appId: number, serviceName?: string, force: boolean = false) => {
	const currentState = await containerManager.getCurrentState();
	const app = currentState.apps[appId];
	
	if (!app) {
		throw new Error(`Application with ID ${appId} not found`);
	}

	// For single-container apps, start the first service
	const service = serviceName 
		? app.services.find(s => s.serviceName === serviceName)
		: app.services[0];

	if (!service) {
		throw new Error(`Service not found`);
	}

	// Start the container
	if (service.containerId) {
		const docker = containerManager.getDocker();
		if (docker) {
			const container = docker.getContainer(service.containerId);
			await container.start();
		}
	}

	return service;
};

/**
 * Get application information for a single-container app
 * Used by: GET /v1/apps/:appId
 */
export const getApp = async (appId: number) => {
	const currentState = await containerManager.getCurrentState();
	const app = currentState.apps[appId];
	
	if (!app) {
		throw new Error('App not found');
	}

	const service = app.services[0];
	if (!service) {
		throw new Error('App has no services');
	}

	return {
		appId,
		appName: app.appName,
		containerId: service.containerId,
		serviceName: service.serviceName,
		imageName: service.imageName,
		status: service.status,
		config: service.config,
	};
};

/**
 * Get device state information
 * Used by: GET /v1/device
 */
export const getDeviceState = async () => {
	const deviceInfo = deviceManager.getDeviceInfo();
	const currentState = await containerManager.getCurrentState();
	const isOnline = cloudSync?.isOnline?.() ?? false;
	
	return {
		...deviceInfo,
		apps: Object.keys(currentState.apps).length,
		is_online: isOnline,
		status: 'Idle',
	};
};

/**
 * Purge volumes for an application
 * Used by: POST /v1/apps/:appId/purge
 */
export const purgeApp = async (appId: number, force: boolean = false) => {
	const currentState = await containerManager.getCurrentState();
	const app = currentState.apps[appId];
	
	if (!app) {
		throw new Error(`Application with ID ${appId} not found`);
	}

	logger?.infoSync('Purging data for app', {
		component: LogComponents.agent,
		appId
	});

	// Remove app from target state
	const targetState = containerManager.getTargetState();
	delete targetState.apps[appId];
	await containerManager.setTarget(targetState);

	// Apply changes
	await containerManager.applyTargetState();

	// Restore app to target state
	targetState.apps[appId] = app;
	await containerManager.setTarget(targetState);
	
	logger?.infoSync('Purge complete for app', {
		component: LogComponents.agent,
		appId
	});
};

/**
 * Get connection health status
 * Used by: GET /v2/connection/health
 */
export const getConnectionHealth = async () => {
	if (!cloudSync) {
		return {
			status: 'offline',
			message: 'API binder not initialized',
		};
	}
	
	return cloudSync.getConnectionHealth();
};

/**
 * Provision device with provisioning key
 * Used by: POST /v1/provision
 */
export const provisionDevice = async (config: {
	provisioningApiKey: string;
	deviceName?: string;
	deviceType?: string;
	apiEndpoint?: string;
	applicationId?: number;
}) => {
	logger?.infoSync('Provisioning device', {
		component: LogComponents.deviceManager,
		operation: 'provision',
		deviceName: config.deviceName,
		apiEndpoint: config.apiEndpoint
	});

	const result = await deviceManager.provision(config);
	
	logger?.infoSync('Agent provisioned successfully', {
		component: LogComponents.deviceManager,
		operation: 'provision',
		uuid: result.uuid,
		provisioned: result.provisioned
	});

	return {
		success: true,
		device: {
			uuid: result.uuid,
			deviceName: result.deviceName,
			provisioned: result.provisioned,
			mqttBrokerUrl: result.mqttBrokerConfig ? `${result.mqttBrokerConfig.protocol}://${result.mqttBrokerConfig.host}:${result.mqttBrokerConfig.port}` : undefined
		}
	};
};

/**
 * Get provisioning status
 * Used by: GET /v1/provision/status
 */
export const getProvisionStatus = async () => {
	const deviceInfo = deviceManager.getDeviceInfo();
	
	return {
		provisioned: deviceInfo.provisioned,
		uuid: deviceInfo.uuid,
		deviceName: deviceInfo.deviceName,
		apiEndpoint: deviceInfo.apiEndpoint,
		hasProvisioningKey: !!deviceInfo.provisioningApiKey,
		mqttConfigured: !!(deviceInfo.mqttBrokerConfig?.username && deviceInfo.mqttBrokerConfig?.password),
		mqttBrokerUrl: deviceInfo.mqttBrokerConfig 
			? `${deviceInfo.mqttBrokerConfig.protocol}://${deviceInfo.mqttBrokerConfig.host}:${deviceInfo.mqttBrokerConfig.port}` 
			: undefined
	};
};

/**
 * Deprovision device
 * Used by: POST /v1/deprovision
 */
export const deprovisionDevice = async () => {
	logger?.infoSync('Deprovisioning device', {
		component: LogComponents.deviceManager,
		operation: 'deprovision'
	});

	await deviceManager.reset();
	
	logger?.infoSync('Device deprovisioned successfully', {
		component: LogComponents.deviceManager,
		operation: 'deprovision'
	});
};

/**
 * Get all configured endpoints/sensors
 * Used by: GET /v1/endpoints
 */
export const getEndpoints = async (protocol?: string) => {
	const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
	const endpoints = await EndpointModel.getAll(protocol);
	return endpoints;
};

/**
 * Get all protocol devices from the devices table
 * Used by: GET /v1/devices
 */
export const getDevices = async (protocol?: string) => {
	const { DeviceModel } = await import('../db/models/device.model.js');
	return await DeviceModel.getAll(protocol);
};

/**
 * Factory reset device - complete data wipe
 * Used by: POST /v1/factory-reset
 */
export const factoryResetDevice = async () => {
	logger?.warnSync('Factory reset requested', {
		component: LogComponents.deviceManager,
		operation: 'factoryReset',
		warning: 'This will delete all apps, services, and data'
	});

	await deviceManager.factoryReset();
	
	logger?.warnSync('Factory reset completed', {
		component: LogComponents.deviceManager,
		operation: 'factoryReset'
	});
};

/**
 * Run device discovery
 * @param options Discovery options
 * @returns Array of discovered devices
 */
export async function runDiscovery(options: {
	trigger: 'manual' | 'first_boot' | 'scheduled' | 'config-change';
	protocols?: string[];
	validate?: boolean;
	forceRun?: boolean;
}): Promise<any[]> {
	if (!discoveryService) {
		throw new Error('DiscoveryService not initialized');
	}
	// Cast protocols to the proper type expected by DiscoveryService
	const discoveryOptions = {
		...options,
		protocols: options.protocols as any
	};
	return discoveryService.runDiscovery(discoveryOptions);
}
