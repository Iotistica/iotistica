/**
 * Grafana SimpleJSON Datasource Adapter
 *
 * Implements the Grafana SimpleJSON protocol so Grafana can consume this API
 * as a native datasource with variable dropdowns and template support.
 *
 * SimpleJSON endpoints:
 *   GET  /grafana/            → health check (datasource "Test" button)
 *   POST /grafana/search      → discovery for Grafana variable dropdowns
 *   POST /grafana/query       → time-series data
 *   POST /grafana/annotations → anomaly event overlays
 *   GET  /grafana/tag-keys    → ad-hoc filter dimension names
 *   GET  /grafana/tag-values  → ad-hoc filter values for a key
 *
 * Explicit discovery endpoints (usable from /search or directly):
 *   GET  /grafana/agents                        → all agents
 *   GET  /grafana/agents/:agentId/devices        → devices under an agent
 *   GET  /grafana/devices/:deviceId/metrics      → metrics for a device
 *
 * Infinity datasource (GET, URL params):
 *   GET  /grafana/timeseries?deviceId=<uuid>&metric=<name>&from=<iso>&to=<iso>&agentId=<uuid>
 *   → [{ time: "2026-01-01T00:00:00.000Z", value: 23.5 }, ...]
 *
 * Query target model (JSON, encoded as string in Grafana target field):
 *   { "deviceId": "uuid", "metric": "temperature" }
 *   { "agentId": "uuid", "deviceId": "uuid", "metric": "temperature" }
 *
 * Variable target formats for /search:
 *   "agents"                    → all agents [{text, value}]
 *   "devices"                   → all devices [{text, value}]
 *   "agent:<agentUuid>"         → devices under that agent [{text, value}]
 *   "device:<deviceUuid>"       → metrics for that device [string]
 *   "agent:<uuid>/device:<uuid>"→ metrics scoped to both agent and device [string]
 *   "<prefix>"                  → metric names starting with prefix [string]
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
// TODO: restore jwtAuth when done testing
// import { jwtAuth } from '../../middleware/jwt-auth';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jwtAuth = async (_req: any, _reply: any): Promise<void> => { /* no-op for local dev */ };
import { getTimeseries } from '../../services/agent/metrics';
import { query } from '../../db/connection';
import logger from '../../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days hard cap
const ANNOTATION_ROW_LIMIT = 500;
const SEARCH_ROW_LIMIT = 500;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

const isoDateSchema = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)),
  'Invalid ISO date string'
);

/**
 * Structured query target.
 * agentId is optional — when omitted, queries across all agents for that device.
 */
const targetModelSchema = z.object({
  deviceId: z.string().uuid(),
  metric: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._\-]+$/, 'Invalid metric name'),
  agentId: z.string().uuid().optional(),
});

const queryRequestSchema = z.object({
  range: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
  }),
  intervalMs: z.number().optional(),
  maxDataPoints: z.number().optional(),
  targets: z
    .array(
      z.object({
        /**
         * Grafana sends `target` as a string. We expect it to contain a
         * JSON-encoded targetModelSchema object.
         */
        target: z.string().max(1000),
        type: z.enum(['timeserie', 'table']).default('timeserie'),
        refId: z.string().optional(),
      })
    )
    .min(1)
    .max(20),
});

const searchRequestSchema = z.object({
  target: z.string().max(500).optional(),
});

const annotationsRequestSchema = z.object({
  range: z
    .object({
      from: isoDateSchema,
      to: isoDateSchema,
    })
    .optional(),
  annotation: z
    .object({
      name: z.string().optional(),
      query: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-encoded target string into a validated query model.
 * Returns null when the string cannot be parsed or fails validation —
 * callers should skip null targets gracefully.
 */
function parseTarget(
  raw: string
): z.infer<typeof targetModelSchema> | null {
  try {
    const parsed = JSON.parse(raw);
    const result = targetModelSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Map a millisecond span to the nearest TimeRange enum value */
function inferTimeRange(spanMs: number): '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d' {
  if (spanMs <= 60 * 1000)                return '1m';
  if (spanMs <= 60 * 60 * 1000)           return '1h';
  if (spanMs <= 6 * 60 * 60 * 1000)       return '6h';
  if (spanMs <= 12 * 60 * 60 * 1000)      return '12h';
  if (spanMs <= 24 * 60 * 60 * 1000)      return '24h';
  if (spanMs <= 7 * 24 * 60 * 60 * 1000)  return '7d';
  return '30d';
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const grafanaPlugin: FastifyPluginAsync = async (fastify) => {

  // -------------------------------------------------------------------------
  // GET / — health check (Grafana "Test" button)
  // -------------------------------------------------------------------------
  fastify.get('/', { preHandler: [jwtAuth] }, async (_req, reply) => {
    return reply.status(200).send({ status: 200 });
  });

  // =========================================================================
  // Explicit discovery endpoints
  // These are usable standalone (e.g. from the dashboard) and are also
  // called internally by /search to back variable dropdowns.
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /agents — all agents
  // -------------------------------------------------------------------------
  fastify.get(
    '/agents',
    { preHandler: [jwtAuth] },
    async (_req, reply) => {
      try {
        const result = await query<{ uuid: string; name: string; is_online: boolean }>(
          `SELECT uuid::text AS uuid,
                  COALESCE(NULLIF(name, ''), 'Agent ' || left(uuid::text, 8)) AS name,
                  is_online
           FROM agents
           ORDER BY name
           LIMIT $1`,
          [SEARCH_ROW_LIMIT]
        );
        return reply.send(result.rows);
      } catch (err) {
        logger.error('grafana GET /agents error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // Variable endpoints — return [{text, value}] for Infinity variable queries
  // -------------------------------------------------------------------------

  // GET /variable/agents
  fastify.get(
    '/variable/agents',
    { preHandler: [jwtAuth] },
    async (_req, reply) => {
      try {
        const result = await query<{ uuid: string; name: string }>(
          `SELECT uuid::text AS uuid,
                  COALESCE(NULLIF(name, ''), 'Agent ' || left(uuid::text, 8)) AS name
           FROM agents
           ORDER BY name
           LIMIT $1`,
          [SEARCH_ROW_LIMIT]
        );
        const rows = result.rows.map(r => ({ text: r.name, value: r.uuid }));
        logger.info('grafana GET /variable/agents', { count: rows.length, rows });
        return reply.send(rows);
      } catch (err) {
        logger.error('grafana GET /variable/agents error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // GET /variable/devices?agentId=<uuid>
  fastify.get<{ Querystring: { agentId?: string } }>(
    '/variable/devices',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const agentParsed = uuidSchema.safeParse(req.query.agentId);
      if (!agentParsed.success) return reply.send([]);
      try {
        const result = await query<{ device_uuid: string; device_name: string }>(
          `SELECT DISTINCT
                  device_uuid::text                                                         AS device_uuid,
                  COALESCE(NULLIF(device_name, ''), 'Unknown')                             AS device_name
           FROM endpoint_devices
           WHERE agent_uuid = $1
             AND device_uuid IS NOT NULL
           ORDER BY device_name
           LIMIT $2`,
          [agentParsed.data, SEARCH_ROW_LIMIT]
        );
        return reply.send(result.rows.map(r => ({ text: r.device_name, value: r.device_uuid })));
      } catch (err) {
        logger.error('grafana GET /variable/devices error', {
          agentId: req.query.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // GET /variable/metrics?deviceId=<uuid>&agentId=<uuid>
  fastify.get<{ Querystring: { deviceId?: string; agentId?: string } }>(
    '/variable/metrics',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const deviceParsed = uuidSchema.safeParse(req.query.deviceId);
      if (!deviceParsed.success) return reply.send([]);
      const agentParsed = req.query.agentId ? uuidSchema.safeParse(req.query.agentId) : null;
      if (agentParsed && !agentParsed.success) return reply.send([]);
      try {
        const sqlParams: unknown[] = [deviceParsed.data, SEARCH_ROW_LIMIT];
        let agentFilter = '';
        if (agentParsed?.success) {
          sqlParams.push(agentParsed.data);
          agentFilter = ` AND agent_uuid = $${sqlParams.length}`;
        }
        const result = await query<{ metric_name: string }>(
          `SELECT DISTINCT metric_name
           FROM metric_catalog
           WHERE device_uuid = $1
             ${agentFilter}
           ORDER BY metric_name
           LIMIT $2`,
          sqlParams
        );
        return reply.send(result.rows.map(r => ({ text: r.metric_name, value: r.metric_name })));
      } catch (err) {
        logger.error('grafana GET /variable/metrics error', {
          deviceId: req.query.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /agents/:agentId/devices — devices under a specific agent
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/devices',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const agentParsed = uuidSchema.safeParse(req.params.agentId);
      if (!agentParsed.success) {
        return reply.status(400).send({ error: 'Invalid agent UUID' });
      }
      try {
        const result = await query<{
          device_uuid: string;
          device_name: string;
          protocol: string;
          metric_count: number;
          last_seen: string;
        }>(
          `SELECT DISTINCT
                  device_uuid::text                                                         AS device_uuid,
                  COALESCE(NULLIF(device_name, ''), 'Unknown')                             AS device_name,
                  protocol,
                  COALESCE(metric_count, 0)::int                                           AS metric_count,
                  last_seen
           FROM endpoint_devices
           WHERE agent_uuid = $1
             AND device_uuid IS NOT NULL
           ORDER BY device_name
           LIMIT $2`,
          [agentParsed.data, SEARCH_ROW_LIMIT]
        );
        return reply.send(result.rows);
      } catch (err) {
        logger.error('grafana GET /agents/:agentId/devices error', {
          agentId: req.params.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /devices/:deviceId/metrics — metrics for a specific device
  // Optionally scoped to an agent via ?agentId=<uuid>
  // -------------------------------------------------------------------------
  fastify.get<{
    Params: { deviceId: string };
    Querystring: { agentId?: string };
  }>(
    '/devices/:deviceId/metrics',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const deviceParsed = uuidSchema.safeParse(req.params.deviceId);
      if (!deviceParsed.success) {
        return reply.status(400).send({ error: 'Invalid device UUID' });
      }
      const agentParsed = req.query.agentId
        ? uuidSchema.safeParse(req.query.agentId)
        : null;
      if (agentParsed && !agentParsed.success) {
        return reply.status(400).send({ error: 'Invalid agent UUID' });
      }

      try {
        const sqlParams: unknown[] = [deviceParsed.data, SEARCH_ROW_LIMIT];
        let agentFilter = '';
        if (agentParsed?.success) {
          sqlParams.push(agentParsed.data);
          agentFilter = ` AND agent_uuid = $${sqlParams.length}`;
        }

        const result = await query<{
          metric_name: string;
          unit: string | null;
          protocol: string;
          last_seen: string;
        }>(
          `SELECT DISTINCT metric_name,
                  COALESCE(NULLIF(unit, ''), NULL) AS unit,
                  protocol,
                  last_seen
           FROM metric_catalog
           WHERE device_uuid = $1
             ${agentFilter}
           ORDER BY metric_name
           LIMIT $2`,
          sqlParams
        );
        return reply.send(result.rows);
      } catch (err) {
        logger.error('grafana GET /devices/:deviceId/metrics error', {
          deviceId: req.params.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /devices?agentId=<uuid> — devices for an agent (query-param variant,
  // avoids double-slash when Infinity substitutes an empty template variable)
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: { agentId?: string } }>(
    '/devices',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const agentParsed = uuidSchema.safeParse(req.query.agentId);
      if (!agentParsed.success) {
        return reply.send([]);
      }
      try {
        const result = await query<{
          device_uuid: string;
          device_name: string;
          protocol: string;
          metric_count: number;
          last_seen: string;
        }>(
          `SELECT DISTINCT
                  device_uuid::text                                                         AS device_uuid,
                  COALESCE(NULLIF(device_name, ''), 'Unknown')                             AS device_name,
                  protocol,
                  COALESCE(metric_count, 0)::int                                           AS metric_count,
                  last_seen
           FROM endpoint_devices
           WHERE agent_uuid = $1
             AND device_uuid IS NOT NULL
           ORDER BY device_name
           LIMIT $2`,
          [agentParsed.data, SEARCH_ROW_LIMIT]
        );
        return reply.send(result.rows);
      } catch (err) {
        logger.error('grafana GET /devices error', {
          agentId: req.query.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /metrics?deviceId=<uuid>&agentId=<uuid> — metrics (query-param variant)
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: { deviceId?: string; agentId?: string } }>(
    '/metrics',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const deviceParsed = uuidSchema.safeParse(req.query.deviceId);
      if (!deviceParsed.success) {
        return reply.send([]);
      }
      const agentParsed = req.query.agentId
        ? uuidSchema.safeParse(req.query.agentId)
        : null;
      if (agentParsed && !agentParsed.success) {
        return reply.send([]);
      }
      try {
        const sqlParams: unknown[] = [deviceParsed.data, SEARCH_ROW_LIMIT];
        let agentFilter = '';
        if (agentParsed?.success) {
          sqlParams.push(agentParsed.data);
          agentFilter = ` AND agent_uuid = $${sqlParams.length}`;
        }
        const result = await query<{
          metric_name: string;
          unit: string | null;
          protocol: string;
          last_seen: string;
        }>(
          `SELECT DISTINCT metric_name,
                  COALESCE(NULLIF(unit, ''), NULL) AS unit,
                  protocol,
                  last_seen
           FROM metric_catalog
           WHERE device_uuid = $1
             ${agentFilter}
           ORDER BY metric_name
           LIMIT $2`,
          sqlParams
        );
        return reply.send(result.rows);
      } catch (err) {
        logger.error('grafana GET /metrics error', {
          deviceId: req.query.deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // =========================================================================
  // Infinity datasource endpoint
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /timeseries — time-series data via GET for Infinity datasource
  //
  // Query params:
  //   deviceId  (required) — device UUID
  //   metric    (required) — metric name
  //   from      (required) — ISO date string
  //   to        (required) — ISO date string
  //   agentId   (optional) — scope to a specific agent
  //
  // Response: [{ time: string (ISO), value: number | null }, ...]
  // -------------------------------------------------------------------------
  fastify.get<{
    Querystring: {
      deviceId?: string;
      metric?: string;
      from?: string;
      to?: string;
      agentId?: string;
    };
  }>(
    '/timeseries',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const deviceParsed = uuidSchema.safeParse(req.query.deviceId);
      if (!deviceParsed.success) {
        return reply.status(400).send({ error: 'deviceId must be a valid UUID' });
      }

      const metricParsed = z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9._\-]+$/)
        .safeParse(req.query.metric);
      if (!metricParsed.success) {
        return reply.status(400).send({ error: 'metric is required and must contain only alphanumeric, dot, underscore, or hyphen characters' });
      }

      const fromParsed = isoDateSchema.safeParse(req.query.from);
      const toParsed   = isoDateSchema.safeParse(req.query.to);
      if (!fromParsed.success || !toParsed.success) {
        return reply.status(400).send({ error: 'from and to must be valid ISO date strings' });
      }

      const agentParsed = req.query.agentId
        ? uuidSchema.safeParse(req.query.agentId)
        : null;
      if (agentParsed && !agentParsed.success) {
        return reply.status(400).send({ error: 'agentId must be a valid UUID' });
      }

      const from   = new Date(fromParsed.data);
      const to     = new Date(toParsed.data);
      const spanMs = to.getTime() - from.getTime();

      if (spanMs <= 0) {
        return reply.status(400).send({ error: 'from must be before to' });
      }
      if (spanMs > MAX_RANGE_MS) {
        return reply.status(400).send({ error: 'Time range exceeds maximum of 90 days' });
      }

      try {
        const ts = await getTimeseries({
          deviceUuid:  deviceParsed.data,
          metricName:  metricParsed.data,
          agentUuid:   agentParsed?.data,
          timeRange:   inferTimeRange(spanMs),
          aggregation: 'auto',
          startTime:   from,
          endTime:     to,
        });

        const rows = ts.data.map((row) => ({
          time:  row.time,
          value: row.avg_value !== null && row.avg_value !== undefined
            ? Number(row.avg_value)
            : null,
        }));

        return reply.send(rows);
      } catch (err) {
        logger.error('grafana GET /timeseries error', {
          deviceId: deviceParsed.data,
          metric:   metricParsed.data,
          error:    err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // =========================================================================
  // SimpleJSON protocol endpoints
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /search — discovery for Grafana variable dropdowns
  //
  // Supported target strings:
  //   "agents"                     → all agents [{text, value}]
  //   "devices"                    → all devices [{text, value}]
  //   "agent:<agentUuid>"          → devices under agent [{text, value}]
  //   "device:<deviceUuid>"        → metrics for device [string]
  //   "agent:<uuid>/device:<uuid>" → metrics scoped to agent+device [string]
  //   "<prefix>"                   → metric names starting with prefix [string]
  //   ""                           → all distinct metric names [string]
  // -------------------------------------------------------------------------
  fastify.post<{ Body: unknown }>(
    '/search',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const parsed = searchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request' });
      }

      const target = (parsed.data.target ?? '').trim();

      try {
        // "agents" → all agents
        if (target === 'agents') {
          const result = await query<{ uuid: string; name: string }>(
            `SELECT uuid::text AS uuid,
                    COALESCE(NULLIF(name, ''), 'Agent ' || left(uuid::text, 8)) AS name
             FROM agents
             ORDER BY name
             LIMIT $1`,
            [SEARCH_ROW_LIMIT]
          );
          return reply.send(result.rows.map((r) => ({ text: r.name, value: r.uuid })));
        }

        // "devices" → all devices
        if (target === 'devices') {
          const result = await query<{ device_uuid: string; device_name: string }>(
            `SELECT DISTINCT device_uuid::text AS device_uuid,
                    COALESCE(NULLIF(device_name, ''), 'Unknown') AS device_name
             FROM endpoint_devices
             WHERE device_uuid IS NOT NULL
             ORDER BY device_name
             LIMIT $1`,
            [SEARCH_ROW_LIMIT]
          );
          return reply.send(
            result.rows.map((r) => ({ text: r.device_name, value: r.device_uuid }))
          );
        }

        // "agent:<uuid>/device:<uuid>" → metrics scoped to both agent and device
        const agentDeviceMatch = target.match(
          /^agent:([0-9a-f-]{36})\/device:([0-9a-f-]{36})$/i
        );
        if (agentDeviceMatch) {
          const agentUuid  = agentDeviceMatch[1];
          const deviceUuid = agentDeviceMatch[2];
          if (!uuidSchema.safeParse(agentUuid).success || !uuidSchema.safeParse(deviceUuid).success) {
            return reply.status(400).send({ error: 'Invalid UUID in target' });
          }
          const result = await query<{ metric_name: string; unit: string | null }>(
            `SELECT DISTINCT metric_name,
                    COALESCE(NULLIF(unit, ''), NULL) AS unit
             FROM metric_catalog
             WHERE device_uuid = $1
               AND agent_uuid  = $2
             ORDER BY metric_name
             LIMIT $3`,
            [deviceUuid, agentUuid, SEARCH_ROW_LIMIT]
          );
          return reply.send(
            result.rows.map((r) => (r.unit ? `${r.metric_name} (${r.unit})` : r.metric_name))
          );
        }

        // "agent:<uuid>" → devices under that agent
        if (target.startsWith('agent:')) {
          const rawUuid = target.slice(6);
          const agentParsed = uuidSchema.safeParse(rawUuid);
          if (!agentParsed.success) {
            return reply.status(400).send({ error: 'Invalid agent UUID' });
          }
          const result = await query<{ device_uuid: string; device_name: string }>(
            `SELECT DISTINCT device_uuid::text AS device_uuid,
                    COALESCE(NULLIF(device_name, ''), 'Unknown') AS device_name
             FROM endpoint_devices
             WHERE agent_uuid  = $1
               AND device_uuid IS NOT NULL
             ORDER BY device_name
             LIMIT $2`,
            [agentParsed.data, SEARCH_ROW_LIMIT]
          );
          return reply.send(
            result.rows.map((r) => ({ text: r.device_name, value: r.device_uuid }))
          );
        }

        // "device:<uuid>" → metrics for that device
        if (target.startsWith('device:')) {
          const rawUuid = target.slice(7);
          const deviceParsed = uuidSchema.safeParse(rawUuid);
          if (!deviceParsed.success) {
            return reply.status(400).send({ error: 'Invalid device UUID' });
          }
          const result = await query<{ metric_name: string; unit: string | null }>(
            `SELECT DISTINCT metric_name,
                    COALESCE(NULLIF(unit, ''), NULL) AS unit
             FROM metric_catalog
             WHERE device_uuid = $1
             ORDER BY metric_name
             LIMIT $2`,
            [deviceParsed.data, SEARCH_ROW_LIMIT]
          );
          return reply.send(
            result.rows.map((r) => (r.unit ? `${r.metric_name} (${r.unit})` : r.metric_name))
          );
        }

        // Default: all distinct metric names, optionally filtered by prefix
        const result = await query<{ metric_name: string }>(
          target
            ? `SELECT DISTINCT metric_name FROM metric_catalog WHERE metric_name ILIKE $1 ORDER BY metric_name LIMIT $2`
            : `SELECT DISTINCT metric_name FROM metric_catalog ORDER BY metric_name LIMIT $1`,
          target ? [`${target}%`, SEARCH_ROW_LIMIT] : [SEARCH_ROW_LIMIT]
        );
        return reply.send(result.rows.map((r) => r.metric_name));

      } catch (err) {
        logger.error('grafana /search error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /query — time-series data
  //
  // Each target.target must be a JSON string matching targetModelSchema:
  //   '{"deviceId":"<uuid>","metric":"temperature"}'
  //   '{"agentId":"<uuid>","deviceId":"<uuid>","metric":"temperature"}'
  // -------------------------------------------------------------------------
  fastify.post<{ Body: unknown }>(
    '/query',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const parsed = queryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
      }

      const { range, targets } = parsed.data;
      const from = new Date(range.from);
      const to   = new Date(range.to);
      const spanMs = to.getTime() - from.getTime();

      if (spanMs <= 0) {
        return reply.status(400).send({ error: 'range.from must be before range.to' });
      }
      if (spanMs > MAX_RANGE_MS) {
        return reply.status(400).send({ error: 'Time range exceeds maximum of 90 days' });
      }

      const timeRange = inferTimeRange(spanMs);

      try {
        const results = await Promise.all(
          targets.map(async (t) => {
            const target = parseTarget(t.target);
            if (!target) return null;

            const { deviceId, metric, agentId } = target;

            const ts = await getTimeseries({
              deviceUuid:  deviceId,
              metricName:  metric,
              agentUuid:   agentId,
              timeRange,
              aggregation: 'auto',
              startTime:   from,
              endTime:     to,
            });

            // Grafana SimpleJSON format: [[value, timestamp_ms], ...]
            const datapoints: [number | null, number][] = ts.data.map((row) => [
              row.avg_value !== null && row.avg_value !== undefined
                ? Number(row.avg_value)
                : null,
              new Date(row.time).getTime(),
            ]);

            const label = ts.metric.unit
              ? `${metric} (${ts.metric.unit})`
              : metric;

            return { target: label, datapoints, refId: t.refId };
          })
        );

        return reply.send(results.filter(Boolean));
      } catch (err) {
        logger.error('grafana /query error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /annotations — anomaly event overlays
  // -------------------------------------------------------------------------
  fastify.post<{ Body: unknown }>(
    '/annotations',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const parsed = annotationsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request' });
      }

      const from = parsed.data.range?.from
        ? new Date(parsed.data.range.from)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = parsed.data.range?.to ? new Date(parsed.data.range.to) : new Date();

      if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
        return reply.status(400).send({ error: 'Annotation range exceeds 90 days' });
      }

      try {
        const result = await query<{
          timestamp_ms: string;
          device_uuid: string;
          metric: string;
          anomaly_score: number;
          description: string | null;
        }>(
          `SELECT timestamp_ms, device_uuid::text, metric, anomaly_score, description
           FROM anomaly_events
           WHERE to_timestamp(timestamp_ms::double precision / 1000.0) >= $1
             AND to_timestamp(timestamp_ms::double precision / 1000.0) <= $2
           ORDER BY timestamp_ms ASC
           LIMIT $3`,
          [from, to, ANNOTATION_ROW_LIMIT]
        );

        const annotationName = parsed.data.annotation?.name ?? 'Anomaly';

        const annotations = result.rows.map((row) => ({
          annotation: annotationName,
          time:  Number(row.timestamp_ms),
          title: `Anomaly: ${row.metric}`,
          text:  row.description ?? `Score: ${row.anomaly_score?.toFixed(3) ?? 'n/a'}`,
          tags:  ['anomaly', row.metric],
        }));

        return reply.send(annotations);
      } catch (err) {
        logger.error('grafana /annotations error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /tag-keys — ad-hoc filter dimension names
  // -------------------------------------------------------------------------
  fastify.get('/tag-keys', { preHandler: [jwtAuth] }, async (_req, reply) => {
    return reply.send([
      { type: 'string', text: 'Agent' },
      { type: 'string', text: 'Device' },
      { type: 'string', text: 'Protocol' },
      { type: 'string', text: 'Metric' },
    ]);
  });

  // -------------------------------------------------------------------------
  // GET /tag-values — values for a given ad-hoc filter key
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: { key?: string } }>(
    '/tag-values',
    { preHandler: [jwtAuth] },
    async (req, reply) => {
      const key = req.query.key ?? '';

      try {
        if (key === 'Agent') {
          const result = await query<{ uuid: string; name: string }>(
            `SELECT uuid::text AS uuid,
                    COALESCE(NULLIF(name, ''), 'Agent ' || left(uuid::text, 8)) AS name
             FROM agents
             ORDER BY name`,
            []
          );
          return reply.send(result.rows.map((r) => ({ text: r.name, value: r.uuid })));
        }

        if (key === 'Device') {
          const result = await query<{ device_uuid: string; device_name: string }>(
            `SELECT DISTINCT device_uuid::text AS device_uuid,
                    COALESCE(NULLIF(device_name, ''), 'Unknown') AS device_name
             FROM endpoint_devices
             WHERE device_uuid IS NOT NULL
             ORDER BY device_name`,
            []
          );
          return reply.send(
            result.rows.map((r) => ({ text: r.device_name, value: r.device_uuid }))
          );
        }

        if (key === 'Protocol') {
          const result = await query<{ protocol: string }>(
            `SELECT DISTINCT protocol
             FROM metric_catalog
             WHERE protocol IS NOT NULL
             ORDER BY protocol`,
            []
          );
          return reply.send(result.rows.map((r) => ({ text: r.protocol, value: r.protocol })));
        }

        if (key === 'Metric') {
          const result = await query<{ metric_name: string }>(
            `SELECT DISTINCT metric_name
             FROM metric_catalog
             WHERE metric_name IS NOT NULL
             ORDER BY metric_name
             LIMIT $1`,
            [SEARCH_ROW_LIMIT]
          );
          return reply.send(
            result.rows.map((r) => ({ text: r.metric_name, value: r.metric_name }))
          );
        }

        return reply.send([]);
      } catch (err) {
        logger.error('grafana /tag-values error', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.status(500).send({ error: 'Internal error' });
      }
    }
  );
};

export default grafanaPlugin;
