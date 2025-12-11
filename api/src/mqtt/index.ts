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
  handleAgentStatus
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

  try {
    logger.info('Initializing MQTT service...');

    mqttManager = new MqttManager({
      brokerUrl: mqttBrokerUrl,
      clientId: process.env.MQTT_CLIENT_ID || `api-${process.env.HOSTNAME || 'server'}`,
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      reconnectPeriod: parseInt(process.env.MQTT_RECONNECT_PERIOD || '5000'),
      keepalive: parseInt(process.env.MQTT_KEEPALIVE || '60'),
      qos: (parseInt(process.env.MQTT_QOS || '1') as 0 | 1 | 2)
    });

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

    // Subscribe to all device topics
    // Use '*' wildcard for all devices, or specific UUIDs for targeted subscriptions
    const subscribeToAll = process.env.MQTT_SUBSCRIBE_ALL !== 'false';
    
    if (subscribeToAll) {
      logger.info('Subscribing to all device topics...');
      mqttManager.subscribeToAll([
        'endpoints',
        'state',
        'agent',
      ]);
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
    await mqttManager.disconnect();
    mqttManager = null;
    logger.info('MQTT service shut down');
  }
}

export default { initializeMqtt, getMqttManager, shutdownMqtt };
