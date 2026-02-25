#!/usr/bin/env tsx
/**
 * Customer Management Script
 * 
 * Usage:
 *   npm run customer -- add --email customer@example.com --name "Customer Name" --company "Company Inc"
 *   npm run customer -- upgrade --id cust_xxx --plan professional
 *   npm run customer -- deactivate --id cust_xxx
 *   npm run customer -- list
 */

import { program } from 'commander';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const BILLING_API_URL = process.env.BILLING_API_URL || 'http://localhost:3100';

interface CustomerResponse {
  id: string;
  email: string;
  name: string;
  company?: string;
  stripe_customer_id?: string;
  license_jwt?: string;
  created_at: string;
}

interface SubscriptionResponse {
  id: string;
  customer_id: string;
  plan: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
}

// Add new customer
async function addCustomer(email: string, name: string, company?: string) {
  console.log('🆕 Creating new customer...\n');
  
  try {
    const response = await axios.post<CustomerResponse>(
      `${BILLING_API_URL}/api/customers`,
      { email, name, company }
    );
    
    const customer = response.data;
    
    console.log('✅ Customer created successfully!\n');
    console.log('Customer Details:');
    console.log('─────────────────────────────────────────');
    console.log(`ID:               ${customer.id}`);
    console.log(`Email:            ${customer.email}`);
    console.log(`Name:             ${customer.name}`);
    if (customer.company) console.log(`Company:          ${customer.company}`);
    if (customer.stripe_customer_id) console.log(`Stripe ID:        ${customer.stripe_customer_id}`);
    console.log(`Created:          ${new Date(customer.created_at).toLocaleString()}`);
    console.log('─────────────────────────────────────────\n');
    
    if (customer.license_jwt) {
      console.log('📜 Initial License JWT (Trial):');
      console.log(customer.license_jwt);
      console.log('\n💡 Add this to customer instance .env file:');
      console.log(`LICENSE_JWT=${customer.license_jwt}`);
      console.log(`CUSTOMER_ID=${customer.id}\n`);
    }
    
  } catch (error: any) {
    console.error('❌ Failed to create customer:', error.response?.data?.error || error.message);
    process.exit(1);
  }
}

// Upgrade customer subscription
async function upgradeCustomer(customerId: string, plan: string) {
  console.log(`🚀 Upgrading customer ${customerId} to ${plan} plan...\n`);
  
  try {
    const response = await axios.post(
      `${BILLING_API_URL}/api/subscriptions/checkout`,
      {
        customer_id: customerId,
        plan,
        success_url: 'http://localhost:3100/success',
        cancel_url: 'http://localhost:3100/cancel'
      }
    );
    
    const { checkout_url, session_id } = response.data;
    
    console.log('✅ Checkout session created!\n');
    console.log('Checkout Details:');
    console.log('─────────────────────────────────────────');
    console.log(`Session ID:       ${session_id}`);
    console.log(`Plan:             ${plan}`);
    console.log('─────────────────────────────────────────\n');
    console.log('🔗 Checkout URL:');
    console.log(checkout_url);
    console.log('\n💡 Send this URL to the customer to complete payment.');
    console.log('   After payment, webhook will auto-provision subscription.\n');
    
  } catch (error: any) {
    console.error('❌ Failed to create checkout session:', error.response?.data?.error || error.message);
    process.exit(1);
  }
}

// Deactivate customer
async function deactivateCustomer(customerId: string) {
  console.log(`⏸️  Deactivating customer ${customerId}...\n`);
  
  try {
    // First, get customer's subscription
    const subResponse = await axios.get(`${BILLING_API_URL}/api/subscriptions/customer/${customerId}`);
    const subscription: SubscriptionResponse = subResponse.data;
    
    if (!subscription) {
      console.log('⚠️  Customer has no active subscription');
      return;
    }
    
    // Cancel subscription
    await axios.delete(`${BILLING_API_URL}/api/subscriptions/${subscription.id}`);
    
    console.log('✅ Customer deactivated successfully!\n');
    console.log('Deactivation Details:');
    console.log('─────────────────────────────────────────');
    console.log(`Customer ID:      ${customerId}`);
    console.log(`Subscription ID:  ${subscription.id}`);
    console.log(`Previous Plan:    ${subscription.plan}`);
    console.log(`Cancelled At:     ${new Date().toLocaleString()}`);
    console.log('─────────────────────────────────────────\n');
    console.log('💡 Customer will revert to trial mode.');
    console.log('   They can reactivate by subscribing again.\n');
    
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.error('❌ Customer or subscription not found');
    } else {
      console.error('❌ Failed to deactivate customer:', error.response?.data?.error || error.message);
    }
    process.exit(1);
  }
}

// List all customers
async function listCustomers() {
  console.log('📋 Fetching customers...\n');
  
  try {
    const response = await axios.get<CustomerResponse[]>(`${BILLING_API_URL}/api/customers`);
    const customers = response.data;
    
    if (customers.length === 0) {
      console.log('No customers found.\n');
      return;
    }
    
    console.log(`Found ${customers.length} customer(s):\n`);
    console.log('─────────────────────────────────────────────────────────────────────────────');
    console.log('ID                    | Email                        | Name                  | Company');
    console.log('─────────────────────────────────────────────────────────────────────────────');
    
    for (const customer of customers) {
      const id = customer.id.padEnd(21);
      const email = customer.email.padEnd(28);
      const name = (customer.name || '').padEnd(21);
      const company = customer.company || '-';
      console.log(`${id} | ${email} | ${name} | ${company}`);
    }
    
    console.log('─────────────────────────────────────────────────────────────────────────────\n');
    
  } catch (error: any) {
    console.error('❌ Failed to fetch customers:', error.response?.data?.error || error.message);
    process.exit(1);
  }
}

// CLI Setup
program
  .name('customer-manager')
  .description('Manage billing customers')
  .version('1.0.0');

program
  .command('add')
  .description('Add a new customer')
  .requiredOption('--email <email>', 'Customer email address')
  .requiredOption('--name <name>', 'Customer name')
  .option('--company <company>', 'Company name')
  .action(async (options) => {
    await addCustomer(options.email, options.name, options.company);
  });

program
  .command('upgrade')
  .description('Upgrade customer to paid plan')
  .requiredOption('--id <customerId>', 'Customer ID')
  .requiredOption('--plan <plan>', 'Plan name (starter, professional, enterprise)')
  .action(async (options) => {
    await upgradeCustomer(options.id, options.plan);
  });

program
  .command('deactivate')
  .description('Deactivate customer subscription')
  .requiredOption('--id <customerId>', 'Customer ID')
  .action(async (options) => {
    await deactivateCustomer(options.id);
  });

program
  .command('list')
  .description('List all customers')
  .action(async () => {
    await listCustomers();
  });

// Parse CLI arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
