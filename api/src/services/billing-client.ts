/**
 * Billing Client
 * Communicates with Global Billing API for license and subscription management
 */

import { fetch } from 'undici';
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
  private billingApiUrl: string;
  private customerId: string;

  private constructor() {
    this.billingApiUrl = process.env.BILLING_API_URL || '';
    this.customerId = process.env.CUSTOMER_ID || '';

    if (!this.billingApiUrl) {
      console.warn('⚠️  BILLING_API_URL not configured');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T }> {
    const response = await fetch(this.billingApiUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Billing API error: HTTP ${response.status}`);
    return { data: await response.json() as T };
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

    const response = await this.request<CheckoutSessionResponse>(
      'POST',
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

    const response = await this.request<LicenseResponse>(
      'GET',
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

    await this.request('POST', '/api/usage/report', {
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

    const response = await this.request<any>('GET', `/api/subscriptions/${this.customerId}`);
    return response.data.subscription;
  }
}
