/**
 * Non-critical background workers: heartbeat monitor.
 * Failures are warned but do not prevent startup.
 */

import logger from '../utils/logger';
import heartbeatMonitor from '../services/health/heartbeat-monitor';

export async function bootstrapWorkers(): Promise<void> {
  try {
    heartbeatMonitor.start();
    logger.info('Heartbeat monitor started');
  } catch (error) {
    logger.warn('Failed to start heartbeat monitor', { error });
  }
}
