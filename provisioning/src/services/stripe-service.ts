/**
 * Stripe Service
 * Handles Stripe integration for subscriptions
 */

import Stripe from 'stripe';
import crypto from 'crypto';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import pool from '../db/connection';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

// Stripe Price IDs (configure these in Stripe dashboard)
const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER || 'price_starter',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || 'price_professional',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || 'price_enterprise',
};

export class StripeService {
  /**
   * Create checkout session for subscription
   */
  static async createCheckoutSession(data: {
    customerId: string;
    plan: 'starter' | 'professional' | 'enterprise';
    successUrl: string;
    cancelUrl: string;
  }): Promise<Stripe.Checkout.Session> {
    const customer = await CustomerModel.getById(data.customerId);
    if (!customer) {
      throw new Error('Customer not found');
    }

    // Get or create Stripe customer
    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({
        email: customer.email,
        metadata: {
          customer_id: customer.customer_id,
        },
      });
      stripeCustomerId = stripeCustomer.id;

      // Update customer with Stripe ID
      await CustomerModel.update(customer.customer_id, {
        stripe_customer_id: stripeCustomerId,
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: PRICE_IDS[data.plan],
          quantity: 1,
        },
      ],
      success_url: data.successUrl,
      cancel_url: data.cancelUrl,
      metadata: {
        customer_id: customer.customer_id,
        plan: data.plan,
      },
    });

    return session;
  }

  /**
   * Handle successful checkout
   */
  static async handleCheckoutCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    const customerId = session.metadata?.customer_id;
    const plan = session.metadata?.plan as 'starter' | 'professional' | 'enterprise';

    if (!customerId || !plan) {
      console.error('Missing metadata in checkout session:', session.id);
      return;
    }

    // Get subscription from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(
      session.subscription as string
    );

    // Create or update subscription in database
    const existingSub = await SubscriptionModel.getByCustomerId(customerId);
    
    if (existingSub) {
      await SubscriptionModel.update(customerId, {
        stripe_subscription_id: stripeSubscription.id,
        status: 'active',
        plan,
        trial_ends_at: null, // Clear trial date when upgrading to paid
        current_period_start: new Date(stripeSubscription.current_period_start * 1000),
        current_period_ends_at: new Date(stripeSubscription.current_period_end * 1000),
      });
    } else {
      await SubscriptionModel.createPaid(
        customerId,
        plan,
        stripeSubscription.id,
        new Date(stripeSubscription.current_period_end * 1000),
        new Date(stripeSubscription.current_period_start * 1000)
      );
    }

    console.log(`✅ Subscription created for customer ${customerId}`);
  }

  /**
   * Handle subscription created (IMPORTANT: Supports Stripe Dashboard-created customers!)
   * This method handles subscriptions created via:
   * 1. Checkout flow (customer exists in DB)
   * 2. Stripe Dashboard (customer may NOT exist in DB yet)
   */
  static async handleSubscriptionCreated(
    subscription: Stripe.Subscription
  ): Promise<void> {
    const stripeCustomerId = typeof subscription.customer === 'string' 
      ? subscription.customer 
      : subscription.customer.id;

    console.log(`🔍 Processing subscription created: ${subscription.id}`);
    console.log(`   Stripe Customer: ${stripeCustomerId}`);
    
    // Check if customer already exists in our database
    let customer = await CustomerModel.getByStripeCustomerId(stripeCustomerId);
    
    // If customer doesn't exist, this is a Stripe Dashboard-created customer!
    if (!customer) {
      console.log(`📋 Customer not found in database - fetching from Stripe...`);
      
      // Fetch full customer details from Stripe
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
      
      if (!stripeCustomer.email) {
        console.error(`❌ Cannot create customer without email! Stripe Customer: ${stripeCustomerId}`);
        console.error(`   Please add an email to this customer in Stripe Dashboard.`);
        return;
      }

      console.log(`✨ Creating new customer from Stripe Dashboard data...`);
      console.log(`   Email: ${stripeCustomer.email}`);
      console.log(`   Name: ${stripeCustomer.name || 'N/A'}`);
      
      // Create customer in our database
      customer = await CustomerModel.create({
        email: stripeCustomer.email,
        companyName: stripeCustomer.metadata?.company_name || stripeCustomer.name || undefined,
        fullName: stripeCustomer.name || undefined,
        passwordHash: undefined, // No password for Dashboard-created customers
      });

      // Link to Stripe customer
      await CustomerModel.update(customer.customer_id, {
        stripe_customer_id: stripeCustomerId,
      });

      console.log(`✅ Customer created: ${customer.customer_id}`);
      console.log(`   Company: ${customer.company_name || 'N/A'}`);
    } else {
      console.log(`✅ Customer found: ${customer.customer_id}`);
    }

    // Determine plan from price ID
    const priceId = subscription.items.data[0]?.price.id;
    let plan: 'starter' | 'professional' | 'enterprise' = 'starter';
    
    if (priceId === process.env.STRIPE_PRICE_STARTER) plan = 'starter';
    else if (priceId === process.env.STRIPE_PRICE_PROFESSIONAL) plan = 'professional';
    else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) plan = 'enterprise';
    else {
      console.warn(`⚠️  Unknown price ID: ${priceId} - defaulting to starter plan`);
    }

    console.log(`📦 Plan detected: ${plan}`);

    // Check if subscription already exists (idempotency)
    const existingSubscription = await SubscriptionModel.getByStripeId(subscription.id);
    if (existingSubscription) {
      console.log(`ℹ️  Subscription already exists in database - updating instead`);
      await this.handleSubscriptionUpdated(subscription);
      return;
    }

    // Check if customer has an existing subscription (e.g., canceled one)
    const customerSubscription = await SubscriptionModel.getByCustomerId(customer.customer_id);
    if (customerSubscription) {
      console.log(`ℹ️  Customer has existing subscription (${customerSubscription.status}) - updating to new subscription`);
      await SubscriptionModel.update(customer.customer_id, {
        stripe_subscription_id: subscription.id,
        plan,
        status: 'active',
        current_period_start: new Date(subscription.current_period_start * 1000),
        current_period_ends_at: new Date(subscription.current_period_end * 1000),
        trial_ends_at: null, // Clear trial if any
      });
      console.log(`✅ Subscription updated for customer ${customer.customer_id} (${plan})`);
    } else {
      // Create new subscription
      await SubscriptionModel.createPaid(
        customer.customer_id,
        plan,
        subscription.id,
        new Date(subscription.current_period_end * 1000),
        new Date(subscription.current_period_start * 1000)
      );
      console.log(`✅ Subscription created for customer ${customer.customer_id} (${plan})`);
    }

    // Reactivate customer if they were deactivated (subscription canceled then re-subscribed)
    const isReactivation = !customer.instance_namespace || customer.deployment_status === 'failed';
    if (isReactivation) {
      console.log(`🔄 Reactivating customer ${customer.customer_id} (re-subscription)...`);
      await pool.query(
        `UPDATE customers 
         SET is_active = true, 
             deleted_at = NULL,
             deployment_status = NULL,
             deployment_error = NULL,
             updated_at = NOW()
         WHERE customer_id = $1`,
        [customer.customer_id]
      );
      console.log(`✅ Customer ${customer.customer_id} reactivated`);
    }

    // Trigger K8s deployment (if not already deployed or if re-subscribing)
    if (!customer.instance_namespace && customer.deployment_status !== 'provisioning') {
      console.log(`🚀 Triggering K8s deployment for customer ${customer.customer_id}...`);
      
      try {
        const { deploymentQueue } = await import('./deployment-queue');

        // Hash customer_id to get 12-char client ID
        // CRITICAL: Must match deployment-worker.ts sanitizeClientId() method
        const clientId = crypto
          .createHash('sha256')
          .update(customer.customer_id)
          .digest('hex')
          .substring(0, 12);
        
        const namespace = `client-${clientId}`;
        
        // License will be fetched by gitops-provisioning-service from provisioning API
        await deploymentQueue.add('deploy-customer-stack', {
          customerId: customer.customer_id,
          email: customer.email,
          companyName: customer.company_name || customer.full_name || 'Customer',
          namespace,
          // GitOps-specific fields
          plan,
          domain: process.env.BASE_DOMAIN || 'iotistica.com',
        }, {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        });

        console.log(`✅ Deployment job queued for ${customer.customer_id} (namespace: ${namespace})`);
      } catch (error) {
        console.error(`❌ Failed to queue deployment:`, error);
        // Don't throw - subscription was created successfully, deployment can be retried
      }
    } else {
      console.log(`ℹ️  Customer already has deployment (status: ${customer.deployment_status})`);
    }
  }

  /**
   * Handle subscription updated
   */
  static async handleSubscriptionUpdated(
    subscription: Stripe.Subscription
  ): Promise<void> {
    // Try to find existing subscription
    let dbSubscription = await SubscriptionModel.getByStripeId(subscription.id);
    
    // If not found, this might be a new subscription - try to find by Stripe customer ID
    if (!dbSubscription) {
      const stripeCustomerId = typeof subscription.customer === 'string' 
        ? subscription.customer 
        : subscription.customer.id;
      
      const customer = await CustomerModel.getByStripeCustomerId(stripeCustomerId);
      
      if (!customer) {
        console.warn(`⚠️  Customer not found for Stripe subscription ${subscription.id}`);
        console.warn(`   Stripe customer ID: ${stripeCustomerId}`);
        console.warn(`   ℹ️  This is normal for test webhooks. Real webhooks will have a customer in the database.`);
        return;
      }

      // Determine plan from price ID
      const priceId = subscription.items.data[0]?.price.id;
      let plan: 'starter' | 'professional' | 'enterprise' | 'trial' = 'starter';
      
      if (priceId === process.env.STRIPE_PRICE_STARTER) plan = 'starter';
      else if (priceId === process.env.STRIPE_PRICE_PROFESSIONAL) plan = 'professional';
      else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) plan = 'enterprise';

      // Create new subscription
      await SubscriptionModel.createPaid(
        customer.customer_id,
        plan,
        subscription.id,
        new Date(subscription.current_period_end * 1000),
        new Date(subscription.current_period_start * 1000)
      );

      console.log(`✅ New subscription created for customer ${customer.customer_id} (${plan})`);
      return;
    }

    // Update existing subscription
    const statusMap: Record<string, any> = {
      active: 'active',
      past_due: 'past_due',
      canceled: 'canceled',
      unpaid: 'unpaid',
      trialing: 'trialing',
    };

    const mappedStatus = statusMap[subscription.status] || 'active';
    
    await SubscriptionModel.update(dbSubscription.customer_id, {
      status: mappedStatus,
      current_period_start: new Date(subscription.current_period_start * 1000),
      current_period_ends_at: new Date(subscription.current_period_end * 1000),
      // Clear trial_ends_at when subscription becomes active (paid)
      ...(mappedStatus === 'active' && { trial_ends_at: null }),
    });

    console.log(`✅ Subscription updated for customer ${dbSubscription.customer_id}`);
  }

  /**
   * Handle subscription deleted/canceled
   * Triggers customer deactivation and K8s cleanup
   */
  static async handleSubscriptionDeleted(
    subscription: Stripe.Subscription
  ): Promise<void> {
    const dbSubscription = await SubscriptionModel.getByStripeId(subscription.id);
    if (!dbSubscription) {
      console.warn('Subscription not found in database:', subscription.id);
      return;
    }

    const customerId = dbSubscription.customer_id;

    // Update subscription status to canceled
    await SubscriptionModel.cancel(customerId);
    console.log(`✅ Subscription canceled for customer ${customerId}`);

    // Get customer to check deployment status
    const customer = await CustomerModel.getById(customerId);
    if (!customer) {
      console.warn('Customer not found in database:', customerId);
      return;
    }

    // Queue K8s namespace cleanup job
    // Use dynamic import to avoid circular dependency
    const { deploymentQueue } = await import('./deployment-queue');
    
    // Hash customer_id to get 12-char client ID for namespace
    const clientId = crypto
      .createHash('sha256')
      .update(customerId)
      .digest('hex')
      .substring(0, 12);
    const namespace = `client-${clientId}`;

    // Check if provisioning is in progress
    const provisioningStatuses = [
      'provisioning', 'db_provisioning', 'db_ready',
      'secret_creating', 'secret_ready',
      'deploying', 'git_committed', 'argo_syncing'
    ];
    const isProvisioning = customer.deployment_status ? provisioningStatuses.includes(customer.deployment_status) : false;

    if (isProvisioning) {
      console.log(`⚠️  Provisioning in progress (status: ${customer.deployment_status})`);
      
      // Cancel any pending (waiting/delayed) deployment jobs
      const cancelledCount = await deploymentQueue.cancelPendingDeploymentJobs(customerId);
      if (cancelledCount > 0) {
        console.log(`🚫 Cancelled ${cancelledCount} pending deployment job(s)`);
      }

      // Check if there are active jobs
      const hasActiveJobs = await deploymentQueue.hasActiveDeploymentJobs(customerId);
      if (hasActiveJobs) {
        console.log(`⏳ Active deployment job detected - deletion will wait for completion`);
      }

      // Update customer status to 'cancelled' to signal deployment to abort
      await CustomerModel.updateDeploymentStatus(customerId, 'cancelled');
      console.log(`✅ Customer status updated to 'cancelled'`);

      // Queue deletion with delay to allow active jobs to complete/abort
      // Deletion is idempotent, so it will clean up whatever resources were created
      const delayMs = hasActiveJobs ? 2 * 60 * 1000 : 10 * 1000; // 2 min if active, 10s otherwise
      await deploymentQueue.add('delete-customer-stack', {
        customerId,
        namespace,
        reason: 'subscription_cancelled_during_provisioning',
      }, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        delay: delayMs, // Delay to allow provisioning to complete/abort
      });

      console.log(`🗑️  Delayed deletion job queued (${delayMs/1000}s delay) - will clean up after provisioning completes`);
    } else {
      // Customer is ready, failed, or already deleted - proceed with immediate deletion
      console.log(`✅ Customer status: ${customer.deployment_status} - proceeding with immediate deletion`);
      
      await deploymentQueue.add('delete-customer-stack', {
        customerId,
        namespace,
        reason: 'subscription_deleted',
      }, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      });

      console.log(`🗑️  K8s cleanup job queued for customer ${customerId} (namespace: ${namespace})`);
    }

    // Update customer database record
    await pool.query(
      `UPDATE customers 
       SET is_active = false, 
           deleted_at = NOW(),
           updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId]
    );
    console.log(`✅ Customer ${customerId} deactivated`);
  }

  /**
   * Handle successful payment
   */
  static async handlePaymentSucceeded(
    invoice: Stripe.Invoice
  ): Promise<void> {
    if (!invoice.subscription) {
      console.log('Invoice is not for a subscription, skipping');
      return;
    }

    const dbSubscription = await SubscriptionModel.getByStripeId(
      invoice.subscription as string
    );
    
    if (!dbSubscription) {
      console.warn('Subscription not found in database:', invoice.subscription);
      return;
    }

    // Update subscription to active status
    await SubscriptionModel.update(dbSubscription.customer_id, {
      status: 'active',
      current_period_ends_at: new Date(invoice.period_end * 1000),
    });

    console.log(`✅ Payment succeeded for customer ${dbSubscription.customer_id}`);
  }

  /**
   * Handle failed payment
   */
  static async handlePaymentFailed(
    invoice: Stripe.Invoice
  ): Promise<void> {
    if (!invoice.subscription) {
      console.log('Invoice is not for a subscription, skipping');
      return;
    }

    const dbSubscription = await SubscriptionModel.getByStripeId(
      invoice.subscription as string
    );
    
    if (!dbSubscription) {
      console.warn('Subscription not found in database:', invoice.subscription);
      return;
    }

    // Update subscription to past_due status
    await SubscriptionModel.update(dbSubscription.customer_id, {
      status: 'past_due',
    });

    console.log(`❌ Payment failed for customer ${dbSubscription.customer_id}`);
  }

  /**
   * Cancel subscription
   */
  static async cancelSubscription(customerId: string): Promise<void> {
    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription || !subscription.stripe_subscription_id) {
      throw new Error('No active subscription found');
    }

    await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
    await SubscriptionModel.cancel(customerId);
  }

  /**
   * Cancel subscription at period end (graceful cancellation)
   */
  static async cancelAtPeriodEnd(customerId: string): Promise<void> {
    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription || !subscription.stripe_subscription_id) {
      throw new Error('No active subscription found');
    }

    // Update subscription to cancel at period end
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    // Update database status
    await pool.query(
      `UPDATE subscriptions 
       SET cancel_at_period_end = true,
           updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId]
    );
  }

  /**
   * Keep subscription (undo cancel at period end)
   */
  static async keepSubscription(customerId: string): Promise<void> {
    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription || !subscription.stripe_subscription_id) {
      throw new Error('No active subscription found');
    }

    // Remove cancel at period end flag
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    // Update database status
    await pool.query(
      `UPDATE subscriptions 
       SET cancel_at_period_end = false,
           updated_at = NOW()
       WHERE customer_id = $1`,
      [customerId]
    );
  }

  /**
   * Upgrade subscription plan
   */
  static async upgradeSubscription(
    customerId: string,
    newPlan: 'starter' | 'professional' | 'enterprise'
  ): Promise<void> {
    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    if (!subscription || !subscription.stripe_subscription_id) {
      throw new Error('No active subscription found');
    }

    // Get current subscription from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    );

    // Update subscription with new price
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      items: [
        {
          id: stripeSubscription.items.data[0].id,
          price: PRICE_IDS[newPlan],
        },
      ],
      proration_behavior: 'always_invoice', // Immediate upgrade
    });

    // Update database
    await SubscriptionModel.update(customerId, {
      plan: newPlan,
    });

    console.log(`✅ Subscription upgraded for customer ${customerId} to ${newPlan}`);
  }

  /**
   * Construct webhook event
   */
  static constructWebhookEvent(
    payload: string | Buffer,
    signature: string
  ): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }
}
