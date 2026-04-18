/**
 * Device Jobs Management Routes
 *
 * API endpoints for managing device jobs (inspired by AWS IoT Jobs).
 * Allows cloud-based creation, scheduling, and tracking of device jobs.
 */

import type { FastifyPluginAsync } from 'fastify';
import deviceAuth from '../middleware/agent-auth';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { logger } from '../utils/logger';
import * as JobsService from '../services/agent/jobs';

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

const plugin: FastifyPluginAsync = async (fastify) => {
  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  fastify.get<{ Querystring: TemplateListQuerystring }>('/jobs/templates', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      return reply.status(200).send(await JobsService.getTemplates(req.query));
    } catch (error) {
      logger.error('Error fetching job templates:', error);
      return reply.status(500).send({ error: 'Failed to fetch job templates', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.get<{ Params: IdParams }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const template = await JobsService.getTemplate(req.params.id);
      if (!template) return reply.status(404).send({ error: 'Job template not found' });
      return reply.status(200).send(template);
    } catch (error) {
      logger.error('Error fetching job template:', error);
      return reply.status(500).send({ error: 'Failed to fetch job template', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.post<{ Body: TemplateCreateBody }>('/jobs/templates', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      if (!req.body.name || !req.body.job_document) {
        return reply.status(400).send({ error: 'Missing required fields: name, job_document' });
      }
      return reply.status(201).send(await JobsService.createTemplate(req.body));
    } catch (error: unknown) {
      logger.error('Error creating job template:', error);
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
        return reply.status(409).send({ error: 'Job template with this name already exists' });
      }
      return reply.status(500).send({ error: 'Failed to create job template', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.put<{ Params: IdParams; Body: TemplateUpdateBody }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const updated = await JobsService.updateTemplate(req.params.id, req.body);
      if (!updated) return reply.status(updated === null ? 404 : 400).send({ error: 'Job template not found or no fields to update' });
      return reply.status(200).send(updated);
    } catch (error) {
      logger.error('Error updating job template:', error);
      return reply.status(500).send({ error: 'Failed to update job template', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.delete<{ Params: IdParams }>('/jobs/templates/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const deleted = await JobsService.deleteTemplate(req.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Job template not found' });
      return reply.status(200).send({ message: 'Job template deleted successfully', id: deleted.id });
    } catch (error) {
      logger.error('Error deleting job template:', error);
      return reply.status(500).send({ error: 'Failed to delete job template', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // -------------------------------------------------------------------------
  // Job executions
  // -------------------------------------------------------------------------

  fastify.post<{ Body: ExecuteJobBody }>('/jobs/execute', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { job_name, job_document, template_id, target_type } = req.body;

      if (!job_name) return reply.status(400).send({ error: 'job_name is required' });
      if (!job_document && !template_id) return reply.status(400).send({ error: 'Either job_document or template_id must be provided' });
      if (!target_type || !['device', 'group', 'all'].includes(target_type)) {
        return reply.status(400).send({ error: 'target_type must be one of: device, group, all' });
      }

      const result = await JobsService.executeJob(req.body, {
        method: req.method,
        path: req.url,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });

      if ('error' in result) {
        if (result.error === 'template_not_found') return reply.status(404).send({ error: 'Job template not found' });
        if (result.error === 'no_agents') return reply.status(400).send({ error: 'No target agents found' });
      }

      return reply.status(201).send({ job: result.job, message: `Job created and queued for ${result.agentCount} device(s)` });
    } catch (error) {
      logger.error('Error creating job execution:', error);
      return reply.status(500).send({ error: 'Failed to create job execution', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.get<{ Querystring: PaginationQuerystring }>('/jobs/executions', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const limit = parsePaginationValue(req.query.limit, 50);
      const offset = parsePaginationValue(req.query.offset, 0);
      return reply.status(200).send(await JobsService.getExecutions({ status: req.query.status, limit, offset }));
    } catch (error) {
      logger.error('Error fetching job executions:', error);
      return reply.status(500).send({ error: 'Failed to fetch job executions', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.get<{ Params: JobIdParams }>('/jobs/executions/:jobId', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const result = await JobsService.getExecution(req.params.jobId);
      if (!result) return reply.status(404).send({ error: 'Job execution not found' });
      return reply.status(200).send(result);
    } catch (error) {
      logger.error('Error fetching job execution:', error);
      return reply.status(500).send({ error: 'Failed to fetch job execution', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.post<{ Params: JobIdParams }>('/jobs/executions/:jobId/cancel', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const canceled = await JobsService.cancelJob(req.params.jobId);
      if (!canceled) return reply.status(404).send({ error: 'Job not found or already completed' });
      return reply.status(200).send({ message: 'Job canceled successfully', job: canceled });
    } catch (error) {
      logger.error('Error canceling job:', error);
      return reply.status(500).send({ error: 'Failed to cancel job', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.delete<{ Params: JobIdParams }>('/jobs/:jobId', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const result = await JobsService.deleteJob(req.params.jobId);
      if ('error' in result) {
        if (result.error === 'not_found') return reply.status(404).send({ error: 'Job not found', message: `Job with ID ${req.params.jobId} does not exist` });
        if (result.error === 'in_progress') return reply.status(400).send({ error: 'Cannot delete running job', message: 'Job is currently in progress. Cancel it first before deleting.' });
      }
      return reply.status(200).send({ success: true, message: 'Job deleted successfully', jobId: req.params.jobId });
    } catch (error: unknown) {
      logger.error('Error deleting job:', error);
      return reply.status(500).send({ error: 'Failed to delete job', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // -------------------------------------------------------------------------
  // Agent-facing job endpoints
  // -------------------------------------------------------------------------

  fastify.get<{ Params: AgentUuidParams; Querystring: PaginationQuerystring }>('/agents/:uuid/jobs', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const limit = parsePaginationValue(req.query.limit, 20);
      const offset = parsePaginationValue(req.query.offset, 0);
      return reply.status(200).send(await JobsService.getAgentJobs(req.params.uuid, { status: req.query.status, limit, offset }));
    } catch (error) {
      logger.error('Error fetching device jobs:', error);
      return reply.status(500).send({ error: 'Failed to fetch device jobs', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/jobs/next', { preHandler: [deviceAuth] }, async (req, reply) => {
    try {
      const job = await JobsService.getNextJob(req.params.uuid);
      if (!job) return reply.status(404).send({ error: 'No pending jobs' });
      return reply.status(200).send(job);
    } catch (error) {
      logger.error('Error fetching next job:', error);
      return reply.status(500).send({ error: 'Failed to fetch next job', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.patch<{ Params: AgentJobParams; Body: JobStatusUpdateBody }>('/agents/:uuid/jobs/:jobId/status', { preHandler: [deviceAuth] }, async (req, reply) => {
    try {
      if (!req.body.status) return reply.status(400).send({ error: 'status is required' });
      const updated = await JobsService.updateAgentJobStatus(req.params.uuid, req.params.jobId, req.body);
      if (!updated) return reply.status(404).send({ error: 'Job status not found' });
      return reply.status(200).send(updated);
    } catch (error) {
      logger.error('Error updating job status:', error);
      return reply.status(500).send({ error: 'Failed to update job status', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  fastify.get('/jobs/handlers', { preHandler: [jwtAuth] }, async (_req, reply) => {
    try {
      return reply.status(200).send(await JobsService.getHandlers());
    } catch (error) {
      logger.error('Error fetching job handlers:', error);
      return reply.status(500).send({ error: 'Failed to fetch job handlers', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  fastify.post<{ Body: JobHandlerCreateBody }>('/jobs/handlers', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      if (!req.body.name || !req.body.script_content) {
        return reply.status(400).send({ error: 'Missing required fields: name, script_content' });
      }
      return reply.status(201).send(await JobsService.createHandler(req.body));
    } catch (error: unknown) {
      logger.error('Error creating job handler:', error);
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
        return reply.status(409).send({ error: 'Job handler with this name already exists' });
      }
      return reply.status(500).send({ error: 'Failed to create job handler', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
};

export default plugin;

