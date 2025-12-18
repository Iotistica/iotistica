/**
 * Device API v1 Router
 * Simplified version of balena supervisor v1 API
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as actions from './actions';

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
 * Reboot the agent (graceful restart via process.exit)
 */
router.post('/v1/reboot', async (req: Request, res: Response, next: NextFunction) => {
	try {
		console.log('Agent reboot requested - exiting process for restart');
		
		// Send response before exiting
		res.status(202).json({ 
			Data: 'Agent restarting', 
			Error: null 
		});
		
		// Close the response and exit (Docker/systemd will restart the container/process)
		res.end();
		
		// Give time for response to be sent
		setTimeout(() => {
			process.exit(0);
		}, 1000);
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
 * Factory reset - complete data wipe (WARNING: deletes all apps, services, state, sensors)
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

export default router;
