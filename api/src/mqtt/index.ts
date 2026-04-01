/**
 * MQTT Service Initialization
 * 
 * Sets up MQTT manager and registers message handlers
 */

import MqttManager from './manager';
import logger from '../utils/logger';
import {
  handleDeviceData,
  handleAgentState,
  handleAgentStatus,
  handleAnomalyEvent,
  handleJobMessage
} from './handlers';
import { getDefaultBrokerConfig, buildBrokerUrl } from '../utils/mqtt-broker-config';
import { getTenantId } from '../redis/tenant-keys';

let mqttManager: MqttManager | null = null;

/**
 * Initialize MQTT service
 * Uses same broker configuration system as device provisioning:
 * 1. Environment variables (MQTT_BROKER_HOST/PORT/PROTOCOL)
 * 2. Default broker from mqtt_broker_config table
 */
export async function initializeMqtt(): Promise<MqttManager | null> {
  // Use unified broker configuration (same as device provisioning)
  const brokerConfig = await getDefaultBrokerConfig();
  
  if (!brokerConfig) {
    logger.warn('MQTT broker not configured. Set MQTT_BROKER_HOST/PORT/PROTOCOL or configure default broker in database.');
    return null;
  }
  
  const mqttBrokerUrl = buildBrokerUrl(brokerConfig);
  
  logger.info('🔍 MQTT INITIALIZATION STARTING', {
    source: brokerConfig.id === 0 ? 'environment' : 'database',
    brokerName: brokerConfig.name,
    brokerUrl: mqttBrokerUrl,
    protocol: brokerConfig.protocol,
    host: brokerConfig.host,
    port: brokerConfig.port,
    useTls: brokerConfig.use_tls,
    MQTT_CLIENT_ID: process.env.MQTT_CLIENT_ID,
    HOSTNAME: process.env.HOSTNAME,
    hasPassword: !!process.env.MQTT_PASSWORD
  });

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
      username: brokerConfig.username || process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
      reconnectPeriod: brokerConfig.reconnect_period,
      keepalive: brokerConfig.keep_alive,
      clean: brokerConfig.clean_session,
      qos: (parseInt(process.env.MQTT_QOS || '1') as 0 | 1 | 2)
    });

    logger.info('🔌 MQTT CONFIG CREATED', {
      source: brokerConfig.id === 0 ? 'environment' : `database (${brokerConfig.name})`,
      brokerUrl: mqttBrokerUrl,
      clientId: process.env.MQTT_CLIENT_ID || `api-${process.env.HOSTNAME || 'server'}`,
      username: brokerConfig.username || process.env.MQTT_USERNAME,
      hasPassword: !!process.env.MQTT_PASSWORD,
      reconnectPeriod: brokerConfig.reconnect_period,
      keepalive: brokerConfig.keep_alive,
      cleanSession: brokerConfig.clean_session,
      useTls: brokerConfig.use_tls
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
        await handleDeviceData(data);
      } catch (error) {
        logger.error('Error handling endpoint data:', error);
      }
    });

    mqttManager.on('state', async (state) => {
      try {
        await handleAgentState(state);
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

    mqttManager.on('jobs', async (data) => {
      try {
        await handleJobMessage(data);
      } catch (error) {
        logger.error('Error handling job message:', error);
      }
    });

    // Handle metrics
    mqttManager.on('metrics', async (data) => {
      try {
        logger.info('[MQTT] Metrics event received, storing to database', {
          deviceUuid: data.deviceUuid?.substring(0, 8) + '...',
          cpu_usage: data.cpu_usage,
          memory_usage: data.memory_usage,
          timestamp: data.timestamp
        });
        
        const { DeviceMetricsModel } = await import('../db/models');
        await DeviceMetricsModel.record(data.deviceUuid, {
          cpu_usage: data.cpu_usage,
          cpu_temp: data.cpu_temp,
          memory_usage: data.memory_usage,
          memory_total: data.memory_total,
          storage_usage: data.storage_usage,
          storage_total: data.storage_total
        });
        
        logger.info('[MQTT] Metrics stored successfully', {
          deviceUuid: data.deviceUuid?.substring(0, 8) + '...'
        });
      } catch (error) {
        logger.error('Error storing metrics:', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          deviceUuid: data.deviceUuid
        });
      }
    });

    // Initialize jobs handler
    try {
      const { getJobsHandler } = await import('./jobs-handler');
      const handler = getJobsHandler();
      handler.setMqttManager(mqttManager);
      logger.info('MQTT Jobs Handler initialized');
    } catch (error) {
      logger.warn('Failed to initialize MQTT Jobs Handler', { error });
    }

    // Subscribe to all device topics
    // Use '*' wildcard for all agents, or specific UUIDs for targeted subscriptions
    const subscribeToAll = process.env.MQTT_SUBSCRIBE_ALL !== 'false';
    
    if (subscribeToAll) {
  
      const topics = ['endpoints', 'state', 'agent', 'events', 'jobs'];
      
      // Add meta topic if dictionary manager enabled
      if (useKeyCompaction) {
        const tenantId = getTenantId();
        topics.push('meta');
        logger.info('Dictionary sync enabled - subscribing to meta topic', {
          topic: `i/${tenantId}/a/+/meta/#`,
          useKeyCompaction,
          timestamp: new Date().toISOString()
        });
      }
      
      // ✅ FIX: Await subscription to ensure it completes before processing messages
      await mqttManager.subscribeToAll(topics);
      
      logger.info('All MQTT subscriptions active', {
        topics,
        wildcardPattern: `i/${getTenantId()}/a/+/{topic}/#`,
        timestamp: new Date().toISOString()
      });
    } else {
      logger.warn('MQTT subscription disabled. Set MQTT_SUBSCRIBE_ALL=true to enable.');
    }

    logger.info('MQTT service initialized');
    return mqttManager;

  } catch (error) {
    logger.error('❌ FAILED TO INITIALIZE MQTT SERVICE', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      brokerUrl: mqttBrokerUrl,
      clientId: process.env.MQTT_CLIENT_ID || `api-${process.env.HOSTNAME || 'server'}`,
      username: process.env.MQTT_USERNAME,
      hasPassword: !!process.env.MQTT_PASSWORD,
      reconnectPeriod: process.env.MQTT_RECONNECT_PERIOD || '5000',
      keepalive: process.env.MQTT_KEEPALIVE || '60',
      useKeyCompaction: process.env.USE_KEY_COMPACTION_POC === 'true'
    });
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
