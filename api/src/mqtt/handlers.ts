/**
 * MQTT Message Handlers
 * 
 * Processes incoming MQTT messages and queues them to Redis Streams
 */

import { query } from '../db/connection';
import type { SensorData, MetricsData, StateMessage } from './mqtt-manager';
import { processDeviceStateReport } from '../services/device-state';
import { redisSensorQueue } from '../services/redis-sensor-queue';
import logger from '../utils/logger';

/**
 * Handle incoming endpoint data
 * Queue to Redis Stream for batch processing
 * Supports both single messages and batches
 */
export async function handleEndpointsData(data: SensorData): Promise<void> {
  try {
    const startTime = Date.now();
    
    
    // Check if this is a batch (from Sensor Publish feature)
    const isBatch = data.data && Array.isArray((data.data as any).messages);
    
    if (isBatch) {
      // Process batch of messages
      const batch = data.data as any;
      const messages = batch.messages as (string | object)[];
      
      logger.debug(`Processing endpoints data batch: ${messages.length} messages from ${data.deviceUuid}/${data.sensorName}`);
      
      // Transform all messages to queue format
      // Handle both JSON strings (legacy) and objects (current format)
      const queueEntries = messages
        .map((messageData: string | object) => {
          try {
            // If it's a string, parse it; if it's already an object, use it directly
            const message = typeof messageData === 'string' ? JSON.parse(messageData) : messageData;
            return {
              deviceUuid: data.deviceUuid,
              sensorName: data.sensorName,
              data: message,
              timestamp: message.timestamp || batch.timestamp || new Date().toISOString(),
              metadata: data.metadata || {}
            };
          } catch (parseError) {
            logger.error(`Failed to parse message in batch: ${messageData}`, parseError);
            return null;
          }
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      
      // Add to Redis Stream
      await redisSensorQueue.add(queueEntries);
      
      const duration = Date.now() - startTime;
      logger.info('Queued endpoints data batch to Redis Stream', {
        deviceUuid: data.deviceUuid.substring(0, 8),
        sensorName: data.sensorName,
        received: messages.length,
        queued: queueEntries.length,
        dropped: messages.length - queueEntries.length,
        durationMs: duration
      });
    } else {
      // Single message (legacy format)
      await redisSensorQueue.add([{
        deviceUuid: data.deviceUuid,
        sensorName: data.sensorName,
        data: data.data,
        timestamp: data.timestamp,
        metadata: data.metadata || {}
      }]);
      
      const duration = Date.now() - startTime;
      logger.debug('Queued endpoints data to Redis Stream', {
        deviceUuid: data.deviceUuid.substring(0, 8),
        sensorName: data.sensorName,
        durationMs: duration
      });
    }

  } catch (error) {
    logger.error('Failed to queue endpoints data:', error);
    throw error;
  }
}

/**
 * Handle device state updates (MQTT primary path)
 * Processes full device state reports including config, apps, and metrics
 * Dual-write: PostgreSQL (durable) + Redis pub/sub (real-time)
 */
export async function handleDeviceState(payload: StateMessage): Promise<void> {
  try {
    // Destructure new payload format
    const { deviceUuid, data: mqttPayload } = payload;
    
    if (!deviceUuid || !mqttPayload) {
      logger.error('Invalid state payload format', { hasUuid: !!deviceUuid, hasData: !!mqttPayload });
      return;
    }
    
    // Extract actual state from MQTT payload
    // MQTT sends: { "full-uuid": { apps, config, version, ... }, "msgId": "..." }
    // We need to extract just the state object under the UUID key
    const state = mqttPayload[deviceUuid];
    
    if (!state) {
      logger.error('State data not found under UUID key', {
        deviceUuid: deviceUuid.substring(0, 8),
        payloadKeys: Object.keys(mqttPayload)
      });
      return;
    }
    
    // Reconstruct old format for processDeviceStateReport
    const stateReport = { [deviceUuid]: state };
    
    // Use shared service for consistent state processing
    await processDeviceStateReport(stateReport, {
      source: 'mqtt',
      topic: 'iot/device/+/state'
    });

    // Publish to Redis for real-time distribution (MQTT-specific, non-blocking)
    try {
      const { redisClient } = await import('../redis/client');
      
      if (deviceUuid && state) {
        // Publish full state to device:{uuid}:state channel
        await redisClient.publishDeviceState(deviceUuid, state);
        
        // Publish metrics-only to device:{uuid}:metrics channel (if metrics present)
        if (
          state.cpu_usage !== undefined ||
          state.memory_usage !== undefined ||
          state.storage_usage !== undefined
        ) {
          const metrics = {
            cpu_usage: state.cpu_usage,
            cpu_temp: state.temperature,
            memory_usage: state.memory_usage,
            memory_total: state.memory_total,
            storage_usage: state.storage_usage,
            storage_total: state.storage_total,
            top_processes: state.top_processes,
            network_interfaces: state.network_interfaces,
          };
          await redisClient.publishDeviceMetrics(deviceUuid, metrics);
        }
      }
    } catch (error) {
      // Log but don't throw - graceful degradation
      logger.error('  Failed to publish to Redis (continuing with PostgreSQL only):', error);
    }

  } catch (error) {
    logger.error('  Failed to handle device state:', error);
    throw error;
  }
}

/**
 * Handle agent update status messages
 * Tracks agent self-update progress and records in database
 */
export async function handleAgentStatus(data: any): Promise<void> {
  try {
    const { deviceUuid, subTopic, message } = data;
    
    // Only handle 'status' subtopic (iot/device/{uuid}/agent/status)
    if (subTopic !== 'status') {
      return;
    }

    const status = typeof message === 'string' ? JSON.parse(message) : message;
    
    logger.info('Received agent update status', {
      deviceUuid,
      statusType: status.type,
      version: status.version || status.target_version
    });

    // Find the latest pending/in-progress update for this device
    const result = await query(
      `SELECT id, status, target_version 
       FROM agent_updates 
       WHERE device_uuid = $1 
       AND status IN ('pending', 'acknowledged', 'scheduled', 'in_progress')
       ORDER BY created_at DESC 
       LIMIT 1`,
      [deviceUuid]
    );

    if (result.rows.length === 0) {
      logger.warn('Received status update but no pending update found', {
        deviceUuid,
        statusType: status.type
      });
      return;
    }

    const updateId = result.rows[0].id;

    // Update status based on message type
    switch (status.type) {
      case 'update_command_received':
        await query(
          `UPDATE agent_updates 
           SET status = 'acknowledged', 
               current_version = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [updateId, status.current_version]
        );
        logger.info('Update acknowledged', { updateId, deviceUuid });
        break;

      case 'update_scheduled':
        await query(
          `UPDATE agent_updates 
           SET status = 'scheduled', 
               scheduled_time = $2,
               current_version = $3,
               updated_at = NOW()
           WHERE id = $1`,
          [updateId, status.scheduled_time, status.current_version]
        );
        logger.info('Update scheduled', { 
          updateId, 
          deviceUuid, 
          scheduledTime: status.scheduled_time 
        });
        break;

      case 'update_started':
        await query(
          `UPDATE agent_updates 
           SET status = 'in_progress', 
               started_at = NOW(),
               current_version = $2,
               deployment_type = $3,
               timeout_at = NOW() + INTERVAL '30 minutes',
               updated_at = NOW()
           WHERE id = $1`,
          [updateId, status.current_version, status.deployment_type]
        );
        logger.info('Update started', { 
          updateId, 
          deviceUuid, 
          deploymentType: status.deployment_type 
        });
        break;

      case 'update_succeeded':
        await query(
          `UPDATE agent_updates 
           SET status = 'succeeded', 
               completed_at = NOW(),
               exit_code = 0,
               updated_at = NOW()
           WHERE id = $1`,
          [updateId]
        );
        
        // Update device agent_version in devices table
        if (status.target_version) {
          await query(
            `UPDATE devices 
             SET agent_version = $1, 
                 modified_at = NOW() 
             WHERE uuid = $2`,
            [status.target_version, deviceUuid]
          );
          logger.info('Update succeeded - device version updated', { 
            updateId, 
            deviceUuid, 
            newVersion: status.target_version 
        });
        }
        break;

      case 'update_failed':
        await query(
          `UPDATE agent_updates 
           SET status = 'failed', 
               completed_at = NOW(),
               error_message = $2,
               exit_code = $3,
               updated_at = NOW()
           WHERE id = $1`,
          [updateId, status.error, status.exit_code]
        );
        logger.error('Update failed', { 
          updateId, 
          deviceUuid, 
          error: status.error 
        });
        break;

      default:
        logger.warn('Unknown agent status type', { 
          statusType: status.type, 
          deviceUuid 
        });
    }

  } catch (error) {
    logger.error('Failed to handle agent status:', error);
    throw error;
  }
}

