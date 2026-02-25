import { Router } from 'express';
import { upgradeService } from '../services/upgrade-service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /api/upgrades/:customerId
 * Upgrade a specific customer instance to a new version
 */
router.post('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { version, dryRun = false, force = false, timeout = 600 } = req.body;

    if (!version) {
      return res.status(400).json({ 
        error: 'Missing required field: version' 
      });
    }

    logger.info('Starting customer upgrade', { customerId, version, dryRun });

    // Check if upgrade is safe
    const preflight = await upgradeService.canUpgrade(customerId, version);
    if (!preflight.canUpgrade) {
      return res.status(400).json({ 
        error: 'Upgrade not allowed',
        reasons: preflight.reasons
      });
    }

    // Execute upgrade
    const result = await upgradeService.upgradeCustomerInstance(customerId, version, {
      dryRun,
      force,
      timeout
    });

    if (result.success) {
      res.json({
        success: true,
        customerId: result.customerId,
        namespace: result.namespace,
        version: result.version,
        duration: result.duration,
        message: dryRun ? 'Dry-run successful' : 'Upgrade completed successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        customerId: result.customerId,
        namespace: result.namespace,
        version: result.version,
        error: result.error,
        rolledBack: result.rolledBack,
        message: result.rolledBack 
          ? 'Upgrade failed but was automatically rolled back'
          : 'Upgrade failed'
      });
    }

  } catch (error) {
    logger.error('Failed to upgrade customer', { error });
    res.status(500).json({ 
      error: 'Failed to upgrade customer',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/upgrades/:customerId/history
 * Get upgrade history for a customer
 */
router.get('/:customerId/history', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const history = await upgradeService.getUpgradeHistory(customerId);

    res.json({
      customerId,
      count: history.length,
      history,
    });

  } catch (error) {
    logger.error('Failed to get upgrade history', { error });
    res.status(500).json({ 
      error: 'Failed to get upgrade history',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/upgrades/:customerId/can-upgrade
 * Check if a customer can be upgraded
 */
router.get('/:customerId/can-upgrade', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { version } = req.query;

    if (!version) {
      return res.status(400).json({ 
        error: 'Missing required query parameter: version' 
      });
    }

    const result = await upgradeService.canUpgrade(customerId, version as string);

    res.json({
      customerId,
      version,
      canUpgrade: result.canUpgrade,
      reasons: result.reasons,
    });

  } catch (error) {
    logger.error('Failed to check upgrade eligibility', { error });
    res.status(500).json({ 
      error: 'Failed to check upgrade eligibility',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
