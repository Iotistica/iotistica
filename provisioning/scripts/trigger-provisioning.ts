/**
 * Manual script to trigger provisioning for existing customers
 * 
 * Usage:
 *   npx ts-node scripts/trigger-provisioning.ts <customer_id>
 * 
 * Example:
 *   npx ts-node scripts/trigger-provisioning.ts cust_b345b02c911c4fbcb47a48727492af1b
 */

import { deploymentQueue } from '../src/queues/deployment-queue';
import { db } from '../src/database/db';

async function triggerProvisioning(customerId: string) {
  try {
    console.log(`\n🔍 Looking up customer: ${customerId}...`);
    
    // Get customer details
    const customer = await db('customers')
      .where({ customer_id: customerId })
      .first();
    
    if (!customer) {
      console.error(`❌ Customer not found: ${customerId}`);
      process.exit(1);
    }
    
    console.log(`✅ Found customer: ${customer.email}`);
    console.log(`   Stripe ID: ${customer.stripe_customer_id}`);
    console.log(`   DB Service: ${customer.db_service_id || '(not provisioned)'}`);
    console.log(`   Secret Item: ${customer.secret_item_id || '(not created)'}`);
    
    // Get subscription details
    const subscription = await db('subscriptions')
      .where({ customer_id: customerId })
      .first();
    
    if (!subscription) {
      console.error(`❌ No subscription found for customer: ${customerId}`);
      process.exit(1);
    }
    
    console.log(`\n📦 Subscription found:`);
    console.log(`   Plan: ${subscription.plan}`);
    console.log(`   Status: ${subscription.status}`);
    console.log(`   Stripe Sub ID: ${subscription.stripe_subscription_id}`);
    
    // Check if already provisioned
    if (customer.db_service_id && customer.secret_item_id) {
      console.warn(`\n⚠️  Customer already provisioned!`);
      console.log(`   DB Service: ${customer.db_service_id}`);
      console.log(`   Secret: ${customer.secret_item_id}`);
      console.log(`\nDo you want to re-provision? This will create NEW resources.`);
      process.exit(0);
    }
    
    // Generate license key
    const licenseGenerator = require('../src/services/license-generator').licenseGenerator;
    const licenseKey = licenseGenerator.generateLicense({
      customerId: customer.customer_id,
      plan: subscription.plan,
      email: customer.email,
      companyName: customer.company_name || customer.full_name || 'Customer',
    });
    
    console.log(`\n🔑 Generated license key (first 50 chars): ${licenseKey.substring(0, 50)}...`);
    
    // Sanitize client ID (for GitOps)
    const clientId = customer.customer_id.replace(/^cust_/, '').substring(0, 8);
    const namespace = process.env.GITOPS_ENABLED === 'true' 
      ? `client-${clientId}` 
      : `customer-${customer.customer_id.substring(5, 13)}`;
    
    console.log(`\n📂 Namespace: ${namespace}`);
    console.log(`\n🚀 Triggering provisioning...`);
    
    // Add to deployment queue
    const job = await deploymentQueue.add('deploy-customer-stack', {
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || customer.full_name || 'Customer',
      licenseKey,
      namespace,
      // GitOps-specific fields
      plan: subscription.plan,
      licensePublicKey: process.env.LICENSE_PUBLIC_KEY || '',
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
