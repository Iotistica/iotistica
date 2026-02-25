/**
 * License Generator
 * Generates JWT-based licenses for customer instances
 */

import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { Subscription } from '../db/subscription-model';
import { Customer } from '../db/customer-model';

export interface LicenseData {
  customerId: string;
  customerName: string;
  plan: 'trial' | 'starter' | 'professional' | 'enterprise';
  features: {
    // Core device management
    maxDevices: number;
    
    // Job execution capabilities
    canExecuteJobs: boolean;
    canScheduleJobs: boolean;
    
    // Remote access & control
    canRemoteAccess: boolean;
    canOtaUpdates: boolean;
    
    // Data management
    canExportData: boolean;
    
    // Advanced features
    hasAdvancedAlerts: boolean;
    hasCustomDashboards: boolean;
    
    // Monitoring & observability
    hasDedicatedPrometheus: boolean;
    hasDedicatedGrafana: boolean;
    prometheusRetentionDays: number;
    prometheusStorageGb: number;
  };
  limits: {
    maxJobTemplates?: number;
    maxAlertRules?: number;
    maxUsers?: number;
  };
  trial: {
    isTrialMode: boolean;
    expiresAt?: string;
  };
  subscription: {
    status: 'active' | 'past_due' | 'canceled' | 'trialing';
    currentPeriodEndsAt: string;
  };
  issuedAt: number;
  expiresAt: number;
}

// Plan configurations
const PLAN_CONFIG = {
  starter: {
    // Core device management
    maxDevices: 5,
    
    // Job execution
    canExecuteJobs: true,
    canScheduleJobs: false,
    
    // Remote access & control
    canRemoteAccess: true,
    canOtaUpdates: false,
    
    // Data management
    canExportData: true,
    
    // Advanced features
    hasAdvancedAlerts: false,
    hasCustomDashboards: false,
    
    // Monitoring & observability (shared Prometheus)
    hasDedicatedPrometheus: false,
    hasDedicatedGrafana: false,
    prometheusRetentionDays: 7,  // Shared cluster default
    prometheusStorageGb: 0,  // Shared storage
    
    // Limits
    maxJobTemplates: 10,
    maxAlertRules: 25,
    maxUsers: 2,
  },
  professional: {
    // Core device management
    maxDevices: 50,
    
    // Job execution
    canExecuteJobs: true,
    canScheduleJobs: true,
    
    // Remote access & control
    canRemoteAccess: true,
    canOtaUpdates: true,
    
    // Data management
    canExportData: true,
    
    // Advanced features
    hasAdvancedAlerts: true,
    hasCustomDashboards: true,
    
    // Monitoring & observability (shared Prometheus with better retention)
    hasDedicatedPrometheus: false,
    hasDedicatedGrafana: false,
    prometheusRetentionDays: 15,  // Shared cluster with longer retention
    prometheusStorageGb: 0,  // Shared storage
    
    // Limits
    maxJobTemplates: 100,
    maxAlertRules: 100,
    maxUsers: 10,
  },
  enterprise: {
    // Core device management
    maxDevices: 999999, // Unlimited
    
    // Job execution
    canExecuteJobs: true,
    canScheduleJobs: true,
    
    // Remote access & control
    canRemoteAccess: true,
    canOtaUpdates: true,
    
    // Data management
    canExportData: true,
    
    // Advanced features
    hasAdvancedAlerts: true,
    hasCustomDashboards: true,
    
    // Monitoring & observability (dedicated Prometheus + Grafana)
    hasDedicatedPrometheus: true,
    hasDedicatedGrafana: true,
    prometheusRetentionDays: 30,  // Dedicated instance with 30-day retention
    prometheusStorageGb: 50,  // 50GB dedicated storage
    
    // Limits
    maxProvisioningKeys: undefined, // Unlimited
    maxJobTemplates: undefined, // Unlimited
    maxAlertRules: undefined, // Unlimited
    maxUsers: undefined, // Unlimited
  },
};

export class LicenseGenerator {
  private static privateKey: string | null = null;
  private static publicKey: string | null = null;

  /**
   * Load RSA keys
   */
  static init() {
    try {
      const privateKeyPath = process.env.LICENSE_PRIVATE_KEY_PATH || './keys/private-key.pem';
      const publicKeyPath = process.env.LICENSE_PUBLIC_KEY_PATH || './keys/public-key.pem';

      this.privateKey = fs.readFileSync(path.resolve(privateKeyPath), 'utf8');
      this.publicKey = fs.readFileSync(path.resolve(publicKeyPath), 'utf8');

      console.log('✅ License keys loaded successfully');
    } catch (error) {
      console.error('❌ Failed to load license keys:', error);
      throw new Error('License keys not found. Run: npm run generate-keys');
    }
  }

  /**
   * Generate license JWT for customer
   */
  static async generateLicense(
    customer: Customer,
    subscription: Subscription
  ): Promise<string> {
    if (!this.privateKey) {
      throw new Error('License generator not initialized. Call init() first.');
    }

    const planConfig = PLAN_CONFIG[subscription.plan] || PLAN_CONFIG.starter;

    const licenseData: LicenseData = {
      customerId: customer.customer_id,
      customerName: customer.company_name || customer.email,
      plan: subscription.plan as any,
      features: {
        maxDevices: planConfig.maxDevices,
        canExecuteJobs: planConfig.canExecuteJobs,
        canScheduleJobs: planConfig.canScheduleJobs,
        canRemoteAccess: planConfig.canRemoteAccess,
        canOtaUpdates: planConfig.canOtaUpdates,
        canExportData: planConfig.canExportData,
        hasAdvancedAlerts: planConfig.hasAdvancedAlerts,
        hasCustomDashboards: planConfig.hasCustomDashboards,
        hasDedicatedPrometheus: planConfig.hasDedicatedPrometheus,
        hasDedicatedGrafana: planConfig.hasDedicatedGrafana,
        prometheusRetentionDays: planConfig.prometheusRetentionDays,
        prometheusStorageGb: planConfig.prometheusStorageGb,
      },
      limits: {
        maxJobTemplates: planConfig.maxJobTemplates,
        maxAlertRules: planConfig.maxAlertRules,
        maxUsers: planConfig.maxUsers,
      },
      trial: {
        isTrialMode: subscription.status === 'trialing',
        expiresAt: subscription.trial_ends_at?.toISOString(),
      },
      subscription: {
        status: subscription.status as any,
        currentPeriodEndsAt: subscription.current_period_ends_at?.toISOString() || '',
      },
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year
    };

    // Sign with RS256
    const token = jwt.sign(licenseData, this.privateKey, {
      algorithm: 'RS256',
      expiresIn: '365d',
    });

    return token;
  }

  /**
   * Get public key (to share with customer instances)
   */
  static getPublicKey(): string {
    if (!this.publicKey) {
      throw new Error('License generator not initialized. Call init() first.');
    }
    return this.publicKey;
  }

  /**
   * Verify license (for testing)
   */
  static verifyLicense(token: string): LicenseData {
    if (!this.publicKey) {
      throw new Error('License generator not initialized. Call init() first.');
    }

    try {
      const decoded = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256'],
      }) as LicenseData;

      return decoded;
    } catch (error: any) {
      throw new Error(`License verification failed: ${error.message}`);
    }
  }
}
