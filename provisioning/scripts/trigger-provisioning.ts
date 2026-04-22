/**
 * Manual script to trigger provisioning for existing customers
 * 
 * Usage:
 *   npx ts-node scripts/trigger-provisioning.ts <customer_id>
 * 
 * Example:
 *   npx ts-node scripts/trigger-provisioning.ts cust_b345b02c911c4fbcb47a48727492af1b
 */

import crypto from 'crypto';
import { deploymentQueue } from '../src/services/deployment-queue';
import { CustomerModel } from '../src/db/customer-model';
import { SubscriptionModel } from '../src/db/subscription-model';

async function triggerProvisioning(customerId: string) {
  try {
    console.log(`\n🔍 Looking up customer: ${customerId}...`);
    
    // Get customer details
    const customer = await CustomerModel.getById(customerId);
    
    if (!customer) {
      console.error(`❌ Customer not found: ${customerId}`);
      process.exit(1);
    }
    
    console.log(`✅ Found customer: ${customer.email}`);
    console.log(`   Stripe ID: ${customer.stripe_customer_id}`);
    console.log(`   Deployment status: ${customer.deployment_status || '(not provisioned)'}`);
    console.log(`   Namespace: ${customer.instance_namespace || '(none)'}`);
    
    // Get subscription details
    const subscription = await SubscriptionModel.getByCustomerId(customerId);
    
    if (!subscription) {
      console.error(`❌ No subscription found for customer: ${customerId}`);
      process.exit(1);
    }
    
    console.log(`\n📦 Subscription found:`);
    console.log(`   Plan: ${subscription.plan}`);
    console.log(`   Status: ${subscription.status}`);
    console.log(`   Stripe Sub ID: ${subscription.stripe_subscription_id}`);
    
    // Check if already provisioned
    if (customer.deployment_status === 'ready') {
      console.warn(`\n⚠️  Customer already provisioned!`);
      console.log(`   Namespace: ${customer.instance_namespace}`);
      console.log(`   Instance URL: ${customer.instance_url}`);
      console.log(`\nRe-running will re-queue a deployment job. Ctrl+C to cancel.`);
    }
    
    // Derive namespace: SHA256 hash of customer_id → 12-char hex → client-{id}
    const clientId = crypto
      .createHash('sha256')
      .update(customer.customer_id)
      .digest('hex')
      .substring(0, 12);
    const namespace = `client-${clientId}`;
    
    console.log(`\n📂 Namespace: ${namespace}`);
    console.log(`\n🚀 Triggering provisioning...`);
    
    // Add to deployment queue using the typed helper
    // Note: the worker fetches the license from the API itself; do not pass licenseKey here
    const job = await deploymentQueue.addDeploymentJob({
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || customer.full_name || 'Customer',
      namespace,
      plan: subscription.plan,
      domain: process.env.BASE_DOMAIN || 'iotistic.com',
    }, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    });
    
    console.log(`✅ Job queued! Job ID: ${job.id}`);
    console.log(`\n📊 Monitor progress:`);
    console.log(`   docker logs -f provisioning-worker`);
    console.log(`   http://localhost:3100/admin/queues`);
    console.log(`\n✅ Done!`);
    
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Error:`, error);
    process.exit(1);
  }
}

// Get customer ID from command line
const customerId = process.argv[2];

if (!customerId) {
  console.error(`\n❌ Usage: npx ts-node scripts/trigger-provisioning.ts <customer_id>`);
  console.error(`\nExample: npx ts-node scripts/trigger-provisioning.ts cust_b345b02c911c4fbcb47a48727492af1b`);
  process.exit(1);
}

triggerProvisioning(customerId);
