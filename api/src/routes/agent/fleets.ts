/**
 * Fleet Management Routes
 * Unified fleet management for virtual and physical agents
 */
import { randomUUID } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';

import { query } from '../../db/connection';
import { jwtAuth } from '../../middleware/jwt-auth';
import logger from '../../utils/logger';

type JsonObject = Record<string, unknown>;

interface FleetIdentifierParams {
  id: string;
}

interface FleetListQuerystring {
  fleet_type?: string;
  status?: string;
  environment?: string;
}

interface FleetEstimateBody {
  agent_count?: number;
  agents_per_agent?: number;
  billing_mode?: string;
}

interface CreateFleetBody {
  fleet_name?: string;
  fleet_type?: 'virtual' | 'physical' | 'mixed';
  description?: string;
  environment?: string;
  location?: string;
  tags?: JsonObject;
  billing_enabled?: boolean;
  billing_mode?: string;
  budget_limit?: number;
  agent_count?: number;
  agents_per_agent?: number;
  customer_id?: string;
}

interface UpdateFleetBody {
  fleet_name?: string;
  description?: string;
  environment?: string;
  location?: string;
  tags?: JsonObject;
  budget_limit?: number;
  status?: string;
}

interface UsageEventsQuerystring {
  limit?: number | string;
}

interface FleetLookupRow {
  fleet_uuid: string;
  status: string;
  billing_enabled: boolean;
  k8s_namespace: string | null;
  [key: string]: unknown;
}

interface FleetStatsRow {
  [key: string]: unknown;
}

interface FleetRow {
  fleet_uuid: string;
  [key: string]: unknown;
}

interface AgentRow {
  uuid: string;
  name: string;
  type: string | null;
  is_online: boolean | null;
  cpu_usage: number | null;
  memory_usage: number | null;
  memory_total: number | null;
  deployment_status: string | null;
  k8s_pod_name: string | null;
  endpoint_count: number | string;
}

interface CountRow {
  count: number | string;
}

interface BillingSummaryRow {
  [key: string]: unknown;
}

interface UsageEventRow {
  [key: string]: unknown;
}

function parseInteger(value: number | string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function getCountValue(value: number | string): number {
  return Number.parseInt(String(value), 10);
}

async function resolveFleetByIdentifier(fleetIdentifier: string): Promise<FleetLookupRow | null> {
  const result = await query<FleetLookupRow>(
    'SELECT * FROM fleets WHERE fleet_uuid::text = $1',
    [fleetIdentifier]
  );

  return result.rows[0] ?? null;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  // ============================================================================
  // POST /fleets/virtual/estimate - Estimate virtual fleet cost (PUBLIC - no auth)
  // ============================================================================
  fastify.post<{ Body: FleetEstimateBody }>('/fleets/virtual/estimate', async (req, reply) => {
    try {
      const {
        agent_count,
        agents_per_agent,
        billing_mode = 'hourly',
      } = req.body;

      if (!agent_count || !agents_per_agent) {
        return reply.status(400).send({
          error: 'Missing required fields',
          required: ['agent_count', 'agents_per_agent'],
        });
      }

      const result = await query<Record<string, unknown>>(
        'SELECT * FROM calculate_fleet_cost($1, $2, $3)',
        [agent_count, agents_per_agent, billing_mode]
      );

      return reply.send({
        agent_count,
        agents_per_agent,
        billing_mode,
        ...result.rows[0],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error estimating cost:', error);
      return reply.status(500).send({
        error: 'Failed to estimate cost',
        message,
      });
    }
  });

  // ============================================================================
  // GET /fleets - List all fleets
  // ============================================================================
  fastify.get<{ Querystring: FleetListQuerystring }>('/fleets', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { fleet_type, status, environment } = req.query;

      let queryText = `
        SELECT 
          f.fleet_uuid, f.fleet_name, f.customer_id, f.fleet_type, f.status,
          f.environment, f.location, f.billing_enabled, f.current_cost,
          f.budget_limit, f.created_at, f.updated_at,
          COUNT(d.uuid) as device_count,
          COUNT(d.uuid) FILTER (WHERE d.is_online = true) as online_count
        FROM fleets f
        LEFT JOIN agents d ON d.fleet_uuid = f.fleet_uuid
        WHERE f.status != 'deleted'
      `;

      const params: string[] = [];
      let paramCount = 1;

      if (fleet_type) {
        queryText += ` AND f.fleet_type = $${paramCount++}`;
        params.push(fleet_type);
      }

      if (status) {
        queryText += ` AND f.status = $${paramCount++}`;
        params.push(status);
      }

      if (environment) {
        queryText += ` AND f.environment = $${paramCount++}`;
        params.push(environment);
      }

      queryText += `
        GROUP BY 
          f.fleet_uuid, f.fleet_name, f.customer_id, f.fleet_type, f.status,
          f.environment, f.location, f.billing_enabled, f.current_cost,
          f.budget_limit, f.created_at, f.updated_at
        ORDER BY f.created_at DESC
      `;

      const result = await query<Record<string, unknown>>(queryText, params);

      return reply.send({
        fleets: result.rows,
        total: result.rowCount,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error listing fleets:', {
        error: message,
        userId: req.user?.id,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id ?? 'unknown',
      });
    }
  });

  // ============================================================================
  // GET /fleets/:id - Get fleet details
  // ============================================================================
  fastify.get<{ Params: FleetIdentifierParams }>('/fleets/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;

      const fleetInfo = await query<FleetRow>(
        'SELECT * FROM fleets WHERE fleet_uuid::text = $1',
        [id]
      );

      if (fleetInfo.rows.length === 0) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      const resolvedFleetUuid = fleetInfo.rows[0].fleet_uuid;

      const stats = await query<FleetStatsRow>(
        'SELECT * FROM get_fleet_stats($1)',
        [resolvedFleetUuid]
      );

      const agents = await query<AgentRow>(
        `SELECT 
          d.uuid, d.name, d.type, d.is_online,
          d.cpu_usage, d.memory_usage, d.memory_total,
          d.deployment_status, d.k8s_pod_name,
          (SELECT COUNT(*) FROM endpoints ds WHERE ds.agent_uuid = d.uuid) as endpoint_count
        FROM agents d
        WHERE d.fleet_uuid = $1
        ORDER BY d.name`,
        [resolvedFleetUuid]
      );

      return reply.send({
        ...fleetInfo.rows[0],
        stats: stats.rows[0],
        agents: agents.rows,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error getting fleet details:', {
        error: message,
        userId: req.user?.id,
      });
      return reply.status(500).send({
        error: 'Internal server error',
        requestId: req.id ?? 'unknown',
      });
    }
  });

  // ============================================================================
  // POST /fleets - Create new fleet
  // ============================================================================
  fastify.post<{ Body: CreateFleetBody }>('/fleets', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const {
        fleet_name,
        fleet_type = 'physical',
        description,
        environment,
        location,
        tags = {},
        billing_enabled = false,
        billing_mode,
        budget_limit,
        agent_count,
        agents_per_agent,
        customer_id = '00000000-0000-0000-0000-000000000001',
      } = req.body;

      if (!fleet_name) {
        return reply.status(400).send({
          error: 'Missing required fields',
          required: ['fleet_name'],
        });
      }

      if (!['virtual', 'physical', 'mixed'].includes(fleet_type)) {
        return reply.status(400).send({
          error: 'Invalid fleet_type',
          allowed: ['virtual', 'physical', 'mixed'],
        });
      }

      if (fleet_type === 'virtual' && (!agent_count || !agents_per_agent)) {
        return reply.status(400).send({
          error: 'Virtual fleets require agent_count and agents_per_agent',
          required: ['agent_count', 'agents_per_agent'],
        });
      }

      const fleet_uuid = randomUUID();

      const deployment_config: JsonObject = fleet_type === 'virtual'
        ? {
            agent_count,
            agents_per_agent,
            total_agents: agent_count * agents_per_agent,
            created_at: new Date().toISOString(),
          }
        : {};

      let k8s_namespace: string | null = null;
      let namespaceWarning: string | undefined;

      if (fleet_type === 'virtual') {
        logger.info('[FLEETS] Virtual fleet created without pre-assigned namespace', {
          fleet_uuid,
          note: 'Use pre-created fleet instances from dashboard',
        });
        namespaceWarning = 'Virtual fleet created without namespace. Use pre-created fleet instances for agent deployment.';
      }

      const result = await query<FleetRow>(
        `INSERT INTO fleets (
          fleet_uuid, fleet_name, customer_id, fleet_type, description,
          environment, location, tags, billing_enabled, billing_mode, budget_limit,
          deployment_config, k8s_namespace, target_device_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (fleet_uuid) DO NOTHING
        RETURNING *`,
        [
          fleet_uuid,
          fleet_name,
          customer_id,
          fleet_type,
          description,
          environment,
          location,
          JSON.stringify(tags),
          billing_enabled,
          billing_mode,
          budget_limit,
          JSON.stringify(deployment_config),
          k8s_namespace,
          fleet_type === 'virtual' ? agent_count * agents_per_agent : null,
        ]
      );

      if (!result.rows.length) {
        return reply.status(409).send({
          error: 'Fleet with this UUID already exists',
          fleet_uuid,
        });
      }

      await query(
        'SELECT record_fleet_usage_event($1, $2, $3, $4)',
        [
          fleet_uuid,
          'fleet_created',
          'api',
          JSON.stringify({
            created_via: 'api',
            fleet_type,
            agent_count: agent_count ?? null,
            agents_per_agent: agents_per_agent ?? null,
            k8s_namespace,
          }),
        ]
      );

      logger.info(`[FLEETS] Created fleet: ${fleet_uuid}`, {
        fleet_name,
        fleet_type,
        customer_id,
        k8s_namespace,
        agent_count: agent_count ?? null,
      });

      const response: Record<string, unknown> = {
        ...result.rows[0],
      };

      if (fleet_type === 'virtual' && !k8s_namespace && namespaceWarning) {
        response.warning = `Fleet created but K8s namespace creation failed: ${namespaceWarning}`;
        response.namespace_status = 'failed';
      } else if (fleet_type === 'virtual' && k8s_namespace) {
        response.namespace_status = 'created';
      }

      return reply.status(201).send(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error creating fleet:', error);
      return reply.status(500).send({
        error: 'Failed to create fleet',
        message,
      });
    }
  });

  // ============================================================================
  // PATCH /fleets/:id - Update fleet
  // ============================================================================
  fastify.patch<{ Params: FleetIdentifierParams; Body: UpdateFleetBody }>('/fleets/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const {
        fleet_name,
        description,
        environment,
        location,
        tags,
        budget_limit,
        status,
      } = req.body;

      const fleet = await resolveFleetByIdentifier(id);
      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      let paramCount = 1;

      if (fleet_name !== undefined) {
        updates.push(`fleet_name = $${paramCount++}`);
        params.push(fleet_name);
      }

      if (description !== undefined) {
        updates.push(`description = $${paramCount++}`);
        params.push(description);
      }

      if (environment !== undefined) {
        updates.push(`environment = $${paramCount++}`);
        params.push(environment);
      }

      if (location !== undefined) {
        updates.push(`location = $${paramCount++}`);
        params.push(location);
      }

      if (tags !== undefined) {
        updates.push(`tags = $${paramCount++}`);
        params.push(JSON.stringify(tags));
      }

      if (budget_limit !== undefined) {
        updates.push(`budget_limit = $${paramCount++}`);
        params.push(budget_limit);
      }

      if (status !== undefined) {
        updates.push(`status = $${paramCount++}`);
        params.push(status);
      }

      if (!updates.length) {
        return reply.status(400).send({
          error: 'No fields to update',
        });
      }

      params.push(fleet.fleet_uuid);

      const result = await query<FleetRow>(
        `UPDATE fleets SET ${updates.join(', ')}
         WHERE fleet_uuid = $${paramCount}
         RETURNING *`,
        params
      );

      if (!result.rows.length) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      logger.info(`[FLEETS] Updated fleet: ${fleet.fleet_uuid}`, {
        id,
        ...req.body,
      });

      return reply.send(result.rows[0]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error updating fleet:', error);
      return reply.status(500).send({
        error: 'Failed to update fleet',
        message,
      });
    }
  });

  // ============================================================================
  // POST /fleets/:id/stop - Stop fleet (virtual fleets)
  // ============================================================================
  fastify.post<{ Params: FleetIdentifierParams }>('/fleets/:id/stop', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const fleet = await resolveFleetByIdentifier(id);

      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      if (fleet.status === 'stopped') {
        return reply.status(400).send({
          error: 'Fleet is already stopped',
        });
      }

      await query(
        `UPDATE fleets 
         SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP
         WHERE fleet_uuid = $1`,
        [fleet.fleet_uuid]
      );

      await query(
        'SELECT record_fleet_usage_event($1, $2, $3, $4)',
        [fleet.fleet_uuid, 'stopped', 'api', JSON.stringify({ stopped_via: 'api' })]
      );

      const agents = await query<CountRow>(
        'SELECT COUNT(*) as count FROM agents WHERE fleet_uuid = $1',
        [fleet.fleet_uuid]
      );

      const deviceCount = getCountValue(agents.rows[0].count);

      logger.info(`[FLEETS] Stopped fleet: ${fleet.fleet_uuid}`, {
        device_count: deviceCount,
      });

      return reply.send({
        fleet_uuid: fleet.fleet_uuid,
        status: 'stopped',
        stopped_at: new Date().toISOString(),
        device_count: deviceCount,
        message: `Fleet stopped. ${fleet.billing_enabled ? 'Billing paused.' : ''}`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error stopping fleet:', error);
      return reply.status(500).send({
        error: 'Failed to stop fleet',
        message,
      });
    }
  });

  // ============================================================================
  // POST /fleets/:id/start - Start fleet (virtual fleets)
  // ============================================================================
  fastify.post<{ Params: FleetIdentifierParams }>('/fleets/:id/start', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const fleet = await resolveFleetByIdentifier(id);

      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      if (fleet.status === 'active') {
        return reply.status(400).send({
          error: 'Fleet is already active',
        });
      }

      await query(
        `UPDATE fleets 
         SET status = 'active', started_at = CURRENT_TIMESTAMP, stopped_at = NULL
         WHERE fleet_uuid = $1`,
        [fleet.fleet_uuid]
      );

      await query(
        'SELECT record_fleet_usage_event($1, $2, $3, $4)',
        [fleet.fleet_uuid, 'started', 'api', JSON.stringify({ started_via: 'api' })]
      );

      const agents = await query<CountRow>(
        'SELECT COUNT(*) as count FROM agents WHERE fleet_uuid = $1',
        [fleet.fleet_uuid]
      );

      const deviceCount = getCountValue(agents.rows[0].count);

      logger.info(`[FLEETS] Started fleet: ${fleet.fleet_uuid}`, {
        device_count: deviceCount,
      });

      return reply.send({
        fleet_uuid: fleet.fleet_uuid,
        status: 'active',
        started_at: new Date().toISOString(),
        device_count: deviceCount,
        message: `Fleet started. ${fleet.billing_enabled ? 'Billing resumed.' : ''}`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error starting fleet:', error);
      return reply.status(500).send({
        error: 'Failed to start fleet',
        message,
      });
    }
  });

  // ============================================================================
  // DELETE /fleets/:id - Delete fleet (soft delete + K8s namespace cleanup)
  // ============================================================================
  fastify.delete<{ Params: FleetIdentifierParams }>('/fleets/:id', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const fleet = await resolveFleetByIdentifier(id);

      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      if (fleet.status === 'deleted') {
        return reply.status(404).send({
          error: 'Fleet already deleted',
          id,
        });
      }

      if (fleet.k8s_namespace) {
        logger.info('[FLEETS] Fleet deleted with assigned namespace', {
          fleet_uuid: fleet.fleet_uuid,
          namespace: fleet.k8s_namespace,
          note: 'Pre-provisioned namespace remains for reuse',
        });
      }

      const result = await query<FleetRow>(
        `UPDATE fleets 
         SET status = 'deleted', stopped_at = CURRENT_TIMESTAMP
         WHERE fleet_uuid = $1 AND status != 'deleted'
         RETURNING *`,
        [fleet.fleet_uuid]
      );

      if (!result.rows.length) {
        return reply.status(404).send({
          error: 'Fleet not found or already deleted',
          id,
        });
      }

      await query(
        'SELECT record_fleet_usage_event($1, $2, $3, $4)',
        [
          fleet.fleet_uuid,
          'stopped',
          'api',
          JSON.stringify({
            deleted_via: 'api',
            k8s_namespace_deleted: Boolean(fleet.k8s_namespace),
          }),
        ]
      );

      logger.info(`[FLEETS] Deleted fleet: ${fleet.fleet_uuid}`, {
        k8s_namespace_deleted: Boolean(fleet.k8s_namespace),
      });

      return reply.send({
        fleet_uuid: fleet.fleet_uuid,
        status: 'deleted',
        message: 'Fleet deleted successfully',
        k8s_namespace_deleted: Boolean(fleet.k8s_namespace),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error deleting fleet:', error);
      return reply.status(500).send({
        error: 'Failed to delete fleet',
        message,
      });
    }
  });

  // ============================================================================
  // GET /fleets/:id/billing - Get billing summary
  // ============================================================================
  fastify.get<{ Params: FleetIdentifierParams }>('/fleets/:id/billing', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const fleet = await resolveFleetByIdentifier(id);

      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      const result = await query<BillingSummaryRow>(
        'SELECT * FROM fleet_billing_summary WHERE fleet_uuid = $1',
        [fleet.fleet_uuid]
      );

      if (!result.rows.length) {
        return reply.status(404).send({
          error: 'Fleet not found or billing not enabled',
          id,
        });
      }

      return reply.send({
        ...result.rows[0],
        fleet_uuid: fleet.fleet_uuid,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error getting billing summary:', error);
      return reply.status(500).send({
        error: 'Failed to get billing summary',
        message,
      });
    }
  });

  // ============================================================================
  // GET /fleets/:id/usage-events - Get usage event history
  // ============================================================================
  fastify.get<{ Params: FleetIdentifierParams; Querystring: UsageEventsQuerystring }>('/fleets/:id/usage-events', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const limit = parseInteger(req.query.limit, 50);

      const fleet = await resolveFleetByIdentifier(id);
      if (!fleet) {
        return reply.status(404).send({
          error: 'Fleet not found',
          id,
        });
      }

      const result = await query<UsageEventRow>(
        `SELECT * FROM fleet_usage_events
         WHERE fleet_uuid = $1
         ORDER BY event_timestamp DESC
         LIMIT $2`,
        [fleet.fleet_uuid, limit]
      );

      return reply.send({
        fleet_uuid: fleet.fleet_uuid,
        events: result.rows,
        total: result.rowCount,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[FLEETS] Error getting usage events:', error);
      return reply.status(500).send({
        error: 'Failed to get usage events',
        message,
      });
    }
  });
};

export default plugin;