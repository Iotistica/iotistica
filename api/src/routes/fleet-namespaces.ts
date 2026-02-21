/**
 * Fleet Namespace Routes
 * 
 * Endpoints for discovering and managing pre-provisioned fleet namespaces
 */

import { Router } from 'express';
import { fleetNamespaceManager } from '../services/fleet-namespace-manager.js';
import { jwtAuth } from '../middleware/jwt-auth';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/fleets/namespaces/available
 * 
 * List all available fleet namespaces with capacity information
 * 
 * Response:
 * [
 *   {
 *     name: "fleet-test",
 *     maxAgents: 2,
 *     maxDevices: 32,
 *     currentAgents: 0,
 *     currentDevices: 0,
 *     available: true,
 *     utilizationPercent: 0
 *   }
 * ]
 */
router.get('/fleets/namespaces/available', jwtAuth, async (req, res) => {
  try {
    logger.info('[FLEET-NAMESPACES] Listing available fleet namespaces');
    
    const namespaces = await fleetNamespaceManager.discoverNamespaces();
    
    // Filter to only available namespaces (or show all with ?showFull=true)
    const showFull = req.query.showFull === 'true';
    const filtered = showFull ? namespaces : namespaces.filter(ns => ns.available);
    
    logger.info('[FLEET-NAMESPACES] Found fleet namespaces', {
      total: namespaces.length,
      available: filtered.length,
      showFull
    });

    res.json({
      namespaces: filtered,
      summary: {
        total: namespaces.length,
        available: namespaces.filter(ns => ns.available).length,
        full: namespaces.filter(ns => !ns.available).length
      }
    });

  } catch (error: any) {
    logger.error('[FLEET-NAMESPACES] Failed to list namespaces', {
      error: error.message
    });
    res.status(500).json({
      error: 'Failed to list fleet namespaces',
      message: error.message
    });
  }
});

/**
 * GET /api/fleets/namespaces/:name
 * 
 * Get detailed information about a specific fleet namespace
 */
router.get('/fleets/namespaces/:name', jwtAuth, async (req, res) => {
  try {
    const { name } = req.params;
    
    logger.info('[FLEET-NAMESPACES] Getting namespace details', { name });
    
    const namespaces = await fleetNamespaceManager.discoverNamespaces();
    const namespace = namespaces.find(ns => ns.name === name);
    
    if (!namespace) {
      return res.status(404).json({
        error: 'Namespace not found',
        message: `Fleet namespace '${name}' does not exist or is not managed by Iotistic`
      });
    }

    res.json(namespace);

  } catch (error: any) {
    logger.error('[FLEET-NAMESPACES] Failed to get namespace details', {
      name: req.params.name,
      error: error.message
    });
    res.status(500).json({
      error: 'Failed to get namespace details',
      message: error.message
    });
  }
});

/**
 * POST /api/fleets/namespaces/sync
 * 
 * Force sync fleet namespaces from Kubernetes to database
 * 
 * Admin endpoint - refreshes cached namespace data
 */
router.post('/fleets/namespaces/sync', jwtAuth, async (req, res) => {
  try {
    logger.info('[FLEET-NAMESPACES] Manual sync triggered');
    
    await fleetNamespaceManager.syncNamespacesToDatabase();
    
    const namespaces = await fleetNamespaceManager.discoverNamespaces();
    
    logger.info('[FLEET-NAMESPACES] Sync completed', {
      count: namespaces.length
    });

    res.json({
      message: 'Fleet namespaces synced successfully',
      count: namespaces.length,
      namespaces
    });

  } catch (error: any) {
    logger.error('[FLEET-NAMESPACES] Failed to sync namespaces', {
      error: error.message
    });
    res.status(500).json({
      error: 'Failed to sync fleet namespaces',
      message: error.message
    });
  }
});

/**
 * GET /api/fleets/namespaces/recommend
 * 
 * Get recommended namespace for new fleet/agent
 * 
 * Query params:
 * - requiredDevices: Number of devices needed (optional)
 * 
 * Response:
 * {
 *   recommended: "fleet-test",
 *   reason: "Lowest utilization (0%)",
 *   available: true
 * }
 */
router.get('/fleets/namespaces/recommend', jwtAuth, async (req, res) => {
  try {
    const requiredDevices = parseInt(req.query.requiredDevices as string) || 0;
    
    logger.info('[FLEET-NAMESPACES] Finding recommended namespace', {
      requiredDevices
    });
    
    const recommended = await fleetNamespaceManager.findAvailableNamespace(requiredDevices);
    
    if (!recommended) {
      return res.status(503).json({
        error: 'No available namespaces',
        message: 'All fleet namespaces are at capacity. Contact admin to provision more namespaces.',
        recommended: null,
        available: false
      });
    }

    // Get details for recommended namespace
    const namespaces = await fleetNamespaceManager.discoverNamespaces();
    const details = namespaces.find(ns => ns.name === recommended);

    res.json({
      recommended,
      reason: `Lowest utilization (${details?.utilizationPercent.toFixed(1)}%)`,
      available: true,
      details
    });

  } catch (error: any) {
    logger.error('[FLEET-NAMESPACES] Failed to recommend namespace', {
      error: error.message
    });
    res.status(500).json({
      error: 'Failed to recommend namespace',
      message: error.message
    });
  }
});

export default router;
