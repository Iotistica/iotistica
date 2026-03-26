/**
 * Billing Client
 * Communicates with Global Billing API for license and subscription management
 */

import axios, { AxiosInstance } from 'axios';
import { LicenseValidator } from './auth/license-validator';

export interface CheckoutSessionResponse {
  session_id: string;
  checkout_url: string;
}

export interface LicenseResponse {
  license: string;
  customer_id: string;
  plan: string;
  status: string;
}

export class BillingClient {
  private static instance: BillingClient;
  private client: AxiosInstance;
  private billingApiUrl: string;
  private customerId: string;

  private constructor() {
    this.billingApiUrl = process.env.BILLING_API_URL || '';
    this.customerId = process.env.CUSTOMER_ID || '';

    if (!this.billingApiUrl) {
      console.warn('⚠️  BILLING_API_URL not configured');
    }

    this.client = axios.create({
      baseURL: this.billingApiUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  static getInstance(): BillingClient {
    if (!BillingClient.instance) {
      BillingClient.instance = new BillingClient();
    }
    return BillingClient.instance;
  }

  /**
   * Check if billing API is configured
   */
  isConfigured(): boolean {
    return !!(this.billingApiUrl && this.customerId);
  }

  /**
   * Create Stripe checkout session for plan upgrade
   */
  async createCheckoutSession(
    plan: 'starter' | 'professional' | 'enterprise',
    successUrl: string,
    cancelUrl: string
  ): Promise<CheckoutSessionResponse> {
    if (!this.isConfigured()) {
      throw new Error('Billing API not configured. Set BILLING_API_URL and CUSTOMER_ID');
    }

    const response = await this.client.post<CheckoutSessionResponse>(
      '/api/subscriptions/checkout',
      {
        customer_id: this.customerId,
        plan,
        success_url: successUrl,
        cancel_url: cancelUrl,
      }
    );

    return response.data;
  }

  /**
   * Get fresh license from billing API
   */
  async refreshLicense(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Billing API not configured. Set BILLING_API_URL and CUSTOMER_ID');
    }

    const response = await this.client.get<LicenseResponse>(
      `/api/licenses/${this.customerId}`
    );

    // Update license in validator
    const validator = LicenseValidator.getInstance();
    await validator.validateLicense(response.data.license);

    console.log(`✅ License refreshed: ${response.data.plan} (${response.data.status})`);

    return response.data.license;
  }

  /**
   * Report usage to billing API
   */
  async reportUsage(activeDevices: number, totalDevices: number): Promise<void> {
    if (!this.isConfigured()) {
      console.warn('⚠️  Billing API not configured, skipping usage report');
      return;
    }

    await this.client.post('/api/usage/report', {
      customer_id: this.customerId,
      instance_id: process.env.INSTANCE_ID || 'default',
      active_agents: activeDevices,
      total_agents: totalDevices,
    });

    console.log(`✅ Usage reported: ${activeDevices}/${totalDevices} agents`);
  }

  /**
   * Get current subscription details
   */
  async getSubscription(): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('Billing API not configured. Set BILLING_API_URL and CUSTOMER_ID');
    }

    const response = await this.client.get(`/api/subscriptions/${this.customerId}`);
    return response.data.subscription;
  }
}
