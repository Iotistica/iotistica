/**
 * Systemd Watchdog Integration
 * 
 * Sends periodic keepalive signals to systemd to indicate the process is healthy.
 * If watchdog pings stop, systemd will restart the service (when WatchdogSec is configured).
 * 
 * Performance optimizations for edge devices:
 * - Periodic watchdog pings use native Unix socket (zero process spawning)
 * - systemd-notify binary only used for rare status updates (READY, STOPPING)
 * 
 * Health-gated watchdog (production pattern):
 * - Only sends WATCHDOG=1 if application passes health checks
 * - Enables automatic recovery from deadlocks, hung network, partial failures
 * - Systemd restarts service when watchdog pings stop
 * 
 * Monotonic drift protection:
 * - Detects blocked event loop, CPU pegging, long GC pauses
 * - Withholds ping if timing drift exceeds 2x expected interval
 * - Makes watchdog time-sensitive, not best-effort
 * 
 * Usage:
 *   import { startWatchdog } from './systemd-watchdog';
 *   
 *   // Simple (always healthy - backward compatible)
 *   startWatchdog(undefined, logger);
 *   
 *   // Production (health-gated - recommended)
 *   const healthCheck = () => {
 *     return mqttConnected() &&
 *            workersResponsive() &&
 *            memoryHealthy() &&
 *            !unrecoverableError;
 *   };
 *   const stopWatchdog = startWatchdog(healthCheck, logger);
 *    *   // Notify intermediate states during initialization
 *   notifySystemd('STATUS=Loading configuration...', logger);
 *   await loadConfig();
 *   
 *   notifySystemd('STATUS=Connecting to MQTT...', logger);
 *   await connectMQTT();
 *   
 *   notifySystemd('STATUS=Initializing database...', logger);
 *   await initDatabase();
 *   
 *   // Send READY=1 only when fully operational
 *   await notifyReady(logger);
 *    *   // Graceful shutdown (ensure STOPPING notification is flushed)
 *   process.on('SIGTERM', async () => {
 *     await stopWatchdog(); // Await to flush STOPPING=1
 *     process.exit(0);
 *   });
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
let lastWatchdogPing: number = 0; // Monotonic drift protection
let consecutiveSkippedPings: number = 0; // Observability: track skipped pings

/**
 * Send notification to systemd using native Unix socket (hot path - zero process spawning)
 * 
 * @param message - Notification message (e.g., "WATCHDOG=1")
 * @param socketPath - Path to NOTIFY_SOCKET
 * @param logger - Optional logger
 */
function sendNativeNotification(message: string, socketPath: string, logger?: AgentLogger): void {
	try {
		// Lazy-create Unix datagram socket
		if (!notifySocket) {
			notifySocket = createSocket({ type: 'unix_dgram' } as any); // Type workaround for unix_dgram
			notifySocket.on('error', (err) => {
				logger?.errorSync('Watchdog socket error', err, {
					component: LogComponents.agent,
					operation: 'sendNativeNotification'
				});
				// Close and recreate socket on next ping
				notifySocket?.close();
				notifySocket = null;
			});
		}
    
		// Send datagram to systemd socket
		// @ts-ignore - Unix socket path not in official types
		notifySocket.send(message, socketPath, (err: Error | null) => {
			if (err) {
				logger?.errorSync('Failed to send watchdog ping', err, {
					component: LogComponents.agent,
					operation: 'sendNativeNotification',
					message
				});
				// Close socket on error - will recreate on next ping
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

/**
 * Send notification to systemd using systemd-notify command (fallback for rare status updates)
 * 
 * Use this for startup (READY=1), shutdown (STOPPING=1), and rare status updates.
 * For periodic watchdog pings, use sendNativeNotification() to avoid process spawning.
 * 
 * @param message - Notification message (e.g., "READY=1", "STOPPING=1", "STATUS=...")
 * @param logger - Optional logger
 */
async function sendNotification(message: string, logger?: AgentLogger): Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;

	if (socketPath) {
		sendNativeNotification(message, socketPath, logger);
		await new Promise(resolve => setTimeout(resolve, 25));
		return;
	}

	try {
		await execFileAsync('systemd-notify', ['--pid=parent', message]);
		logger?.debugSync(`Sent notification: ${message}`, {
			component: LogComponents.agent,
			operation: 'sendNotification',
			method: 'systemd-notify'
		});
	} catch (error) {
		logger?.errorSync(`Failed to send notification: ${message}`, error instanceof Error ? error : undefined, {
			component: LogComponents.agent,
			operation: 'sendNotification'
		});
	}
}

/**
 * Health check function type
 * Returns true if application is healthy, false if unhealthy
 * Supports both synchronous and asynchronous checks
 * 
 * Unhealthy states should trigger systemd restart:
 * - MQTT bridge disconnected
 * - Worker threads unresponsive
 * - Memory threshold exceeded
 * - Database connection lost
 * - Unrecoverable error state
 * - I/O loop stalled
 */
export type HealthCheckFn = () => boolean | Promise<boolean>;

/**
 * Start systemd watchdog notifications
 * 
 * Performance optimization for edge devices:
 * - Uses native Unix socket for periodic watchdog pings (zero process spawning)
 * - Falls back to systemd-notify binary for startup/shutdown status updates
 * 
 * Health-gated watchdog (CRITICAL for production):
 * - Only sends WATCHDOG=1 if healthCheck() returns true
 * - Withholds watchdog ping on unhealthy state → systemd restarts service
 * - Enables automatic recovery from deadlocks, hung network stacks, partial failures
 * 
 * Monotonic drift protection:
 * - Tracks last successful ping timestamp
 * - Withholds ping if drift exceeds 2x interval (detects blocked event loop, CPU pegging, long GC pauses)
 * - Makes watchdog time-sensitive, not best-effort
 * 
 * @param healthCheck - Optional health check function (default: always healthy)
 * @param logger - Optional logger for debug output
 * @returns Async cleanup function to stop watchdog (await during shutdown to ensure STOPPING notification is flushed)
 */
export function startWatchdog(healthCheck?: HealthCheckFn, logger?: AgentLogger): () => Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
  
	if (!socketPath) {
		logger?.debugSync('NOTIFY_SOCKET not set - systemd watchdog disabled', {
			component: LogComponents.agent,
			operation: 'startWatchdog'
		});
		return async () => {}; // No-op cleanup (async)
	}

	// Observability: Capture systemd context for diagnosing edge restarts
	const systemdUnit = process.env.SYSTEMD_UNIT || 'unknown';
	const invocationId = process.env.INVOCATION_ID || 'unknown';
  
	logger?.infoSync('Starting systemd watchdog', {
		component: LogComponents.agent,
		socket: socketPath,
		method: 'native_unix_socket',
		systemdUnit,
		invocationId
	});

	// Read watchdog interval from systemd (in microseconds)
	// Best practice: ping at half the watchdog timeout
	const watchdogUsec = Number(process.env.WATCHDOG_USEC ?? 0);
  
	// Validate WATCHDOG_USEC (guardrails against invalid/dangerous values)
	if (!Number.isFinite(watchdogUsec) || watchdogUsec <= 0) {
		logger?.warnSync('WATCHDOG_USEC invalid or not set - using default interval', {
			component: LogComponents.agent,
			operation: 'startWatchdog',
			watchdogUsec: process.env.WATCHDOG_USEC,
			defaultIntervalMs: 10000
		});
	} else if (watchdogUsec < 1_000_000) {
		// Too aggressive (<1 second) - can cause restart storms on edge devices
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
		? Math.floor(watchdogUsec / 2000) // Half interval, convert µs to ms
		: 10000; // Fallback to 10s

	logger?.infoSync('Watchdog interval configured', {
		component: LogComponents.agent,
		operation: 'startWatchdog',
		intervalMs,
		watchdogTimeoutMs: watchdogUsec / 1000,
		source: watchdogUsec > 0 ? 'WATCHDOG_USEC' : 'default',
		systemdUnit,
		invocationId
	});

	// NOTE: Do NOT send READY=1 here - watchdog running != application ready
	// Application must call notifyReady() when fully operational:
	// - Config loaded
	// - Network initialized
	// - Critical connections established (MQTT, database, etc.)
	// Use notifySystemd('STATUS=...') for intermediate states
  
	// Initialize last ping timestamp
	lastWatchdogPing = Date.now();
  
	// Send periodic watchdog ping using native socket (hot path - zero process spawning)
	// CRITICAL: Health-gated - only send WATCHDOG=1 if application is truly healthy
	// This enables systemd to auto-restart on deadlocks, hung network, partial failures
	watchdogInterval = setInterval(async () => {
		const now = Date.now();
		const drift = now - lastWatchdogPing;
		const maxDrift = intervalMs * 2; // Tolerance: 2x expected interval
    
		// Monotonic drift protection - detect blocked event loop, CPU pegging, long GC pauses
		if (drift > maxDrift) {
			// Event loop blocked or CPU pegged - withhold ping to trigger systemd restart
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
			return; // Withhold ping - systemd will restart service
		}
    
		// Check application health before sending watchdog ping (await if async)
		const isHealthy = healthCheck ? await healthCheck() : true; // Default: always healthy
    
		if (isHealthy) {
			sendNativeNotification('WATCHDOG=1', socketPath, logger);
			lastWatchdogPing = now; // Update last successful ping time
      
			// Reset skip counter on successful ping (observability)
			if (consecutiveSkippedPings > 0) {
				logger?.infoSync('Watchdog ping resumed after skips', {
					component: LogComponents.agent,
					operation: 'watchdog',
					previousSkips: consecutiveSkippedPings
				});
				consecutiveSkippedPings = 0;
			}
		} else {
			// Withhold watchdog ping - systemd will restart service after timeout
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

	// Return cleanup function
	return async () => {
		// CRITICAL: Send STOPPING notification and flush before cleanup
		// Use native socket for instant delivery (no fork/exec race condition)
		// Ensures systemd receives notification before process exits
		sendNativeNotification('STOPPING=1', socketPath, logger);
    
		// Small delay to ensure datagram is flushed to kernel
		await new Promise(resolve => setTimeout(resolve, 50));

		if (watchdogInterval) {
			clearInterval(watchdogInterval);
			watchdogInterval = null;
		}
    
		// Close native socket
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

/**
 * Notify systemd that application is ready (fully operational)
 * 
 * CRITICAL: Only call after:
 * - Config loaded
 * - Network initialized
 * - Critical connections established (MQTT, database, etc.)
 * 
 * READY=1 should mean "fully operational", not "process started"
 * Use notifySystemd('STATUS=...') for intermediate states
 * 
 * @param logger - Optional logger
 */
export async function notifyReady(logger?: AgentLogger): Promise<void> {
	if (!process.env.NOTIFY_SOCKET) {
		return; // Silently skip if not running under systemd
	}

	await sendNotification('READY=1', logger);
  
	logger?.infoSync('Systemd READY notification sent', {
		component: LogComponents.agent,
		operation: 'notifyReady'
	});
}

/**
 * Notify systemd of application status
 * 
 * Best-effort helper for status notifications and intermediate states.
 * Uses systemd-notify command for simplicity and compatibility.
 * 
 * Common patterns:
 * - STATUS=Connecting to MQTT...
 * - STATUS=Loading configuration...
 * - STATUS=Initializing database...
 * - STOPPING=1
 * 
 * @param status - Status message (e.g., "STATUS=Loading...", "STOPPING=1")
 * @param logger - Optional logger
 */
export function notifySystemd(status: string, logger?: AgentLogger): void {
	if (!process.env.NOTIFY_SOCKET) {
		return; // Silently skip if not running under systemd
	}

	void sendNotification(status, logger);
}
