/**
 * MQTT bootstrap: initializes the MQTT manager and WebSocket integration.
 *
 * Intentionally fire-and-forget (non-blocking) - EMQX needs time to become
 * ready after startup, and the API can serve requests without MQTT.
 * Retries automatically on failure.
 */

import logger from '../utils/logger';
import { initializeMqtt } from '../mqtt';
import { websocketManager } from '../services/websocket/manager';

export function bootstrapMqtt(): void {
  // Non-blocking: runs in background after a startup delay
  (async () => {
    const mqttStartupDelay = parseInt(process.env.MQTT_STARTUP_DELAY_MS || '15000');
    logger.info(
      `Delaying MQTT initialization for ${mqttStartupDelay}ms to allow EMQX webhook to become ready`,
    );
    await new Promise(resolve => setTimeout(resolve, mqttStartupDelay));

    try {
      const mqttManager = await initializeMqtt();
      if (mqttManager) {
        const { getMqttManager } = await import('../mqtt');
        const manager = getMqttManager();
        if (manager) {
          websocketManager.setMqttManager(manager);
        }
      }
    } catch (error) {
      logger.warn('[WARNING] MQTT service initialization failed - will retry in background', {
        error: error instanceof Error ? error.message : String(error),
        note: 'This is non-critical - API will continue without MQTT',
      });
      retryMqttInitialization();
    }
  })();
}

async function retryMqttInitialization(intervalMs = 15000): Promise<void> {
  const { initializeMqtt: retry, getMqttManager } = await import('../mqtt');
  const interval = setInterval(async () => {
    try {
      const manager = await retry();
      if (manager && manager.isConnected()) {
        logger.info('MQTT reconnected successfully');
        clearInterval(interval);
      } else {
        logger.debug('MQTT initialization returned but not connected, will retry');
      }
    } catch (err: any) {
      logger.warn('MQTT still unavailable', { error: err?.message || err });
    }
  }, intervalMs);
}
