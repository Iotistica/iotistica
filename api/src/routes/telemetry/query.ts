/**
 * Advanced Readings Query Route
 *
 * POST /api/v1/readings/query
 *
 * OpenTSDB-inspired multi-metric query endpoint supporting:
 *   - Downsampling with configurable intervals and aggregation functions
 *   - Rate / derivative calculation with optional counter-rollover correction
 *   - Tag-based filtering (exact, wildcard, regexp) on protocol or extra JSONB fields
 *   - Group-by on tag dimensions (splits one series into N per unique tag value)
 *   - Histogram/percentile queries (p50, p95, p99, etc.)
 *   - Multi-metric: any number of sub-queries in a single request
 */

import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { jwtAuth } from '../../middleware/jwt-auth';
import logger from '../../utils/logger';
import { executeAdvancedQuery } from '../../services/telemetry/query';

// ── Validation schemas ────────────────────────────────────────────────────────

const SAFE_METRIC = /^[a-zA-Z0-9_.-]+$/;
const SAFE_TAGK   = /^[a-zA-Z0-9_.-]+$/;
const DOWNSAMPLE_RE = /^\d+[smhdw]-\w+$/;
const RELATIVE_TIME_RE = /^\d+[smhdw]-ago$/;

function isValidTime(v: string): boolean {
  if (RELATIVE_TIME_RE.test(v)) return true;
  return !isNaN(new Date(v).getTime());
}

const rateOptionsSchema = z.object({
  counter:     z.boolean().optional(),
  counter_max: z.number().positive().optional(),
  reset_value: z.number().optional(),
}).optional();

const tagFilterSchema = z.object({
  type:     z.enum(['exact', 'wildcard', 'regexp']),
  tagk:     z.string().min(1).max(64).regex(SAFE_TAGK, 'tagk must match /^[a-zA-Z0-9_.-]+$/'),
  filter:   z.string().min(1).max(256),
  group_by: z.boolean().optional(),
});

const subQuerySchema = z.object({
  metric:       z.string().min(1).max(100).regex(SAFE_METRIC, 'metric must match /^[a-zA-Z0-9_.-]+$/'),
  agent_uuids:  z.array(z.string().uuid()).min(1).optional(),
  aggregator:   z.enum(['avg', 'sum', 'min', 'max', 'last', 'count']).optional(),
  downsample:   z.string().regex(DOWNSAMPLE_RE, 'downsample format: <N><unit>-<fn>, e.g. "1h-avg"').optional(),
  rate:         z.boolean().optional(),
  rate_options: rateOptionsSchema,
  filters:      z.array(tagFilterSchema).max(10).optional(),
  percentiles:  z.array(z.number().min(1).max(99)).max(10).optional(),
}).refine(
  sq => sq.rate !== true || !sq.percentiles?.length,
  { message: 'rate and percentiles cannot be combined in the same sub-query' },
).refine(
  sq => sq.agent_uuids?.length || sq.filters?.length,
  { message: 'each sub-query must have at least one agent_uuid or filter to narrow scope' },
);

const queryBodySchema = z.object({
  start:   z.string().refine(isValidTime, 'start must be ISO 8601 or relative like "1h-ago"'),
  end:     z.string().refine(isValidTime, 'end must be ISO 8601 or relative like "1h-ago"').optional(),
  queries: z.array(subQuerySchema).min(1).max(20),
});

// ── Route plugin ──────────────────────────────────────────────────────────────

const plugin: FastifyPluginAsync = async (fastify) => {

  /**
   * POST /query
   *
   * Body: AdvancedQueryInput
   * Response: array of sub-query result arrays (one array per sub-query, in order)
   */
  fastify.post('/query', { preHandler: [jwtAuth] }, async (req, reply) => {
    const requestId = req.id ?? 'unknown';

    let body: z.infer<typeof queryBodySchema>;
    try {
      body = queryBodySchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        logger.warn('Invalid advanced query request', { requestId, errors: err.errors });
        return reply.status(400).send({
          error: 'Invalid request body',
          details: err.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
          requestId,
        });
      }
      throw err;
    }

    try {
      const results = await executeAdvancedQuery(body);

      return reply.send({
        query_count: body.queries.length,
        start: body.start,
        end: body.end ?? 'now',
        results,
      });
    } catch (err: unknown) {
      logger.error('Advanced query execution failed', {
        requestId,
        userId: req.user?.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return reply.status(500).send({ error: 'Internal server error', requestId });
    }
  });

};

export default plugin;
