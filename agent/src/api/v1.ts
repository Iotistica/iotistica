/**
 * Device API v1 Router
 * Simplified version of balena supervisor v1 API
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as actions from './actions';
import { ModbusAdapter } from '../plugins/modbus/adapter.js';
import { getMemoryDiagnostics, getRestartPolicyStatus } from '../system/memory.js';
import {
	getCpuUsage,
	getMemoryInfo,
	getStorageInfo,
	getUptime,
	getHostname,
	getNetworkBandwidth,
} from '../system/metrics.js';
import bcrypt from 'bcryptjs';
import { UserModel } from '../db/models/admin-user.model.js';
import { AdminSessionModel } from '../db/models/admin-session.model.js';

export const router = express.Router();

/**
 * POST /v1/restart
 * Restart an application
 */
router.post('/v1/restart', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.body.appId);
		const force = req.body.force === true || req.body.force === 'true';

		if (isNaN(appId)) {
			return res.status(400).json({ error: 'Missing or invalid app id' });
		}

		await actions.restartApp(appId, force);
		return res.status(200).send('OK');
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/apps/:appId/stop
 * Stop a service in an application
 */
router.post('/v1/apps/:appId/stop', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		const force = req.body.force === true || req.body.force === 'true';

		if (isNaN(appId)) {
			return res.status(400).json({ error: 'Invalid app id' });
		}

		const service = await actions.stopService(appId, undefined, force);
		return res.status(200).json({ 
			containerId: service.containerId,
			status: 'stopped' 
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/apps/:appId/start
 * Start a service in an application
 */
router.post('/v1/apps/:appId/start', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		const force = req.body.force === true || req.body.force === 'true';

		if (isNaN(appId)) {
			return res.status(400).json({ error: 'Invalid app id' });
		}

		const service = await actions.startService(appId, undefined, force);
		return res.status(200).json({ 
			containerId: service.containerId,
			status: 'started' 
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/apps/:appId
 * Get application information
 */
router.get('/v1/apps/:appId', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);

		if (isNaN(appId)) {
			return res.status(400).json({ error: 'Invalid app id' });
		}

		const app = await actions.getApp(appId);
		return res.status(200).json(app);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/discover
 * Run device discovery for protocols
 */
router.post('/v1/discover', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const protocols = req.body.protocols as string[] | undefined;
		const validate = req.body.validate === true || req.body.validate === 'true';
		const forceRun = req.body.forceRun === true || req.body.forceRun === 'true';
		const optionOverrides = req.body.overrides as Record<string, Record<string, any>> | undefined;

		const devices = await actions.runDiscovery({
			trigger: 'manual',
			protocols,
			validate,
			forceRun,
			skipDbWrites: true,
			...(optionOverrides ? { optionOverrides } : {}),
		});

		return res.status(200).json({ devices });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/discover/opcua/browse
 * Browse OPC UA address space and return full tree nodes for tag-browser UI.
 * Body: { endpointUrl, maxDepth?, securityMode?, securityPolicy?, certificateTrustMode?, username?, password? }
 */
router.post('/v1/discover/opcua/browse', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { endpointUrl, maxDepth, securityMode, securityPolicy, certificateTrustMode, username, password } = req.body ?? {};

		if (!endpointUrl || typeof endpointUrl !== 'string') {
			return res.status(400).json({ error: 'Missing or invalid endpointUrl' });
		}

		const parsedMaxDepth = maxDepth === undefined ? undefined : Number(maxDepth);
		if (parsedMaxDepth !== undefined && (!Number.isInteger(parsedMaxDepth) || parsedMaxDepth < 1 || parsedMaxDepth > 20)) {
			return res.status(400).json({ error: 'maxDepth must be an integer between 1 and 20' });
		}

		const nodes = await actions.browseOPCUAAddressSpace({
			endpointUrl,
			maxDepth: parsedMaxDepth,
			securityMode,
			securityPolicy,
			certificateTrustMode,
			username,
			password,
		});

		return res.status(200).json({
			endpointUrl,
			nodes,
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/device
 * Get device state information
 */
router.get('/v1/device', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const deviceState = await actions.getDeviceState();
		return res.status(200).json(deviceState);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/sync/pull
 * Trigger on-demand target-state pull from cloud API
 */
router.post('/v1/sync/pull', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.pullTargetStateNow();
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/purge
 * Purge application data (volumes)
 */
router.post('/v1/purge', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.body.appId);
		const force = req.body.force === true || req.body.force === 'true';

		if (isNaN(appId)) {
			return res.status(400).json({ error: 'Missing or invalid app id' });
		}

		await actions.purgeApp(appId, force);
		return res.status(200).send('OK');
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/reboot
 * Restart agent services (soft restart - keeps API running)
 */
router.post('/v1/reboot', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const agent = actions.getAgent();
		const state = agent.getLifecycleState?.() ?? 'UNKNOWN';

		if (state !== 'RUNNING') {
			return res.status(409).json({
				error: 'Restart not allowed in current lifecycle state',
				state,
				hint: 'Wait for RUNNING state before requesting restart',
			});
		}
		
		// Send response immediately (don't wait for restart)
		res.status(202).json({ 
			Data: 'Agent services restarting', 
			Error: null,
			state,
		});
		
		// Restart services asynchronously (keeps API running)
		setImmediate(async () => {
			try {
				await agent.restartServices();
			} catch (error) {
				console.error('Agent restart failed:', error);
			}
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/shutdown
 * Shutdown the device (placeholder - requires platform-specific implementation)
 */
router.post('/v1/shutdown', async (req: Request, res: Response, next: NextFunction) => {
	try {
		console.log('Shutdown requested');
		// This would need platform-specific implementation
		// For now, just return success
		return res.status(202).json({ 
			Data: 'Shutdown scheduled', 
			Error: null 
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/test/anomaly
 * Inject test data to simulate anomalies (for testing only)
 * Body: { metric: 'cpu_usage', value: 95, count: 5 }
 */
router.post('/v1/test/anomaly', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { metric = 'cpu_usage', value, count = 1 } = req.body;
		
		if (value === undefined) {
			return res.status(400).json({ error: 'Missing value parameter' });
		}
		
		const anomalyService = (actions as any).getAnomalyService?.();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		
		// Inject test data points
		const injectedPoints = [];
		for (let i = 0; i < count; i++) {
			const dataPoint = {
				source: 'test' as const,
				metric,
				value: typeof value === 'number' ? value : parseFloat(value),
				unit: metric === 'cpu_usage' || metric === 'memory_percent' ? '%' : '°C',
				timestamp: Date.now() + (i * 1000), // Spread over time
				quality: 'GOOD' as const
			};
			
			anomalyService.processDataPoint(dataPoint);
			injectedPoints.push(dataPoint);
		}
		
		// Get current stats
		const stats = anomalyService.getStats();
		const alerts = anomalyService.getAlerts();
		
		return res.status(200).json({
			message: `Injected ${count} test data point(s)`,
			injectedPoints,
			currentStats: stats,
			recentAlerts: alerts.slice(0, 10)
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/anomaly/save-baselines
 * Manually trigger baseline save (for testing)
 */
router.post('/v1/anomaly/save-baselines', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = (actions as any).getAnomalyService?.();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		
		// Trigger baseline save
		anomalyService.saveBaselines();
		
		const stats = anomalyService.getStats();
		
		return res.status(200).json({
			message: 'Baseline save triggered',
			stats
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/anomaly/metrics
 * Return all metric names available for anomaly rule configuration.
 * Merges live tracked metrics, always-on system metrics, and endpoint data-point names.
 * Each entry carries source, optional live score, and a `configured` flag.
 */
router.get('/v1/anomaly/metrics', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const metrics = await actions.getAvailableAnomalyMetrics();
		return res.status(200).json({ metrics });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/anomaly/config
 * Return current anomaly detection configuration
 */
router.get('/v1/anomaly/config', (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		return res.status(200).json({ config: anomalyService.getConfig() });
	} catch (error) {
		next(error);
	}
});

/**
 * PATCH /v1/anomaly/config
 * Hot-reload anomaly detection configuration (no restart required).
 * Also persists the merged config to the local target state so it survives
 * restarts in standalone mode. When the agent is provisioned, the cloud
 * target state continues to take precedence on the next reconciliation cycle.
 */
router.patch('/v1/anomaly/config', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		if (!req.body || typeof req.body !== 'object') {
			return res.status(400).json({ error: 'Request body must be a JSON object' });
		}
		// 1. Apply immediately to the running service (in-memory hot-reload).
		anomalyService.updateConfig(req.body);
		// 2. Persist the full merged config to local target state (SQLite) so the
		//    change survives restarts in standalone mode.
		await actions.persistAnomalyConfig(anomalyService.getConfig() as unknown as Record<string, unknown>);
		return res.status(200).json({ config: anomalyService.getConfig() });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/anomaly/alerts
 * List in-memory anomaly alerts
 * Query: ?since=<unixMs>, ?severity=critical|warning|info, ?metric=<name>, ?limit=<n>
 */
router.get('/v1/anomaly/alerts', (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		const since = req.query.since ? Number(req.query.since) : undefined;
		const severity = req.query.severity as string | undefined;
		const metric = req.query.metric as string | undefined;
		const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 200;

		let alerts = anomalyService.getAlerts(since);
		if (severity) alerts = alerts.filter((a) => a.severity === severity);
		if (metric) alerts = alerts.filter((a) => a.metric === metric);
		alerts = alerts.slice(0, limit);

		return res.status(200).json({ alerts, total: alerts.length });
	} catch (error) {
		next(error);
	}
});

/**
 * DELETE /v1/anomaly/alerts
 * Clear all in-memory anomaly alerts
 */
router.delete('/v1/anomaly/alerts', (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		anomalyService.clearAlerts();
		return res.status(200).json({ cleared: true });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/anomaly/stats
 * Get anomaly detection stats, live per-metric scores, and predictions
 */
router.get('/v1/anomaly/stats', (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		return res.status(200).json({
			stats: anomalyService.getStats(),
			scores: anomalyService.getAllAnomalyScores(),
			predictions: anomalyService.getPredictions() ?? null,
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/anomaly/baselines
 * Query persisted baseline statistics from SQLite
 * Query: ?metric=<name>, ?limit=<n> (max 500)
 */
router.get('/v1/anomaly/baselines', (req: Request, res: Response, next: NextFunction) => {
	try {
		const anomalyService = actions.getAnomalyService();
		if (!anomalyService) {
			return res.status(503).json({ error: 'Anomaly detection service not available' });
		}
		const metric = req.query.metric as string | undefined;
		const limit = req.query.limit ? Number(req.query.limit) : 100;
		const baselines = actions.getAnomalyBaselines(metric, limit);
		return res.status(200).json({ baselines, total: baselines.length });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/memory
 * Get agent process memory diagnostics and leak detection status
 */
router.get('/v1/memory', (req: Request, res: Response, next: NextFunction) => {
	try {
		const diagnostics = getMemoryDiagnostics();
		const restartPolicy = getRestartPolicyStatus();
		return res.status(200).json({ diagnostics, restartPolicy });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/db/stats
 * Get SQLite database stats (path, size, and table inventory)
 */
router.get('/v1/db/stats', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const stats = await actions.getDbStats();
		return res.status(200).json(stats);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/simulation/status
 * Get simulation orchestrator status
 */
router.get('/v1/simulation/status', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const simulationOrchestrator = (actions as any).getSimulationOrchestrator?.();
		if (!simulationOrchestrator) {
			return res.status(404).json({ 
				error: 'Simulation mode not available',
				hint: 'Set SIMULATION_MODE=true to enable'
			});
		}
		
		const status = simulationOrchestrator.getStatus();
		return res.status(200).json(status);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/simulation/scenarios/:scenario/start
 * Start a specific simulation scenario
 */
router.post('/v1/simulation/scenarios/:scenario/start', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { scenario } = req.params;
		
		const simulationOrchestrator = (actions as any).getSimulationOrchestrator?.();
		if (!simulationOrchestrator) {
			return res.status(404).json({ error: 'Simulation mode not available' });
		}
		
		await simulationOrchestrator.startScenario(scenario);
		const status = simulationOrchestrator.getStatus();
		
		return res.status(200).json({
			message: `Scenario ${scenario} started`,
			status
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/simulation/scenarios/:scenario/stop
 * Stop a specific simulation scenario
 */
router.post('/v1/simulation/scenarios/:scenario/stop', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { scenario } = req.params;
		
		const simulationOrchestrator = (actions as any).getSimulationOrchestrator?.();
		if (!simulationOrchestrator) {
			return res.status(404).json({ error: 'Simulation mode not available' });
		}
		
		await simulationOrchestrator.stopScenario(scenario);
		const status = simulationOrchestrator.getStatus();
		
		return res.status(200).json({
			message: `Scenario ${scenario} stopped`,
			status
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/simulation/stop-all
 * Stop all running simulation scenarios
 */
router.post('/v1/simulation/stop-all', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const simulationOrchestrator = (actions as any).getSimulationOrchestrator?.();
		if (!simulationOrchestrator) {
			return res.status(404).json({ error: 'Simulation mode not available' });
		}
		
		await simulationOrchestrator.stop();
		const status = simulationOrchestrator.getStatus();
		
		return res.status(200).json({
			message: 'All simulations stopped',
			status
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/provision
 * Provision device with a provisioning key
 * Body: { provisioningApiKey: string, deviceName?: string, deviceType?: string, apiEndpoint?: string }
 */
router.post('/v1/provision', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.provisionDevice(req.body);
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/provision/status
 * Get provisioning status
 */
router.get('/v1/provision/status', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const status = await actions.getProvisionStatus();
		return res.status(200).json(status);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/deprovision
 * Deprovision device (remove cloud registration, keep UUID and deviceApiKey)
 */
router.post('/v1/deprovision', async (req: Request, res: Response, next: NextFunction) => {
	try {
		await actions.deprovisionDevice();
		return res.status(200).json({ 
			message: 'Device deprovisioned successfully. UUID and deviceApiKey preserved for re-provisioning.',
			status: 'deprovisioned'
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/factory-reset
 * Factory reset - complete data wipe (WARNING: deletes all apps, services, state, devices)
 */
router.post('/v1/factory-reset', async (req: Request, res: Response, next: NextFunction) => {
	try {
		await actions.factoryResetDevice();
		return res.status(200).json({ 
			message: 'Factory reset complete. All data deleted. Only UUID preserved.',
			status: 'factory-reset'
		});
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/vpn/tailscale/connect
 * Connect to Tailscale VPN
 * 
 * Body: {
 *   authKey: string,
 *   tailnetName: string,
 *   hostname?: string,
 *   shieldsUp?: boolean,
 *   acceptRoutes?: boolean,
 *   acceptDNS?: boolean
 * }
 */
router.post('/v1/vpn/tailscale/connect', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { authKey, tailnetName, hostname, shieldsUp, acceptRoutes, acceptDNS } = req.body;

		if (!authKey || !tailnetName) {
			return res.status(400).json({ 
				error: 'Missing required fields: authKey and tailnetName are required' 
			});
		}

		const result = await actions.connectTailscale({
			authKey,
			tailnetName,
			hostname,
			shieldsUp: shieldsUp ?? true,  // Default true for security
			acceptRoutes: acceptRoutes ?? false,  // Default false for edge devices
			acceptDNS: acceptDNS ?? false,  // Default false to avoid DNS hijacking
		});

		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/vpn/tailscale/disconnect
 * Disconnect from Tailscale VPN
 */
router.post('/v1/vpn/tailscale/disconnect', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.disconnectTailscale();
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/vpn/tailscale/status
 * Get Tailscale VPN status
 */
router.get('/v1/vpn/tailscale/status', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const status = await actions.getTailscaleStatus();
		return res.status(200).json(status);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/vpn/tailscale/ip
 * Get Tailscale IP address
 */
router.get('/v1/vpn/tailscale/ip', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const ip = await actions.getTailscaleIP();
		return res.status(200).json({ ip });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/vpn/tailscale/ping
 * Ping another Tailscale node
 * 
 * Body: {
 *   hostname: string,
 *   count?: number
 * }
 */
router.post('/v1/vpn/tailscale/ping', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { hostname, count } = req.body;

		if (!hostname) {
			return res.status(400).json({ 
				error: 'Missing required field: hostname' 
			});
		}

		const success = await actions.pingTailscaleNode(hostname, count);
		return res.status(200).json({ success, hostname });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/adapters/:protocol/devices
 * Get all device statuses for a given protocol adapter
 */
router.get('/v1/adapters/:protocol/devices', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { protocol } = req.params;
		const adapterManager = actions.getAdapterManager();
		if (!adapterManager) {
			return res.status(503).json({ error: 'devices feature not initialized' });
		}

		const adapter = adapterManager.getAdapter(protocol);
		if (!adapter) {
			return res.status(404).json({ error: `No adapter running for protocol: ${protocol}` });
		}

		const devices = adapter.getDeviceStatuses();
		return res.status(200).json({ devices });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/adapters/:protocol/devices/:deviceName
 * Get a specific device status. Returns enriched status when the adapter supports it.
 */
router.get('/v1/adapters/:protocol/devices/:deviceName', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { protocol, deviceName } = req.params;
		const adapterManager = actions.getAdapterManager();
		if (!adapterManager) {
			return res.status(503).json({ error: 'devices feature not initialized' });
		}

		const adapter = adapterManager.getAdapter(protocol);
		if (!adapter) {
			return res.status(404).json({ error: `No adapter running for protocol: ${protocol}` });
		}

		// Use enriched status if the adapter supports it (e.g. ModbusAdapter), otherwise filter from statuses
		if ('getEnrichedDeviceStatus' in adapter && typeof (adapter as any).getEnrichedDeviceStatus === 'function') {
			const status = (adapter as any).getEnrichedDeviceStatus(deviceName);
			if (!status) {
				return res.status(404).json({ error: `Device not found: ${deviceName}` });
			}
			return res.status(200).json(status);
		}

		const status = adapter.getDeviceStatuses().find((d) => d.deviceName === deviceName);
		if (!status) {
			return res.status(404).json({ error: `Device not found: ${deviceName}` });
		}
		return res.status(200).json(status);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/adapters/:protocol/devices/:deviceName/metrics
 * Get metrics summary for a specific device. Only supported by adapters that expose getDeviceMetricsSummary().
 */
router.get('/v1/adapters/:protocol/devices/:deviceName/metrics', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { protocol, deviceName } = req.params;
		const adapterManager = actions.getAdapterManager();
		if (!adapterManager) {
			return res.status(503).json({ error: 'devices feature not initialized' });
		}

		const adapter = adapterManager.getAdapter(protocol);
		if (!adapter) {
			return res.status(404).json({ error: `No adapter running for protocol: ${protocol}` });
		}

		if (!('getDeviceMetricsSummary' in adapter) || typeof (adapter as any).getDeviceMetricsSummary !== 'function') {
			return res.status(501).json({ error: `Metrics summary not supported for protocol: ${protocol}` });
		}

		const metrics = (adapter as any).getDeviceMetricsSummary(deviceName);
		if (!metrics) {
			return res.status(404).json({ error: `Device not found: ${deviceName}` });
		}
		return res.status(200).json(metrics);
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/adapters/modbus/devices/:deviceName/write
 * Write value to a Modbus register
 * Body: { register: string, value: number | boolean | string }
 */
router.post('/v1/adapters/modbus/devices/:deviceName/write', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { deviceName } = req.params;
		const { register, value } = req.body ?? {};

		if (!register || typeof register !== 'string') {
			return res.status(400).json({ error: 'Missing or invalid register field' });
		}

		if (value === undefined || value === null) {
			return res.status(400).json({ error: 'Missing value field' });
		}

		const adapterManager = actions.getAdapterManager();
		if (!adapterManager) {
			return res.status(503).json({ error: 'devices feature not initialized' });
		}

		const adapter = adapterManager.getAdapter('modbus');
		if (!adapter) {
			return res.status(404).json({ error: 'No adapter running for protocol: modbus' });
		}

		if (!(adapter instanceof ModbusAdapter)) {
			return res.status(500).json({ error: 'Adapter type mismatch for protocol: modbus' });
		}

		await adapter.writeRegister(deviceName, register, value);

		return res.status(200).json({
			success: true,
			deviceName,
			register,
			value
		});
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/adapters/:protocol/metrics
 * Get metrics summaries for all devices. Only supported by adapters that expose getAllDeviceMetrics().
 */
router.get('/v1/adapters/:protocol/metrics', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { protocol } = req.params;
		const adapterManager = actions.getAdapterManager();
		if (!adapterManager) {
			return res.status(503).json({ error: 'devices feature not initialized' });
		}

		const adapter = adapterManager.getAdapter(protocol);
		if (!adapter) {
			return res.status(404).json({ error: `No adapter running for protocol: ${protocol}` });
		}

		if (!('getAllDeviceMetrics' in adapter) || typeof (adapter as any).getAllDeviceMetrics !== 'function') {
			return res.status(501).json({ error: `Device metrics not supported for protocol: ${protocol}` });
		}

		const allMetrics: Map<string, unknown> = (adapter as any).getAllDeviceMetrics();
		const metricsObject: Record<string, unknown> = {};
		for (const [name, metrics] of allMetrics) {
			metricsObject[name] = metrics;
		}
		return res.status(200).json(metricsObject);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/endpoints
 * Get all configured device endpoints/devices
 * Supports filtering by protocol via query parameter: ?protocol=modbus
 */
router.get('/v1/endpoints', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const endpoints = await actions.getEndpoints(req.query.protocol as string | undefined);
		return res.status(200).json({ endpoints });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/endpoints
 * Add a new endpoint to the agent configuration
 * Body: { name, protocol, connection, poll_interval?, enabled?, data_points?, metadata? }
 */
router.post('/v1/endpoints', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const endpoint = await actions.addEndpoint(req.body);
		return res.status(201).json({ endpoint });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * PATCH /v1/endpoints/:uuid
 * Update an endpoint (enable/disable, poll interval) by UUID or name
 * Body: { enabled?: boolean, poll_interval?: number }
 */
router.patch('/v1/endpoints/:uuid', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.updateEndpoint(req.params.uuid, req.body);
		return res.status(200).json({ endpoint: result });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * DELETE /v1/endpoints/:uuid
 * Remove an endpoint from the agent configuration by UUID
 */
router.delete('/v1/endpoints/:uuid', async (req: Request, res: Response, next: NextFunction) => {
	try {
		await actions.removeEndpoint(req.params.uuid);
		return res.status(200).json({ message: 'Endpoint removed' });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * DELETE /v1/endpoints
 * Remove all endpoints from the agent configuration
 */
router.delete('/v1/endpoints', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.removeAllEndpoints();
		return res.status(200).json({ message: `Removed ${result.removed} endpoint(s)`, removed: result.removed });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/devices
 * Get all physical/logical protocol devices
 * Supports filtering by protocol via query parameter: ?protocol=modbus
 */
router.get('/v1/devices', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const devices = await actions.getDevices(req.query.protocol as string | undefined);
		return res.status(200).json({ devices });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/publish/destinations
 * List configured upstream publish destinations
 */
router.get('/v1/publish/destinations', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const includeDisabled = req.query.includeDisabled !== 'false';
		const publishers = await actions.listPublishDestinations(includeDisabled);
		return res.status(200).json({ publishers });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/publish/destinations/test
 * Test connectivity for a destination config without saving it
 */
router.post('/v1/publish/destinations/test', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { type, config_json: cfg } = req.body as { type?: string; config_json?: Record<string, unknown> };
		if (!type) return res.status(400).json({ ok: false, error: 'type is required' });

		if (type === 'influxdb') {
			const url = typeof cfg?.url === 'string' ? cfg.url.trim() : '';
			const token = typeof cfg?.token === 'string' ? cfg.token.trim() : '';
			const org = typeof cfg?.org === 'string' ? cfg.org.trim() : '';
			const bucket = typeof cfg?.bucket === 'string' ? cfg.bucket.trim() : '';

			if (!url) return res.status(200).json({ ok: false, error: 'URL is required' });
			if (!token) return res.status(200).json({ ok: false, error: 'Token is required' });
			if (!org) return res.status(200).json({ ok: false, error: 'Org is required' });
			if (!bucket) return res.status(200).json({ ok: false, error: 'Bucket is required' });

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 8000);
			try {
				// Write a single test point — directly validates token + org + bucket write access
				const testLine = `_connection_test value=1 ${Date.now()}`;
				const r = await fetch(
					`${url}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ms`,
					{
						method: 'POST',
						headers: { Authorization: `Token ${token}`, 'Content-Type': 'text/plain; charset=utf-8' },
						body: testLine,
						signal: controller.signal,
					}
				);
				clearTimeout(timeout);
				if (r.status === 204) return res.status(200).json({ ok: true, message: `Connected — ${org}/${bucket}` });
				if (r.status === 401) return res.status(200).json({ ok: false, error: 'Invalid or missing token' });
				if (r.status === 403) return res.status(200).json({ ok: false, error: 'Token lacks write permission for this bucket' });
				if (r.status === 404) return res.status(200).json({ ok: false, error: `Org "${org}" or bucket "${bucket}" not found` });
				const body = await r.text().catch(() => '');
				return res.status(200).json({ ok: false, error: `HTTP ${r.status}${body ? ': ' + body.slice(0, 120) : ''}` });
			} catch (err: any) {
				clearTimeout(timeout);
				const msg = err?.name === 'AbortError' ? 'Connection timed out' : (err?.message ?? 'Connection failed');
				return res.status(200).json({ ok: false, error: msg });
			}
		}

		if (type === 'mqtt') {
			const { createConnection } = await import('net');
			const brokerUrl = typeof cfg?.brokerUrl === 'string' ? cfg.brokerUrl.trim() : '';
			if (!brokerUrl) return res.status(200).json({ ok: false, error: 'Broker URL is required' });
			try {
				const u = new URL(brokerUrl);
				const host = u.hostname;
				const port = Number(u.port) || (u.protocol === 'mqtts:' ? 8883 : 1883);
				await new Promise<void>((resolve, reject) => {
					const sock = createConnection({ host, port, timeout: 5000 }, () => { sock.destroy(); resolve(); });
					sock.on('error', reject);
					sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP connection timed out')); });
				});
				return res.status(200).json({ ok: true, message: `TCP reachable at ${host}:${port}` });
			} catch (err: any) {
				return res.status(200).json({ ok: false, error: err?.message ?? 'Connection failed' });
			}
		}

		return res.status(200).json({ ok: false, error: `Connection test not supported for type "${type}"` });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/publish/destinations
 * Create an upstream publish destination
 */
router.post('/v1/publish/destinations', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const publisher = await actions.createPublisher(req.body);
		return res.status(201).json({ publisher });
	} catch (error) {
		next(error);
	}
});

/**
 * PATCH /v1/publish/destinations/:id
 * Update an upstream publish destination
 */
router.patch('/v1/publish/destinations/:id', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) {
			return res.status(400).json({ error: 'Invalid destination id' });
		}

		const publisher = await actions.updatePublisher(id, req.body);
		return res.status(200).json({ publisher });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * DELETE /v1/publish/destinations/:id
 * Delete an upstream publish destination
 */
router.delete('/v1/publish/destinations/:id', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) {
			return res.status(400).json({ error: 'Invalid destination id' });
		}

		await actions.deletePublisher(id);
		return res.status(200).json({ deleted: true });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * GET /v1/publish/subscriptions
 * List publish subscriptions (optional query: publish_destination_id)
 */
router.get('/v1/publish/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const includeDisabled = req.query.includeDisabled !== 'false';
		const publishDestinationId = req.query.publish_destination_id ? Number(req.query.publish_destination_id) : undefined;
		if (publishDestinationId !== undefined && !Number.isFinite(publishDestinationId)) {
			return res.status(400).json({ error: 'Invalid publish_destination_id' });
		}

		const subscriptions = await actions.listPublishSubscriptions(publishDestinationId, includeDisabled);
		return res.status(200).json({ subscriptions });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/publish/subscriptions
 * Create a publish subscription
 */
router.post('/v1/publish/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const subscription = await actions.createPublishSubscription(req.body);
		return res.status(201).json({ subscription });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * PATCH /v1/publish/subscriptions/:id
 * Update a publish subscription
 */
router.patch('/v1/publish/subscriptions/:id', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) {
			return res.status(400).json({ error: 'Invalid subscription id' });
		}

		const subscription = await actions.updatePublishSubscription(id, req.body);
		return res.status(200).json({ subscription });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * DELETE /v1/publish/subscriptions/:id
 * Delete a publish subscription
 */
router.delete('/v1/publish/subscriptions/:id', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) {
			return res.status(400).json({ error: 'Invalid subscription id' });
		}

		await actions.deletePublishSubscription(id);
		return res.status(200).json({ deleted: true });
	} catch (error: any) {
		if (error?.statusCode === 404) return res.status(404).json({ error: error.message });
		next(error);
	}
});

/**
 * POST /v1/update
 * Trigger an OTA agent self-update.
 * Body: { version: string, force?: boolean }
 * - version: target version string or "latest"
 * - force: skip same-version guard (default false)
 */
router.post('/v1/update', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { version, force } = req.body as { version?: string; force?: boolean };

		if (!version || typeof version !== 'string' || version.trim() === '') {
			return res.status(400).json({ error: 'version is required (string)' });
		}

		await actions.triggerUpdate(version.trim(), force === true);
		return res.status(202).json({ status: 'update_triggered', version: version.trim() });
	} catch (error: any) {
		if (error?.message === 'Agent updater not available') {
			return res.status(503).json({ error: 'Agent updater not available' });
		}
		next(error);
	}
});

/**
 * GET /v1/discovery-rules
 * List all discovery rules
 */
router.get('/v1/discovery-rules', async (_req: Request, res: Response, next: NextFunction) => {
	try {
		const rules = await actions.listDiscoveryRules();
		return res.status(200).json({ rules });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/discovery-rules
 * Create a discovery rule
 */
router.post('/v1/discovery-rules', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const rule = await actions.createDiscoveryRule(req.body);
		return res.status(201).json({ rule });
	} catch (error) {
		next(error);
	}
});

/**
 * PATCH /v1/discovery-rules/:uuid
 * Update a discovery rule
 */
router.patch('/v1/discovery-rules/:uuid', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const rule = await actions.updateDiscoveryRule(req.params.uuid, req.body);
		return res.status(200).json({ rule });
	} catch (error) {
		next(error);
	}
});

/**
 * DELETE /v1/discovery-rules/:uuid
 * Delete a discovery rule
 */
router.delete('/v1/discovery-rules/:uuid', async (req: Request, res: Response, next: NextFunction) => {
	try {
		await actions.deleteDiscoveryRule(req.params.uuid);
		return res.status(204).send();
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/discovery-rules/:uuid/run
 * Trigger a discovery rule immediately
 */
router.post('/v1/discovery-rules/:uuid/run', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.runDiscoveryRule(req.params.uuid);
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/discovery-rules/:uuid/runs
 * Run history for a specific rule
 */
router.get('/v1/discovery-rules/:uuid/runs', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
		const runs = await actions.listDiscoveryRuns(req.params.uuid, limit);
		return res.status(200).json({ runs });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/discovery-runs
 * Recent runs across all rules
 */
router.get('/v1/discovery-runs', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
		const runs = await actions.listRecentDiscoveryRuns(limit);
		return res.status(200).json({ runs });
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/settings
 * Return the user-editable agent settings (logging, features, intervals, runtime,
 * anomalyDetection) plus read-only agent identity (uuid, name, version).
 */
router.get('/v1/settings', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const settings = await actions.getSettings();
		return res.status(200).json({ settings });
	} catch (error) {
		next(error);
	}
});

/**
 * PATCH /v1/settings
 * Merge a partial settings object into the target config and trigger reconciliation.
 * Only recognised top-level keys (logging, features, intervals, runtime,
 * anomalyDetection) are applied; everything else is silently ignored.
 */
router.patch('/v1/settings', async (req: Request, res: Response, next: NextFunction) => {
	try {
		if (!req.body || typeof req.body !== 'object') {
			return res.status(400).json({ error: 'Request body must be a JSON object' });
		}
		await actions.updateSettings(req.body);
		const settings = await actions.getSettings();
		return res.status(200).json({ settings });
	} catch (error) {
		next(error);
	}
});

// ── Dashboard stats ───────────────────────────────────────────────────────────

router.get('/v1/dashboard/stats', async (_req: Request, res: Response, next: NextFunction) => {
	try {
		const [cpu, mem, storage, uptime, hostname, network] = await Promise.all([
			getCpuUsage(),
			getMemoryInfo(),
			getStorageInfo(),
			getUptime(),
			getHostname(),
			getNetworkBandwidth(),
		]);
		return res.status(200).json({
			cpu_usage: cpu,
			memory_percent: mem.percent,
			memory_used: mem.used,
			memory_total: mem.total,
			storage_percent: storage.percent,
			storage_used: storage.used,
			storage_total: storage.total,
			uptime,
			hostname,
			network,
		});
	} catch (error) {
		next(error);
	}
});

// ── Auth: login / logout / me ────────────────────────────────────────────────

function parseCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const [k, v] = part.trim().split('=');
		if (k === name) return v;
	}
	return undefined;
}

const SESSION_COOKIE = 'admin_session';
const COOKIE_OPTS = 'HttpOnly; Path=/; SameSite=Strict; Max-Age=86400';

router.post('/v1/auth/login', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username, password } = req.body ?? {};
		if (!username || !password) {
			return res.status(400).json({ error: 'username and password are required' });
		}
		const user = UserModel.getByUsername(username);
		if (!user || !user.is_active) {
			return res.status(401).json({ error: 'Invalid credentials' });
		}
		const hash = UserModel.getPasswordHash(username);
		if (!hash) return res.status(401).json({ error: 'Invalid credentials' });
		const ok = await bcrypt.compare(password, hash);
		if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
		const token = AdminSessionModel.create(username);
		res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${COOKIE_OPTS}`);
		return res.status(200).json({ username, is_superuser: user.is_superuser });
	} catch (error) {
		next(error);
	}
});

router.post('/v1/auth/logout', (req: Request, res: Response) => {
	const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
	if (token) AdminSessionModel.delete(token);
	res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
	return res.status(200).json({ ok: true });
});

router.get('/v1/auth/me', (req: Request, res: Response) => {
	const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
	if (!token) return res.status(401).json({ error: 'Not authenticated' });
	const session = AdminSessionModel.find(token);
	if (!session) return res.status(401).json({ error: 'Session expired' });
	const user = UserModel.getByUsername(session.username);
	if (!user) return res.status(401).json({ error: 'User not found' });
	return res.status(200).json({ username: user.username, is_superuser: user.is_superuser });
});

// ── Session guard for all /v1/admin/* routes ─────────────────────────────────

router.use('/v1/admin', (req: Request, res: Response, next: NextFunction) => {
	const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
	if (!token) return res.status(401).json({ error: 'Not authenticated' });
	const session = AdminSessionModel.find(token);
	if (!session) return res.status(401).json({ error: 'Session expired' });
	(req as any).adminUser = session.username;
	next();
});

// ── Administration: Users ────────────────────────────────────────────────────

router.get('/v1/admin/users', (_req: Request, res: Response, next: NextFunction) => {
	try {
		return res.status(200).json({ users: UserModel.getAll() });
	} catch (error) {
		next(error);
	}
});

router.post('/v1/admin/users', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username, password, is_superuser = false } = req.body ?? {};
		if (!username || typeof username !== 'string' || !username.trim()) {
			return res.status(400).json({ error: 'username is required' });
		}
		if (!password || typeof password !== 'string' || password.length < 6) {
			return res.status(400).json({ error: 'password must be at least 6 characters' });
		}
		if (UserModel.existsByUsername(username.trim())) {
			return res.status(409).json({ error: 'Username already exists' });
		}
		const hash = await bcrypt.hash(password, 10);
		const user = UserModel.create(username.trim(), hash, Boolean(is_superuser));
		return res.status(201).json({ user });
	} catch (error) {
		next(error);
	}
});

router.patch('/v1/admin/users/:username', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username } = req.params;
		if (!UserModel.existsByUsername(username)) {
			return res.status(404).json({ error: 'User not found' });
		}
		const { is_active, is_superuser, password } = req.body ?? {};
		const fields: { is_active?: boolean; is_superuser?: boolean; password_hash?: string } = {};
		if (is_active !== undefined) fields.is_active = Boolean(is_active);
		if (is_superuser !== undefined) fields.is_superuser = Boolean(is_superuser);
		if (password) {
			if (typeof password !== 'string' || password.length < 6) {
				return res.status(400).json({ error: 'password must be at least 6 characters' });
			}
			fields.password_hash = await bcrypt.hash(password, 10);
		}
		const user = UserModel.update(username, fields);
		return res.status(200).json({ user });
	} catch (error) {
		next(error);
	}
});

router.delete('/v1/admin/users/:username', (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username } = req.params;
		if (!UserModel.existsByUsername(username)) {
			return res.status(404).json({ error: 'User not found' });
		}
		UserModel.delete(username);
		return res.status(200).json({ ok: true });
	} catch (error) {
		next(error);
	}
});

export default router;
