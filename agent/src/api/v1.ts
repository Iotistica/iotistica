/**
 * Device API v1 Router
 * Simplified version of balena supervisor v1 API
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { LogFilter } from '../logging/types.js';
import { PassThrough } from 'stream';
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
 * GET /v1/app-templates
 * Returns the built-in catalog of one-click deployable application templates.
 */
import { APP_TEMPLATES, TEMPLATE_CATEGORIES } from '../data/app-templates.js';

router.get('/v1/app-templates', (_req: Request, res: Response) => {
	return res.status(200).json({ templates: APP_TEMPLATES, categories: TEMPLATE_CATEGORIES });
});

/**
 * GET /v1/apps
 * List all apps with current runtime state
 */
router.get('/v1/apps', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const apps = await actions.getAllApps();
		return res.status(200).json({ apps });
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/apps
 * Deploy a new application (adds to target state and reconciles)
 */
router.post('/v1/apps', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.deployApp(req.body);
		return res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * DELETE /v1/apps/:appId
 * Remove an application from target state (stops + removes containers)
 */
router.delete('/v1/apps/:appId', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		if (isNaN(appId)) return res.status(400).json({ error: 'Invalid app id' });
		await actions.removeApp(appId);
		return res.status(204).send();
	} catch (error) {
		next(error);
	}
});

/**
 * POST /v1/apps/:appId/services
 * Add a service to an existing application
 */
router.post('/v1/apps/:appId/services', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		if (isNaN(appId)) return res.status(400).json({ error: 'Invalid app id' });
		const result = await actions.addService(appId, req.body);
		return res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * PUT /v1/apps/:appId/services/:serviceName
 * Update a service's config; triggers reconciliation (container recreated if needed)
 */
router.put('/v1/apps/:appId/services/:serviceName', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		const { serviceName } = req.params;
		if (isNaN(appId)) return res.status(400).json({ error: 'Invalid app id' });
		const result = await actions.updateService(appId, serviceName, req.body);
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * DELETE /v1/apps/:appId/services/:serviceName
 * Remove a service from an app (stops + removes its container)
 */
router.delete('/v1/apps/:appId/services/:serviceName', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		const { serviceName } = req.params;
		if (isNaN(appId)) return res.status(400).json({ error: 'Invalid app id' });
		await actions.removeService(appId, serviceName);
		return res.status(204).send();
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/apps/:appId/services/:serviceName/logs
 * Stream container logs via SSE.
 * ?tail=200   — how many historical lines to include
 * ?follow=true — keep connection open and stream new lines
 * ?timestamps=true — prefix each line with Docker timestamp
 */
router.get('/v1/apps/:appId/services/:serviceName/logs', async (req: Request, res: Response) => {
	const appId = parseInt(req.params.appId);
	const { serviceName } = req.params;
	const tail = Math.min(parseInt(req.query.tail as string) || 200, 2000);
	const follow = req.query.follow === 'true';
	const timestamps = req.query.timestamps !== 'false';

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	const send = (data: object) => {
		try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* ignore closed connection */ }
	};

	if (isNaN(appId)) { send({ error: 'Invalid app id' }); res.end(); return; }

	try {
		const containerId = await actions.getServiceContainerId(appId, serviceName);
		if (!containerId) { send({ error: 'Container is not running' }); res.end(); return; }

		const docker = actions.getDockerInstance();
		if (!docker) { send({ error: 'Docker not available' }); res.end(); return; }

		const container = docker.getContainer(containerId);

		if (!follow) {
			// One-shot: get buffer, parse multiplexed frames, close
			const buf = await (container as any).logs({
				follow: false, stdout: true, stderr: true, timestamps, tail,
			}) as Buffer;
			for (const line of parseMuxedLogs(buf)) send(line);
			res.end();
		} else {
			// Live follow: demux stream into SSE events until client disconnects
			const logStream = await (container as any).logs({
				follow: true, stdout: true, stderr: true, timestamps, tail,
			}) as NodeJS.ReadableStream;

			const stdout = new PassThrough();
			const stderr = new PassThrough();
			(container as any).modem.demuxStream(logStream, stdout, stderr);

			const writeLines = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
				for (const line of chunk.toString('utf8').split('\n')) {
					if (line) send({ msg: line, stream });
				}
			};

			stdout.on('data', writeLines('stdout'));
			stderr.on('data', writeLines('stderr'));
			stdout.on('end', () => { try { res.end(); } catch { /* ignore */ } });

			req.on('close', () => {
				try { (logStream as any).destroy(); } catch { /* ignore */ }
				stdout.destroy();
				stderr.destroy();
			});
		}
	} catch (e) {
		send({ error: (e as Error).message });
		try { res.end(); } catch { /* ignore */ }
	}
});

function parseMuxedLogs(buf: Buffer): Array<{ msg: string; stream: 'stdout' | 'stderr' }> {
	const result: Array<{ msg: string; stream: 'stdout' | 'stderr' }> = [];
	let offset = 0;
	while (offset + 8 <= buf.length) {
		const streamType = buf[offset];
		const size = buf.readUInt32BE(offset + 4);
		offset += 8;
		if (offset + size > buf.length) break;
		const text = buf.subarray(offset, offset + size).toString('utf8');
		const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
		for (const line of text.split('\n')) {
			if (line.trim()) result.push({ msg: line, stream });
		}
		offset += size;
	}
	return result;
}

/**
 * POST /v1/apps/:appId/services/:serviceName/start|stop|restart
 * Perform an action on a specific service
 */
router.post('/v1/apps/:appId/services/:serviceName/:action', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const appId = parseInt(req.params.appId);
		const { serviceName, action } = req.params;
		if (isNaN(appId)) return res.status(400).json({ error: 'Invalid app id' });
		if (!['start', 'stop', 'restart'].includes(action)) {
			return res.status(400).json({ error: 'Invalid action — use start, stop, or restart' });
		}
		const result = await actions.serviceAction(appId, serviceName, action as 'start' | 'stop' | 'restart');
		return res.status(200).json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * GET /v1/docker/config — read current Docker daemon config
 * POST /v1/docker/config — save + reconnect
 * POST /v1/docker/test  — test without saving
 */
router.get('/v1/docker/config', async (_req: Request, res: Response, next: NextFunction) => {
	try { return res.json(await actions.getDockerConfig()); } catch (e) { next(e); }
});
router.post('/v1/docker/config', async (req: Request, res: Response, next: NextFunction) => {
	try { await actions.saveDockerConfig(req.body); return res.json({ ok: true }); } catch (e) { next(e); }
});
router.post('/v1/docker/test', async (req: Request, res: Response, next: NextFunction) => {
	try { return res.json(await actions.testDockerConnection(req.body)); } catch (e) { next(e); }
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
 * GET /v1/logs
 * Return in-memory agent logs from LocalLogBackend.
 * Query: ?level=info|warn|error|debug, ?source=system|container|manager,
 *        ?since=<unixMs>, ?limit=<n> (default 200)
 */
router.get('/v1/logs', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const backend = actions.getLocalLogBackend();
		if (!backend) {
			return res.status(503).json({ error: 'Log backend not available' });
		}
		const filter: LogFilter = {
			level: req.query.level as any,
			sourceType: req.query.source as any,
			since: req.query.since ? Number(req.query.since) : undefined,
			limit: req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200,
		};
		// Drop undefined keys so getLogs doesn't treat them as active filters
		Object.keys(filter).forEach(k => (filter as any)[k] === undefined && delete (filter as any)[k]);
		const logs = await backend.getLogs(filter);
		const total = await backend.getLogCount();
		return res.json({ logs, total });
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
		if (severity) alerts = alerts.filter((a: any) => a.severity === severity);
		if (metric) alerts = alerts.filter((a: any) => a.metric === metric);
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
 * DELETE /v1/anomaly/baselines
 * Clear all persisted baseline statistics from SQLite and reset in-memory buffers.
 */
router.delete('/v1/anomaly/baselines', (req: Request, res: Response, next: NextFunction) => {
	try {
		const deleted = actions.clearAnomalyBaselines();
		return res.status(200).json({ deleted });
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
 * PUT /v1/endpoints/:uuid
 * Full replace — update all fields including name, protocol, connection, data_points.
 */
router.put('/v1/endpoints/:uuid', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = await actions.replaceEndpoint(req.params.uuid, req.body);
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
			let brokerUrl = typeof cfg?.brokerUrl === 'string' ? cfg.brokerUrl.trim() : '';
			if (!brokerUrl && typeof cfg?.host === 'string' && cfg.host) {
				const port = typeof cfg.port === 'number' ? cfg.port : 1883;
				brokerUrl = `mqtt://${cfg.host}:${port}`;
			}
			if (!brokerUrl) return res.status(200).json({ ok: false, error: 'Host is required' });
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
 * GET /v1/protocol-outputs
 * Return all protocol output configs (one per protocol: modbus, opcua, bacnet…).
 */
router.get('/v1/protocol-outputs', async (_req: Request, res: Response, next: NextFunction) => {
	try {
		const { EndpointOutputModel } = await import('../db/models/endpoint-outputs.model.js');
		const outputs = await EndpointOutputModel.getAll();
		res.json({ outputs });
	} catch (err) {
		next(err);
	}
});

/**
 * PATCH /v1/protocol-outputs/:protocol/drift
 * Update schema drift options for a single protocol pipe.
 */
router.patch('/v1/protocol-outputs/:protocol/drift', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { protocol } = req.params;
		const { EndpointOutputModel } = await import('../db/models/endpoint-outputs.model.js');
		const existing = await EndpointOutputModel.getOutput(protocol);
		if (!existing) {
			res.status(404).json({ error: `Protocol output not found: ${protocol}` });
			return;
		}
		const body = req.body ?? {};
		const drift_options = body.drift_options === null ? null : {
			...existing.drift_options,
			...body.drift_options,
		};
		const updated = await EndpointOutputModel.setOutput({ ...existing, drift_options });
		res.json({ output: updated });
	} catch (err) {
		next(err);
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

router.patch('/v1/settings/target-sync', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { enabled } = req.body ?? {};
		if (typeof enabled !== 'boolean') {
			return res.status(400).json({ error: '"enabled" (boolean) is required' });
		}
		await actions.setTargetSyncEnabled(enabled);
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
		if (!user?.is_active) {
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

// ── Administration: Sessions ──────────────────────────────────────────────────

router.get('/v1/admin/sessions', (_req: Request, res: Response, next: NextFunction) => {
	try {
		const now = Date.now();
		const sessions = AdminSessionModel.getAll().map((s) => ({
			token: s.token.slice(0, 8) + '…',
			token_id: s.token,
			username: s.username,
			created_at: new Date(s.created_at).toISOString(),
			expires_at: new Date(s.expires_at).toISOString(),
			active: s.expires_at > now,
		}));
		return res.status(200).json({ sessions });
	} catch (error) {
		next(error);
	}
});

router.delete('/v1/admin/sessions/:token', (req: Request, res: Response, next: NextFunction) => {
	try {
		const deleted = AdminSessionModel.deleteByToken(req.params.token);
		if (!deleted) return res.status(404).json({ error: 'Session not found' });
		return res.status(200).json({ ok: true });
	} catch (error) {
		next(error);
	}
});

// ── MQTT Broker Monitor (/v1/mqtt/*) ──────────────────────────────────────────

import { BrokerMonitorService } from '../mqtt/broker-monitor.js';

// ── MQTT Users (/v1/mqtt/users) ───────────────────────────────────────────────
// Users are stored in the mqtt_users SQLite table so they survive builds and
// cloud-state syncs. The auth reconciler picks them up on every reconcile cycle.

import { generateMosquittoHash } from '../mqtt/auth.js';
import { MqttUserModel } from '../db/models/mqtt-user.model.js';

router.get('/v1/mqtt/users', (_req: Request, res: Response, next: NextFunction) => {
	try {
		const bootstrapUsername = process.env.MQTT_USERNAME ?? 'admin';
		const localUsers = MqttUserModel.getAll();
		const users = [
			{ username: bootstrapUsername, topic: '#', access: 'readwrite', superuser: true },
			...localUsers
				.filter(u => u.username !== bootstrapUsername)
				.map(u => ({
					username: u.username,
					topic: '#',
					access: u.is_superuser ? 'readwrite' : 'readwrite',
					superuser: u.is_superuser,
				})),
		];
		res.json({ users });
	} catch (err) { next(err); }
});

router.post('/v1/mqtt/users', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username, password } = req.body ?? {};
		if (!username || typeof username !== 'string') return res.status(400).json({ error: '"username" is required' });
		if (!password || typeof password !== 'string') return res.status(400).json({ error: '"password" is required' });
		const bootstrapUsername = process.env.MQTT_USERNAME ?? 'admin';
		if (username === bootstrapUsername) return res.status(400).json({ error: 'Cannot create a user with the admin username' });
		if (MqttUserModel.existsByUsername(username)) return res.status(409).json({ error: `User "${username}" already exists` });

		const passwordHash = generateMosquittoHash(password);
		MqttUserModel.create(username, passwordHash);
		await actions.reconcileMqttAuth();
		res.status(201).json({ ok: true, username });
	} catch (err) { next(err); }
});

router.delete('/v1/mqtt/users/:username', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { username } = req.params;
		const bootstrapUsername = process.env.MQTT_USERNAME ?? 'admin';
		if (username === bootstrapUsername) return res.status(400).json({ error: 'Cannot delete the bootstrap admin user' });
		if (!MqttUserModel.existsByUsername(username)) return res.status(404).json({ error: `User "${username}" not found` });
		MqttUserModel.delete(username);
		await actions.reconcileMqttAuth();
		res.json({ ok: true });
	} catch (err) { next(err); }
});

router.get('/v1/mqtt/broker/status', (_req: Request, res: Response) => {
	const monitor = BrokerMonitorService.getInstance();
	res.json(monitor.getStatus());
});

router.get('/v1/mqtt/broker/metrics', (_req: Request, res: Response) => {
	const monitor = BrokerMonitorService.getInstance();
	res.json(monitor.getMetrics());
});

router.get('/v1/mqtt/broker/topic-tree', (_req: Request, res: Response) => {
	const monitor = BrokerMonitorService.getInstance();
	res.json(monitor.getTopicTree());
});

router.get('/v1/mqtt/topics', (_req: Request, res: Response) => {
	const monitor = BrokerMonitorService.getInstance();
	res.json(monitor.getTopics());
});

router.post('/v1/mqtt/broker/test', (req: Request, res: Response) => {
	const { url, username, password } = req.body ?? {};
	if (typeof url !== 'string' || !url.trim()) {
		return res.status(400).json({ ok: false, error: '"url" is required' });
	}
	import('mqtt').then(({ default: mqtt }) => {
		let settled = false;
		const client = mqtt.connect(url.trim(), {
			clientId: `iotistica-test-${Math.random().toString(36).slice(2, 8)}`,
			clean: true,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			...(username ? { username, password: password ?? '' } : {}),
		});
		const finish = (ok: boolean, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.end(true);
			res.json({ ok, ...(error ? { error } : {}) });
		};
		const timer = setTimeout(() => finish(false, 'Connection timed out'), 9000);
		client.on('connect', () => finish(true));
		client.on('error', (err: Error) => finish(false, err.message));
	}).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
});

router.patch('/v1/mqtt/broker/config', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { url, username, password } = req.body ?? {};
		if (typeof url !== 'string' || !url.trim()) {
			return res.status(400).json({ error: '"url" (string) is required' });
		}
		// If password is blank, keep whatever is already persisted
		let resolvedPassword: string = password ?? '';
		if (!resolvedPassword) {
			const existing = await actions.getSettings();
			resolvedPassword = existing.mqttMonitor?.password ?? '';
		}
		// Persist to settings
		await actions.updateSettings({
			mqttMonitor: { url: url.trim(), username: username ?? '', password: resolvedPassword },
		});
		// Apply immediately — reconnect the live monitor
		const monitor = BrokerMonitorService.getInstance();
		monitor.reconfigure(url.trim(), username ?? '', resolvedPassword);
		return res.status(200).json({ ok: true });
	} catch (error) {
		next(error);
	}
});

// ─── Database Backups ─────────────────────────────────────────────────────────

import {
	createDbBackup,
	listDbBackups,
	restoreDbFromBackup,
	getDefaultBackupDir,
} from '../db/backup.js';
import { getDatabasePath } from '../db/db-path.js';
import { BackupScheduleModel } from '../db/models/backup-schedule.model.js';
import { join as pathJoin } from 'path';
import { existsSync, rmSync } from 'fs';

/** GET /v1/backups — list all database backups */
router.get('/v1/backups', async (_req: Request, res: Response, next: NextFunction) => {
	try {
		const dbPath = getDatabasePath();
		const backupDir = getDefaultBackupDir(dbPath);
		const backups = listDbBackups({ backupDir });
		return res.status(200).json({ backups });
	} catch (error) {
		next(error);
	}
});

/** POST /v1/backups — create a new database backup */
router.post('/v1/backups', async (_req: Request, res: Response, next: NextFunction) => {
	try {
		const dbPath = getDatabasePath();
		const backup = await createDbBackup({ dbPath });
		return res.status(201).json({ backup });
	} catch (error) {
		next(error);
	}
});

/** POST /v1/backups/:fileName/restore — restore database from a named backup */
router.post('/v1/backups/:fileName/restore', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { fileName } = req.params;
		const dbPath = getDatabasePath();
		const backupDir = getDefaultBackupDir(dbPath);
		const backupPath = pathJoin(backupDir, fileName);
		const result = await restoreDbFromBackup({ dbPath, backupPath, createPreRestoreBackup: true });
		return res.status(200).json({ ok: true, restoredPath: result.restoredPath, preRestoreBackupPath: result.preRestoreBackupPath });
	} catch (error) {
		next(error);
	}
});

/** DELETE /v1/backups/:fileName — delete a backup file */
router.delete('/v1/backups/:fileName', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const { fileName } = req.params;
		const dbPath = getDatabasePath();
		const backupDir = getDefaultBackupDir(dbPath);
		const backupPath = pathJoin(backupDir, fileName);
		const metaPath = `${backupPath}.meta.json`;
		if (!existsSync(backupPath)) {
			return res.status(404).json({ error: 'Backup not found' });
		}
		rmSync(backupPath, { force: true });
		rmSync(metaPath, { force: true });
		return res.status(200).json({ ok: true });
	} catch (error) {
		next(error);
	}
});

/** GET /v1/backups/schedule — get the current backup schedule config */
router.get('/v1/backups/schedule', (_req: Request, res: Response, next: NextFunction) => {
	try {
		const schedule = BackupScheduleModel.get();
		return res.status(200).json({ schedule });
	} catch (error) {
		next(error);
	}
});

/** PUT /v1/backups/schedule — update the backup schedule config */
router.put('/v1/backups/schedule', (req: Request, res: Response, next: NextFunction) => {
	try {
		const { enabled, intervalHours, keepCount } = req.body as {
			enabled?: boolean;
			intervalHours?: number;
			keepCount?: number;
		};

		const patch: Parameters<typeof BackupScheduleModel.upsert>[0] = {};
		if (typeof enabled === 'boolean') patch.enabled = enabled;
		if (typeof intervalHours === 'number' && intervalHours >= 1) patch.intervalHours = intervalHours;
		if (typeof keepCount === 'number' && keepCount >= 1) patch.keepCount = keepCount;

		// When enabling or changing the interval, recalculate next_run_at
		if (patch.intervalHours !== undefined || patch.enabled) {
			const current = BackupScheduleModel.get();
			const hours = patch.intervalHours ?? current.intervalHours;
			patch.nextRunAt = new Date(Date.now() + hours * 3_600_000).toISOString();
		}

		const schedule = BackupScheduleModel.upsert(patch);
		return res.status(200).json({ schedule });
	} catch (error) {
		next(error);
	}
});

export default router;
