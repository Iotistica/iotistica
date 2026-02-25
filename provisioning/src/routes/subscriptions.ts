/**
 * Subscription Routes
 * Manage subscriptions and trials
 */

import { Router } from 'express';
import crypto from 'crypto';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { LicenseHistoryModel } from '../db/license-history-model';
import { StripeService } from '../services/stripe-service';
import { LicenseGenerator } from '../services/license-generator';
import { RefundService } from '../services/refund-service';
import { CustomerDeactivationService } from '../services/customer-deactivation';

const router = Router();

/**
 * POST /api/subscriptions/checkout
 * Create Stripe checkout session
 */
router.post('/checkout', async (req, res) => {
  try {
    const { customer_id, plan, success_url, cancel_url } = req.body;

    if (!customer_id || !plan) {
      return res.status(400).json({ error: 'customer_id and plan are required' });
    }

    if (!['starter', 'professional', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await StripeService.createCheckoutSession({
      customerId: customer_id,
      plan,
      successUrl: success_url || `${req.protocol}://${req.get('host')}/success`,
      cancelUrl: cancel_url || `${req.protocol}://${req.get('host')}/cancel`,
    });

    res.json({
      session_id: session.id,
      checkout_url: session.url,
    });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/trial
 * Create trial subscription (already done in customer creation, but kept for flexibility)
 */
router.post('/trial', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    const customer = await CustomerModel.getById(customer_id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Check if subscription exists
    const existing = await SubscriptionModel.getByCustomerId(customer_id);
    if (existing) {
      return res.status(409).json({ error: 'Subscription already exists' });
    }

    const subscription = await SubscriptionModel.createTrial(customer_id, 'starter', 14);
    const license = await LicenseGenerator.generateLicense(customer, subscription);

    // ✅ Log trial creation
    const licenseHash = crypto.createHash('sha256').update(license).digest('hex');
    const decoded = LicenseGenerator.verifyLicense(license);
    
    await LicenseHistoryModel.log({
      customerId: customer_id,
      action: 'generated',
      plan: subscription.plan,
      maxDevices: decoded.features.maxDevices,
      licenseHash,
      generatedBy: 'api',
      metadata: {
        type: 'trial',
        trialDays: 14,
        features: decoded.features,
        limits: decoded.limits,
        expiresAt: new Date(decoded.expiresAt * 1000).toISOString(),
      }
    });

    console.log(`🎁 Trial license generated for ${customer.email} (14 days)`);

    res.status(201).json({
      subscription,
      license,
    });
  } catch (error: any) {
    console.error('Error creating trial:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/upgrade
 * Upgrade subscription plan
 */
router.post('/upgrade', async (req, res) => {
  try {
    const { customer_id, new_plan } = req.body;

    if (!customer_id || !new_plan) {
      return res.status(400).json({ error: 'customer_id and new_plan are required' });
    }

    if (!['starter', 'professional', 'enterprise'].includes(new_plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Get current subscription for comparison
    const oldSubscription = await SubscriptionModel.getByCustomerId(customer_id);
    const oldPlan = oldSubscription?.plan || 'unknown';

    await StripeService.upgradeSubscription(customer_id, new_plan);

    // Get updated subscription and regenerate license
    const subscription = await SubscriptionModel.getByCustomerId(customer_id);
    const customer = await CustomerModel.getById(customer_id);
    
    if (!subscription || !customer) {
      return res.status(404).json({ error: 'Customer or subscription not found' });
    }

    const license = await LicenseGenerator.generateLicense(customer, subscription);

    // ✅ Log upgrade/downgrade
    const licenseHash = crypto.createHash('sha256').update(license).digest('hex');
    const decoded = LicenseGenerator.verifyLicense(license);
    const action = new_plan > oldPlan ? 'upgraded' : 'downgraded';
    
    await LicenseHistoryModel.log({
      customerId: customer_id,
      action,
      plan: subscription.plan,
      maxDevices: decoded.features.maxDevices,
      licenseHash,
      generatedBy: 'api',
      metadata: {
        oldPlan,
        newPlan: new_plan,
        features: decoded.features,
        limits: decoded.limits,
        expiresAt: new Date(decoded.expiresAt * 1000).toISOString(),
      }
    });

    console.log(`📈 Subscription ${action} for ${customer.email} (${oldPlan} → ${new_plan})`);

    res.json({
      subscription,
      license,
    });
  } catch (error: any) {
    console.error('Error upgrading subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription immediately (legacy endpoint - kept for backwards compatibility)
 */
router.post('/cancel', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    await StripeService.cancelSubscription(customer_id);

    res.json({
      message: 'Subscription canceled successfully',
    });
  } catch (error: any) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/cancel-at-period-end
 * Cancel subscription at period end (graceful cancellation)
 */
router.post('/cancel-at-period-end', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    await StripeService.cancelAtPeriodEnd(customer_id);

    const subscription = await SubscriptionModel.getByCustomerId(customer_id);

    res.json({
      message: 'Subscription will cancel at period end',
      subscription,
    });
  } catch (error: any) {
    console.error('Error canceling subscription at period end:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/keep
 * Keep subscription (undo cancel-at-period-end)
 */
router.post('/keep', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    await StripeService.keepSubscription(customer_id);

    const subscription = await SubscriptionModel.getByCustomerId(customer_id);

    res.json({
      message: 'Subscription will continue',
      subscription,
    });
  } catch (error: any) {
    console.error('Error keeping subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/cancel-immediate
 * Cancel subscription immediately with optional refund
 */
router.post('/cancel-immediate', async (req, res) => {
  try {
    const { customer_id, issue_refund, refund_amount, refund_reason } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    // Cancel subscription immediately
    await StripeService.cancelSubscription(customer_id);

    let refundResult = null;

    // Issue refund if requested
    if (issue_refund && refund_reason) {
      try {
        refundResult = await RefundService.issueRefund({
          customerId: customer_id,
          reason: refund_reason,
          amount: refund_amount, // Optional: if not provided, full refund
          description: 'Subscription cancellation refund',
        });
      } catch (error: any) {
        console.error('Refund failed:', error);
        // Continue even if refund fails
      }
    }

    res.json({
      message: 'Subscription canceled immediately',
      refund: refundResult,
    });
  } catch (error: any) {
    console.error('Error canceling subscription immediately:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/refund
 * Issue refund for subscription (without canceling)
 */
router.post('/refund', async (req, res) => {
  try {
    const { customer_id, amount, reason, description, use_prorated } = req.body;

    if (!customer_id || !reason) {
      return res.status(400).json({ error: 'customer_id and reason are required' });
    }

    let refundAmount = amount;

    // Calculate pro-rated refund if requested
    if (use_prorated) {
      refundAmount = await RefundService.calculateProRatedRefund(customer_id);
      if (refundAmount === 0) {
        return res.status(400).json({ error: 'No pro-rated refund available' });
      }
    }

    const refundResult = await RefundService.issueRefund({
      customerId: customer_id,
      reason,
      amount: refundAmount,
      description: description || 'Refund requested',
    });

    res.json({
      message: 'Refund issued successfully',
      refund: refundResult,
    });
  } catch (error: any) {
    console.error('Error issuing refund:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subscriptions/:customerId/refunds
 * Get refund history for customer
 */
router.get('/:customerId/refunds', async (req, res) => {
  try {
    const { customerId } = req.params;

    const refunds = await RefundService.getRefundHistory(customerId);

    res.json({ refunds });
  } catch (error: any) {
    console.error('Error fetching refunds:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/deactivate
 * Complete customer deactivation (cancel, refund, schedule data deletion)
 */
router.post('/deactivate', async (req, res) => {
  try {
    const {
      customer_id,
      cancel_subscription = true,
      issue_refund = false,
      refund_reason = 'requested_by_customer',
      refund_amount,
      delete_data = true,
      retention_days = 30,
      cancel_at_period_end = false,
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    const result = await CustomerDeactivationService.deactivateCustomer(customer_id, {
      cancelSubscription: cancel_subscription,
      issueRefund: issue_refund,
      refundReason: refund_reason,
      refundAmount: refund_amount,
      deleteData: delete_data,
      retentionDays: retention_days,
      cancelAtPeriodEnd: cancel_at_period_end,
    });

    res.json({
      message: 'Customer deactivated successfully',
      result,
    });
  } catch (error: any) {
    console.error('Error deactivating customer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/subscriptions/reactivate
 * Reactivate customer (within retention period)
 */
router.post('/reactivate', async (req, res) => {
  try {
    const { customer_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    await CustomerDeactivationService.reactivateCustomer(customer_id);

    res.json({
      message: 'Customer reactivated successfully',
    });
  } catch (error: any) {
    console.error('Error reactivating customer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subscriptions/scheduled-deletions
 * Get customers scheduled for deletion
 */
router.get('/scheduled-deletions', async (req, res) => {
  try {
    const deletions = await CustomerDeactivationService.getScheduledDeletions();

    res.json({ deletions });
  } catch (error: any) {
    console.error('Error fetching scheduled deletions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/subscriptions/:customerId
 * Get subscription details
 */
router.get('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ subscription });
  } catch (error: any) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
