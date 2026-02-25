#!/usr/bin/env tsx
/**
 * Usage Report Viewer Script
 * 
 * Usage:
 *   npm run usage -- --customer cust_xxx
 *   npm run usage -- --customer cust_xxx --days 30
 *   npm run usage -- --all
 */

import { program } from 'commander';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const BILLING_API_URL = process.env.BILLING_API_URL || 'http://localhost:3100';

interface UsageReport {
  id: string;
  customer_id: string;
  instance_id: string;
  active_devices: number;
  total_devices: number;
  reported_at: string;
}

interface CustomerInfo {
  id: string;
  email: string;
  name: string;
  company?: string;
}

interface SubscriptionInfo {
  id: string;
  plan: string;
  status: string;
  device_limit: number;
  current_period_end: string;
}

// View usage reports for a specific customer
async function viewCustomerUsage(customerId: string, days: number = 7) {
  console.log(`📊 Fetching usage reports for customer ${customerId}...\n`);
  
  try {
    // Fetch customer info
    const customerResponse = await axios.get<CustomerInfo>(`${BILLING_API_URL}/api/customers/${customerId}`);
    const customer = customerResponse.data;
    
    // Fetch subscription info
    let subscription: SubscriptionInfo | null = null;
    try {
      const subResponse = await axios.get<SubscriptionInfo>(`${BILLING_API_URL}/api/subscriptions/customer/${customerId}`);
      subscription = subResponse.data;
    } catch (error: any) {
      if (error.response?.status !== 404) throw error;
    }
    
    // Fetch usage reports
    const usageResponse = await axios.get<UsageReport[]>(
      `${BILLING_API_URL}/api/usage/customer/${customerId}?days=${days}`
    );
    const reports = usageResponse.data;
    
    // Display customer info
    console.log('Customer Information:');
    console.log('═════════════════════════════════════════════════════════════════════════════');
    console.log(`ID:               ${customer.id}`);
    console.log(`Email:            ${customer.email}`);
    console.log(`Name:             ${customer.name}`);
    if (customer.company) console.log(`Company:          ${customer.company}`);
    console.log('═════════════════════════════════════════════════════════════════════════════\n');
    
    // Display subscription info
    if (subscription) {
      console.log('Subscription Information:');
      console.log('─────────────────────────────────────────────────────────────────────────────');
      console.log(`Plan:             ${subscription.plan.toUpperCase()}`);
      console.log(`Status:           ${subscription.status.toUpperCase()}`);
      console.log(`Device Limit:     ${subscription.device_limit}`);
      console.log(`Renewal Date:     ${new Date(subscription.current_period_end).toLocaleString()}`);
      console.log('─────────────────────────────────────────────────────────────────────────────\n');
    } else {
      console.log('⚠️  No active subscription (Trial mode)\n');
    }
    
    // Display usage reports
    if (reports.length === 0) {
      console.log(`No usage reports found for the last ${days} days.\n`);
      return;
    }
    
    console.log(`Usage Reports (Last ${days} Days):`);
    console.log('─────────────────────────────────────────────────────────────────────────────');
    console.log('Date                 | Instance ID    | Active | Total | Utilization');
    console.log('─────────────────────────────────────────────────────────────────────────────');
    
    for (const report of reports) {
      const date = new Date(report.reported_at).toLocaleString().padEnd(20);
      const instanceId = report.instance_id.padEnd(14);
      const active = report.active_devices.toString().padStart(6);
      const total = report.total_devices.toString().padStart(5);
      const utilization = subscription 
        ? `${((report.active_devices / subscription.device_limit) * 100).toFixed(1)}%`.padStart(11)
        : 'N/A'.padStart(11);
      
      console.log(`${date} | ${instanceId} | ${active} | ${total} | ${utilization}`);
    }
    console.log('─────────────────────────────────────────────────────────────────────────────\n');
    
    // Summary statistics
    if (reports.length > 0) {
      const avgActive = reports.reduce((sum, r) => sum + r.active_devices, 0) / reports.length;
      const maxActive = Math.max(...reports.map(r => r.active_devices));
      const latestReport = reports[0];
      
      console.log('Summary Statistics:');
      console.log('─────────────────────────────────────────────────────────────────────────────');
      console.log(`Total Reports:    ${reports.length}`);
      console.log(`Avg Active:       ${avgActive.toFixed(1)} devices`);
      console.log(`Peak Active:      ${maxActive} devices`);
      console.log(`Current Active:   ${latestReport.active_devices} devices`);
      console.log(`Current Total:    ${latestReport.total_devices} devices`);
      if (subscription) {
        console.log(`Limit:            ${subscription.device_limit} devices`);
        console.log(`Remaining:        ${subscription.device_limit - latestReport.active_devices} devices`);
        
        // Warning if approaching limit
        const utilizationPct = (latestReport.active_devices / subscription.device_limit) * 100;
        if (utilizationPct >= 80) {
          console.log(`\n⚠️  WARNING: ${utilizationPct.toFixed(1)}% of device limit used!`);
          if (utilizationPct >= 100) {
            console.log('    Customer has exceeded their device limit.');
          } else {
            console.log('    Consider upgrading to a higher plan.');
          }
        }
      }
      console.log('─────────────────────────────────────────────────────────────────────────────\n');
    }
    
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.error('❌ Customer not found');
    } else {
      console.error('❌ Failed to fetch usage reports:', error.response?.data?.error || error.message);
    }
    process.exit(1);
  }
}

// View usage reports for all customers
async function viewAllUsage(days: number = 7) {
  console.log(`📊 Fetching usage reports for all customers...\n`);
  
  try {
    // Fetch all customers
    const customersResponse = await axios.get<CustomerInfo[]>(`${BILLING_API_URL}/api/customers`);
    const customers = customersResponse.data;
    
    if (customers.length === 0) {
      console.log('No customers found.\n');
      return;
    }
    
    console.log(`Found ${customers.length} customer(s)\n`);
    console.log('═════════════════════════════════════════════════════════════════════════════');
    
    // Fetch usage for each customer
    for (const customer of customers) {
      try {
        const usageResponse = await axios.get<UsageReport[]>(
          `${BILLING_API_URL}/api/usage/customer/${customer.id}?days=${days}`
        );
        const reports = usageResponse.data;
        
        // Get subscription info
        let subscription: SubscriptionInfo | null = null;
        try {
          const subResponse = await axios.get<SubscriptionInfo>(`${BILLING_API_URL}/api/subscriptions/customer/${customer.id}`);
          subscription = subResponse.data;
        } catch (error: any) {
          if (error.response?.status !== 404) throw error;
        }
        
        const latestReport = reports[0];
        const plan = subscription?.plan.toUpperCase() || 'TRIAL';
        const deviceLimit = subscription?.device_limit || 5;
        const active = latestReport?.active_devices || 0;
        const total = latestReport?.total_devices || 0;
        const utilization = latestReport ? `${((active / deviceLimit) * 100).toFixed(1)}%` : 'N/A';
        
        console.log(`\n${customer.name} (${customer.email})`);
        console.log(`  Customer ID:  ${customer.id}`);
        console.log(`  Plan:         ${plan}`);
        console.log(`  Device Limit: ${deviceLimit}`);
        console.log(`  Active:       ${active} devices`);
        console.log(`  Total:        ${total} devices`);
        console.log(`  Utilization:  ${utilization}`);
        console.log(`  Reports:      ${reports.length} in last ${days} days`);
        
        if (latestReport && subscription) {
          const utilizationPct = (active / deviceLimit) * 100;
          if (utilizationPct >= 80) {
            console.log(`  ⚠️  WARNING: ${utilizationPct.toFixed(1)}% of limit used!`);
          }
        }
        
      } catch (error: any) {
        console.log(`\n${customer.name} (${customer.email})`);
        console.log(`  ❌ Failed to fetch usage: ${error.message}`);
      }
    }
    
    console.log('\n═════════════════════════════════════════════════════════════════════════════\n');
    
  } catch (error: any) {
    console.error('❌ Failed to fetch customers:', error.response?.data?.error || error.message);
    process.exit(1);
  }
}

// CLI Setup
program
  .name('usage-viewer')
  .description('View customer usage reports')
  .version('1.0.0');

program
  .option('--customer <customerId>', 'View usage for specific customer')
  .option('--all', 'View usage for all customers')
  .option('--days <days>', 'Number of days to show (default: 7)', '7')
  .action(async (options) => {
    const days = parseInt(options.days, 10);
    
    if (options.all) {
      await viewAllUsage(days);
    } else if (options.customer) {
      await viewCustomerUsage(options.customer, days);
    } else {
      console.error('❌ Please specify --customer <id> or --all\n');
      program.outputHelp();
      process.exit(1);
    }
  });

// Parse CLI arguments
program.parse(process.argv);

// Show help if no arguments provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
