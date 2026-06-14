/**
 * Device API v1 Router
 * Simplified version of balena supervisor v1 API
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as actions from './actions';
import { ModbusAdapter } from '../plugins/modbus/adapter.js';
import { getMemoryDiagnostics, getRestartPolicyStatus } from '../system/memory.js';

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
		const rule = await actions.runDiscoveryRule(req.params.uuid);
		return res.status(200).json({ rule });
	} catch (error) {
		next(error);
	}
});

export default router;
