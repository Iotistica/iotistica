import type { FastifyPluginAsync } from 'fastify';

import { renderEndpointPrometheusMetrics } from '../services/telemetry/prometheus';
import { logger } from '../utils/logger';

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/metrics', async (_req, reply) => {
    try {
      const output = await renderEndpointPrometheusMetrics();
      return reply
        .header('Content-Type', 'text/plain; version=0.0.4')
        .send(output);
    } catch (error: unknown) {
      logger.error('Error generating Prometheus metrics', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return reply.status(500)
        .header('Content-Type', 'text/plain; version=0.0.4')
        .send('# Error generating metrics\n');
    }
  });
};

export default plugin;