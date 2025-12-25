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

import dgram from 'dgram';
import type { AgentLogger } from './logging/agent-logger';
import { LogComponents } from './logging/types';

let watchdogInterval: NodeJS.Timeout | null = null;

/**
 * Normalize systemd NOTIFY_SOCKET path to handle abstract namespace sockets
 * 
 * Linux abstract namespace sockets are prefixed with @ in environment variables,
 * but need to be converted to null byte (\0) for actual socket communication.
 * 
 * @param path - Raw NOTIFY_SOCKET path from environment
 * @returns Normalized socket path
 */
function normalizeNotifySocket(path: string): string {
  // Abstract namespace socket (e.g., @/org/freedesktop/systemd1/notify)
  if (path.startsWith('@')) {
    return '\0' + path.slice(1);
  }
  return path;
}

/**
 * Start systemd watchdog notifications
 * 
 * @param logger - Optional logger for debug output
 * @returns Cleanup function to stop watchdog
 */
export function startWatchdog(logger?: AgentLogger): () => void {
  const rawSocket = process.env.NOTIFY_SOCKET;
  
  if (!rawSocket) {
    logger?.debugSync('NOTIFY_SOCKET not set - systemd watchdog disabled', {
      component: LogComponents.agent,
      operation: 'startWatchdog'
    });
    return () => {}; // No-op cleanup
  }

  const notifySocket = normalizeNotifySocket(rawSocket);

  logger?.infoSync('Starting systemd watchdog', {
    component: LogComponents.agent,
    socket: rawSocket
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

  // Create Unix domain socket (use 'udp4' type for compatibility, but send to Unix path)
  const socket = dgram.createSocket({ type: 'unix_dgram' } as any);
  
  // Send watchdog ping at configured interval
  watchdogInterval = setInterval(() => {
    try {
      const message = Buffer.from('WATCHDOG=1');
      (socket as any).send(message, notifySocket, (err?: Error) => {
        if (err) {
          logger?.errorSync('Failed to send watchdog ping', err, {
            component: LogComponents.agent,
            operation: 'watchdogPing'
          });
        } else {
          logger?.debugSync('Watchdog ping sent', {
            component: LogComponents.agent,
            operation: 'watchdogPing'
          });
        }
      });
    } catch (error) {
      logger?.errorSync('Watchdog ping error', error instanceof Error ? error : undefined, {
        component: LogComponents.agent,
        operation: 'watchdogPing'
      });
    }
  }, intervalMs);

  // Send initial READY notification to systemd
  const readyMessage = Buffer.from('READY=1');
  (socket as any).send(readyMessage, notifySocket, (err?: Error) => {
    if (err) {
      logger?.errorSync('Failed to send READY notification', err, {
        component: LogComponents.agent,
        operation: 'notifyReady'
      });
    } else {
      logger?.infoSync('Sent READY notification to systemd', {
        component: LogComponents.agent,
        operation: 'notifyReady'
      });
    }
  });

  // Return cleanup function
  return () => {
    // Send STOPPING notification before cleanup (improves observability and avoids race conditions)
    try {
      const stoppingMessage = Buffer.from('STOPPING=1');
      (socket as any).send(stoppingMessage, notifySocket, (err?: Error) => {
        if (err) {
          logger?.errorSync('Failed to send STOPPING notification', err, {
            component: LogComponents.agent,
            operation: 'stopWatchdog'
          });
        }
      });
    } catch (error) {
      logger?.errorSync('STOPPING notification error', error instanceof Error ? error : undefined, {
        component: LogComponents.agent,
        operation: 'stopWatchdog'
      });
    }

    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    socket.close();
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
 * Creates a new socket for each call for simplicity - acceptable for
 * infrequent use. For high-frequency notifications, use the main
 * watchdog socket instead.
 * 
 * @param status - Status message (e.g., "READY=1", "STOPPING=1", "STATUS=Processing...")
 * @param logger - Optional logger
 */
export function notifySystemd(status: string, logger?: AgentLogger): void {
  const rawSocket = process.env.NOTIFY_SOCKET;
  
  if (!rawSocket) {
    return; // Silently skip if not running under systemd
  }

  const notifySocket = normalizeNotifySocket(rawSocket);

  try {
    const socket = dgram.createSocket({ type: 'unix_dgram' } as any);
    const message = Buffer.from(status);
    
    (socket as any).send(message, notifySocket, (err?: Error) => {
      if (err) {
        logger?.errorSync('Failed to send systemd notification', err, {
          component: LogComponents.agent,
          operation: 'notifySystemd',
          status
        });
      }
      socket.close();
    });
  } catch (error) {
    logger?.errorSync('Systemd notification error', error instanceof Error ? error : undefined, {
      component: LogComponents.agent,
      operation: 'notifySystemd',
      status
    });
  }
}
