/**
 * Webhook Routes
 * Handle Stripe webhooks
 */

import { Router } from 'express';
import { StripeService } from '../services/stripe-service';

const router = Router();

/**
 * POST /api/webhooks/stripe
 * Handle Stripe webhook events
 */
router.post('/stripe', async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    // Construct event from webhook (verifies signature)
    const event = StripeService.constructWebhookEvent(
      req.body, // Raw body (see index.ts for express.raw() middleware)
      signature
    );

    console.log(`📥 Webhook received: ${event.type}`);

    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed':
        await StripeService.handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
        console.log('✅ Subscription created');
        // This handles BOTH: checkout-based AND Stripe Dashboard-created subscriptions
        await StripeService.handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        console.log('✅ Subscription updated');
        await StripeService.handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        console.log('✅ Subscription deleted');
        await StripeService.handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        console.log('✅ Invoice payment succeeded');
        await StripeService.handlePaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        console.log('❌ Invoice payment failed');
        await StripeService.handlePaymentFailed(event.data.object);
        break;

      // Optional: Log but don't process these events
      case 'customer.created':
      case 'customer.updated':
      case 'payment_method.attached':
      case 'payment_intent.created':
      case 'payment_intent.succeeded':
      case 'charge.succeeded':
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.paid':
      case 'product.created':
      case 'plan.created':
      case 'price.created':
        console.log(`ℹ️  Event logged but not processed: ${event.type}`);
        break;

      default:
        console.log(`⚠️  Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('❌ Webhook error:', error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
