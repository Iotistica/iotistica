/**
 * MQTT Message Handlers
 * 
 * Processes incoming MQTT messages and queues them to Redis Streams
 */

import { pool, query } from '../db/connection';
import type MqttManager from './manager';
import type { DeviceDataMessage, StateMessage } from './manager';
import { processAgentStateReport } from '../services/agent/state';
import { ingestion } from '../services/telemetry';
import { getAnomalyEventHandler, type AnomalyEvent } from './anomaly-handler';
import { EventPublisher } from '../services/audit/event-sourcing';
import { getTenantId } from '../redis/tenant-keys';
import { mqttDevicePattern, mqttDeviceTopic } from './topics';
import logger from '../utils/logger';

type JobStatusDetails = {
  reason?: string;
  stdout?: string;
  stderr?: string;
  progress?: number;
  [key: string]: unknown;
};

type JobUpdatePayload = {
  deviceUuid: string;
  jobId: string;
  status: string;
  statusDetails?: JobStatusDetails;
  expectedVersion?: number;
  executionNumber?: number;
  clientToken?: string;
};

type AgentJobStatusRow = {
  status?: string;
  queued_at?: string | Date | null;
  started_at?: string | Date | null;
};

type QueuedJobRow = {
  id: string;
  job_document: unknown;
  created_at: string | Date;
};

const jobsEventPublisher = new EventPublisher('mqtt-jobs-handler');
let jobsMqttManager: MqttManager | null = null;

export function setJobsMqttManager(manager: MqttManager | null): void {
  jobsMqttManager = manager;
}

export async function stopJobsHandler(): Promise<void> {
  logger.info('MQTT jobs handler stopped');
  jobsMqttManager = null;
}

/**
 * Handle incoming endpoint data
 * Queue raw parsed data to Redis Stream (FAST - no compression!)
 * Supports both single messages and batches
 */
export async function handleDeviceData(data: DeviceDataMessage): Promise<void> {
  try {
    const startTime = Date.now();
    const resolvedDeviceName = data.deviceName.trim() || 'unknown';
    
    // Check if this is a batch (from Sensor Publish feature)
    const isBatch = data.data && Array.isArray((data.data as any).messages);
    
    if (isBatch) {
      // Process batch of messages
      const batch = data.data as any;
      const messages = batch.messages as object[];
      
      logger.debug('Handling device batch', {
        deviceUuid: data.deviceUuid.substring(0, 8),
        deviceName: resolvedDeviceName,
        count: messages.length,
      });
      
      // Transform canonical agent-style batch messages into device queue entries.
      // Each message is a direct payload object with top-level readings and timestamp.
      const readings = messages
        .map((message: any) => {
          if (!message || typeof message !== 'object') {
            logger.error('Ignoring invalid batch message: expected object payload', {
              deviceUuid: data.deviceUuid.substring(0, 8),
              payloadType: typeof message,
            });
            return null;
          }

          return {
            deviceUuid: data.deviceUuid,
            deviceName: message.deviceName?.trim?.() || resolvedDeviceName,
            data: message,
            timestamp: message.timestamp || batch.timestamp || new Date().toISOString(),
            metadata: {
              ...(data.metadata || {}),
              ...(batch.protocol ? { protocol: batch.protocol } : {}),
            }
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      
      // Queue raw parsed data (NO compression - worker handles it if needed)
      const outcome = await ingestion.add('metrics', readings);
      
      const duration = Date.now() - startTime;
      logger.debug('Processed metrics batch', {
        deviceUuid: data.deviceUuid.substring(0, 8),
        deviceName: resolvedDeviceName,
        received: messages.length,
        submitted: readings.length,
        dropped: messages.length - readings.length,
        destination: outcome,
        durationMs: duration,
      });
    } else {
      // Single message
      const outcome = await ingestion.add('metrics', [{
        deviceUuid: data.deviceUuid,
        deviceName: resolvedDeviceName,
        data: data.data,
        timestamp: data.timestamp,
        metadata: data.metadata || {}
      }]);
      
      const duration = Date.now() - startTime;
      logger.debug('Processed endpoints data', {
        deviceUuid: data.deviceUuid.substring(0, 8),
        deviceName: resolvedDeviceName,
        destination: outcome,
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
export async function handleAgentState(payload: StateMessage): Promise<void> {
  try {

    // Destructure new payload format
    const { deviceUuid, data: rawMqttPayload } = payload;

    if (!deviceUuid || rawMqttPayload === undefined || rawMqttPayload === null) {
      logger.error('Invalid state payload format', { hasUuid: !!deviceUuid, hasData: rawMqttPayload !== undefined && rawMqttPayload !== null });
      return;
    }

    // Some publishers may send JSON-stringified state payloads.
    // Parse string payloads so key lookups don't operate on string indices.
    let mqttPayload: any = rawMqttPayload;
    if (typeof mqttPayload === 'string') {
      try {
        mqttPayload = JSON.parse(mqttPayload);
      } catch (parseError) {
        logger.error('Invalid state payload JSON string', {
          deviceUuid: deviceUuid.substring(0, 8),
          payloadPreview: mqttPayload.substring(0, 120)
        });
        return;
      }
    }

    if (!mqttPayload || typeof mqttPayload !== 'object') {
      logger.error('Invalid state payload type after parsing', {
        deviceUuid: deviceUuid.substring(0, 8),
        payloadType: typeof mqttPayload
      });
      return;
    }

    // Extract actual state from MQTT payload
    // Common format: { "full-uuid": { apps, config, version, ... }, "msgId": "..." }
    // Compatibility fallback: already-unwrapped state object { apps, config, version, ... }
    const state = mqttPayload[deviceUuid] || mqttPayload;

    if (!state || typeof state !== 'object') {
      logger.error('State data not found under UUID key', {
        deviceUuid: deviceUuid.substring(0, 8),
        payloadKeys: Object.keys(mqttPayload)
      });
      return;
    }

    // Reconstruct old format for processDeviceStateReport
    const stateReport = { [deviceUuid]: state };
    
    // Use shared service for consistent state processing
    const tenantId = getTenantId();
    await processAgentStateReport(stateReport, {
      source: 'mqtt',
      topic: mqttDevicePattern(tenantId, '+', 'state')
    });

    // Publish to Redis for real-time distribution (MQTT-specific, non-blocking)
    try {
      const { redisClient } = await import('../redis/client');
      
      if (deviceUuid && state) {
        // Publish full state to device:{uuid}:state channel
        await redisClient.publishAgentState(tenantId, deviceUuid, state);
        
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
            network_interfaces: state.network_interfaces,
          };
          await redisClient.publishAgentMetrics(tenantId, deviceUuid, metrics);
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
       WHERE agent_uuid = $1 
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
        
        // Update device agent_version in agents table
        if (status.target_version) {
          await query(
            `UPDATE agents 
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

/**
 * Handle anomaly events from edge agents
 * Performs cloud-side correlation, deduplication, and alerting
 */
export async function handleAnomalyEvent(event: AnomalyEvent): Promise<void> {
  try {
    const handler = getAnomalyEventHandler();
    await handler.handleEvent(event);
  } catch (error) {
    logger.error('Failed to handle anomaly event:', error);
    throw error;
  }
}

/**
 * Handle job-related MQTT messages
 * Processes job updates and start-next requests from agents
 */
export async function handleJobMessage(data: { topic: string; payload: Buffer }): Promise<void> {
  try {
    const message = JSON.parse(data.payload.toString()) as Record<string, unknown>;

    if (data.topic.endsWith('/update')) {
      await handleJobUpdateMessage(data.topic, message);
      return;
    }

    if (data.topic.endsWith('/start-next')) {
      await handleStartNextRequest(data.topic);
    }
  } catch (error) {
    logger.error('Failed to handle job message:', error);
    throw error;
  }
}

export async function publishJobNotification(deviceUuid: string, jobId: string, jobDocument: unknown): Promise<void> {
  if (!jobsMqttManager) {
    throw new Error('MQTT manager not initialized');
  }

  const tenantId = getTenantId();
  const topic = mqttDeviceTopic(tenantId, deviceUuid, 'jobs', 'notify');
  const payload = JSON.stringify({
    execution: {
      jobId,
      jobDocument,
      queuedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      versionNumber: 1,
      executionNumber: 1,
      status: 'QUEUED',
    },
    timestamp: Date.now(),
  });

  await jobsMqttManager.publish(topic, payload, 1);
  logger.info(`Published job notification to ${topic}`, { jobId });
}

async function handleJobUpdateMessage(topic: string, message: Record<string, unknown>): Promise<void> {
  const parts = topic.split('/');
  const deviceUuid = parts[2];
  const jobId = parts[4];
  const statusDetails = isRecord(message.statusDetails) ? (message.statusDetails as JobStatusDetails) : undefined;

  logger.info(`Received job update for ${jobId} from device ${deviceUuid}`, {
    status: message.status,
    hasStdout: !!statusDetails?.stdout,
    hasStderr: !!statusDetails?.stderr,
  });

  await handleJobUpdate({
    deviceUuid,
    jobId,
    status: typeof message.status === 'string' ? message.status : 'UNKNOWN',
    statusDetails,
    expectedVersion: typeof message.expectedVersion === 'number' ? message.expectedVersion : undefined,
    executionNumber: typeof message.executionNumber === 'number' ? message.executionNumber : undefined,
    clientToken: typeof message.clientToken === 'string' ? message.clientToken : undefined,
  });
}

async function handleStartNextRequest(topic: string): Promise<void> {
  const parts = topic.split('/');
  const deviceUuid = parts[2];

  logger.info(`Received start-next request from device ${deviceUuid}`);

  const result = await pool.query<QueuedJobRow>(
    `SELECT id, job_document, created_at 
     FROM jobs 
     WHERE agent_uuid = $1 AND status = 'QUEUED' 
     ORDER BY created_at ASC 
     LIMIT 1`,
    [deviceUuid]
  );

  await publishStartNextResponse(deviceUuid, result.rows[0] ?? null);
}

async function publishStartNextResponse(deviceUuid: string, job: QueuedJobRow | null): Promise<void> {
  if (!jobsMqttManager) {
    throw new Error('MQTT manager not initialized');
  }

  const tenantId = getTenantId();
  const topicSuffix = job ? 'accepted' : 'rejected';
  const topic = mqttDeviceTopic(tenantId, deviceUuid, 'jobs', 'start-next', topicSuffix);
  const payload = job
    ? {
        execution: {
          jobId: job.id,
          jobDocument: job.job_document,
          queuedAt: new Date(job.created_at).getTime(),
          lastUpdatedAt: Date.now(),
          versionNumber: 1,
          executionNumber: 1,
          status: 'IN_PROGRESS',
        },
        timestamp: Date.now(),
      }
    : {
        timestamp: Date.now(),
        clientToken: null,
      };

  await jobsMqttManager.publish(topic, JSON.stringify(payload), 1);
  logger.info(`Published start-next response to ${topic}`);
}

async function handleJobUpdate(update: JobUpdatePayload): Promise<void> {
  logger.info({ update }, '[JobsHandler] Raw update object');

  const { deviceUuid, jobId, status, statusDetails } = update;

  logger.debug({
    deviceUuid,
    status,
    hasDetails: !!statusDetails,
    jobIdType: typeof jobId,
    jobIdValue: jobId,
  }, `[JobsHandler] Processing update for job ${jobId}`);

  try {
    const existing = await pool.query<AgentJobStatusRow>(
      'SELECT * FROM agent_job_status WHERE job_id = $1 AND agent_uuid = $2',
      [jobId, deviceUuid]
    );

    const now = new Date();
    const stdout = typeof statusDetails?.stdout === 'string' ? statusDetails.stdout : null;
    const stderr = typeof statusDetails?.stderr === 'string' ? statusDetails.stderr : null;
    const reason = typeof statusDetails?.reason === 'string' ? statusDetails.reason : null;

    if (existing.rows.length > 0) {
      let updateQuery = `
        UPDATE agent_job_status 
        SET status = $1, 
            updated_at = $2,
            reason = COALESCE($3, reason)
      `;
      const params: Array<string | Date | null> = [status, now, reason];
      let paramIndex = 4;

      if (stdout) {
        updateQuery += `, stdout = $${paramIndex}`;
        params.push(stdout);
        paramIndex++;
      }

      if (stderr) {
        updateQuery += `, stderr = $${paramIndex}`;
        params.push(stderr);
        paramIndex++;
      }

      if (status === 'IN_PROGRESS' && !existing.rows[0].started_at) {
        updateQuery += `, started_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      }

      if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(status)) {
        updateQuery += `, completed_at = $${paramIndex}`;
        params.push(now);
        paramIndex++;
      }

      updateQuery += ` WHERE job_id = $${paramIndex} AND agent_uuid = $${paramIndex + 1}`;
      params.push(jobId, deviceUuid);

      await pool.query(updateQuery, params);

      logger.info(`[JobsHandler] Updated job ${jobId} status to ${status}`);
      await publishJobEvent(deviceUuid, jobId, status, existing.rows[0], statusDetails);
      return;
    }

    logger.warn(`[JobsHandler] Job status record not found, creating new one for ${jobId}`);

    await pool.query(
      `INSERT INTO agent_job_status 
       (job_id, agent_uuid, status, queued_at, started_at, completed_at, stdout, stderr, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        jobId,
        deviceUuid,
        status,
        now,
        status === 'IN_PROGRESS' ? now : null,
        ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(status) ? now : null,
        stdout,
        stderr,
        reason,
        now,
      ]
    );

    logger.info(`[JobsHandler] Created job status record for ${jobId}`);
  } catch (error) {
    logger.error(`[JobsHandler] Failed to update job ${jobId}:`, error);
  }
}

async function publishJobEvent(
  deviceUuid: string,
  jobId: string,
  status: string,
  previousRecord: AgentJobStatusRow,
  statusDetails?: JobStatusDetails
): Promise<void> {
  const eventMap: Record<string, string> = {
    IN_PROGRESS: 'job.started',
    SUCCEEDED: 'job.completed',
    FAILED: 'job.failed',
    TIMED_OUT: 'job.timeout',
    CANCELED: 'job.cancelled',
  };

  let eventType = eventMap[status];

  if (status === 'IN_PROGRESS' && statusDetails?.progress !== undefined && previousRecord?.status === 'IN_PROGRESS') {
    eventType = 'job.progress';
  }

  if (!eventType) {
    return;
  }

  const eventData: Record<string, unknown> = {
    job_id: jobId,
    status,
    previous_status: previousRecord?.status,
  };

  if (eventType === 'job.started') {
    eventData.started_at = new Date().toISOString();
    eventData.queued_at = previousRecord?.queued_at;
  } else if (['job.completed', 'job.failed', 'job.timeout', 'job.cancelled'].includes(eventType)) {
    eventData.completed_at = new Date().toISOString();
    eventData.started_at = previousRecord?.started_at;
    eventData.queued_at = previousRecord?.queued_at;

    if (previousRecord?.started_at) {
      const duration = Date.now() - new Date(previousRecord.started_at).getTime();
      eventData.duration_ms = duration;
    }
  }

  if (statusDetails) {
    if (statusDetails.reason) eventData.reason = statusDetails.reason;
    if (statusDetails.progress !== undefined) eventData.progress = statusDetails.progress;
    if (eventType === 'job.failed' && statusDetails.stderr) {
      eventData.error_output = statusDetails.stderr.substring(0, 500);
    }
  }

  const severity = eventType === 'job.failed' ? 'error' : eventType === 'job.timeout' ? 'warning' : 'info';
  const impact = eventType === 'job.failed' ? 'medium' : 'low';

  await jobsEventPublisher.publish(
    eventType,
    'agent',
    deviceUuid,
    eventData,
    {
      metadata: {
        job_status_details: statusDetails
      },
      severity,
      impact,
      actor: {
        type: 'device',
        id: deviceUuid
      }
    }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
