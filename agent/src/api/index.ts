/**
 * Device API for Standalone Application Manager
 * Adapted from balena-supervisor device API
 * Simplified version without balena-specific dependencies
 */

import express from 'express';
import type { Server } from 'http';
import { join } from 'path';
import * as middleware from './middleware';
import * as actions from './actions';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

interface DeviceAPIConstructOpts {
	routers: express.Router[];
	healthchecks?: Array<() => Promise<boolean>>;
	logger?: AgentLogger;
}

export class DeviceAPI {
	private routers: express.Router[];
	private healthchecks: Array<() => Promise<boolean>>;
	private logger?: AgentLogger;

	private api = express();
	private server: Server | null = null;

	public constructor({ routers, healthchecks = [], logger }: DeviceAPIConstructOpts) {
		this.routers = routers;
		this.healthchecks = healthchecks;
		this.logger = logger;

		// Set logger for middleware
		if (logger) {
			middleware.setLoggingLogger(logger);
			middleware.setNetworkSecurityLogger(logger);
			middleware.setErrorsLogger(logger);
			actions.initVpnActions(logger);  // Initialize VPN actions
		}

		this.api.disable('x-powered-by');
		this.api.use(middleware.logging);
		
		// Network-based security (enabled by default - localhost only)
		this.api.use(middleware.networkSecurity);

		// Health check endpoint
		this.api.get('/v1/healthy', async (_req, res) => {
			const isHealthy = await actions.runHealthchecks(this.healthchecks);
			const payload = actions.getHealthPayload(isHealthy);
			if (isHealthy) {
				return res.status(200).json(payload);
			} else {
				return res.status(500).json(payload);
			}
		});

		// Readiness endpoint
		this.api.get('/v1/readiness', (_req, res) => {
			const payload = actions.getReadinessPayload();
			if (payload.ready) {
				return res.status(200).json(payload);
			}
			return res.status(503).json(payload);
		});

		// Detailed health report endpoint
		this.api.get('/v1/health/report', (_req, res) => {
			const payload = actions.getHealthReportPayload();
			if (payload.overall === 'healthy') {
				return res.status(200).json(payload);
			}
			return res.status(500).json(payload);
		});

		// Buffer status summary endpoint
		this.api.get('/v1/buffer/status', async (_req, res, next) => {
			try {
				const payload = await actions.getBufferStatusPayload();
				return res.status(200).json(payload);
			} catch (error) {
				return next(error);
			}
		});

		// Ping endpoint
		this.api.get('/ping', (_req, res) => res.send('OK'));

		// Silence browser/tooling probes (Chrome DevTools, etc.)
		this.api.get('/.well-known/*', (_req, res) => res.json({}));

		// Authentication middleware:
		// - Explicitly enabled with ENABLE_AUTH=true
		// - Implicitly required when API_SECURITY_MODE=API_KEY
		const securityMode = process.env.API_SECURITY_MODE || 'LOCALHOST_ONLY';
		const authEnabled = process.env.ENABLE_AUTH === 'true' || securityMode === 'API_KEY';
		if (authEnabled) {
			this.api.use(middleware.auth);
		}

		// Parse request bodies
		this.api.use(express.urlencoded({ limit: '10mb', extended: true }));
		this.api.use(express.json({ limit: '10mb' }));

		// Serve admin panel static files (built output from agent/admin/dist)
		const adminDist = join(__dirname, '../../admin/dist');
		// Hashed assets (JS/CSS chunks) get long-lived cache; index.html must never be cached
		// so browsers always get the latest chunk manifest after an upgrade.
		this.api.use('/admin', express.static(adminDist, { maxAge: '1y', immutable: true }));
		this.api.get('/admin/*', (_req, res) => {
			res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
			res.sendFile(join(adminDist, 'index.html'));
		});

		// Mount all routers
		for (const router of this.routers) {
			this.api.use(router);
		}

		// Error handling middleware
		this.api.use(middleware.errors);
	}

	public async listen(port: number, timeout: number = 300000): Promise<void> {
		const securityMode = process.env.API_SECURITY_MODE || 'LOCALHOST_ONLY';
		const host = process.env.DEVICE_API_HOST || (securityMode === 'LOCALHOST_ONLY' ? '127.0.0.1' : '0.0.0.0');

		return new Promise((resolve) => {
			this.server = this.api.listen(port, host, () => {
				if (this.server) {
					this.server.timeout = timeout;
				}
				this.logger?.infoSync('Device API listening', {
					component: LogComponents.agent,
					port,
					host,
					securityMode,
				});
				return resolve();
			});
		});
	}

	public async stop(): Promise<void> {
		if (this.server != null) {
			const server = this.server;
			this.server = null;
			return new Promise((resolve, reject) => {
				server.close((err: Error) => {
					if (err) {
						this.server = server;
						return reject(err);
					} else {
						this.logger?.infoSync('Stopped Device API', {
							component: LogComponents.agent
						});
						return resolve();
					}
				});
			});
		} else {
			this.logger?.warnSync('Device API already stopped, ignoring further requests', {
				component: LogComponents.agent
			});
		}
	}

	public getApp(): express.Application {
		return this.api;
	}

	public getServer(): Server | null {
		return this.server;
	}
}

export default DeviceAPI;
