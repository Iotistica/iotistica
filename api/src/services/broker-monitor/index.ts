/**
 * Singleton manager for the Broker Monitor service.
 * Holds module-level instances so routes and bootstrap share the same objects.
 */

import type { Pool } from 'pg';
import { MQTTMonitorService } from './monitor';
import { MQTTDatabaseService } from './db';
import { StatsHistoryService } from './history';
import logger from '../../utils/logger';

let monitorInstance: MQTTMonitorService | null = null;
let dbServiceInstance: MQTTDatabaseService | null = null;
let historyInstance: StatsHistoryService | null = null;

export function getBrokerMonitorService(): MQTTMonitorService | null {
  return monitorInstance;
}

export function getBrokerDbService(): MQTTDatabaseService | null {
  return dbServiceInstance;
}

export function getBrokerHistoryService(): StatsHistoryService | null {
  return historyInstance;
}

export async function initBrokerMonitor(pool: Pool): Promise<void> {
  if (monitorInstance) {
    logger.info('BrokerMonitor already initialised, skipping');
    return;
  }

  try {
    const { instance, dbService } = await MQTTMonitorService.initialize(pool);

    monitorInstance = instance;
    dbServiceInstance = dbService;

    if (instance) {
      historyInstance = new StatsHistoryService();
      historyInstance.start(() => {
        const metrics = monitorInstance?.getMetrics();
        return {
          clients: metrics?.clients ?? 0,
          subscriptions: metrics?.subscriptions ?? 0,
          messageRate: {
            published: metrics?.messageRate.current.published ?? 0,
            received: metrics?.messageRate.current.received ?? 0,
          },
          throughput: {
            inbound: metrics?.throughput.current.inbound ?? 0,
            outbound: metrics?.throughput.current.outbound ?? 0,
          },
        };
      }, 60_000);

      logger.info('BrokerMonitor initialised successfully');
    }
  } catch (err: any) {
    logger.error('BrokerMonitor init failed', { error: err.message });
    throw err;
  }
}

export async function stopBrokerMonitor(): Promise<void> {
  try {
    historyInstance?.stop();
    await monitorInstance?.stop();
  } catch (err: any) {
    logger.warn('BrokerMonitor stop error', { error: err.message });
  } finally {
    monitorInstance = null;
    dbServiceInstance = null;
    historyInstance = null;
    logger.info('BrokerMonitor stopped and cleared');
  }
}
