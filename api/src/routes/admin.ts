/**
 * Admin Routes
 * Administrative endpoints for system monitoring
 */

import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../middleware/jwt-auth';
import logger from '../utils/logger';

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', requireRole('admin'));

  // ============================================================================
  // Admin / Monitoring Endpoints
  // ============================================================================

  /**
   * Get heartbeat monitor status and configuration
   * GET /api/v1/admin/heartbeat
   */
  fastify.get('/admin/heartbeat', async (_request, reply) => {
    try {
      const heartbeatMonitor = await import('../services/health/heartbeat-monitor');
      const config = heartbeatMonitor.default.getConfig();

      return reply.send({
        status: 'ok',
        heartbeat: config
      });
    } catch (error: any) {
      logger.error('Error getting heartbeat config:', error);
      return reply.status(500).send({
        error: 'Failed to get heartbeat configuration',
        message: error.message
      });
    }
  });

  /**
   * Manually trigger heartbeat check
   * POST /api/v1/admin/heartbeat/check
   */
  fastify.post('/admin/heartbeat/check', async (_request, reply) => {
    try {
      logger.info('Manual heartbeat check triggered');

      const heartbeatMonitor = await import('../services/health/heartbeat-monitor');
      await heartbeatMonitor.default.checkNow();

      return reply.send({
        status: 'ok',
        message: 'Heartbeat check completed'
      });
    } catch (error: any) {
      logger.error('Error during manual heartbeat check:', error);
      return reply.status(500).send({
        error: 'Failed to perform heartbeat check',
        message: error.message
      });
    }
  });
};

export default plugin;
