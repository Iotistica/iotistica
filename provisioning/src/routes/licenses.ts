/**
 * License Routes
 * Generate and manage licenses
 */

import { Router } from 'express';
import crypto from 'crypto';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { LicenseHistoryModel } from '../db/license-history-model';
import { LicenseGenerator } from '../services/license-generator';

const router = Router();

/**
 * GET /api/licenses/public-key
 * Get public key for license verification
 */
router.get('/public-key', async (req, res) => {
  try {
    const publicKey = LicenseGenerator.getPublicKey();
    
    res.json({
      public_key: publicKey,
      algorithm: 'RS256',
      usage: 'Place this key in customer instance environment variable: LICENSE_PUBLIC_KEY',
    });
  } catch (error: any) {
    console.error('Error fetching public key:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/licenses/:customerId
 * Get license for customer instance
 */
router.get('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Generate fresh license
    const license = await LicenseGenerator.generateLicense(customer, subscription);

    // Decode for response (but don't verify - we just generated it)
    const decoded = LicenseGenerator.verifyLicense(license);

    // ✅ GOOD: Log metadata (NOT the actual JWT)
    const licenseHash = crypto.createHash('sha256').update(license).digest('hex');
    
    await LicenseHistoryModel.log({
      customerId: customer.customer_id,
      action: 'generated',
      plan: subscription.plan,
      maxDevices: decoded.features.maxDevices,
      licenseHash,
      generatedBy: 'api',
      metadata: {
        features: decoded.features,
        limits: decoded.limits,
        subscriptionStatus: subscription.status,
        trialMode: decoded.trial.isTrialMode,
        expiresAt: new Date(decoded.expiresAt * 1000).toISOString(),
      }
    });

    console.log(`✅ License generated for ${customer.email} (${subscription.plan})`);

    res.json({
      license,
      decoded,
      customer_id: customer.customer_id,
      plan: subscription.plan,
      status: subscription.status,
    });
  } catch (error: any) {
    console.error('Error generating license:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/licenses/:customerId/revoke
 * Revoke license (cancel subscription)
 */
router.post('/:customerId/revoke', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { reason } = req.body;

    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Cancel subscription
    await SubscriptionModel.cancel(customerId);

    // ✅ Log revocation
    await LicenseHistoryModel.log({
      customerId: customer.customer_id,
      action: 'revoked',
      plan: subscription.plan,
      maxDevices: 0,
      licenseHash: 'revoked',
      generatedBy: 'api',
      metadata: {
        reason: reason || 'Manual revocation',
        previousPlan: subscription.plan,
        revokedAt: new Date().toISOString(),
      }
    });

    console.log(`❌ License revoked for ${customer.email} (${reason || 'No reason provided'})`);

    res.json({
      message: 'License revoked successfully',
      customer_id: customerId,
    });
  } catch (error: any) {
    console.error('Error revoking license:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/licenses/verify
 * Verify license JWT (for testing)
 */
router.post('/verify', async (req, res) => {
  try {
    const { license } = req.body;

    if (!license) {
      return res.status(400).json({ error: 'License token required' });
    }

    const decoded = LicenseGenerator.verifyLicense(license);

    res.json({
      valid: true,
      data: decoded,
    });
  } catch (error: any) {
    res.status(401).json({
      valid: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/licenses/:customerId/history
 * Get license generation history for a customer
 */
router.get('/:customerId/history', async (req, res) => {
  try {
    const { customerId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;

    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const history = await LicenseHistoryModel.getByCustomerId(customerId, limit);
    const stats = await LicenseHistoryModel.getStats(customerId);

    res.json({
      customer_id: customerId,
      email: customer.email,
      company_name: customer.company_name,
      history,
      statistics: stats,
    });
  } catch (error: any) {
    console.error('Error fetching license history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/licenses/history/recent
 * Get recent license generations across all customers
 */
router.get('/history/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;

    const history = await LicenseHistoryModel.getRecent(limit);

    res.json({
      count: history.length,
      history,
    });
  } catch (error: any) {
    console.error('Error fetching recent license history:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/licenses/stats
 * Get overall license generation statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await LicenseHistoryModel.getStats();

    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching license stats:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
