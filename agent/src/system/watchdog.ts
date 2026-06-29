/**
 * Systemd watchdog helpers for readiness and keepalive notifications.
 */

import { createSocket } from 'dgram';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { Socket } from 'dgram';

const execFileAsync = promisify(execFile);
let watchdogInterval: NodeJS.Timeout | null = null;
let notifySocket: Socket | null = null;
let lastWatchdogPing: number = 0;
let consecutiveSkippedPings: number = 0;

/** Send a systemd notification via native Unix socket. */
function sendNativeNotification(message: string, socketPath: string, logger?: AgentLogger): void {
	try {
		// Lazy-create Unix datagram socket.
		if (!notifySocket) {
			notifySocket = createSocket({ type: 'unix_dgram' } as any); // Type workaround for unix_dgram
			notifySocket.on('error', (err) => {
				logger?.errorSync('Watchdog socket error', err, {
					component: LogComponents.agent,
					operation: 'sendNativeNotification'
				});
				// Recreate socket on the next attempt.
				notifySocket?.close();
				notifySocket = null;
			});
		}

		// systemd encodes abstract socket paths with a leading '@'.
		// The kernel abstract namespace uses a NUL byte prefix instead.
		const actualPath = socketPath.startsWith('@') ? '\0' + socketPath.slice(1) : socketPath;

		// Send datagram to systemd socket.
		// Must use the 5-arg form (buf, offset, length, path, cb) — the 3-arg
		// form (buf, path, cb) maps 'path' into the 'port' slot and is silently dropped.
		const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
		// @ts-ignore - Unix socket path not in official types
		notifySocket.send(buf, 0, buf.length, actualPath, (err: Error | null) => {
			if (err) {
				logger?.errorSync('Failed to send watchdog ping', err, {
					component: LogComponents.agent,
					operation: 'sendNativeNotification',
					message
				});
				// Recreate socket on the next attempt.
				notifySocket?.close();
				notifySocket = null;
			}
		});
    
		logger?.debugSync(`Sent notification: ${message}`, {
			component: LogComponents.agent,
			operation: 'sendNativeNotification',
			method: 'unix_socket'
		});
	} catch (error) {
		logger?.errorSync(`Native notification failed: ${message}`, error instanceof Error ? error : undefined, {
			component: LogComponents.agent,
			operation: 'sendNativeNotification'
		});
	}
}

/** Send a systemd notification. Prefers the systemd-notify CLI which correctly
 *  handles both filesystem and abstract socket paths without needing a bound
 *  local socket. Falls back to raw unix_dgram if the CLI is unavailable. */
async function sendNotification(message: string, logger?: AgentLogger): Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
	if (!socketPath) {
		return;
	}

	// Try systemd-notify CLI first — it is the most reliable method and handles
	// all socket path formats (filesystem and abstract @-prefixed paths).
	try {
		await execFileAsync('systemd-notify', ['--pid=parent', message]);
		logger?.debugSync(`Sent notification: ${message}`, {
			component: LogComponents.agent,
			operation: 'sendNotification',
			method: 'systemd-notify'
		});
		return;
	} catch {
		// CLI not available; fall back to raw unix_dgram socket.
	}

	sendNativeNotification(message, socketPath, logger);
	await new Promise(resolve => setTimeout(resolve, 25));
}

/** Health check used to gate watchdog pings. */
export type HealthCheckFn = () => boolean | Promise<boolean>;

/**
 * Starts systemd watchdog notifications.
 * Returns async cleanup for shutdown.
 */
export function startWatchdog(healthCheck?: HealthCheckFn, logger?: AgentLogger): () => Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
  
	if (!socketPath) {
		logger?.debugSync('NOTIFY_SOCKET not set - systemd watchdog disabled', {
			component: LogComponents.agent,
			operation: 'startWatchdog'
		});
		return async () => {};
	}

	// Capture systemd context for restart diagnostics.
	const systemdUnit = process.env.SYSTEMD_UNIT || 'unknown';
	const invocationId = process.env.INVOCATION_ID || 'unknown';
  
	logger?.infoSync('Starting systemd watchdog', {
		component: LogComponents.agent,
		socket: socketPath,
		method: 'native_unix_socket',
		systemdUnit,
		invocationId
	});

	// Read watchdog interval from systemd in microseconds.
	const watchdogUsec = Number(process.env.WATCHDOG_USEC ?? 0);
  
	// Validate WATCHDOG_USEC.
	if (!Number.isFinite(watchdogUsec) || watchdogUsec <= 0) {
		logger?.warnSync('WATCHDOG_USEC invalid or not set - using default interval', {
			component: LogComponents.agent,
			operation: 'startWatchdog',
			watchdogUsec: process.env.WATCHDOG_USEC,
			defaultIntervalMs: 10000
		});
	} else if (watchdogUsec < 1_000_000) {
		// Too aggressive (<1s) can cause restart storms.
		logger?.warnSync('WATCHDOG_USEC too aggressive - risk of restart storms', {
			component: LogComponents.agent,
			operation: 'startWatchdog',
			watchdogUsec,
			watchdogTimeoutMs: watchdogUsec / 1000,
			minRecommendedMs: 1000,
			recommendation: 'Increase WatchdogSec to at least 2s in systemd unit'
		});
	}
  
	const intervalMs = watchdogUsec > 0 && Number.isFinite(watchdogUsec)
		? Math.floor(watchdogUsec / 2000)
		: 10000;

	logger?.infoSync('Watchdog interval configured', {
		component: LogComponents.agent,
		operation: 'startWatchdog',
		intervalMs,
		watchdogTimeoutMs: watchdogUsec / 1000,
		source: watchdogUsec > 0 ? 'WATCHDOG_USEC' : 'default',
		systemdUnit,
		invocationId
	});

	// Do not send READY=1 here.
	// Application readiness is handled by notifyReady().
  
	// Initialize last ping timestamp.
	lastWatchdogPing = Date.now();
  
	// Send periodic watchdog pings through native socket.
	watchdogInterval = setInterval(async () => {
		const now = Date.now();
		const drift = now - lastWatchdogPing;
		const maxDrift = intervalMs * 2; // Tolerance: 2x expected interval
    
		// Skip ping when drift exceeds tolerance.
		if (drift > maxDrift) {
			consecutiveSkippedPings++;
			logger?.errorSync('Watchdog ping skipped - timing drift detected', undefined, {
				component: LogComponents.agent,
				operation: 'watchdog',
				action: 'skipped',
				reason: 'timing_drift',
				driftMs: drift,
				expectedIntervalMs: intervalMs,
				maxDriftMs: maxDrift,
				consecutiveSkips: consecutiveSkippedPings,
				systemdUnit,
				invocationId,
				consequence: 'systemd_will_restart'
			});
			return;
		}
    
		const isHealthy = healthCheck ? await healthCheck() : true;

		if (isHealthy) {
			await sendNotification('WATCHDOG=1', logger);
			lastWatchdogPing = now;
      
			// Reset skip counter on successful ping.
			if (consecutiveSkippedPings > 0) {
				logger?.infoSync('Watchdog ping resumed after skips', {
					component: LogComponents.agent,
					operation: 'watchdog',
					previousSkips: consecutiveSkippedPings
				});
				consecutiveSkippedPings = 0;
			}
		} else {
			// Withhold ping; systemd restarts service after timeout.
			consecutiveSkippedPings++;
			logger?.errorSync('Watchdog ping skipped - unhealthy state', undefined, {
				component: LogComponents.agent,
				operation: 'watchdog',
				action: 'skipped',
				reason: 'health_check_failed',
				consecutiveSkips: consecutiveSkippedPings,
				systemdUnit,
				invocationId,
				consequence: 'systemd_will_restart'
			});
		}
	}, intervalMs);

	// Cleanup function.
	return async () => {
		// Send STOPPING and flush before cleanup.
		sendNativeNotification('STOPPING=1', socketPath, logger);
    
		// Ensure datagram is flushed.
		await new Promise(resolve => setTimeout(resolve, 50));

		if (watchdogInterval) {
			clearInterval(watchdogInterval);
			watchdogInterval = null;
		}
    
		// Close native socket.
		if (notifySocket) {
			notifySocket.close();
			notifySocket = null;
		}
    
		logger?.infoSync('Watchdog stopped', {
			component: LogComponents.agent,
			operation: 'stopWatchdog',
			totalSkippedPings: consecutiveSkippedPings,
			systemdUnit: process.env.SYSTEMD_UNIT || 'unknown',
			invocationId: process.env.INVOCATION_ID || 'unknown'
		});
	};
}

/** Notify systemd that the application is ready. */
export async function notifyReady(logger?: AgentLogger): Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
	if (!socketPath) {
		return;
	}

	console.log(`[watchdog] Sending READY=1 to NOTIFY_SOCKET=${socketPath}`);
	await sendNotification('READY=1', logger);

	console.log('[watchdog] READY=1 sent');
	logger?.infoSync('Systemd READY notification sent', {
		component: LogComponents.agent,
		operation: 'notifyReady'
	});
}

/** Notify systemd with a status message. */
export function notifySystemd(status: string, logger?: AgentLogger): void {
	if (!process.env.NOTIFY_SOCKET) {
		return;
	}

	void sendNotification(status, logger);
}
