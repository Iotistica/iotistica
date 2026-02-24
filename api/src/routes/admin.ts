/**
 * Admin Routes
 * Administrative endpoints for system monitoring
 */

import express from 'express';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import logger from '../utils/logger';

export const router = express.Router();

// Apply admin-only protection to all admin routes
router.use(jwtAuth);
router.use(requireRole('admin'));

// ============================================================================
// Admin / Monitoring Endpoints
// ============================================================================

/**
 * Get heartbeat monitor status and configuration
 * GET /api/v1/admin/heartbeat
 */
router.get('/admin/heartbeat', async (req, res) => {
  try {
    const heartbeatMonitor = await import('../services/heartbeat-monitor');
    const config = heartbeatMonitor.default.getConfig();

    res.json({
      status: 'ok',
      heartbeat: config
    });
  } catch (error: any) {
    logger.error('Error getting heartbeat config:', error);
    res.status(500).json({
      error: 'Failed to get heartbeat configuration',
      message: error.message
    });
  }
});

/**
 * Manually trigger heartbeat check
 * POST /api/v1/admin/heartbeat/check
 */
router.post('/admin/heartbeat/check', async (req, res) => {
  try {
    logger.info('🔍 Manual heartbeat check triggered');
    
    const heartbeatMonitor = await import('../services/heartbeat-monitor');
    await heartbeatMonitor.default.checkNow();

    res.json({
      status: 'ok',
      message: 'Heartbeat check completed'
    });
  } catch (error: any) {
    logger.error('Error during manual heartbeat check:', error);
    res.status(500).json({
      error: 'Failed to perform heartbeat check',
      message: error.message
    });
  }
});

export default router;
