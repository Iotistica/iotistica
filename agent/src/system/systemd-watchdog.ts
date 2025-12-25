/**
 * Systemd Watchdog Integration
 * 
 * Sends periodic keepalive signals to systemd to indicate the process is healthy.
 * If watchdog pings stop, systemd will restart the service (when WatchdogSec is configured).
 * 
 * Usage:
 *   import { startWatchdog } from './systemd-watchdog';
 *   startWatchdog();
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

const execFileAsync = promisify(execFile);
let watchdogInterval: NodeJS.Timeout | null = null;

/**
 * Send notification to systemd using systemd-notify command
 * 
 * @param message - Notification message (e.g., "READY=1", "WATCHDOG=1", "STOPPING=1")
 * @param logger - Optional logger
 */
async function sendNotification(message: string, logger?: AgentLogger): Promise<void> {
  try {
    await execFileAsync('systemd-notify', ['--pid=parent', message]);
    logger?.debugSync(`Sent notification: ${message}`, {
      component: LogComponents.agent,
      operation: 'sendNotification'
    });
  } catch (error) {
    logger?.errorSync(`Failed to send notification: ${message}`, error instanceof Error ? error : undefined, {
      component: LogComponents.agent,
      operation: 'sendNotification'
    });
  }
}

/**
 * Start systemd watchdog notifications
 * 
 * @param logger - Optional logger for debug output
 * @returns Cleanup function to stop watchdog
 */
export function startWatchdog(logger?: AgentLogger): () => void {
  const notifySocket = process.env.NOTIFY_SOCKET;
  
  if (!notifySocket) {
    logger?.debugSync('NOTIFY_SOCKET not set - systemd watchdog disabled', {
      component: LogComponents.agent,
      operation: 'startWatchdog'
    });
    return () => {}; // No-op cleanup
  }

  logger?.infoSync('Starting systemd watchdog', {
    component: LogComponents.agent,
    socket: notifySocket
  });

  // Read watchdog interval from systemd (in microseconds)
  // Best practice: ping at half the watchdog timeout
  const watchdogUsec = Number(process.env.WATCHDOG_USEC || 0);
  const intervalMs = watchdogUsec > 0
    ? Math.floor(watchdogUsec / 2000) // Half interval, convert µs to ms
    : 10000; // Fallback to 10s

  logger?.infoSync('Watchdog interval configured', {
    component: LogComponents.agent,
    operation: 'startWatchdog',
    intervalMs,
    watchdogTimeoutMs: watchdogUsec / 1000
  });

  // Send initial READY notification to systemd
  sendNotification('READY=1', logger);
  
  // Send watchdog ping at configured interval
  watchdogInterval = setInterval(() => {
    sendNotification('WATCHDOG=1', logger);
  }, intervalMs);

  // Return cleanup function
  return () => {
    // Send STOPPING notification before cleanup (improves observability and avoids race conditions)
    sendNotification('STOPPING=1', logger);

    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    
    logger?.infoSync('Watchdog stopped', {
      component: LogComponents.agent,
      operation: 'stopWatchdog'
    });
  };
}

/**
 * Notify systemd of application status
 * 
 * Best-effort helper for rare status notifications (e.g., STOPPING=1).
 * Uses systemd-notify command for simplicity and compatibility.
 * 
 * @param status - Status message (e.g., "READY=1", "STOPPING=1", "STATUS=Processing...")
 * @param logger - Optional logger
 */
export function notifySystemd(status: string, logger?: AgentLogger): void {
  if (!process.env.NOTIFY_SOCKET) {
    return; // Silently skip if not running under systemd
  }

  sendNotification(status, logger);
}
