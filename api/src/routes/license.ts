/**
 * License Routes
 * Endpoints for viewing license information and feature availability
 */

import express from 'express';
import { LicenseValidator } from '../services/auth/license-validator';
import { AgentModel } from '../db/models';
import { logger } from '../utils/logger';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';

const router = express.Router();

/**
 * GET /api/license
 * Get current license information
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.get('/license', jwtAuth, requireRole('admin'), async (req, res) => {
  try {
    const license = LicenseValidator.getInstance();
    const licenseData = license.getLicense();
    const agents = await AgentModel.list({ isActive: true });
    
    res.json({
      customer: {
        id: licenseData.customerId,
        name: licenseData.customerName,
      },
      plan: licenseData.plan,
      subscription: {
        status: licenseData.subscription.status,
        currentPeriodEndsAt: licenseData.subscription.currentPeriodEndsAt,
      },
      trial: licenseData.trial.isTrialMode ? {
        isActive: true,
        expiresAt: licenseData.trial.expiresAt,
        daysRemaining: license.getTrialDaysRemaining(),
      } : null,
      features: licenseData.features,
      limits: licenseData.limits,
      usage: {
        agents: {
          current: agents.length,
          max: licenseData.features.maxDevices,
          percentUsed: Math.round((agents.length / licenseData.features.maxDevices) * 100),
        },
      },
      upgradeUrl: process.env.BILLING_UPGRADE_URL || 'https://iotistica.com/upgrade',
    });
  } catch (error: any) {
    logger.error('Error fetching license info', { error: error.message, stack: error.stack, userId: req.user?.id });
    res.status(500).json({ 
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

export default router;
