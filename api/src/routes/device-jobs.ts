/**
 * Device Jobs Management Routes
 * 
 * API endpoints for managing device jobs (inspired by AWS IoT Jobs).
 * Allows cloud-based creation, scheduling, and tracking of device jobs.
 */

import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import poolWrapper from '../db/connection';
import deviceAuth, { deviceAuthFromBody } from '../middleware/device-auth';
import { validateProvisioningKey } from '../utils/provisioning-keys';
import { getMqttJobsNotifier } from '../services/mqtt-jobs-notifier';
import { hasPermission, hasAnyPermission } from '../middleware/permissions';
import { PERMISSIONS } from '../types/permissions';
import { jwtAuth } from '../middleware/jwt-auth';
import { EventPublisher } from '../services/event-sourcing';
import { logger } from '../utils/logger';

const router = express.Router();
const pool = poolWrapper.pool;
const mqttNotifier = getMqttJobsNotifier();
const eventPublisher = new EventPublisher('device-jobs-api');

// Apply JWT authentication to all dashboard/cloud routes
// Device routes use deviceAuth middleware individually
router.use('/jobs/templates', jwtAuth);
router.use('/jobs/executions', jwtAuth);
router.use('/jobs/handlers', jwtAuth);

// =============================================================================
// Job Templates Management
// =============================================================================

/**
 * GET /api/v1/jobs/templates
 * List all job templates
 * Requires: SETTINGS_READ permission (viewers and up)
 */
router.get('/jobs/templates', 
  hasPermission(PERMISSIONS.SETTINGS_READ),
  async (req: Request, res: Response) => {
  try {
    const { category, active } = req.query;

    let query = 'SELECT * FROM job_templates WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (category) {
      query += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (active !== undefined) {
      query += ` AND is_active = $${paramIndex}`;
      params.push(active === 'true');
      paramIndex++;
    }

    query += ' ORDER BY category, name';

    const result = await pool.query(query, params);

    return res.status(200).json({
      templates: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    logger.error('Error fetching job templates:', error);
    return res.status(500).json({
      error: 'Failed to fetch job templates',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/jobs/templates/:id
 * Get a specific job template
 * Requires: SETTINGS_READ permission
 */
router.get('/jobs/templates/:id', 
  hasPermission(PERMISSIONS.SETTINGS_READ),
  async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM job_templates WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job template not found' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error('Error fetching job template:', error);
    return res.status(500).json({
      error: 'Failed to fetch job template',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/jobs/templates
 * Create a new job template
 */
router.post('/jobs/templates', async (req: Request, res: Response) => {
  try {
    const { name, description, category, job_document, created_by } = req.body;

    if (!name || !job_document) {
      return res.status(400).json({
        error: 'Missing required fields: name, job_document',
      });
    }

    const result = await pool.query(
      `INSERT INTO job_templates (name, description, category, job_document, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description, category || 'custom', JSON.stringify(job_document), created_by]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    logger.error('Error creating job template:', error);
    
    if (error.code === '23505') {  // Unique violation
      return res.status(409).json({
        error: 'Job template with this name already exists',
      });
    }

    return res.status(500).json({
      error: 'Failed to create job template',
      message: error.message,
    });
  }
});

/**
 * PUT /api/v1/jobs/templates/:id
 * Update a job template
 */
router.put('/jobs/templates/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, category, job_document, is_active } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex}`);
      params.push(name);
      paramIndex++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(description);
      paramIndex++;
    }

    if (category) {
      updates.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (job_document) {
      updates.push(`job_document = $${paramIndex}`);
      params.push(JSON.stringify(job_document));
      paramIndex++;
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      params.push(is_active);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE job_templates SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job template not found' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error('Error updating job template:', error);
    return res.status(500).json({
      error: 'Failed to update job template',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/v1/jobs/templates/:id
 * Delete a job template
 */
router.delete('/jobs/templates/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM job_templates WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job template not found' });
    }

    return res.status(200).json({
      message: 'Job template deleted successfully',
      id: result.rows[0].id,
    });
  } catch (error) {
    logger.error('Error deleting job template:', error);
    return res.status(500).json({
      error: 'Failed to delete job template',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =============================================================================
// Job Executions Management
// =============================================================================

/**
 * POST /api/v1/jobs/execute
 * Create and execute a job
 */
router.post('/jobs/execute', async (req: Request, res: Response) => {
  try {
    const {
      job_name,
      job_document,
      template_id,
      target_type,
      target_devices,
      target_filter,
      execution_type,
      schedule,
      max_executions,
      timeout_minutes,
      created_by,
    } = req.body;

    if (!job_name) {
      return res.status(400).json({ error: 'job_name is required' });
    }

    if (!job_document && !template_id) {
      return res.status(400).json({
        error: 'Either job_document or template_id must be provided',
      });
    }

    if (!target_type || !['device', 'group', 'all'].includes(target_type)) {
      return res.status(400).json({
        error: 'target_type must be one of: device, group, all',
      });
    }

    // If using template, fetch the template
    let finalJobDocument = job_document;
    if (template_id && !job_document) {
      const templateResult = await pool.query(
        'SELECT job_document FROM job_templates WHERE id = $1',
        [template_id]
      );

      if (templateResult.rows.length === 0) {
        return res.status(404).json({ error: 'Job template not found' });
      }

      finalJobDocument = templateResult.rows[0].job_document;
    }

    // Get target devices
    let deviceUuids: string[] = [];
    if (target_type === 'device') {
      deviceUuids = target_devices || [];
    } else if (target_type === 'all') {
      const devicesResult = await pool.query(
        'SELECT uuid FROM devices WHERE is_active = true'
      );
      deviceUuids = devicesResult.rows.map((row: any) => row.uuid);
    } else if (target_type === 'group' && target_filter) {
      // Apply filter (e.g., { "device_type": "raspberry-pi" })
      const filterKeys = Object.keys(target_filter);
      const filterQuery = filterKeys.map((key, idx) => `${key} = $${idx + 1}`).join(' AND ');
      const filterValues = filterKeys.map(key => target_filter[key]);

      const devicesResult = await pool.query(
        `SELECT uuid FROM devices WHERE is_active = true AND ${filterQuery}`,
        filterValues
      );
      deviceUuids = devicesResult.rows.map((row: any) => row.uuid);
    }

    if (deviceUuids.length === 0) {
      return res.status(400).json({ error: 'No target devices found' });
    }

    const jobId = randomUUID();

    // Create job execution
    const jobResult = await pool.query(
      `INSERT INTO job_executions (
        job_id, template_id, job_name, job_document, target_type, target_devices,
        target_filter, execution_type, schedule, max_executions, timeout_minutes,
        total_devices, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        jobId,
        template_id || null,
        job_name,
        JSON.stringify(finalJobDocument),
        target_type,
        deviceUuids,
        target_filter ? JSON.stringify(target_filter) : null,
        execution_type || 'oneTime',
        schedule ? JSON.stringify(schedule) : null,
        max_executions || null,
        timeout_minutes || 60,
        deviceUuids.length,
        created_by || 'admin',
      ]
    );

    // Create device job status entries
    const deviceStatusValues = deviceUuids.map((uuid) => `('${jobId}', '${uuid}')`).join(', ');
    await pool.query(
      `INSERT INTO device_job_status (job_id, device_uuid) VALUES ${deviceStatusValues}`
    );

    logger.info(`Created job ${jobId} for ${deviceUuids.length} devices`);

    // 🎉 EVENT SOURCING: Publish job.queued event for each device
    for (const deviceUuid of deviceUuids) {
      await eventPublisher.publish(
        'job.queued',
        'device',
        deviceUuid,
        {
          job_id: jobId,
          job_name,
          template_id: template_id || null,
          execution_type: execution_type || 'oneTime',
          timeout_minutes: timeout_minutes || 60,
          queued_at: new Date().toISOString()
        },
        {
          metadata: {
            request: {
              method: 'POST',
              path: '/jobs/executions',
              user_agent: req.headers['user-agent']
            }
          },
          severity: 'info',
          impact: 'low',
          actor: {
            type: 'user',
            id: created_by || 'admin',
            ip_address: req.ip
          }
        }
      );
    }

    // Send MQTT notification for real-time job delivery
    if (mqttNotifier.connected) {
      try {
        for (const deviceUuid of deviceUuids) {
          await mqttNotifier.notifyNextJob(deviceUuid, {
            job_id: jobId,
            job_name,
            job_document: finalJobDocument,
            queued_at: new Date(),
            timeout_seconds: (timeout_minutes || 60) * 60,
          });
        }
        logger.info(`Sent MQTT notifications to ${deviceUuids.length} devices`);
      } catch (mqttError) {
        logger.error('Failed to send MQTT notifications (HTTP fallback will work):', mqttError);
      }
    } else {
      logger.info('MQTT not connected - devices will receive jobs via HTTP polling');
    }

    return res.status(201).json({
      job: jobResult.rows[0],
      message: `Job created and queued for ${deviceUuids.length} device(s)`,
    });
  } catch (error) {
    logger.error('Error creating job execution:', error);
    return res.status(500).json({
      error: 'Failed to create job execution',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/jobs/executions
 * List all job executions
 */
router.get('/jobs/executions', async (req: Request, res: Response) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT * FROM job_executions WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await pool.query(query, params);

    return res.status(200).json({
      executions: result.rows,
      total: result.rows.length,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error) {
    logger.error('Error fetching job executions:', error);
    return res.status(500).json({
      error: 'Failed to fetch job executions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/jobs/executions/:jobId
 * Get details of a specific job execution
 */
router.get('/jobs/executions/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Get job execution
    const jobResult = await pool.query(
      'SELECT * FROM job_executions WHERE job_id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job execution not found' });
    }

    // Get device statuses
    const statusResult = await pool.query(
      `SELECT 
        djs.*,
        d.device_name,
        d.ip_address
       FROM device_job_status djs
       LEFT JOIN devices d ON djs.device_uuid = d.uuid
       WHERE djs.job_id = $1
       ORDER BY djs.updated_at DESC`,
      [jobId]
    );

    return res.status(200).json({
      job: jobResult.rows[0],
      device_statuses: statusResult.rows,
    });
  } catch (error) {
    logger.error('Error fetching job execution:', error);
    return res.status(500).json({
      error: 'Failed to fetch job execution',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/jobs/executions/:jobId/cancel
 * Cancel a job execution
 */
router.post('/jobs/executions/:jobId/cancel', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Update job status
    const jobResult = await pool.query(
      `UPDATE job_executions 
       SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
       WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')
       RETURNING *`,
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Job not found or already completed',
      });
    }

    // Update pending device job statuses
    await pool.query(
      `UPDATE device_job_status
       SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
       WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')`,
      [jobId]
    );

    return res.status(200).json({
      message: 'Job canceled successfully',
      job: jobResult.rows[0],
    });
  } catch (error) {
    logger.error('Error canceling job:', error);
    return res.status(500).json({
      error: 'Failed to cancel job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/devices/:uuid/jobs
 * Get jobs for a specific device
 */
router.get('/devices/:uuid/jobs', async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const { status, limit = 20, offset = 0 } = req.query;

    // Count total jobs for this device
    let countQuery = `
      SELECT COUNT(*) as total
      FROM device_job_status djs
      WHERE djs.device_uuid = $1
    `;
    const countParams: any[] = [uuid];
    
    if (status) {
      countQuery += ` AND djs.status = $2`;
      countParams.push(status);
    }
    
    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].total);

    // Fetch paginated jobs
    let query = `
      SELECT 
        djs.*,
        je.job_name,
        je.job_document,
        je.execution_type,
        je.schedule
      FROM device_job_status djs
      INNER JOIN job_executions je ON djs.job_id = je.job_id
      WHERE djs.device_uuid = $1
    `;

    const params: any[] = [uuid];
    let paramIndex = 2;

    if (status) {
      query += ` AND djs.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY djs.queued_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string));
    params.push(parseInt(offset as string));

    const result = await pool.query(query, params);

    // No need to transform status - QUEUED means queued for execution (now or scheduled)
    const jobs = result.rows;

    return res.status(200).json({
      device_uuid: uuid,
      jobs,
      total: totalCount,
      page: Math.floor(parseInt(offset as string) / parseInt(limit as string)) + 1,
      pageSize: parseInt(limit as string),
      totalPages: Math.ceil(totalCount / parseInt(limit as string)),
    });
  } catch (error) {
    logger.error('Error fetching device jobs:', error);
    return res.status(500).json({
      error: 'Failed to fetch device jobs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Flexible authentication for jobs/next endpoint
 * Accepts both device API key and provisioning key (for development)
 */
async function jobsAuth(req: Request, res: Response, next: any) {
  const apiKey = 
    req.headers['x-device-api-key'] as string ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API key required (X-Device-API-Key or Authorization: Bearer)'
    });
  }

  // Try device auth first
  try {
    await deviceAuth(req, res, () => {});
    if (req.device) {
      return next(); // Device auth successful
    }
  } catch (err) {
    // Device auth failed, check if response already sent before continuing
    if (res.headersSent) {
      return; // Error response already sent by deviceAuth, abort
    }
    // Try provisioning key as fallback
  }

  // Try provisioning key (fallback for development/initial setup only)
  try {
    // Suppress audit logging since this is a fallback, not actual provisioning
    const provisioningResult = await validateProvisioningKey(apiKey, req.ip || 'unknown', true);
    if (provisioningResult.valid) {
      logger.info(`Using provisioning key for device ${req.params.uuid}`);
      // Set req.device for compatibility
      req.device = {
        id: 0, // Placeholder
        uuid: req.params.uuid!,
        deviceName: 'dev-device',
        deviceType: 'unknown',
        isActive: true
      };
      return next();
    }
  } catch (err) {
    // Provisioning key also failed - suppress logging here since it's just a fallback
    // The real error was already logged by deviceAuth middleware
    logger.debug('Provisioning key fallback failed (expected for provisioned devices)', {
      uuid: req.params.uuid,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // Both failed - only send response if headers not already sent
  if (!res.headersSent) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid device API key or provisioning key'
    });
  }
}

/**
 * GET /api/v1/devices/:uuid/jobs/next
 * Get next pending job for device (MQTT endpoint equivalent)
 */
router.get('/devices/:uuid/jobs/next', jobsAuth, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;

    const result = await pool.query(
      `SELECT 
        djs.*,
        je.job_name,
        je.job_document,
        je.schedule
       FROM device_job_status djs
       INNER JOIN job_executions je ON djs.job_id = je.job_id
       WHERE djs.device_uuid = $1 
         AND djs.status = 'QUEUED'
         AND (
           je.schedule IS NULL 
           OR je.schedule->>'scheduled_at' IS NULL 
           OR (je.schedule->>'scheduled_at')::timestamptz <= NOW()
         )
       ORDER BY djs.queued_at ASC
       LIMIT 1`,
      [uuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending jobs' });
    }

    // Update status to IN_PROGRESS
    await pool.query(
      `UPDATE device_job_status
       SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [result.rows[0].id]
    );

    // Return snake_case to match agent's CloudJob interface
    return res.status(200).json({
      job_id: result.rows[0].job_id,
      job_name: result.rows[0].job_name,
      job_document: result.rows[0].job_document,
      timeout_seconds: 3600, // Default 1 hour timeout
      created_at: result.rows[0].queued_at,
    });
  } catch (error) {
    logger.error('Error fetching next job:', error);
    return res.status(500).json({
      error: 'Failed to fetch next job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/v1/devices/:uuid/jobs/:jobId/status
 * Update job status from device
 */
router.patch('/devices/:uuid/jobs/:jobId/status', deviceAuth, async (req: Request, res: Response) => {
  try {
    const { uuid, jobId } = req.params;
    const {
      status,
      exit_code,
      stdout,
      stderr,
      reason,
      executed_steps,
      failed_step,
      status_details,
    } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const result = await pool.query(
      `UPDATE device_job_status
       SET 
        status = $1::VARCHAR,
        exit_code = $2,
        stdout = $3,
        stderr = $4,
        reason = $5,
        executed_steps = $6,
        failed_step = $7,
        status_details = $8,
        last_updated_at = CURRENT_TIMESTAMP,
        completed_at = CASE WHEN $1::VARCHAR IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELED') 
                           THEN CURRENT_TIMESTAMP 
                           ELSE completed_at 
                      END
       WHERE job_id = $9 AND device_uuid = $10
       RETURNING *`,
      [
        status,
        exit_code,
        stdout,
        stderr,
        reason,
        executed_steps,
        failed_step,
        status_details ? JSON.stringify(status_details) : null,
        jobId,
        uuid,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job status not found' });
    }

    // Update job execution statistics
    await updateJobExecutionStats(jobId);

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error('Error updating job status:', error);
    return res.status(500).json({
      error: 'Failed to update job status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// =============================================================================
// Job Handlers Management
// =============================================================================

/**
 * GET /api/v1/jobs/handlers
 * List all job handlers
 */
router.get('/jobs/handlers', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM job_handlers WHERE is_active = true ORDER BY name'
    );

    return res.status(200).json({
      handlers: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    logger.error('Error fetching job handlers:', error);
    return res.status(500).json({
      error: 'Failed to fetch job handlers',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/jobs/handlers
 * Create a new job handler
 */
router.post('/jobs/handlers', async (req: Request, res: Response) => {
  try {
    const { name, description, script_type, script_content, default_args, created_by } = req.body;

    if (!name || !script_content) {
      return res.status(400).json({
        error: 'Missing required fields: name, script_content',
      });
    }

    const result = await pool.query(
      `INSERT INTO job_handlers (name, description, script_type, script_content, default_args, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name,
        description,
        script_type || 'bash',
        script_content,
        default_args ? JSON.stringify(default_args) : null,
        created_by,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    logger.error('Error creating job handler:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Job handler with this name already exists',
      });
    }

    return res.status(500).json({
      error: 'Failed to create job handler',
      message: error.message,
    });
  }
});

// =============================================================================
// Job Deletion
// =============================================================================

/**
 * DELETE /api/v1/jobs/:jobId
 * Delete a job and all its related data
 */
router.delete('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    // Check if job exists
    const jobCheck = await pool.query(
      'SELECT job_id, status FROM job_executions WHERE job_id = $1',
      [jobId]
    );

    if (jobCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'Job not found',
        message: `Job with ID ${jobId} does not exist`,
      });
    }

    const job = jobCheck.rows[0];

    // Prevent deletion of in-progress jobs
    if (job.status === 'IN_PROGRESS') {
      return res.status(400).json({
        error: 'Cannot delete running job',
        message: 'Job is currently in progress. Cancel it first before deleting.',
      });
    }

    // Delete in transaction to ensure consistency
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete device job statuses first (foreign key constraint)
      await client.query(
        'DELETE FROM device_job_status WHERE job_id = $1',
        [jobId]
      );

      // Delete the job execution
      await client.query(
        'DELETE FROM job_executions WHERE job_id = $1',
        [jobId]
      );

      await client.query('COMMIT');

      logger.info(`Deleted job ${jobId}`);

      return res.status(200).json({
        success: true,
        message: 'Job deleted successfully',
        jobId,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    logger.error('Error deleting job:', error);
    return res.status(500).json({
      error: 'Failed to delete job',
      message: error.message,
    });
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Update job execution statistics based on device statuses
 */
async function updateJobExecutionStats(jobId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED') as succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') as in_progress
       FROM device_job_status
       WHERE job_id = $1`,
      [jobId]
    );

    const stats = result.rows[0];

    // Determine overall job status
    let jobStatus = 'IN_PROGRESS';
    if (stats.in_progress === '0') {
      jobStatus = stats.failed === '0' ? 'SUCCEEDED' : 'FAILED';
    }

    await pool.query(
      `UPDATE job_executions
       SET 
        succeeded_devices = $1,
        failed_devices = $2,
        in_progress_devices = $3,
        status = $4::VARCHAR,
        completed_at = CASE WHEN $4::VARCHAR IN ('SUCCEEDED', 'FAILED') THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE job_id = $5`,
      [stats.succeeded, stats.failed, stats.in_progress, jobStatus, jobId]
    );
  } catch (error) {
    logger.error('Error updating job execution stats:', error);
  }
}

export default router;
