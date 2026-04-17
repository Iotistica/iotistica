/**
 * Device Jobs Management Routes
 *
 * API endpoints for managing device jobs (inspired by AWS IoT Jobs).
 * Allows cloud-based creation, scheduling, and tracking of device jobs.
 */

import { randomUUID } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import poolWrapper from '../db/connection';
import deviceAuth from '../middleware/agent-auth';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { publishJobNotification } from '../mqtt/handlers';
import { EventPublisher } from '../services/audit/event-sourcing';
import { logger } from '../utils/logger';

type TemplateListQuerystring = {
  category?: string;
  active?: string;
};

type IdParams = {
  id: string;
};

type JobIdParams = {
  jobId: string;
};

type AgentUuidParams = {
  uuid: string;
};

type AgentJobParams = {
  uuid: string;
  jobId: string;
};

type PaginationQuerystring = {
  status?: string;
  limit?: string | number;
  offset?: string | number;
};

type TemplateCreateBody = {
  name?: string;
  description?: string;
  category?: string;
  job_document?: unknown;
  created_by?: string;
};

type TemplateUpdateBody = {
  name?: string;
  description?: string;
  category?: string;
  job_document?: unknown;
  is_active?: boolean;
};

type JobTargetFilter = Record<string, string | number | boolean | null>;

type ExecuteJobBody = {
  job_name?: string;
  job_document?: unknown;
  template_id?: string;
  target_type?: 'device' | 'group' | 'all';
  target_agents?: string[];
  target_filter?: JobTargetFilter;
  execution_type?: string;
  schedule?: unknown;
  max_executions?: number;
  timeout_minutes?: number;
  created_by?: string;
};

type JobStatusUpdateBody = {
  status?: string;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  reason?: string | null;
  executed_steps?: unknown;
  failed_step?: unknown;
  status_details?: unknown;
};

type JobHandlerCreateBody = {
  name?: string;
  description?: string;
  script_type?: string;
  script_content?: string;
  default_args?: unknown;
  created_by?: string;
};

function parsePaginationValue(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

const pool = poolWrapper.pool;
const eventPublisher = new EventPublisher('device-jobs-api');

async function updateJobExecutionStats(jobId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED') as succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') as in_progress
       FROM agent_job_status
       WHERE job_id = $1`,
      [jobId]
    );

    const stats = result.rows[0];

    let jobStatus = 'IN_PROGRESS';
    if (stats.in_progress === '0') {
      jobStatus = stats.failed === '0' ? 'SUCCEEDED' : 'FAILED';
    }

    await pool.query(
      `UPDATE job_executions
       SET
        succeeded_agents = $1,
        failed_agents = $2,
        in_progress_agents = $3,
        status = $4::VARCHAR,
        completed_at = CASE WHEN $4::VARCHAR IN ('SUCCEEDED', 'FAILED') THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE job_id = $5`,
      [stats.succeeded, stats.failed, stats.in_progress, jobStatus, jobId]
    );
  } catch (error) {
    logger.error('Error updating job execution stats:', error);
  }
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: TemplateListQuerystring }>('/jobs/templates', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { category, active } = req.query;

      let query = 'SELECT * FROM job_templates WHERE 1=1';
      const params: Array<string | boolean> = [];
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

      return reply.status(200).send({
        templates: result.rows,
        total: result.rows.length,
      });
    } catch (error) {
      logger.error('Error fetching job templates:', error);
      return reply.status(500).send({
        error: 'Failed to fetch job templates',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: IdParams }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        'SELECT * FROM job_templates WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Job template not found' });
      }

      return reply.status(200).send(result.rows[0]);
    } catch (error) {
      logger.error('Error fetching job template:', error);
      return reply.status(500).send({
        error: 'Failed to fetch job template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Body: TemplateCreateBody }>('/jobs/templates', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { name, description, category, job_document, created_by } = req.body;

      if (!name || !job_document) {
        return reply.status(400).send({
          error: 'Missing required fields: name, job_document',
        });
      }

      const result = await pool.query(
        `INSERT INTO job_templates (name, description, category, job_document, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [name, description, category || 'custom', JSON.stringify(job_document), created_by]
      );

      return reply.status(201).send(result.rows[0]);
    } catch (error: any) {
      logger.error('Error creating job template:', error);

      if (error.code === '23505') {
        return reply.status(409).send({
          error: 'Job template with this name already exists',
        });
      }

      return reply.status(500).send({
        error: 'Failed to create job template',
        message: error.message,
      });
    }
  });

  fastify.put<{ Params: IdParams; Body: TemplateUpdateBody }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const { name, description, category, job_document, is_active } = req.body;

      const updates: string[] = [];
      const params: unknown[] = [];
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

      if (job_document !== undefined) {
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
        return reply.status(400).send({ error: 'No fields to update' });
      }

      params.push(id);
      const result = await pool.query(
        `UPDATE job_templates SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Job template not found' });
      }

      return reply.status(200).send(result.rows[0]);
    } catch (error) {
      logger.error('Error updating job template:', error);
      return reply.status(500).send({
        error: 'Failed to update job template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.delete<{ Params: IdParams }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        'DELETE FROM job_templates WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Job template not found' });
      }

      return reply.status(200).send({
        message: 'Job template deleted successfully',
        id: result.rows[0].id,
      });
    } catch (error) {
      logger.error('Error deleting job template:', error);
      return reply.status(500).send({
        error: 'Failed to delete job template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Body: ExecuteJobBody }>('/jobs/execute', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const {
        job_name,
        job_document,
        template_id,
        target_type,
        target_agents,
        target_filter,
        execution_type,
        schedule,
        max_executions,
        timeout_minutes,
        created_by,
      } = req.body;

      if (!job_name) {
        return reply.status(400).send({ error: 'job_name is required' });
      }

      if (!job_document && !template_id) {
        return reply.status(400).send({
          error: 'Either job_document or template_id must be provided',
        });
      }

      if (!target_type || !['device', 'group', 'all'].includes(target_type)) {
        return reply.status(400).send({
          error: 'target_type must be one of: device, group, all',
        });
      }

      let finalJobDocument = job_document;
      if (template_id && !job_document) {
        const templateResult = await pool.query(
          'SELECT job_document FROM job_templates WHERE id = $1',
          [template_id]
        );

        if (templateResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Job template not found' });
        }

        finalJobDocument = templateResult.rows[0].job_document;
      }

      let deviceUuids: string[] = [];
      if (target_type === 'device') {
        deviceUuids = target_agents || [];
      } else if (target_type === 'all') {
        const agentsResult = await pool.query(
          'SELECT uuid FROM agents WHERE is_active = true'
        );
        deviceUuids = agentsResult.rows.map((row: { uuid: string }) => row.uuid);
      } else if (target_type === 'group' && target_filter) {
        const filterKeys = Object.keys(target_filter);
        const filterQuery = filterKeys.map((key, idx) => `${key} = $${idx + 1}`).join(' AND ');
        const filterValues = filterKeys.map((key) => target_filter[key]);

        const agentsResult = await pool.query(
          `SELECT uuid FROM agents WHERE is_active = true AND ${filterQuery}`,
          filterValues
        );
        deviceUuids = agentsResult.rows.map((row: { uuid: string }) => row.uuid);
      }

      if (deviceUuids.length === 0) {
        return reply.status(400).send({ error: 'No target agents found' });
      }

      const jobId = randomUUID();

      const jobResult = await pool.query(
        `INSERT INTO job_executions (
          job_id, template_id, job_name, job_document, target_type, target_agents,
          target_filter, execution_type, schedule, max_executions, timeout_minutes,
          total_agents, created_by
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

      const deviceStatusValues = deviceUuids.map((uuid) => `('${jobId}', '${uuid}')`).join(', ');
      await pool.query(
        `INSERT INTO agent_job_status (job_id, agent_uuid) VALUES ${deviceStatusValues}`
      );

      logger.info(`Created job ${jobId} for ${deviceUuids.length} agents`);

      for (const deviceUuid of deviceUuids) {
        await eventPublisher.publish(
          'job.queued',
          'agent',
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

      try {
        for (const deviceUuid of deviceUuids) {
          await publishJobNotification(deviceUuid, jobId, finalJobDocument);
        }
        logger.info(`Sent MQTT notifications to ${deviceUuids.length} agents`);
      } catch (mqttError) {
        logger.error('Failed to send MQTT notifications (HTTP fallback will work):', mqttError);
      }

      return reply.status(201).send({
        job: jobResult.rows[0],
        message: `Job created and queued for ${deviceUuids.length} device(s)`,
      });
    } catch (error) {
      logger.error('Error creating job execution:', error);
      return reply.status(500).send({
        error: 'Failed to create job execution',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: PaginationQuerystring }>('/jobs/executions', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { status } = req.query;
      const limit = parsePaginationValue(req.query.limit, 50);
      const offset = parsePaginationValue(req.query.offset, 0);

      let query = 'SELECT * FROM job_executions WHERE 1=1';
      const params: Array<string | number> = [];
      let paramIndex = 1;

      if (status) {
        query += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return reply.status(200).send({
        executions: result.rows,
        total: result.rows.length,
        limit,
        offset,
      });
    } catch (error) {
      logger.error('Error fetching job executions:', error);
      return reply.status(500).send({
        error: 'Failed to fetch job executions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: JobIdParams }>('/jobs/executions/:jobId', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { jobId } = req.params;

      const jobResult = await pool.query(
        'SELECT * FROM job_executions WHERE job_id = $1',
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Job execution not found' });
      }

      const statusResult = await pool.query(
        `SELECT
          djs.*,
          d.name,
          d.ip_address
         FROM agent_job_status djs
         LEFT JOIN agents d ON djs.agent_uuid = d.uuid
         WHERE djs.job_id = $1
         ORDER BY djs.updated_at DESC`,
        [jobId]
      );

      return reply.status(200).send({
        job: jobResult.rows[0],
        device_statuses: statusResult.rows,
      });
    } catch (error) {
      logger.error('Error fetching job execution:', error);
      return reply.status(500).send({
        error: 'Failed to fetch job execution',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Params: JobIdParams }>('/jobs/executions/:jobId/cancel', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { jobId } = req.params;

      const jobResult = await pool.query(
        `UPDATE job_executions
         SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')
         RETURNING *`,
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        return reply.status(404).send({
          error: 'Job not found or already completed',
        });
      }

      await pool.query(
        `UPDATE agent_job_status
         SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
         WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')`,
        [jobId]
      );

      return reply.status(200).send({
        message: 'Job canceled successfully',
        job: jobResult.rows[0],
      });
    } catch (error) {
      logger.error('Error canceling job:', error);
      return reply.status(500).send({
        error: 'Failed to cancel job',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: AgentUuidParams; Querystring: PaginationQuerystring }>('/agents/:uuid/jobs', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { status } = req.query;
      const limit = parsePaginationValue(req.query.limit, 20);
      const offset = parsePaginationValue(req.query.offset, 0);

      let countQuery = `
        SELECT COUNT(*) as total
        FROM agent_job_status djs
        WHERE djs.agent_uuid = $1
      `;
      const countParams: string[] = [uuid];

      if (status) {
        countQuery += ' AND djs.status = $2';
        countParams.push(status);
      }

      const countResult = await pool.query(countQuery, countParams);
      const totalCount = Number.parseInt(countResult.rows[0].total, 10);

      let query = `
        SELECT
          djs.*,
          je.job_name,
          je.job_document,
          je.execution_type,
          je.schedule
        FROM agent_job_status djs
        INNER JOIN job_executions je ON djs.job_id = je.job_id
        WHERE djs.agent_uuid = $1
      `;

      const params: Array<string | number> = [uuid];
      let paramIndex = 2;

      if (status) {
        query += ` AND djs.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      query += ` ORDER BY djs.queued_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      const jobs = result.rows;

      return reply.status(200).send({
        agent_uuid: uuid,
        jobs,
        total: totalCount,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        totalPages: Math.ceil(totalCount / limit),
      });
    } catch (error) {
      logger.error('Error fetching device jobs:', error);
      return reply.status(500).send({
        error: 'Failed to fetch device jobs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/jobs/next', { preHandler: [deviceAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;

      const result = await pool.query(
        `SELECT
          djs.*,
          je.job_name,
          je.job_document,
          je.schedule
         FROM agent_job_status djs
         INNER JOIN job_executions je ON djs.job_id = je.job_id
         WHERE djs.agent_uuid = $1
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
        return reply.status(404).send({ error: 'No pending jobs' });
      }

      await pool.query(
        `UPDATE agent_job_status
         SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [result.rows[0].id]
      );

      return reply.status(200).send({
        job_id: result.rows[0].job_id,
        job_name: result.rows[0].job_name,
        job_document: result.rows[0].job_document,
        timeout_seconds: 3600,
        created_at: result.rows[0].queued_at,
      });
    } catch (error) {
      logger.error('Error fetching next job:', error);
      return reply.status(500).send({
        error: 'Failed to fetch next job',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.patch<{ Params: AgentJobParams; Body: JobStatusUpdateBody }>('/agents/:uuid/jobs/:jobId/status', { preHandler: [deviceAuth] }, async (req, reply) => {
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
        return reply.status(400).send({ error: 'status is required' });
      }

      const result = await pool.query(
        `UPDATE agent_job_status
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
         WHERE job_id = $9 AND agent_uuid = $10
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
        return reply.status(404).send({ error: 'Job status not found' });
      }

      await updateJobExecutionStats(jobId);

      return reply.status(200).send(result.rows[0]);
    } catch (error) {
      logger.error('Error updating job status:', error);
      return reply.status(500).send({
        error: 'Failed to update job status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get('/jobs/handlers', { preHandler: [jwtAuth] }, async (_req, reply) => {
    try {
      const result = await pool.query(
        'SELECT * FROM job_handlers WHERE is_active = true ORDER BY name'
      );

      return reply.status(200).send({
        handlers: result.rows,
        total: result.rows.length,
      });
    } catch (error) {
      logger.error('Error fetching job handlers:', error);
      return reply.status(500).send({
        error: 'Failed to fetch job handlers',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Body: JobHandlerCreateBody }>('/jobs/handlers', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { name, description, script_type, script_content, default_args, created_by } = req.body;

      if (!name || !script_content) {
        return reply.status(400).send({
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

      return reply.status(201).send(result.rows[0]);
    } catch (error: any) {
      logger.error('Error creating job handler:', error);

      if (error.code === '23505') {
        return reply.status(409).send({
          error: 'Job handler with this name already exists',
        });
      }

      return reply.status(500).send({
        error: 'Failed to create job handler',
        message: error.message,
      });
    }
  });

  fastify.delete<{ Params: JobIdParams }>('/jobs/:jobId', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { jobId } = req.params;

      const jobCheck = await pool.query(
        'SELECT job_id, status FROM job_executions WHERE job_id = $1',
        [jobId]
      );

      if (jobCheck.rows.length === 0) {
        return reply.status(404).send({
          error: 'Job not found',
          message: `Job with ID ${jobId} does not exist`,
        });
      }

      const job = jobCheck.rows[0];

      if (job.status === 'IN_PROGRESS') {
        return reply.status(400).send({
          error: 'Cannot delete running job',
          message: 'Job is currently in progress. Cancel it first before deleting.',
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM agent_job_status WHERE job_id = $1',
          [jobId]
        );
        await client.query(
          'DELETE FROM job_executions WHERE job_id = $1',
          [jobId]
        );
        await client.query('COMMIT');

        logger.info(`Deleted job ${jobId}`);

        return reply.status(200).send({
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
      return reply.status(500).send({
        error: 'Failed to delete job',
        message: error.message,
      });
    }
  });
};

export default plugin;
