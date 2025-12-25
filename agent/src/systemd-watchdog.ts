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

  // Create Unix domain socket
  const socket = dgram.createSocket('unix_dgram');
  
  // Send watchdog ping every 10 seconds (well under 30s timeout)
  watchdogInterval = setInterval(() => {
    try {
      const message = Buffer.from('WATCHDOG=1');
      socket.send(message, notifySocket, (err) => {
        if (err) {
          logger?.errorSync('Failed to send watchdog ping', {
            component: LogComponents.agent,
            error: err.message
          });
        } else {
          logger?.debugSync('Watchdog ping sent', {
            component: LogComponents.agent
          });
        }
      });
    } catch (error) {
      logger?.errorSync('Watchdog ping error', {
        component: LogComponents.agent,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, 10000); // 10 seconds

  // Send initial READY notification to systemd
  const readyMessage = Buffer.from('READY=1');
  socket.send(readyMessage, notifySocket, (err) => {
    if (err) {
      logger?.errorSync('Failed to send READY notification', {
        component: LogComponents.agent,
        error: err.message
      });
    } else {
      logger?.infoSync('Sent READY notification to systemd', {
        component: LogComponents.agent
      });
    }
  });

  // Return cleanup function
  return () => {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    socket.close();
    logger?.infoSync('Watchdog stopped', {
      component: LogComponents.agent
    });
  };
}

/**
 * Notify systemd of application status
 * 
 * @param status - Status message (e.g., "READY=1", "STOPPING=1", "STATUS=Processing...")
 * @param logger - Optional logger
 */
export function notifySystemd(status: string, logger?: AgentLogger): void {
  const notifySocket = process.env.NOTIFY_SOCKET;
  
  if (!notifySocket) {
    return; // Silently skip if not running under systemd
  }

  try {
    const socket = dgram.createSocket('unix_dgram');
    const message = Buffer.from(status);
    
    socket.send(message, notifySocket, (err) => {
      if (err) {
        logger?.errorSync('Failed to send systemd notification', {
          component: LogComponents.agent,
          error: err.message,
          status
        });
      }
      socket.close();
    });
  } catch (error) {
    logger?.errorSync('Systemd notification error', {
      component: LogComponents.agent,
      error: error instanceof Error ? error.message : String(error),
      status
    });
  }
}
