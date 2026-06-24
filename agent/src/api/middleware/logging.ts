/**
 * Request logging middleware
 */

import type { Request, Response, NextFunction } from 'express';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

let logger: AgentLogger | undefined;

function isHealthCheckPath(path: string): boolean {
	return path === '/ping'
		|| path === '/health'
		|| path === '/healthz'
		|| path === '/v1/healthy'
		|| path === '/v1/readiness'
		|| path === '/v1/health/report'
		|| path.startsWith('/.well-known/');
}

function isSilentDebugPath(_path: string): boolean {
	return false;
}

export function setLogger(agentLogger?: AgentLogger) {
	logger = agentLogger;
}

export default function logging(req: Request, res: Response, next: NextFunction) {
	const start = Date.now();

	// Log incoming mutating requests immediately so they appear before any async work they trigger
	if (logger && !isHealthCheckPath(req.path) && req.method !== 'GET') {
		logger.debugSync(`${req.method} ${req.path} received`, {
			component: LogComponents.deviceApi,
			method: req.method,
			path: req.path
		});
	}

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
		const isHealthCheck = isHealthCheckPath(req.path);
		const suppressDebugLog = isSilentDebugPath(req.path);
		
		if (logger && !isHealthCheck) {
			if (res.statusCode >= 500) {
				logger.errorSync(logMessage, undefined, context);
			} else if (res.statusCode >= 400) {
				logger.warnSync(logMessage, context);
			}
			// 2xx: incoming request was already logged on arrival — no duplicate needed
		} else if (!logger && !isHealthCheck && !suppressDebugLog) {
			// Fallback to console if logger not available (skip health checks)
			console.log(`${logMessage} - ${res.statusCode} (${duration}ms)`);
		}
	});
	
	next();
}
