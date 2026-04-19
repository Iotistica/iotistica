/**
 * Bootstrap for the Broker Monitor service.
 * Uses Redis leader election so only one API replica runs the MQTT monitor.
 */

import logger from '../utils/logger';
import { pool } from '../db/connection';
import { BrokerMonitorLeader } from '../services/broker-monitor/leader';
import { initBrokerMonitor, stopBrokerMonitor } from '../services/broker-monitor/index';

export function bootstrapBrokerMonitor(): void {
  const leader = new BrokerMonitorLeader(
    () => {
      initBrokerMonitor(pool).catch((err: any) => {
        logger.error('BrokerMonitor init error after acquiring leadership', { error: err.message });
      });
    },
    () => {
      stopBrokerMonitor().catch((err: any) => {
        logger.warn('BrokerMonitor stop error after losing leadership', { error: err.message });
      });
    }
  );

  leader.start().catch((err: any) => {
    logger.warn('BrokerMonitorLeader start error (non-fatal)', { error: err.message });
  });
}
