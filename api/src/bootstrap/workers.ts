/**
 * Non-critical background workers: heartbeat monitor + traffic flush.
 * Failures are warned but do not prevent startup.
 */

import logger from '../utils/logger';
import { startTrafficFlushService } from '../services/traffic-flush.service';
import heartbeatMonitor from '../services/health/heartbeat-monitor';

export async function bootstrapWorkers(): Promise<void> {
  try {
    heartbeatMonitor.start();
    logger.info('Heartbeat monitor started');
  } catch (error) {
    logger.warn('Failed to start heartbeat monitor', { error });
  }

  try {
    startTrafficFlushService();
    logger.info('Traffic flush service started');
  } catch (error) {
    logger.warn('Failed to start traffic flush service', { error });
  }
}
