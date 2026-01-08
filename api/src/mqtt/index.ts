/**
 * MQTT Service Initialization
 * 
 * Sets up MQTT manager and registers message handlers
 */

import MqttManager from './mqtt-manager';
import logger from '../utils/logger';
import {
  handleEndpointsData,
  handleDeviceState,
  handleAgentStatus,
  handleAnomalyEvent
} from './handlers';

let mqttManager: MqttManager | null = null;

/**
 * Initialize MQTT service
 */
export async function initializeMqtt(): Promise<MqttManager | null> {
  const mqttBrokerUrl = process.env.MQTT_BROKER_URL || process.env.MQTT_BROKER;
  
  if (!mqttBrokerUrl) {
    logger.warn('MQTT broker not configured. Set MQTT_BROKER_URL to enable MQTT features.');
    return null;
  }

  // If already connected, return existing instance
  if (mqttManager && mqttManager.isConnected()) {
    logger.debug('MQTT already connected, reusing existing instance');
    return mqttManager;
  }

  // Clean up old connection if exists
  if (mqttManager) {
    logger.info('Cleaning up old MQTT connection before reinitializing');
    try {
      await mqttManager.destroy();
    } catch (err) {
      logger.warn('Error destroying old MQTT connection', { error: err });
    }
    mqttManager = null;
  }

  try {
    logger.info('Initializing MQTT service...');

    mqttManager = new MqttManager({
      brokerUrl: mqttBrokerUrl,
      clientId: process.env.MQTT_CLIENT_ID || `api-${process.env.HOSTNAME || 'server'}`,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      reconnectPeriod: parseInt(process.env.MQTT_RECONNECT_PERIOD || '5000'),
      keepalive: parseInt(process.env.MQTT_KEEPALIVE || '60'),
      clean: true, // Use clean session to avoid stale session state causing ECONNRESET
      qos: (parseInt(process.env.MQTT_QOS || '1') as 0 | 1 | 2)
    });

    // Initialize dictionary manager if key compaction enabled
    const useKeyCompaction = process.env.USE_KEY_COMPACTION_POC === 'true';
    if (useKeyCompaction) {
      logger.info('Initializing dictionary manager for key compaction POC...');
      const { redisClient } = await import('../redis/client');
      await mqttManager.initDictionaryManager(redisClient.getClient());
      logger.info('Dictionary manager initialized');
    } else {
      logger.info('Key compaction POC disabled (USE_KEY_COMPACTION_POC not set)');
    }

    // Connect to broker
    await mqttManager.connect();

    // Register event handlers
    mqttManager.on('endpoints', async (data) => {
      try {
        await handleEndpointsData(data);
      } catch (error) {
        logger.error('Error handling endpoint data:', error);
      }
    });

    mqttManager.on('state', async (state) => {
      try {
        await handleDeviceState(state);
      } catch (error) {
        logger.error('Error handling device state:', error);
      }
    });

    mqttManager.on('agent', async (data) => {
      try {
        await handleAgentStatus(data);
      } catch (error) {
        logger.error('Error handling agent status:', error);
      }
    });

    mqttManager.on('anomaly', async (data) => {
      try {
        logger.info('🔥 Anomaly event handler called', {
          deviceId: data.deviceId?.substring(0, 8),
          metric: data.metric,
          suppressed: data.suppressed
        });
        await handleAnomalyEvent(data);
      } catch (error) {
        logger.error('Error handling anomaly event:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          deviceId: data.deviceId
        });
      }
    });

    // Subscribe to all device topics
    // Use '*' wildcard for all devices, or specific UUIDs for targeted subscriptions
    const subscribeToAll = process.env.MQTT_SUBSCRIBE_ALL !== 'false';
    
    if (subscribeToAll) {
      logger.info('Subscribing to all device topics...');
      
      const topics = ['endpoints', 'state', 'agent', 'events'];
      
      // Add meta topic if dictionary manager enabled
      if (useKeyCompaction) {
        topics.push('meta');
        logger.info('✅ Dictionary sync enabled - subscribing to meta topic', {
          topic: 'iot/device/+/meta/#',
          useKeyCompaction,
          timestamp: new Date().toISOString()
        });
      }
      
      // ✅ FIX: Await subscription to ensure it completes before processing messages
      await mqttManager.subscribeToAll(topics);
      
      logger.info('✅ Subscribed to MQTT topics', {
        topics,
        wildcardPattern: 'iot/device/+/{topic}/#',
        timestamp: new Date().toISOString()
      });
    } else {
      logger.warn('MQTT subscription disabled. Set MQTT_SUBSCRIBE_ALL=true to enable.');
    }

    logger.info('MQTT service initialized');
    return mqttManager;

  } catch (error) {
    logger.error('Failed to initialize MQTT service:', error);
    return null;
  }
}

/**
 * Get MQTT manager instance
 */
export function getMqttManager(): MqttManager | null {
  return mqttManager;
}

/**
 * Shutdown MQTT service
 */
export async function shutdownMqtt(): Promise<void> {
  if (mqttManager) {
    logger.info('Shutting down MQTT service...');
    await mqttManager.destroy();
    mqttManager = null;
    logger.info('MQTT service shut down');
  }
}

// Graceful shutdown on SIGTERM (Kubernetes, PM2, Docker)
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down MQTT gracefully...');
  await shutdownMqtt();
});

// Graceful shutdown on SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down MQTT gracefully...');
  await shutdownMqtt();
});

export default { initializeMqtt, getMqttManager, shutdownMqtt };
