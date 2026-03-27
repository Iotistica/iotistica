/**
 * MQTT Jobs Handler
 * 
 * Listens for job status updates from agents via MQTT and saves them to the database.
 * Handles the server-side of the AWS IoT Jobs MQTT protocol.
 */

import type { MqttManager } from './manager';
import { pool } from '../db/connection';
import { EventPublisher } from '../services/event-sourcing';
import logger from '../utils/logger';
import { mqttDeviceTopic } from './topics';
import { getTenantId } from '../redis/tenant-keys';

export class JobsHandler {
  private eventPublisher = new EventPublisher('mqtt-jobs-handler');
  private mqttManager: MqttManager | null = null;

  /**
   * Set MQTT manager instance (called once during initialization)
   */
  setMqttManager(manager: MqttManager): void {
    this.mqttManager = manager;
  }

  /**
   * Process incoming job message (called by handler)
   */
  async processMessage(topic: string, payload: Buffer): Promise<void> {
    try {
      const message = JSON.parse(payload.toString());
      
      // Handle job update messages
      if (topic.endsWith('/update')) {
        await this.handleJobUpdateMessage(topic, message);
      }
      
      // Handle start-next requests
      else if (topic.endsWith('/start-next')) {
        await this.handleStartNextRequest(topic, message);
      }
    } catch (error) {
      logger.error(`Failed to process job message on ${topic}`, { error });
      throw error;
    }
  }

  /**
   * Handle job update message from MQTT
   */
  private async handleJobUpdateMessage(topic: string, message: any): Promise<void> {
    // Parse topic: iot/device/{deviceUuid}/jobs/{jobId}/update
    const parts = topic.split('/');
    const deviceUuid = parts[2];
    const jobId = parts[4];

    logger.info(`Received job update for ${jobId} from device ${deviceUuid}`, {
      status: message.status,
      hasStdout: !!message.statusDetails?.stdout,
      hasStderr: !!message.statusDetails?.stderr,
    });

    // Process the update
    await this.handleJobUpdate({
      deviceUuid,
      jobId,
      status: message.status,
      statusDetails: message.statusDetails,
    });
  }

  /**
   * Handle start-next request from device
   */
  private async handleStartNextRequest(topic: string, message: any): Promise<void> {
    const parts = topic.split('/');
    const deviceUuid = parts[2];

    logger.info(`Received start-next request from device ${deviceUuid}`);
    
    // Fetch next pending job for this device
    const result = await pool.query(
      `SELECT id, job_document, created_at 
       FROM jobs 
       WHERE agent_uuid = $1 AND status = 'QUEUED' 
       ORDER BY created_at ASC 
       LIMIT 1`,
      [deviceUuid]
    );

    const nextJob = result.rows[0] || null;
    
    // Publish response
    await this.publishStartNextResponse(deviceUuid, nextJob);
  }

  /**
   * Publish start-next response to device
   */
  private async publishStartNextResponse(deviceUuid: string, job: any | null): Promise<void> {
    if (!this.mqttManager) {
      throw new Error('MQTT manager not initialized');
    }
    
    const tenantId = getTenantId();
    const topicSuffix = job ? 'accepted' : 'rejected';
    const topic = mqttDeviceTopic(tenantId, deviceUuid, 'jobs', 'start-next', topicSuffix);

    const payload = job ? {
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
    } : {
      timestamp: Date.now(),
      clientToken: null,
    };

    await this.mqttManager.publish(topic, JSON.stringify(payload), 1);
    logger.info(`Published start-next response to ${topic}`);
  }

  /**
   * Publish job notification to device
   */
  async publishJobNotification(deviceUuid: string, jobId: string, jobDocument: any): Promise<void> {
    if (!this.mqttManager) {
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

    await this.mqttManager.publish(topic, payload, 1);
    logger.info(`Published job notification to ${topic}`, { jobId });
  }

  /**
   * Handle job status update from device
   */
  private async handleJobUpdate(update: {
    deviceUuid: string;
    jobId: string;
    status: string;
    statusDetails?: {
      reason?: string;
      stdout?: string;
      stderr?: string;
      progress?: number;
      [key: string]: any;
    };
    expectedVersion?: number;
    executionNumber?: number;
    clientToken?: string;
  }): Promise<void> {
    // Debug: Log raw update object
    logger.info(`[JobsHandler] Raw update object:`, JSON.stringify(update, null, 2));
    
    const { deviceUuid, jobId, status, statusDetails } = update;

    console.log(`[JobsHandler] Processing update for job ${jobId}:`, {
      deviceUuid,
      status,
      hasDetails: !!statusDetails,
      jobIdType: typeof jobId,
      jobIdValue: jobId,
    });

    try {
      // Check if record exists
      const existing = await pool.query(
        'SELECT * FROM agent_job_status WHERE job_id = $1 AND agent_uuid = $2',
        [jobId, deviceUuid]
      );

      const now = new Date();
      const stdout = statusDetails?.stdout || null;
      const stderr = statusDetails?.stderr || null;
      const reason = statusDetails?.reason || null;

      if (existing.rows.length > 0) {
        // Update existing record
        let updateQuery = `
          UPDATE agent_job_status 
          SET status = $1, 
              updated_at = $2,
              reason = COALESCE($3, reason)
        `;
        const params: any[] = [status, now, reason];
        let paramIndex = 4;

        // Add stdout if provided
        if (stdout) {
          updateQuery += `, stdout = $${paramIndex}`;
          params.push(stdout);
          paramIndex++;
        }

        // Add stderr if provided
        if (stderr) {
          updateQuery += `, stderr = $${paramIndex}`;
          params.push(stderr);
          paramIndex++;
        }

        // Set started_at if status is IN_PROGRESS and not already set
        if (status === 'IN_PROGRESS' && !existing.rows[0].started_at) {
          updateQuery += `, started_at = $${paramIndex}`;
          params.push(now);
          paramIndex++;
        }

        // Set completed_at if status is terminal (SUCCEEDED, FAILED, etc.)
        if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(status)) {
          updateQuery += `, completed_at = $${paramIndex}`;
          params.push(now);
          paramIndex++;
        }

        updateQuery += ` WHERE job_id = $${paramIndex} AND agent_uuid = $${paramIndex + 1}`;
        params.push(jobId, deviceUuid);

        await pool.query(updateQuery, params);

        logger.info(`[JobsHandler] Updated job ${jobId} status to ${status}`);

        // Publish job lifecycle events
        await this.publishJobEvent(deviceUuid, jobId, status, existing.rows[0], statusDetails);
      } else {
        // Insert new record (should already exist from job creation, but handle just in case)
        logger.warn(`[JobsHandler] Job status record not found, creating new one for ${jobId}`);

        await pool.query(
          `INSERT INTO agent_job_status 
           (job_id, agent_uuid, status, queued_at, started_at, completed_at, stdout, stderr, reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            jobId,
            deviceUuid,
            status,
            now, // queued_at
            status === 'IN_PROGRESS' ? now : null,
            ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED'].includes(status) ? now : null,
            stdout,
            stderr,
            reason,
            now,
          ]
        );

        logger.info(`[JobsHandler] Created job status record for ${jobId}`);
      }
    } catch (error) {
      logger.error(`[JobsHandler] Failed to update job ${jobId}:`, error);
    }
  }

  /**
   * Publish job lifecycle events based on status
   */
  private async publishJobEvent(
    deviceUuid: string,
    jobId: string,
    status: string,
    previousRecord: any,
    statusDetails?: any
  ): Promise<void> {
    const eventMap: Record<string, string> = {
      'IN_PROGRESS': 'job.started',
      'SUCCEEDED': 'job.completed',
      'FAILED': 'job.failed',
      'TIMED_OUT': 'job.timeout',
      'CANCELED': 'job.cancelled',
    };

    let eventType = eventMap[status];
    
    // Special case: IN_PROGRESS with progress updates
    if (status === 'IN_PROGRESS' && statusDetails?.progress !== undefined && previousRecord?.status === 'IN_PROGRESS') {
      eventType = 'job.progress';
    }

    if (!eventType) {
      return; // No event for QUEUED or unknown status
    }

    const eventData: any = {
      job_id: jobId,
      status,
      previous_status: previousRecord?.status,
    };

    // Add timing information
    if (eventType === 'job.started') {
      eventData.started_at = new Date().toISOString();
      eventData.queued_at = previousRecord?.queued_at;
    } else if (['job.completed', 'job.failed', 'job.timeout', 'job.cancelled'].includes(eventType)) {
      eventData.completed_at = new Date().toISOString();
      eventData.started_at = previousRecord?.started_at;
      eventData.queued_at = previousRecord?.queued_at;
      
      // Calculate duration
      if (previousRecord?.started_at) {
        const duration = Date.now() - new Date(previousRecord.started_at).getTime();
        eventData.duration_ms = duration;
      }
    }

    // Add status details
    if (statusDetails) {
      if (statusDetails.reason) eventData.reason = statusDetails.reason;
      if (statusDetails.progress !== undefined) eventData.progress = statusDetails.progress;
      if (eventType === 'job.failed' && statusDetails.stderr) {
        eventData.error_output = statusDetails.stderr.substring(0, 500); // Limit size
      }
    }

    const severity = eventType === 'job.failed' ? 'error' : 
                     eventType === 'job.timeout' ? 'warning' : 'info';
    const impact = eventType === 'job.failed' ? 'medium' : 'low';

    await this.eventPublisher.publish(
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

  /**
   * Stop the handler
   */
  async stop(): Promise<void> {
    logger.info('[JobsHandler] Stopping jobs handler');
    this.mqttManager = null;
  }
}

// Singleton instance
let instance: JobsHandler | null = null;

export function getJobsHandler(): JobsHandler {
  if (!instance) {
    instance = new JobsHandler();
  }
  
  return instance;
}
