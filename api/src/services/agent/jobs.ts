import { randomUUID } from 'crypto';
import { query, transaction } from '../../db/connection';
import { EventPublisher } from '../audit/event-sourcing';
import { publishJobNotification } from '../../mqtt/handlers';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateListParams {
  category?: string;
  active?: string;
}

export interface TemplateCreateParams {
  name?: string;
  description?: string;
  category?: string;
  job_document?: unknown;
  created_by?: string;
}

export interface TemplateUpdateParams {
  name?: string;
  description?: string;
  category?: string;
  job_document?: unknown;
  is_active?: boolean;
}

export type JobTargetFilter = Record<string, string | number | boolean | null>;

export interface ExecuteJobParams {
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
}

export interface ExecuteJobMeta {
  method?: string;
  path?: string;
  userAgent?: string;
  ip?: string;
}

export interface JobListParams {
  status?: string;
  limit: number;
  offset: number;
}

export interface AgentJobListParams {
  status?: string;
  limit: number;
  offset: number;
}

export interface JobStatusUpdateParams {
  status?: string;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  reason?: string | null;
  executed_steps?: unknown;
  failed_step?: unknown;
  status_details?: unknown;
}

export interface HandlerCreateParams {
  name?: string;
  description?: string;
  script_type?: string;
  script_content?: string;
  default_args?: unknown;
  created_by?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const eventPublisher = new EventPublisher('device-jobs-api');

async function updateJobExecutionStats(jobId: string): Promise<void> {
  try {
    const result = await query<{
      succeeded: string;
      failed: string;
      in_progress: string;
    }>(
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

    await query(
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

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function getTemplates(params: TemplateListParams) {
  const { category, active } = params;

  let sql = 'SELECT * FROM job_templates WHERE 1=1';
  const sqlParams: Array<string | boolean> = [];
  let idx = 1;

  if (category) {
    sql += ` AND category = $${idx}`;
    sqlParams.push(category);
    idx++;
  }

  if (active !== undefined) {
    sql += ` AND is_active = $${idx}`;
    sqlParams.push(active === 'true');
  }

  sql += ' ORDER BY category, name';

  const result = await query(sql, sqlParams);
  return { templates: result.rows, total: result.rows.length };
}

export async function getTemplate(id: string) {
  const result = await query('SELECT * FROM job_templates WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function createTemplate(params: TemplateCreateParams) {
  const { name, description, category, job_document, created_by } = params;

  const result = await query(
    `INSERT INTO job_templates (name, description, category, job_document, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, description, category || 'custom', JSON.stringify(job_document), created_by]
  );
  return result.rows[0];
}

export async function updateTemplate(id: string, params: TemplateUpdateParams) {
  const { name, description, category, job_document, is_active } = params;

  const updates: string[] = [];
  const sqlParams: unknown[] = [];
  let idx = 1;

  if (name) { updates.push(`name = $${idx}`); sqlParams.push(name); idx++; }
  if (description !== undefined) { updates.push(`description = $${idx}`); sqlParams.push(description); idx++; }
  if (category) { updates.push(`category = $${idx}`); sqlParams.push(category); idx++; }
  if (job_document !== undefined) { updates.push(`job_document = $${idx}`); sqlParams.push(JSON.stringify(job_document)); idx++; }
  if (is_active !== undefined) { updates.push(`is_active = $${idx}`); sqlParams.push(is_active); idx++; }

  if (updates.length === 0) return null;

  sqlParams.push(id);
  const result = await query(
    `UPDATE job_templates SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    sqlParams
  );
  return result.rows[0] ?? null;
}

export async function deleteTemplate(id: string) {
  const result = await query(
    'DELETE FROM job_templates WHERE id = $1 RETURNING id',
    [id]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Job executions
// ---------------------------------------------------------------------------

export async function executeJob(params: ExecuteJobParams, meta: ExecuteJobMeta = {}) {
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
  } = params;

  let finalJobDocument = job_document;
  if (template_id && !job_document) {
    const templateResult = await query(
      'SELECT job_document FROM job_templates WHERE id = $1',
      [template_id]
    );
    if (templateResult.rows.length === 0) return { error: 'template_not_found' as const };
    finalJobDocument = templateResult.rows[0].job_document;
  }

  let deviceUuids: string[] = [];
  if (target_type === 'device') {
    deviceUuids = target_agents || [];
  } else if (target_type === 'all') {
    const agentsResult = await query<{ uuid: string }>(
      'SELECT uuid FROM agents WHERE is_active = true'
    );
    deviceUuids = agentsResult.rows.map((row) => row.uuid);
  } else if (target_type === 'group' && target_filter) {
    const filterKeys = Object.keys(target_filter);
    const filterQuery = filterKeys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');
    const filterValues = filterKeys.map((key) => target_filter[key]);
    const agentsResult = await query<{ uuid: string }>(
      `SELECT uuid FROM agents WHERE is_active = true AND ${filterQuery}`,
      filterValues
    );
    deviceUuids = agentsResult.rows.map((row) => row.uuid);
  }

  if (deviceUuids.length === 0) return { error: 'no_agents' as const };

  const jobId = randomUUID();

  const jobResult = await query(
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
  await query(
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
        queued_at: new Date().toISOString(),
      },
      {
        metadata: {
          request: {
            method: meta.method,
            path: meta.path,
            user_agent: meta.userAgent,
          },
        },
        severity: 'info',
        impact: 'low',
        actor: {
          type: 'user',
          id: created_by || 'admin',
          ip_address: meta.ip,
        },
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

  return { job: jobResult.rows[0], agentCount: deviceUuids.length };
}

export async function getExecutions(params: JobListParams) {
  const { status, limit, offset } = params;

  let sql = 'SELECT * FROM job_executions WHERE 1=1';
  const sqlParams: Array<string | number> = [];
  let idx = 1;

  if (status) {
    sql += ` AND status = $${idx}`;
    sqlParams.push(status);
    idx++;
  }

  sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  sqlParams.push(limit, offset);

  const result = await query(sql, sqlParams);
  return { executions: result.rows, total: result.rows.length, limit, offset };
}

export async function getExecution(jobId: string) {
  const jobResult = await query(
    'SELECT * FROM job_executions WHERE job_id = $1',
    [jobId]
  );
  if (jobResult.rows.length === 0) return null;

  const statusResult = await query(
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

  return { job: jobResult.rows[0], device_statuses: statusResult.rows };
}

export async function cancelJob(jobId: string) {
  const jobResult = await query(
    `UPDATE job_executions
     SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
     WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')
     RETURNING *`,
    [jobId]
  );
  if (jobResult.rows.length === 0) return null;

  await query(
    `UPDATE agent_job_status
     SET status = 'CANCELED', completed_at = CURRENT_TIMESTAMP
     WHERE job_id = $1 AND status IN ('QUEUED', 'IN_PROGRESS')`,
    [jobId]
  );

  return jobResult.rows[0];
}

export async function deleteJob(jobId: string) {
  const jobCheck = await query<{ job_id: string; status: string }>(
    'SELECT job_id, status FROM job_executions WHERE job_id = $1',
    [jobId]
  );
  if (jobCheck.rows.length === 0) return { error: 'not_found' as const };

  const job = jobCheck.rows[0];
  if (job.status === 'IN_PROGRESS') return { error: 'in_progress' as const };

  await transaction(async (client) => {
    await client.query('DELETE FROM agent_job_status WHERE job_id = $1', [jobId]);
    await client.query('DELETE FROM job_executions WHERE job_id = $1', [jobId]);
  });

  logger.info(`Deleted job ${jobId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Agent job operations (called by device/agent)
// ---------------------------------------------------------------------------

export async function getAgentJobs(uuid: string, params: AgentJobListParams) {
  const { status, limit, offset } = params;

  let countSql = `
    SELECT COUNT(*) as total
    FROM agent_job_status djs
    WHERE djs.agent_uuid = $1
  `;
  const countParams: Array<string | number> = [uuid];

  if (status) {
    countSql += ' AND djs.status = $2';
    countParams.push(status);
  }

  const countResult = await query<{ total: string }>(countSql, countParams);
  const totalCount = Number.parseInt(countResult.rows[0].total, 10);

  let sql = `
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

  const sqlParams: Array<string | number> = [uuid];
  let idx = 2;

  if (status) {
    sql += ` AND djs.status = $${idx}`;
    sqlParams.push(status);
    idx++;
  }

  sql += ` ORDER BY djs.queued_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  sqlParams.push(limit, offset);

  const result = await query(sql, sqlParams);
  return {
    agent_uuid: uuid,
    jobs: result.rows,
    total: totalCount,
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
    totalPages: Math.ceil(totalCount / limit),
  };
}

export async function getNextJob(uuid: string) {
  const result = await query(
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
  if (result.rows.length === 0) return null;

  await query(
    `UPDATE agent_job_status
     SET status = 'IN_PROGRESS', started_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [result.rows[0].id]
  );

  return {
    job_id: result.rows[0].job_id,
    job_name: result.rows[0].job_name,
    job_document: result.rows[0].job_document,
    timeout_seconds: 3600,
    created_at: result.rows[0].queued_at,
  };
}

export async function updateAgentJobStatus(
  uuid: string,
  jobId: string,
  params: JobStatusUpdateParams
) {
  const {
    status,
    exit_code,
    stdout,
    stderr,
    reason,
    executed_steps,
    failed_step,
    status_details,
  } = params;

  const result = await query(
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
  if (result.rows.length === 0) return null;

  await updateJobExecutionStats(jobId);
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getHandlers() {
  const result = await query(
    'SELECT * FROM job_handlers WHERE is_active = true ORDER BY name'
  );
  return { handlers: result.rows, total: result.rows.length };
}

export async function createHandler(params: HandlerCreateParams) {
  const { name, description, script_type, script_content, default_args, created_by } = params;

  const result = await query(
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
  return result.rows[0];
}
