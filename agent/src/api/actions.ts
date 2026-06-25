/**
 * Agent API Actions
 * Core actions for agent management
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import type ContainerManager from '../containers/container-manager';
import type { AgentManager } from '../core/index.js';
import type { CloudSync } from '../sync';
import type { AgentLogger } from '../logging/agent-logger';
import type { LocalLogBackend } from '../logging/local-backend';
import type { AnomalyDetectionService } from '../anomaly';
import type { SimulationOrchestrator } from '../anomaly/simulator';
import type { AdapterManager } from '../plugins';
import type { ConfigManager } from '../core/config';
import type { StateManager } from '../core/state';
import { LogComponents } from '../logging/types';
import type { HealthReport } from '../health/arbiter';
import { MessageBufferModel } from '../db/models/buffer.model';
import { PublishDestinationsModel, PublishSubscriptionsModel } from '../db/models/index.js';
import { getDatabasePath } from '../db/db-path';
import { getDatabase } from '../db/sqlite';
import { CloudMqttClient } from '../mqtt/manager';
import { encodeIfUuid } from '../mqtt/codec';
import type { AgentUpdater } from '../updater';
import type { DiscoveryService } from '../discovery/service';
import type { OPCUABrowseRequest } from '../plugins/opcua/discovery';
import { TailscaleManager } from '../network/vpn/tailscale-manager';
import type { TailscaleConfig, TailscaleStatus } from '../network/vpn/tailscale-manager';
import type { DevicePublish } from '../publish/index.js';
import type { DiscoveryRulesScheduler } from '../discovery/rules-scheduler.js';
import type { DockerOptions } from 'dockerode';

type AgentInstance = {
	getLifecycleState: () => string;
	isFullyOperational: () => boolean;
	restartServices: () => Promise<void>;
};

let containerManager: ContainerManager;
let agentManager: AgentManager;
let cloudSync: CloudSync | undefined;
let logger: AgentLogger | undefined;
let anomalyService: AnomalyDetectionService | undefined;
let simulationOrchestrator: SimulationOrchestrator | undefined;
let adapterManager: AdapterManager | undefined;
let configManager: ConfigManager | undefined;
let stateManager: StateManager | undefined;
let discoveryService: DiscoveryService | undefined;
let agentInstance: AgentInstance | undefined;
let healthReporter: (() => HealthReport) | undefined;
let agentUpdater: AgentUpdater | undefined;
let tailscaleManager: TailscaleManager | null = null;
let devicePublish: DevicePublish | undefined;
let discoveryRulesScheduler: DiscoveryRulesScheduler | undefined;
let localLogBackend: LocalLogBackend | undefined;

export function setDevicePublish(dp: DevicePublish | undefined): void {
	devicePublish = dp;
}

export function setDiscoveryRulesScheduler(s: DiscoveryRulesScheduler | undefined): void {
	discoveryRulesScheduler = s;
}

export function setAgent(agent: AgentInstance): void {
	agentInstance = agent;
}

export function getAgent(): AgentInstance {
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
	const info = agentManager.getAgentInfo();
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
	dm: AgentManager, 
	ab?: CloudSync, 
	agentLogger?: AgentLogger,
	anomaly?: AnomalyDetectionService,
	simulation?: SimulationOrchestrator
) {
	containerManager = cm;
	agentManager = dm;
	cloudSync = ab;
	logger = agentLogger;
	anomalyService = anomaly;
	simulationOrchestrator = simulation;
}

/**
 * Initialize VPN actions with logger.
 */
export function initVpnActions(agentLogger?: AgentLogger): void {
	if (agentLogger) {
		logger = agentLogger;
	}
	tailscaleManager = new TailscaleManager(logger);
}

/**
 * Connect to Tailscale VPN.
 */
export async function connectTailscale(config: TailscaleConfig): Promise<{ success: boolean; status: TailscaleStatus }> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	logger?.infoSync('Connecting to Tailscale VPN via API...', {
		component: LogComponents.deviceApi,
		tailnet: config.tailnetName,
		hostname: config.hostname,
	});

	try {
		await tailscaleManager.configure(config);
		const status = await tailscaleManager.getStatus();

		logger?.infoSync('Tailscale VPN connected via API', {
			component: LogComponents.deviceApi,
			tailnetIP: status.tailnetIP,
			hostname: status.hostname,
		});

		return { success: true, status };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to connect to Tailscale VPN via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Disconnect from Tailscale VPN.
 */
export async function disconnectTailscale(): Promise<{ success: boolean }> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	logger?.infoSync('Disconnecting from Tailscale VPN via API...', {
		component: LogComponents.deviceApi,
	});

	try {
		await tailscaleManager.disconnect();

		logger?.infoSync('Tailscale VPN disconnected via API', {
			component: LogComponents.deviceApi,
		});

		return { success: true };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to disconnect from Tailscale VPN via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Get Tailscale VPN status.
 */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.getStatus();
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to get Tailscale status via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Get Tailscale IP address.
 */
export async function getTailscaleIP(): Promise<string | null> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.getIP();
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to get Tailscale IP via API', err, {
			component: LogComponents.deviceApi,
		});
		throw err;
	}
}

/**
 * Ping another Tailscale node.
 */
export async function pingTailscaleNode(hostname: string, count: number = 3): Promise<boolean> {
	if (!tailscaleManager) {
		throw new Error('VPN actions not initialized');
	}

	try {
		return await tailscaleManager.ping(hostname, count);
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		logger?.errorSync('Failed to ping Tailscale node via API', err, {
			component: LogComponents.deviceApi,
			hostname,
		});
		throw err;
	}
}

/**
 * Set adapter manager (called by agent after initialization)
 */
export function setAdapterManager(feature: AdapterManager | undefined) {
	adapterManager = feature;
}

/**
 * Set config manager (called by agent after initialization)
 */
export function setConfigManager(cm: ConfigManager | undefined): void {
	configManager = cm;
}

/**
 * Set state manager (canonical target-state owner)
 */
export function setStateManager(sm: StateManager | undefined): void {
	stateManager = sm;
}

async function applyConfigUpdate(mutator: (config: Record<string, any>) => void): Promise<void> {
	if (stateManager) {
		const currentTarget = stateManager.getTargetState?.() ?? { apps: {}, config: {} };
		const nextConfig = { ...(currentTarget.config || {}) };

		// Merge any endpoints that exist in the DB but are missing from target state.
		// DiscoveryStore.save() writes to the endpoints table directly (bypassing
		// setTarget) so the target state can lag behind the DB.  Without this merge,
		// calling setTarget here would cause ConfigManager to unregister — and delete —
		// every endpoint that was discovered but not yet in the target state.
		try {
			const { EndpointModel } = await import('../db/models/endpoint.model.js');
			const dbEndpoints = await EndpointModel.getAll();
			const targetById = new Map<string, any>(
				(nextConfig.endpoints || []).map((e: any) => [e.uuid ?? e.id, e])
			);
			for (const ep of dbEndpoints) {
				const id = ep.uuid;
				if (id && !targetById.has(id)) targetById.set(id, ep);
			}
			if (targetById.size > 0) nextConfig.endpoints = Array.from(targetById.values());
		} catch {
			// non-fatal — if DB read fails, proceed with target state as-is
		}

		mutator(nextConfig);
		await stateManager.setTarget({
			apps: currentTarget.apps || {},
			config: nextConfig,
		});
		return;
	}

	if (!configManager) {
		throw new Error('Config manager not initialized');
	}

	const config = configManager.getTargetConfig() as Record<string, any>;
	mutator(config);
	await configManager.setTarget(config as any);
}

/**
 * Get adapter manager (for accessing protocol adapters)
 */
export function getAdapterManager(): AdapterManager | undefined {
	return adapterManager;
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
export function setDiscoveryService(service: DiscoveryService | undefined) {
	discoveryService = service;
}

/**
 * Get discovery service (for accessing discovery functionality)
 */
export function getDiscoveryService(): DiscoveryService | undefined {
	return discoveryService;
}

export function setUpdater(updater: AgentUpdater | undefined): void {
	agentUpdater = updater;
}

export function setLocalLogBackend(backend: LocalLogBackend | undefined): void {
	localLogBackend = backend;
}

export function getLocalLogBackend(): LocalLogBackend | undefined {
	return localLogBackend;
}

export async function triggerUpdate(targetVersion: string, force = false): Promise<void> {
	if (!agentUpdater) {
		throw new Error('Agent updater not available');
	}
	await agentUpdater.reconcileVersion({ targetVersion, force });
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
export const restartApp = async (appId: number, _force: boolean = false) => {
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
export const stopService = async (appId: number, serviceName?: string, _force: boolean = false) => {
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
export const startService = async (appId: number, serviceName?: string, _force: boolean = false) => {
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
 * Get agent state information
 * Used by: GET /v1/device
 */
export const getDeviceState = async () => {
	const agentInfo = agentManager.getAgentInfo();
	const currentState = await containerManager.getCurrentState();
	const isOnline = cloudSync?.isOnline?.() ?? false;
	
	return {
		...agentInfo,
		apps: Object.keys(currentState.apps).length,
		is_online: isOnline,
		status: 'Idle',
	};
};

/**
 * Purge volumes for an application
 * Used by: POST /v1/apps/:appId/purge
 */
export const purgeApp = async (appId: number, _force: boolean = false) => {
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
 * Resolve the containerId for a named service — used by the log streaming route
 */
export const getServiceContainerId = async (appId: number, serviceName: string): Promise<string | undefined> => {
	const currentState = await containerManager.getCurrentState();
	const app = (currentState.apps as any)[appId];
	const svc = (app?.services as any[] | undefined)?.find((s: any) => s.serviceName === serviceName);
	return svc?.containerId;
};

/**
 * Expose the Docker instance for streaming operations in routes
 */
export const getDockerInstance = () => containerManager.getDocker();

/**
 * List all apps merged from current + target state
 * Used by: GET /v1/apps
 */
export const getAllApps = async () => {
	const currentState = await containerManager.getCurrentState();
	const targetState = containerManager.getTargetState();

	const allIds = new Set([
		...Object.keys(currentState.apps).map(String),
		...Object.keys(targetState.apps ?? {}).map(String),
	]);

	const apps = [];
	for (const id of allIds) {
		const target = (targetState.apps ?? {} as Record<string, any>)[id as any];
		const current = (currentState.apps ?? {} as Record<string, any>)[id as any];
		const base = target ?? current;
		if (!base) continue;

		const services = (base.services as any[]).map((targetSvc: any) => {
			const cur = (current?.services as any[] | undefined)?.find(
				(s: any) => s.serviceName === targetSvc.serviceName,
			);
			return {
				...targetSvc,
				containerId: cur?.containerId ?? targetSvc.containerId,
				state: cur?.state ?? targetSvc.state,
				status: cur?.status ?? targetSvc.status,
				serviceStatus: cur?.serviceStatus ?? targetSvc.serviceStatus,
				error: cur?.error ?? targetSvc.error,
			};
		});

		apps.push({ appId: base.appId, appName: base.appName, services });
	}

	return apps;
};

/**
 * Deploy a new app (or update existing) by adding it to target state
 * Used by: POST /v1/apps
 */
export const deployApp = async (body: {
	appName: string;
	services: Array<{
		serviceName: string;
		imageName: string;
		state?: 'running' | 'stopped';
		config: {
			image: string;
			ports?: string[];
			environment?: Record<string, string>;
			volumes?: string[];
			restart?: string;
			labels?: Record<string, string>;
		};
	}>;
}) => {
	const targetState = containerManager.getTargetState();

	// Pick an appId: max existing + 1, or 1
	const existing = Object.keys(targetState.apps ?? {}).map(Number).filter(n => !isNaN(n));
	const appId = existing.length > 0 ? Math.max(...existing) + 1 : 1;

	const services = body.services.map((svc, idx) => ({
		serviceId: Date.now() + idx,
		serviceName: svc.serviceName,
		imageName: svc.imageName,
		appId,
		appName: body.appName,
		state: svc.state ?? 'running',
		config: { ...svc.config, image: svc.imageName },
	}));

	const newTargetState = {
		...targetState,
		apps: {
			...targetState.apps,
			[appId]: { appId, appName: body.appName, services },
		},
	};

	await containerManager.setTarget(newTargetState as any);
	return { appId, appName: body.appName };
};

/**
 * Add a service to an existing app's target state
 * Used by: POST /v1/apps/:appId/services
 */
export const addService = async (
	appId: number,
	svc: {
		serviceName: string;
		imageName: string;
		state?: 'running' | 'stopped';
		config: {
			image: string;
			ports?: string[];
			environment?: Record<string, string>;
			volumes?: string[];
			restart?: string;
		};
	},
) => {
	const targetState = containerManager.getTargetState();
	const app = (targetState.apps ?? {} as any)[appId];
	if (!app) throw new Error(`App ${appId} not found`);

	const newService = {
		serviceId: Date.now(),
		serviceName: svc.serviceName,
		imageName: svc.imageName,
		appId,
		appName: app.appName,
		state: svc.state ?? 'running',
		config: { ...svc.config, image: svc.imageName },
	};

	const updatedApp = { ...app, services: [...app.services, newService] };
	await containerManager.setTarget({
		...targetState,
		apps: { ...targetState.apps, [appId]: updatedApp },
	} as any);

	return newService;
};

/**
 * Update an existing service's config in target state
 * Used by: PUT /v1/apps/:appId/services/:serviceName
 */
export const updateService = async (
	appId: number,
	serviceName: string,
	svc: {
		serviceName?: string;
		imageName: string;
		state?: 'running' | 'stopped';
		config: {
			image: string;
			ports?: string[];
			environment?: Record<string, string>;
			volumes?: string[];
			restart?: string;
		};
	},
) => {
	const targetState = containerManager.getTargetState();
	const app = (targetState.apps ?? {} as any)[appId];
	if (!app) throw new Error(`App ${appId} not found`);

	const idx = (app.services as any[]).findIndex((s: any) => s.serviceName === serviceName);
	if (idx === -1) throw new Error(`Service "${serviceName}" not found in app ${appId}`);

	const existing = app.services[idx];
	const updated = {
		...existing,
		serviceName: svc.serviceName ?? existing.serviceName,
		imageName: svc.imageName,
		state: svc.state ?? existing.state,
		config: { ...svc.config, image: svc.imageName },
	};

	const updatedServices = [...app.services];
	updatedServices[idx] = updated;
	const updatedApp = { ...app, services: updatedServices };

	await containerManager.setTarget({
		...targetState,
		apps: { ...targetState.apps, [appId]: updatedApp },
	} as any);

	return updated;
};

/**
 * Remove a single service from an app's target state (stops + removes its container)
 * Used by: DELETE /v1/apps/:appId/services/:serviceName
 */
export const removeService = async (appId: number, serviceName: string) => {
	const targetState = containerManager.getTargetState();
	const app = (targetState.apps ?? {} as any)[appId];
	if (!app) throw new Error(`App ${appId} not found`);

	const idx = (app.services as any[]).findIndex((s: any) => s.serviceName === serviceName);
	if (idx === -1) throw new Error(`Service "${serviceName}" not found in app ${appId}`);

	const updatedServices = (app.services as any[]).filter((_: any, i: number) => i !== idx);
	const updatedApp = { ...app, services: updatedServices };

	await containerManager.setTarget({
		...targetState,
		apps: { ...targetState.apps, [appId]: updatedApp },
	} as any);
};

/**
 * Remove an app from target state (stops + removes containers)
 * Used by: DELETE /v1/apps/:appId
 */
export const removeApp = async (appId: number) => {
	const targetState = containerManager.getTargetState();
	if (!(targetState.apps ?? {} as any)[appId]) {
		throw new Error(`App ${appId} not found in target state`);
	}

	const newApps = { ...targetState.apps } as Record<string, any>;
	delete newApps[appId];

	await containerManager.setTarget({ ...targetState, apps: newApps } as any);
};

/**
 * Start / stop / restart a specific service within an app
 * Used by: POST /v1/apps/:appId/services/:serviceName/:action
 */
export const serviceAction = async (
	appId: number,
	serviceName: string,
	action: 'start' | 'stop' | 'restart',
) => {
	const currentState = await containerManager.getCurrentState();
	const targetState = containerManager.getTargetState();

	// A freshly deployed app only exists in targetState until Docker creates the container
	const currentApp = (currentState.apps as Record<string, any>)[appId];
	const targetApp = (targetState.apps as Record<string, any>)[appId];
	if (!currentApp && !targetApp) throw new Error(`App ${appId} not found`);

	const currentSvc = currentApp
		? (currentApp.services as any[]).find((s: any) => s.serviceName === serviceName)
		: undefined;
	const targetSvc = targetApp
		? (targetApp.services as any[]).find((s: any) => s.serviceName === serviceName)
		: undefined;

	if (!currentSvc && !targetSvc) throw new Error(`Service "${serviceName}" not found in app ${appId}`);

	const containerId: string | undefined = currentSvc?.containerId;

	if (containerId) {
		const docker = containerManager.getDocker();
		if (!docker) throw new Error('Docker not available');
		const container = docker.getContainer(containerId);
		if (action === 'start') await container.start();
		else if (action === 'stop') await container.stop();
		else await container.restart();
	} else {
		// Container not created yet — reconcile to create/start it
		if (action === 'start' || action === 'restart') {
			await containerManager.applyTargetState();
		}
	}

	return { appId, serviceName, action };
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
 * Trigger immediate target-state pull from cloud API
 * Used by: POST /v1/sync/pull
 */
export const pullTargetStateNow = async () => {
	if (!cloudSync) {
		throw new Error('Cloud sync not initialized');
	}

	return cloudSync.pullTargetStateNow(true);
};

/**
 * Provision agent with provisioning key
 * Used by: POST /v1/provision
 */
export const provisionDevice = async (config: {
	provisioningApiKey: string;
	deviceName?: string;
	deviceType?: string;
	apiEndpoint?: string;
	applicationId?: number;
}) => {
	logger?.infoSync('Provisioning agent', {
		component: LogComponents.agentManager,
		operation: 'provision',
		deviceName: config.deviceName,
		apiEndpoint: config.apiEndpoint
	});

	const result = await agentManager.provision(config);
	
	logger?.infoSync('Agent provisioned successfully', {
		component: LogComponents.agentManager,
		operation: 'provision',
		uuid: result.uuid,
		provisioned: result.provisioned
	});

	return {
		success: true,
		device: {
			uuid: result.uuid,
			deviceName: result.name,
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
	const agentInfo = agentManager.getAgentInfo();
	
	return {
		provisioned: agentInfo.provisioned,
		uuid: agentInfo.uuid,
		deviceName: agentInfo.name,
		apiEndpoint: agentInfo.apiEndpoint,
		hasProvisioningKey: !!agentInfo.provisioningApiKey,
		mqttConfigured: !!(agentInfo.mqttBrokerConfig?.username && agentInfo.mqttBrokerConfig?.password),
		mqttBrokerUrl: agentInfo.mqttBrokerConfig 
			? `${agentInfo.mqttBrokerConfig.protocol}://${agentInfo.mqttBrokerConfig.host}:${agentInfo.mqttBrokerConfig.port}` 
			: undefined
	};
};

/**
 * Deprovision agent
 * Used by: POST /v1/deprovision
 */
export const deprovisionDevice = async () => {
	logger?.infoSync('Deprovisioning agent', {
		component: LogComponents.agentManager,
		operation: 'deprovision'
	});

	await agentManager.reset();
	
	logger?.infoSync('Agent deprovisioned successfully', {
		component: LogComponents.agentManager,
		operation: 'deprovision'
	});
};

/**
 * Get all configured endpoints/devices
 * Used by: GET /v1/endpoints
 */
export const getEndpoints = async (protocol?: string) => {
	const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
	const endpoints = await EndpointModel.getAll(protocol);
	const deviceHealth = adapterManager
		? await adapterManager.getAllDeviceStatuses().catch(() => ({} as Record<string, any>))
		: {};

	return endpoints.map((endpoint: any) => {
		const health = deviceHealth[endpoint.name];
		if (!health) {
			return endpoint;
		}

		return {
			...endpoint,
			health: {
				status: health.status,
				connected: health.connected,
				communicationQuality: health.communicationQuality,
				lastSeen: health.lastSeen,
				lastPoll: health.lastPoll,
				lastError: health.lastError,
				responseTimeMs: health.responseTimeMs,
			},
		};
	});
};

/**
 * Add a new endpoint via target state (persists across cloud sync cycles)
 * Used by: POST /v1/endpoints
 */
export const addEndpoint = async (body: {
	name: string;
	protocol: string;
	connection: Record<string, any>;
	poll_interval?: number;
	enabled?: boolean;
	data_points?: any[];
	metadata?: Record<string, any>;
	fingerprint?: string;
}) => {
	if (!configManager && !stateManager) throw new Error('Config manager not initialized');
	if (!body.name) throw new Error('name is required');
	if (!body.protocol) throw new Error('protocol is required');
	if (!body.connection) throw new Error('connection is required');

	const uuid = randomUUID();

	// For MQTT: derive auth.mqtt from connection credentials so
	// MqttFileAuthReconciler writes a passwd/ACL entry on reconcile.
	// Also promote the first data_point topic to connection.topic (the
	// reconciler uses it as the base ACL topic pattern).
	// If no topics were supplied, auto-generate the canonical topic:
	//   i/<encodedTenant>/a/<encodedAgent>/d/<encodedEndpoint>
	let mqttAuth: Record<string, any> | undefined;
	const resolvedConnection = { ...body.connection };
	let resolvedDataPoints = body.data_points ? [...body.data_points] : [];
	if (body.protocol === 'mqtt') {
		const username = body.connection?.username as string | undefined;
		const password = body.connection?.password as string | undefined;
		if (username && password) {
			mqttAuth = { username, passwordPlaintext: password, access: 2 };
		}
		// connection.topic drives the ACL pattern; fall back to first data_point,
		// then to canonical i/<tenant>/a/<agent>/d/<endpoint> when provisioned,
		// then to '#' (all topics) so the passwd entry is always written.
		if (!resolvedConnection.topic) {
			const firstTopic = body.data_points?.[0]?.topic as string | undefined;
			if (firstTopic) {
				resolvedConnection.topic = firstTopic;
			} else {
				const agentInfo = agentManager.getAgentInfo();
				const tenantId = agentInfo?.tenantId;
				const agentUuid = agentInfo?.uuid as string | undefined;
				if (tenantId && agentUuid) {
					const generatedTopic = `i/${encodeIfUuid(tenantId)}/a/${encodeIfUuid(agentUuid)}/d/${encodeIfUuid(uuid)}`;
					resolvedConnection.topic = generatedTopic;
					resolvedDataPoints = [{ topic: generatedTopic }];
				} else {
					resolvedConnection.topic = '#';
				}
			}
		}
	}

	const newEndpoint = {
		id: uuid,
		uuid,
		name: body.name,
		protocol: body.protocol,
		connection: resolvedConnection,
		poll_interval: body.poll_interval ?? 5000,
		pollInterval: body.poll_interval ?? 5000,
		enabled: body.enabled !== false,
		...(mqttAuth ? { auth: { mqtt: mqttAuth } } : {}),
		...(body.metadata ? { metadata: body.metadata } : {}),
		dataPoints: resolvedDataPoints,
	};

	await applyConfigUpdate((config) => {
		if (!Array.isArray(config.endpoints)) config.endpoints = [];
		config.endpoints.push(newEndpoint as any);
	});

	// Write directly to the endpoints table so GET /v1/endpoints reflects the new
	// endpoint immediately. applyConfigUpdate only updates target state; the reconciler
	// that syncs target state → DB runs asynchronously and would otherwise leave the
	// table empty until the next reconciliation cycle.
	const { EndpointModel } = await import('../db/models/endpoint.model.js');
	await EndpointModel.upsert({
		uuid,
		fingerprint: body.fingerprint,
		name: body.name,
		protocol: body.protocol as any,
		connection: resolvedConnection,
		poll_interval: body.poll_interval ?? 5000,
		enabled: body.enabled !== false,
		data_points: resolvedDataPoints.length > 0 ? resolvedDataPoints : undefined,
		metadata: body.metadata,
	});

	return {
		uuid,
		name: body.name,
		protocol: body.protocol,
		enabled: newEndpoint.enabled,
		topic: newEndpoint.connection?.topic,
	};
};

/**
 * Update an endpoint (e.g. enable/disable) by UUID or name
 * Used by: PATCH /v1/endpoints/:uuid
 */
export const updateEndpoint = async (uuidOrName: string, patch: { enabled?: boolean; poll_interval?: number }) => {
	const { EndpointModel } = await import('../db/models/endpoint.model.js');

	// Try to find by name first, then by uuid
	const all = await EndpointModel.getAll();
	const ep = all.find((e: any) => e.name === uuidOrName || e.uuid === uuidOrName);

	if (!ep) {
		throw Object.assign(new Error(`Endpoint not found: ${uuidOrName}`), { statusCode: 404 });
	}

	const updates: Record<string, any> = {};
	if (patch.enabled !== undefined) updates.enabled = patch.enabled;
	if (patch.poll_interval !== undefined) updates.poll_interval = patch.poll_interval;

	const result = await EndpointModel.update(ep.name, updates);
	return { uuid: ep.uuid, name: ep.name, enabled: result?.enabled };
};

/**
 * Remove an endpoint by UUID via target state
 * Used by: DELETE /v1/endpoints/:uuid
 */
export const removeEndpoint = async (uuid: string) => {
	if (!configManager && !stateManager) throw new Error('Config manager not initialized');

	const { EndpointModel } = await import('../db/models/endpoint.model.js');

	// Verify the endpoint exists before attempting removal
	const existing = await EndpointModel.getByUuid(uuid);
	if (!existing) {
		throw Object.assign(new Error(`Endpoint not found: ${uuid}`), { statusCode: 404 });
	}

	// Remove from target state config (keeps reconciler in sync)
	await applyConfigUpdate((config) => {
		if (Array.isArray(config.endpoints)) {
			config.endpoints = config.endpoints.filter((e: any) => e.uuid !== uuid && e.id !== uuid);
		}
	});

	// Remove directly from the endpoints table so GET /v1/endpoints reflects
	// the deletion immediately, without waiting for the reconciliation cycle.
	await EndpointModel.deleteByUuid(uuid);
};

/**
 * Remove all endpoints from target state
 * Used by: DELETE /v1/endpoints
 */
export const removeAllEndpoints = async () => {
	if (!configManager && !stateManager) throw new Error('Config manager not initialized');

	let removed = 0;
	await applyConfigUpdate((config) => {
		removed = Array.isArray(config.endpoints) ? config.endpoints.length : 0;
		config.endpoints = [];
	});

	return { removed };
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
 * Publish control: list publishers
 */
export const listPublishDestinations = async (includeDisabled: boolean = true) => {
	return PublishDestinationsModel.getAll(includeDisabled);
};

/**
 * Publish control: create publisher
 */
export const createPublisher = async (body: {
	name: string;
	type: string;
	config_json?: Record<string, unknown>;
	enabled?: boolean;
}) => {
	if (!body?.name || !body?.type) {
		throw new Error('name and type are required');
	}

	const created = PublishDestinationsModel.create({
		name: body.name,
		type: body.type,
		config_json: body.config_json ?? null,
		enabled: body.enabled !== false,
	});

	if (!created) {
		throw new Error('Failed to create publisher');
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after creating destination', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return created;
};

/**
 * Publish control: update publisher
 */
export const updatePublisher = async (id: number, body: {
	name?: string;
	type?: string;
	config_json?: Record<string, unknown> | null;
	enabled?: boolean;
}) => {
	const existing = PublishDestinationsModel.getById(id);
	if (!existing) {
		throw Object.assign(new Error(`Publisher not found: ${id}`), { statusCode: 404 });
	}

	const updated = PublishDestinationsModel.update(id, body);
	if (!updated) {
		throw new Error(`Failed to update publisher: ${id}`);
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after updating destination', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return updated;
};

/**
 * Publish control: delete destination
 */
export const deletePublisher = async (id: number) => {
	const deleted = PublishDestinationsModel.delete(id);
	if (!deleted) {
		throw Object.assign(new Error(`Destination not found: ${id}`), { statusCode: 404 });
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after deleting destination', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return { deleted: true };
};

/**
 * Publish control: list subscriptions (optionally filtered by publish_destination_id)
 */
export const listPublishSubscriptions = async (publishDestinationId?: number, includeDisabled: boolean = true) => {
	if (publishDestinationId !== undefined) {
		return PublishSubscriptionsModel.getByPublishDestinationId(publishDestinationId, includeDisabled);
	}

	return PublishSubscriptionsModel.getAll(includeDisabled);
};

/**
 * Publish control: create subscription
 */
export const createPublishSubscription = async (body: {
	publish_destination_id: number;
	topics?: string[];
	route_json?: Record<string, unknown> | null;
	payload_format?: 'custom' | 'tags' | 'ecp';
	compression?: 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate' | null;
	enabled?: boolean;
}) => {
	if (!body || !Number.isFinite(body.publish_destination_id)) {
		throw new Error('publish_destination_id is required');
	}

	const destination = PublishDestinationsModel.getById(body.publish_destination_id);
	if (!destination) {
		throw Object.assign(new Error(`Destination not found: ${body.publish_destination_id}`), { statusCode: 404 });
	}

	const format = body.payload_format || 'custom';
	if (format !== 'custom' && format !== 'tags' && format !== 'ecp') {
		throw new Error(`Invalid payload_format: ${format}`);
	}

	const VALID_COMPRESSIONS = ['json', 'msgpack', 'json+deflate', 'msgpack+deflate'];
	if (body.compression != null && !VALID_COMPRESSIONS.includes(body.compression)) {
		throw new Error(`Invalid compression: ${body.compression}. Supported: ${VALID_COMPRESSIONS.join(', ')}`);
	}

	if (destination.type !== 'iotistica') {
		const destinationTopic = typeof body.route_json?.topic === 'string' ? body.route_json.topic.trim() : '';
		if (!destinationTopic) {
			throw new Error('route_json.topic is required for external destinations');
		}
	}

	const created = PublishSubscriptionsModel.create({
		publish_destination_id: body.publish_destination_id,
		topics: body.topics ?? [],
		route_json: (body.route_json as any) ?? null,
		payload_format: format,
		compression: (body.compression as any) ?? null,
		enabled: body.enabled !== false,
	});

	if (!created) {
		throw new Error('Failed to create publish subscription');
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after creating subscription', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return created;
};

/**
 * Publish control: update subscription
 */
export const updatePublishSubscription = async (id: number, body: {
	publish_destination_id?: number;
	topics?: string[];
	route_json?: Record<string, unknown> | null;
	payload_format?: 'custom' | 'tags' | 'ecp';
	compression?: 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate' | null;
	enabled?: boolean;
}) => {
	const existing = PublishSubscriptionsModel.getById(id);
	if (!existing) {
		throw Object.assign(new Error(`Publish subscription not found: ${id}`), { statusCode: 404 });
	}

	let destination = existing.publish_destination_id ? PublishDestinationsModel.getById(existing.publish_destination_id) : null;
	if (body.publish_destination_id !== undefined) {
		destination = PublishDestinationsModel.getById(body.publish_destination_id);
		if (!destination) {
			throw Object.assign(new Error(`Destination not found: ${body.publish_destination_id}`), { statusCode: 404 });
		}
	}

	if (!destination) {
		throw Object.assign(new Error(`Destination not found: ${existing.publish_destination_id}`), { statusCode: 404 });
	}

	if (body.payload_format !== undefined) {
		const format = body.payload_format;
		if (format !== 'custom' && format !== 'tags' && format !== 'ecp') {
			throw new Error(`Invalid payload_format: ${format}`);
		}
	}

	const VALID_COMPRESSIONS = ['json', 'msgpack', 'json+deflate', 'msgpack+deflate'];
	if (body.compression != null && !VALID_COMPRESSIONS.includes(body.compression)) {
		throw new Error(`Invalid compression: ${body.compression}. Supported: ${VALID_COMPRESSIONS.join(', ')}`);
	}

	if (destination.type !== 'iotistica') {
		const effectiveRoute = body.route_json !== undefined ? body.route_json : (existing.route_json as Record<string, unknown> | null | undefined);
		const destinationTopic = typeof effectiveRoute?.topic === 'string' ? effectiveRoute.topic.trim() : '';
		if (!destinationTopic) {
			throw new Error('route_json.topic is required for external destinations');
		}
	}

	const updated = PublishSubscriptionsModel.update(id, body as any);
	if (!updated) {
		throw new Error(`Failed to update publish subscription: ${id}`);
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after updating subscription', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return updated;
};

/**
 * Publish control: delete subscription
 */
export const deletePublishSubscription = async (id: number) => {
	const deleted = PublishSubscriptionsModel.delete(id);
	if (!deleted) {
		throw Object.assign(new Error(`Publish subscription not found: ${id}`), { statusCode: 404 });
	}

	devicePublish?.reloadAllBindings().catch((err) => {
		logger?.warnSync('Failed to reload publish bindings after deleting subscription', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return { deleted: true };
};

/**
 * Factory reset agent - complete data wipe
 * Used by: POST /v1/factory-reset
 */
export const factoryResetDevice = async () => {
	logger?.warnSync('Factory reset requested', {
		component: LogComponents.agentManager,
		operation: 'factoryReset',
		warning: 'This will delete all apps, services, and data'
	});

	await agentManager.factoryReset();
	
	logger?.warnSync('Factory reset completed', {
		component: LogComponents.agentManager,
		operation: 'factoryReset'
	});
};

/**
 * Return all metric names the user could plausibly add anomaly rules for.
 * Merges three sources so the admin UI can show an informed autocomplete:
 *   - observed — every metric ever seen by this agent (primary, from SQLite catalog)
 *   - system   — always-available system metrics seeded as defaults
 *   - endpoint — data-point names from configured endpoints not yet seen in live data
 * Each entry carries a `configured` flag so the UI can highlight gaps.
 * Used by: GET /v1/anomaly/metrics
 */
export const getAvailableAnomalyMetrics = async (): Promise<
	Array<{
		name: string;
		source: 'live' | 'system' | 'endpoint';
		score?: number;
		deviceState?: string;
		endpointName?: string;
		unit?: string;
		configured: boolean;
	}>
> => {
	const configuredNames = new Set(anomalyService?.getConfig().metrics.map((m) => m.name) ?? []);
	const results = new Map<
		string,
		{
			name: string;
			source: 'live' | 'system' | 'endpoint';
			score?: number;
			deviceState?: string;
			endpointName?: string;
			unit?: string;
			configured: boolean;
		}
	>();

	// 1. Persistent metric catalog — every metric the agent has ever observed.
	//    This is the primary source; falls back gracefully if service unavailable.
	if (anomalyService) {
		for (const observed of anomalyService.getObservedMetrics()) {
			if (!observed.name?.trim()) continue;
			results.set(observed.name, {
				name: observed.name,
				source: 'live',
				unit: observed.unit,
				configured: configuredNames.has(observed.name),
			});
		}

		// Overlay live anomaly scores and deviceState on top of catalog entries.
		for (const { metricName, deviceState, score } of anomalyService.getTrackedMetrics()) {
			const existing = results.get(metricName);
			if (existing) {
				existing.score = score;
				existing.deviceState = deviceState;
			} else {
				results.set(metricName, {
					name: metricName,
					source: 'live',
					score,
					deviceState,
					configured: configuredNames.has(metricName),
				});
			}
		}
	}

	// 2. System metrics always produced by the agent (seed even if agent not yet warmed up).
	for (const name of ['cpu_usage', 'memory_percent', 'cpu_temp', 'disk_usage']) {
		if (!results.has(name)) {
			results.set(name, { name, source: 'system', configured: configuredNames.has(name) });
		}
	}

	// 3. Data-point names from all configured endpoints not already in the catalog.
	try {
		const { EndpointModel } = await import('../db/models/endpoint.model.js');
		const endpoints = await EndpointModel.getAll();
		for (const ep of endpoints) {
			const dataPoints: any[] = Array.isArray(ep.data_points) ? ep.data_points : [];
			for (const dp of dataPoints) {
				const dpName: unknown = dp.name ?? dp.key ?? dp.tag ?? dp.label;
				if (typeof dpName !== 'string' || !dpName.trim()) continue;
				const name = dpName.trim();
				if (!results.has(name)) {
					results.set(name, {
						name,
						source: 'endpoint',
						endpointName: ep.name,
						configured: configuredNames.has(name),
					});
				}
			}
		}
	} catch {
		// non-fatal — endpoints table may not exist yet
	}

	return Array.from(results.values()).sort((a, b) => {
		const order: Record<string, number> = { live: 0, system: 1, endpoint: 2 };
		return (order[a.source] - order[b.source]) || a.name.localeCompare(b.name);
	});
};

/**
 * Persist the current in-memory anomaly config back to the local target state.
 * This is the key piece that makes standalone mode work: changes saved via the
 * admin UI survive agent restarts and are used as the local source of truth when
 * no cloud reconciliation is available.
 *
 * When the agent IS provisioned and the cloud later pushes a new target state,
 * the cloud config wins (standard reconciliation behaviour — by design).
 */
export const persistAnomalyConfig = async (config: Record<string, unknown>): Promise<void> => {
	await applyConfigUpdate((targetConfig) => {
		targetConfig.anomalyDetection = config;
	});
};

/**
 * Query stored anomaly baselines from SQLite
 * Used by: GET /v1/anomaly/baselines
 */
export const getAnomalyBaselines = (metric?: string, limit: number = 100): any[] => {
	try {
		const db = getDatabase();
		const cap = Math.min(limit, 500);
		if (metric) {
			return db.prepare(
				`SELECT metric, device_id, device_state, time_slot, mean, std_dev, median, mad,
				        sample_count, calculated_at
				   FROM anomaly_baselines
				  WHERE metric = ?
				  ORDER BY calculated_at DESC
				  LIMIT ?`,
			).all(metric, cap) as any[];
		}
		return db.prepare(
			`SELECT metric, device_id, device_state, time_slot, mean, std_dev, median, mad,
			        sample_count, calculated_at
			   FROM anomaly_baselines
			  ORDER BY calculated_at DESC
			  LIMIT ?`,
		).all(cap) as any[];
	} catch {
		return [];
	}
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
	skipDbWrites?: boolean;
	optionOverrides?: Record<string, Record<string, any>>;
}): Promise<any[]> {
	if (!discoveryService) {
		throw new Error('DiscoveryService not initialized');
	}
	return discoveryService.runDiscovery({
		...options,
		protocols: options.protocols as any,
	});
}

/**
 * Browse OPC UA address space and return full tree nodes for UI tag browser.
 */
export async function browseOPCUAAddressSpace(options: OPCUABrowseRequest) {
	if (!discoveryService) {
		throw new Error('DiscoveryService not initialized');
	}

	return discoveryService.browseOPCUAAddressSpace(options);
}

/**
 * Discovery rules: list all rules
 */
export const listDiscoveryRules = async () => {
	const { DiscoveryRuleModel } = await import('../db/models/discovery-rule.model.js');
	return DiscoveryRuleModel.getAll();
};

/**
 * Discovery rules: create a rule
 */
export const createDiscoveryRule = async (body: {
	name: string;
	protocol: string;
	interval_seconds?: number;
	enabled?: boolean;
	auto_enable?: boolean;
	target_json?: Record<string, any> | null;
	params_json?: Record<string, any> | null;
}) => {
	if (!body.name) throw new Error('name is required');
	if (!body.protocol) throw new Error('protocol is required');

	const { DiscoveryRuleModel } = await import('../db/models/discovery-rule.model.js');
	const rule = DiscoveryRuleModel.create({
		name: body.name,
		protocol: body.protocol,
		interval_seconds: body.interval_seconds ?? 3600,
		enabled: body.enabled !== false,
		auto_enable: body.auto_enable === true,
		target_json: body.target_json ?? null,
		params_json: body.params_json ?? null,
	});

	logger?.infoSync('Discovery rule created', {
		component: LogComponents.deviceApi,
		ruleUuid: rule.uuid,
		name: rule.name,
		protocol: rule.protocol,
	});

	return rule;
};

/**
 * Discovery rules: update a rule
 */
export const updateDiscoveryRule = async (uuid: string, body: {
	name?: string;
	protocol?: string;
	interval_seconds?: number;
	enabled?: boolean;
	auto_enable?: boolean;
	target_json?: Record<string, any> | null;
	params_json?: Record<string, any> | null;
}) => {
	const { DiscoveryRuleModel } = await import('../db/models/discovery-rule.model.js');
	const existing = DiscoveryRuleModel.getByUuid(uuid);
	if (!existing) {
		throw Object.assign(new Error(`Discovery rule not found: ${uuid}`), { statusCode: 404 });
	}

	const rule = DiscoveryRuleModel.update(uuid, body);

	logger?.infoSync('Discovery rule updated', {
		component: LogComponents.deviceApi,
		ruleUuid: uuid,
	});

	return rule;
};

/**
 * Discovery rules: delete a rule
 */
export const deleteDiscoveryRule = async (uuid: string) => {
	const { DiscoveryRuleModel } = await import('../db/models/discovery-rule.model.js');
	const deleted = DiscoveryRuleModel.delete(uuid);
	if (!deleted) {
		throw Object.assign(new Error(`Discovery rule not found: ${uuid}`), { statusCode: 404 });
	}

	// Best-effort: clean up run history. Wrapped so a missing table doesn't fail the delete.
	try {
		const { DiscoveryRunModel } = await import('../db/models/discovery-run.model.js');
		DiscoveryRunModel.deleteByRule(uuid);
	} catch {
		// ignore
	}

	logger?.infoSync('Discovery rule deleted', {
		component: LogComponents.deviceApi,
		ruleUuid: uuid,
	});

	return { deleted: true };
};

/**
 * Discovery rules: get run history for a specific rule
 */
export const listDiscoveryRuns = async (ruleUuid: string, limit = 50) => {
	const { DiscoveryRunModel } = await import('../db/models/discovery-run.model.js');
	return DiscoveryRunModel.getByRule(ruleUuid, limit);
};

/**
 * Discovery rules: get recent runs across all rules
 */
export const listRecentDiscoveryRuns = async (limit = 20) => {
	const { DiscoveryRunModel } = await import('../db/models/discovery-run.model.js');
	return DiscoveryRunModel.getRecent(limit);
};

/**
 * Get agent settings — the config sub-keys that are user-editable via the admin UI.
 * Returns the settings shape plus read-only agent info (uuid, name, version).
 * Deliberately excludes `endpoints`, `apps`, and other internal-only fields.
 */
export const getSettings = async (): Promise<Record<string, any>> => {
	// Prefer the live config manager; fall back to the raw snapshot in SQLite.
	let config: Record<string, any> = {};
	if (configManager) {
		config = configManager.getTargetConfig() as unknown as Record<string, any>;
	} else if (stateManager) {
		const raw = stateManager.getTargetState?.();
		config = (raw as any)?.config ?? {};
	}

	const settings: Record<string, any> = {};
	for (const key of ['logging', 'features', 'intervals', 'runtime', 'anomalyDetection']) {
		if (config[key] !== undefined) settings[key] = config[key];
	}

	// Attach read-only agent identity (mix DB row for version + agentManager for parsed mqtt config).
	try {
		const { AgentModel } = await import('../db/models/agent.model.js');
		const agent = await AgentModel.get();
		const agentInfo = agentManager.getAgentInfo();
		const mqttCfg = agentInfo.mqttBrokerConfig;
		settings.agent = {
			uuid: agent?.uuid ?? null,
			name: agent?.name ?? null,
			version: agent?.agentVersion ?? null,
			provisioned: agentInfo.provisioned ?? false,
			apiEndpoint: agentInfo.apiEndpoint ?? null,
			mqttBrokerUrl: mqttCfg
				? `${mqttCfg.protocol}://${mqttCfg.host}:${mqttCfg.port}`
				: null,
		};
	} catch {
		settings.agent = { uuid: null, name: null, version: null, provisioned: false, apiEndpoint: null, mqttBrokerUrl: null };
	}

	return settings;
};

/**
 * Persist a partial settings update to target state and trigger reconciliation.
 * Only the keys present in `patch` are merged; unrecognised keys are ignored so
 * callers cannot accidentally overwrite endpoints or apps config.
 */
export const updateSettings = async (patch: Record<string, any>): Promise<void> => {
	const ALLOWED = new Set(['logging', 'features', 'intervals', 'runtime', 'anomalyDetection']);
	await applyConfigUpdate((config) => {
		for (const [key, value] of Object.entries(patch)) {
			if (ALLOWED.has(key)) {
				config[key] = value;
			}
		}
	});
};

// ── Docker daemon configuration ───────────────────────────────────────────────

export interface DockerConnectionConfig {
	type: 'socket' | 'tcp' | 'tcp+tls';
	socketPath?: string;
	host?: string;
	port?: number;
	ca?: string;
	cert?: string;
	key?: string;
}

function buildDockerOptions(cfg: DockerConnectionConfig): DockerOptions {
	if (cfg.type === 'tcp') {
		return { host: cfg.host || 'localhost', port: cfg.port || 2375, protocol: 'http' as const };
	}
	if (cfg.type === 'tcp+tls') {
		return { host: cfg.host || 'localhost', port: cfg.port || 2376, ca: cfg.ca, cert: cfg.cert, key: cfg.key, protocol: 'https' as const };
	}
	// socket (default)
	const defaultSocket = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
	return { socketPath: cfg.socketPath || defaultSocket };
}

export const getDockerConfig = async (): Promise<DockerConnectionConfig> => {
	const config = configManager ? (configManager.getTargetConfig() as unknown as Record<string, any>) : {};
	return (config.docker ?? { type: 'socket' }) as DockerConnectionConfig;
};

export const saveDockerConfig = async (cfg: DockerConnectionConfig): Promise<void> => {
	await applyConfigUpdate((config) => { config.docker = cfg; });
	containerManager.setDockerOptions(buildDockerOptions(cfg));
};

export const testDockerConnection = async (cfg: DockerConnectionConfig): Promise<{ version: string; containers: number }> => {
	const { default: Docker } = await import('dockerode');
	const docker = new Docker(buildDockerOptions(cfg));
	await docker.ping();
	const info = await docker.info();
	return { version: info.ServerVersion as string, containers: info.Containers as number };
};

/**
 * Discovery rules: trigger a rule immediately
 */
export const runDiscoveryRule = async (uuid: string) => {
	if (!discoveryRulesScheduler) {
		throw new Error('Discovery rules scheduler not initialized');
	}
	return discoveryRulesScheduler.runNow(uuid);
};

/**
 * Get SQLite database stats for diagnostics
 * Used by: GET /v1/db/stats
 */
export const getDbStats = async () => {
	const path = getDatabasePath();
	const exists = existsSync(path);

	if (!exists) {
		return {
			path,
			exists: false,
			sizeBytes: 0,
			sizeMb: 0,
			tableCount: 0,
			tables: [] as string[],
		};
	}

	const sizeBytes = statSync(path).size;
	const sizeMb = Number((sizeBytes / 1024 / 1024).toFixed(2));

	const db = getDatabase();
	const rows = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all() as Array<{ name: string }>;
	const tables = rows.map((row) => row.name);

	return {
		path,
		exists: true,
		sizeBytes,
		sizeMb,
		tableCount: tables.length,
		tables,
	};
};
