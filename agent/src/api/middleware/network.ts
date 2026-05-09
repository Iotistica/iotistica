/**
 * Network-based security middleware
 * Restricts API access based on client IP address
 * 
 * Security modes:
 * - LOCALHOST_ONLY: Only allow 127.0.0.1, ::1, ::ffff:127.0.0.1
 * - LOCAL_NETWORK: Allow localhost + private network ranges
 * - API_KEY: Require API key (for remote access)
 * - OPEN: No restrictions (NOT RECOMMENDED for production)
 */

import type { Request, Response, NextFunction } from 'express';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

let logger: AgentLogger | undefined;

export function setNetworkSecurityLogger(agentLogger: AgentLogger) {
	logger = agentLogger;
}

type SecurityMode = 'LOCALHOST_ONLY' | 'LOCAL_NETWORK' | 'API_KEY' | 'OPEN';

// Get security mode from environment (default: LOCALHOST_ONLY for safety)
const SECURITY_MODE = (process.env.API_SECURITY_MODE as SecurityMode) || 'LOCALHOST_ONLY';

// Localhost addresses (IPv4 and IPv6)
const LOCALHOST_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

// Private network ranges (RFC 1918)
const PRIVATE_RANGES = [
	/^127\./,                          // 127.0.0.0/8 (localhost)
	/^10\./,                           // 10.0.0.0/8
	/^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
	/^192\.168\./,                     // 192.168.0.0/16
	/^::1$/,                           // IPv6 localhost
	/^fe80:/,                          // IPv6 link-local
	/^fc00:/,                          // IPv6 unique local
];

/**
 * Normalize IP for comparisons.
 * Express may report IPv4 addresses as IPv6-mapped form (e.g. ::ffff:172.18.0.13).
 */
function normalizeIP(ip: string): string {
	if (ip.startsWith('::ffff:')) {
		return ip.substring(7);
	}
	return ip;
}

/**
 * Check if IP is localhost
 */
function isLocalhost(ip: string): boolean {
	const normalized = normalizeIP(ip);
	return LOCALHOST_IPS.includes(ip) || LOCALHOST_IPS.includes(normalized);
}

/**
 * Check if IP is in private network range
 */
function isPrivateNetwork(ip: string): boolean {
	const normalized = normalizeIP(ip);
	return PRIVATE_RANGES.some(range => range.test(normalized));
}

/**
 * Get client IP from request.
 *
 * Security note: we intentionally do not trust X-Forwarded-For headers.
 * This API is intended for local/device access and forwarded headers can be spoofed.
 */
function getClientIP(req: Request): string {
	// Use direct connection IP
	return req.socket.remoteAddress || 'unknown';
}

/**
 * Network-based security middleware
 */
export default function networkSecurity(req: Request, res: Response, next: NextFunction) {
	const clientIP = getClientIP(req);
	const path = req.path;
	
	// Skip security for health check endpoints
	if (path === '/ping' || path === '/v1/healthy' || path === '/v1/readiness' || path === '/v1/health/report') {
		return next();
	}
	
	switch (SECURITY_MODE) {
		case 'LOCALHOST_ONLY':
			if (!isLocalhost(clientIP)) {
				logger?.warnSync('Blocked non-localhost API access', {
					component: LogComponents.agent,
					clientIP,
					path,
					mode: SECURITY_MODE
				});
				return res.status(403).json({ 
					error: 'Forbidden',
					message: 'API access restricted to localhost only',
					hint: 'Run iotctl from the device itself, or set API_SECURITY_MODE=LOCAL_NETWORK'
				});
			}
			break;
			
		case 'LOCAL_NETWORK':
			if (!isPrivateNetwork(clientIP)) {
				logger?.warnSync('Blocked non-local-network API access', {
					component: LogComponents.agent,
					clientIP,
					path,
					mode: SECURITY_MODE
				});
				return res.status(403).json({ 
					error: 'Forbidden',
					message: 'API access restricted to local network only',
					hint: 'Use API_KEY mode for remote access'
				});
			}
			break;
			
		case 'API_KEY':
			// API key validation handled by separate auth middleware
			// This mode allows any IP if they have valid API key
			break;
			
		case 'OPEN':
			// No restrictions - log warning
			logger?.warnSync('API running in OPEN mode - no security restrictions', {
				component: LogComponents.agent,
				clientIP,
				path,
				warning: 'This is NOT recommended for production'
			});
			break;
			
		default:
			logger?.errorSync('Invalid API_SECURITY_MODE', undefined, {
				component: LogComponents.agent,
				mode: SECURITY_MODE,
				validModes: ['LOCALHOST_ONLY', 'LOCAL_NETWORK', 'API_KEY', 'OPEN']
			});
			return res.status(500).json({ 
				error: 'Invalid security configuration' 
			});
	}
	
	next();
}
