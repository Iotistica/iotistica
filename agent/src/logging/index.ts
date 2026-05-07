/**
 * Logging Module
 * ==============
 * 
 * Provides container and system log collection, storage, and retrieval.
 */

export * from './types';
export { LocalLogBackend } from './local-backend';
export { ContainerLogMonitor } from './container-monitor';
export { AgentLogger } from './agent-logger';

import { type AgentLogger } from './agent-logger';
import { LogComponents } from './types';

/**
 * Log system events (for network operations, etc.)
 * Uses AgentLogger if available, falls back to console.log
 */
export function logSystemEvent(eventType: string, data: any, logger?: AgentLogger): void {
	if (logger) {
		logger.debugSync(`System event: ${eventType}`, {
			component: LogComponents.containerManager,
			eventType,
			...data
		});
	} else {
		// Fallback for cases where logger is not available
		const timestamp = new Date().toISOString();
		console.log(`[SYSTEM_EVENT] ${timestamp} - ${eventType}:`, JSON.stringify(data));
	}
}
