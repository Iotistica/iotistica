/**
 * Usage Routes
 * Receive and track usage from customer instances
 */

import { Router } from 'express';
import Stripe from 'stripe';
import { UsageReportModel } from '../db/usage-report-model';
import { CustomerModel } from '../db/customer-model';

const router = Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16'
});

/**
 * POST /api/usage/report
 * Report usage from customer instance (includes Stripe metered billing with overage calculation)
 */
router.post('/report', async (req, res) => {
  try {
    const { customer_id, instance_id, active_devices, total_devices, metrics } = req.body;

    if (!customer_id) {
      return res.status(400).json({ error: 'customer_id is required' });
    }

    // Create usage report in database
    const report = await UsageReportModel.create({
      customer_id,
      instance_id: instance_id || 'default',
      active_devices: active_devices || 0,
      total_devices: total_devices || 0,
    });

    // Report to Stripe if metrics provided
    let stripeReported = false;
    let overageDevices = 0;
    
    if (metrics) {
      try {
        const customer = await CustomerModel.getById(customer_id);
        
        if (customer?.stripe_customer_id) {
          // Get customer's subscription to know their plan
          const { SubscriptionModel } = require('../db/subscription-model');
          const subscription = await SubscriptionModel.getByCustomerId(customer_id);
          
          if (!subscription) {
            console.log('No subscription found for customer, skipping Stripe reporting');
            return res.status(201).json({
              message: 'Usage reported successfully',
              report,
              stripe_reported: false
            });
          }

          // Get active Stripe subscription
          const subscriptions = await stripe.subscriptions.list({
            customer: customer.stripe_customer_id,
            status: 'active',
            limit: 1
          });

          if (subscriptions.data.length > 0) {
            const stripeSubscription = subscriptions.data[0];
            const timestamp = Math.floor(Date.now() / 1000);
            
            // Define plan limits (from license-generator.ts)
            const planLimits: Record<string, number> = {
              starter: 5,
              professional: 50,
              enterprise: Infinity  // Unlimited
            };
            
            const includedDevices = planLimits[subscription.plan] || planLimits.starter;
            const actualDevices = metrics.devices || 0;
            
            // Calculate overages (only positive values)
            overageDevices = Math.max(0, actualDevices - includedDevices);
            
            console.log(`📊 Usage for ${customer_id}:`, {
              plan: subscription.plan,
              actual_devices: actualDevices,
              included_devices: includedDevices,
              overage_devices: overageDevices
            });

            // Report device overages (if applicable)
            if (subscription.plan !== 'enterprise') {
              // Find metered device price (lookup key should be device_usage_starter or device_usage_professional)
              const deviceItem = stripeSubscription.items.data.find(
                item => item.price.lookup_key === `device_usage_${subscription.plan}` ||
                        item.price.lookup_key === 'device_usage'  // Fallback to generic
              );
              
              if (deviceItem) {
                await stripe.subscriptionItems.createUsageRecord(deviceItem.id, {
                  quantity: overageDevices,  // Report only overages
                  timestamp,
                  action: 'set'
                });
                console.log(`✅ Reported ${overageDevices} overage devices to Stripe for ${customer_id}`);
                stripeReported = true;
              } else {
                console.log(`⚠️  No metered device price found in subscription (lookup key: device_usage_${subscription.plan})`);
              }
            } else {
              console.log(`ℹ️  Enterprise plan - unlimited devices, no overage reporting`);
            }

            // Report MQTT messages (if metered and provided)
            const mqttItem = stripeSubscription.items.data.find(
              item => item.price.lookup_key === 'mqtt_messages'
            );
            if (mqttItem && metrics.mqtt_messages !== undefined) {
              await stripe.subscriptionItems.createUsageRecord(mqttItem.id, {
                quantity: metrics.mqtt_messages,
                timestamp,
                action: 'increment'
              });
              console.log(`✅ Reported ${metrics.mqtt_messages} MQTT messages to Stripe for ${customer_id}`);
              stripeReported = true;
            }

            // Report storage (if metered and provided)
            const storageItem = stripeSubscription.items.data.find(
              item => item.price.lookup_key === 'storage_gb'
            );
            if (storageItem && metrics.storage_gb !== undefined) {
              await stripe.subscriptionItems.createUsageRecord(storageItem.id, {
                quantity: Math.ceil(metrics.storage_gb),
                timestamp,
                action: 'set'
              });
              console.log(`✅ Reported ${metrics.storage_gb}GB storage to Stripe for ${customer_id}`);
              stripeReported = true;
            }
          }
        }
      } catch (stripeError: any) {
        console.error('Failed to report to Stripe (non-fatal):', stripeError.message);
        // Continue - database report still succeeded
      }
    }

    res.status(201).json({
      message: 'Usage reported successfully',
      report,
      stripe_reported: stripeReported,
      overage_devices: overageDevices,
      actual_devices: metrics?.devices,
      note: overageDevices > 0 ? `${overageDevices} devices over plan limit` : undefined
    });
  } catch (error: any) {
    console.error('Error reporting usage:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/usage/:customerId
 * Get usage history for customer
 */
router.get('/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const reports = await UsageReportModel.getByCustomerId(customerId);

    res.json({
      customer_id: customerId,
      reports,
      total: reports.length,
    });
  } catch (error: any) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/usage/:customerId/latest
 * Get latest usage report for customer
 */
router.get('/:customerId/latest', async (req, res) => {
  try {
    const { customerId } = req.params;

    const report = await UsageReportModel.getLatest(customerId);
    if (!report) {
      return res.status(404).json({ error: 'No usage reports found' });
    }

    res.json({
      customer_id: customerId,
      report,
    });
  } catch (error: any) {
    console.error('Error fetching latest usage:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/usage/cleanup
 * Clean up old usage reports (> 90 days)
 */
router.delete('/cleanup', async (req, res) => {
  try {
    await UsageReportModel.cleanup();

    res.json({
      message: 'Old usage reports cleaned up successfully',
    });
  } catch (error: any) {
    console.error('Error cleaning up usage:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
