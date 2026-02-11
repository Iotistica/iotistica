/**
 * Device API Actions
 * Core actions for device management
 */

import ContainerManager from '../compose/container-manager';
import type { DeviceManager } from '../device-manager';
import type { CloudSync } from '../device-manager/sync';
import type { AgentLogger } from '../logging/agent-logger';
import type { AnomalyDetectionService } from '../ai/anomaly';
import type { SimulationOrchestrator } from '../simulation';
import type { SensorsFeature } from '../features/endpoints';
import { LogComponents } from '../logging/types';

let containerManager: ContainerManager;
let deviceManager: DeviceManager;
let cloudSync: CloudSync | undefined;
let logger: AgentLogger | undefined;
let anomalyService: AnomalyDetectionService | undefined;
let simulationOrchestrator: SimulationOrchestrator | undefined;
let sensorsFeature: SensorsFeature | undefined;
let discoveryService: import('../features/discovery/discovery-service').DiscoveryService | undefined;
let agentInstance: any | undefined;

export function setAgent(agent: any): void {
	agentInstance = agent;
}

export function getAgent(): any {
	if (!agentInstance) {
		throw new Error('Agent not initialized');
	}
	return agentInstance;
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
export function setDiscoveryService(service: import('../features/discovery/discovery-service').DiscoveryService | undefined) {
	discoveryService = service;
}

/**
 * Get discovery service (for accessing discovery functionality)
 */
export function getDiscoveryService(): import('../features/discovery/discovery-service').DiscoveryService | undefined {
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
	
	return {
		...deviceInfo,
		apps: Object.keys(currentState.apps).length,
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
	
	logger?.infoSync('Device provisioned successfully', {
		component: LogComponents.deviceManager,
		operation: 'provision',
		uuid: result.uuid,
		deviceId: result.deviceId,
		provisioned: result.provisioned
	});

	return {
		success: true,
		device: {
			uuid: result.uuid,
			deviceId: result.deviceId,
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
		deviceId: deviceInfo.deviceId,
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
	const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
	const endpoints = await DeviceEndpointModel.getAll(protocol);
	return endpoints;
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
