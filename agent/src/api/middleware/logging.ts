/**
 * Request logging middleware
 */

import type { Request, Response, NextFunction } from 'express';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

let logger: AgentLogger | undefined;

export function setLogger(agentLogger?: AgentLogger) {
	logger = agentLogger;
}

export default function logging(req: Request, res: Response, next: NextFunction) {
	const start = Date.now();
	
	res.on('finish', () => {
		const duration = Date.now() - start;
		const logMessage = `${req.method} ${req.path}`;
		const context = {
			component: LogComponents.deviceApi,
			statusCode: res.statusCode,
			duration: `${duration}ms`,
			method: req.method,
			path: req.path
		};
		
		// Skip logging for health check endpoints
		const isHealthCheck = req.path === '/ping' || req.path === '/health' || req.path === '/healthz';
		
		if (logger && !isHealthCheck) {
			if (res.statusCode >= 500) {
				logger.errorSync(logMessage, undefined, context);
			} else if (res.statusCode >= 400) {
				logger.warnSync(logMessage, context);
			} else {
				// Use debug for routine successful requests to reduce cloud log volume
				logger.debugSync(logMessage, context);
			}
		} else if (!logger && !isHealthCheck) {
			// Fallback to console if logger not available (skip health checks)
			console.log(`${logMessage} - ${res.statusCode} (${duration}ms)`);
		}
	});
	
	next();
}
