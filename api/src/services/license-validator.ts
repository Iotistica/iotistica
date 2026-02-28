/**
 * License Validator Service
 * Validates JWT-based license keys from Global Billing API
 * Enforces feature flags and usage limits
 */

import jwt from 'jsonwebtoken';
import fs from 'fs';
import { SystemConfigModel } from '../db/system-config-model';

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
  };
  limits: {
    maxJobTemplates?: number;
    maxAlertRules?: number;
    maxUsers?: number;
  };
  trial: {
    isTrialMode: boolean;
    expiresAt?: string; // ISO date
  };
  subscription: {
    status: 'active' | 'past_due' | 'canceled' | 'trialing';
    currentPeriodEndsAt: string;
  };
  issuedAt: number;
  expiresAt: number; // License expiry (separate from subscription)
  
  // Standard JWT claims
  exp?: number; // JWT expiration timestamp (seconds since epoch)
  iat?: number; // JWT issued at timestamp
  nbf?: number; // JWT not before timestamp
}

export class LicenseValidator {
  private static instance: LicenseValidator;
  private licenseData: LicenseData | null = null;
  private licenseKey: string | null = null;
  
  // Public key for verifying JWT (Global Billing API signs with private key)
  // Priority:
  //   1. LICENSE_PUBLIC_KEY_PATH - Read from file (Kubernetes ConfigMap mount)
  //   2. LICENSE_PUBLIC_KEY - Read from env var (development/legacy)
  private static readonly PUBLIC_KEY = (() => {
    const keyPath = process.env.LICENSE_PUBLIC_KEY_PATH;
    if (keyPath) {
      try {
        const key = fs.readFileSync(keyPath, 'utf8');
        console.log(`✅ License public key loaded from file: ${keyPath}`);
        return key;
      } catch (error: any) {
        console.error(`❌ Failed to read license public key from ${keyPath}:`, error.message);
        console.warn('   Falling back to LICENSE_PUBLIC_KEY environment variable');
      }
    }
    
    // Fallback: env var (convert \n literals to actual newlines)
    const envKey = (process.env.LICENSE_PUBLIC_KEY || '').replace(/\\n/g, '\n');
    if (envKey) {
      console.log('✅ License public key loaded from environment variable');
    }
    return envKey;
  })();

  private constructor() {}

  static getInstance(): LicenseValidator {
    if (!this.instance) {
      this.instance = new LicenseValidator();
    }
    return this.instance;
  }

  /**
   * Initialize license from environment variable
   */
  async init(): Promise<void> {
    const licenseKey = process.env.IOTISTIC_LICENSE_KEY;
    
    if (!licenseKey) {
      console.warn('⚠️  No license key found. Running in unlicensed mode (limited features).');
      this.licenseData = this.getDefaultUnlicensedMode();
      return;
    }

    try {
      this.licenseKey = licenseKey;
      this.licenseData = await this.validateLicense(licenseKey);
      
      // Cache license data in system_config
      await SystemConfigModel.set('license_data', this.licenseData);
      await SystemConfigModel.set('license_last_validated', new Date().toISOString());
      
      console.log(`✅ License validated for customer: ${this.licenseData.customerName}`);
      console.log(`   Plan: ${this.licenseData.plan.toUpperCase()}`);
      console.log(`   Max Devices: ${this.licenseData.features.maxDevices}`);
      console.log(`   Subscription Status: ${this.licenseData.subscription.status}`);
      
      if (this.licenseData.trial.isTrialMode) {
        const daysLeft = Math.ceil(
          (new Date(this.licenseData.trial.expiresAt!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
        );
        console.log(`   ⏰ TRIAL MODE - ${daysLeft} days remaining`);
      }
    } catch (error) {
      console.error('❌ License validation failed:', error);
      
      // Try to load cached license (offline mode)
      const cachedLicense = await SystemConfigModel.get<LicenseData>('license_data');
      const lastValidated = await SystemConfigModel.get<string>('license_last_validated');
      
      if (cachedLicense && lastValidated) {
        const daysSinceValidation = Math.floor(
          (Date.now() - new Date(lastValidated).getTime()) / (24 * 60 * 60 * 1000)
        );
        
        if (daysSinceValidation <= 30) {
          console.warn(`⚠️  Using cached license (offline mode, last validated ${daysSinceValidation} days ago)`);
          this.licenseData = cachedLicense;
          return;
        }
      }
      
      // Fallback to unlicensed mode
      console.warn('⚠️  Entering unlicensed mode (limited features)');
      this.licenseData = this.getDefaultUnlicensedMode();
    }
  }

  /**
   * Validate license JWT
   */
  public async validateLicense(licenseKey: string): Promise<LicenseData> {
    try {
      // Validate that we have a proper public key
      if (!LicenseValidator.PUBLIC_KEY || LicenseValidator.PUBLIC_KEY.length < 100) {
        throw new Error('LICENSE_PUBLIC_KEY is not configured or invalid. Please set a valid RSA public key.');
      }

      // Ensure the key has proper PEM format
      if (!LicenseValidator.PUBLIC_KEY.includes('-----BEGIN PUBLIC KEY-----')) {
        throw new Error('LICENSE_PUBLIC_KEY must be in PEM format (-----BEGIN PUBLIC KEY-----)');
      }

      const decoded = jwt.verify(licenseKey, LicenseValidator.PUBLIC_KEY, {
        algorithms: ['RS256'], // Asymmetric signing
      }) as LicenseData;

      // SECURITY: Explicit expiry check (defense-in-depth)
      // Check standard JWT 'exp' field first (do not rely solely on JWT library)
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && now > decoded.exp) {
        const daysExpired = Math.floor((now - decoded.exp) / 86400);
        throw new Error(`License expired ${daysExpired} days ago (JWT exp: ${decoded.exp})`);
      }

      // Check custom expiresAt field (legacy/additional check)
      if (decoded.expiresAt && decoded.expiresAt < Date.now() / 1000) {
        throw new Error('License has expired');
      }

      // Check subscription status
      if (decoded.subscription.status === 'canceled') {
        throw new Error('Subscription has been canceled');
      }

      return decoded;
    } catch (error: any) {
      throw new Error(`License validation failed: ${error.message}`);
    }
  }

  /**
   * Get default unlicensed mode (very limited)
   */
  private getDefaultUnlicensedMode(): LicenseData {
    return {
      customerId: 'unlicensed',
      customerName: 'Unlicensed Mode',
      plan: 'trial',
      features: {
        // Very limited for unlicensed mode
        maxDevices: 2,
        canExecuteJobs: true,
        canScheduleJobs: false,
        canRemoteAccess: true,
        canOtaUpdates: false,
        canExportData: false,
        hasAdvancedAlerts: false,
        hasCustomDashboards: false,
      },
      limits: {
        maxJobTemplates: 5,
        maxAlertRules: 5,
        maxUsers: 1,
      },
      trial: {
        isTrialMode: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      },
      subscription: {
        status: 'trialing',
        currentPeriodEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      issuedAt: Date.now() / 1000,
      expiresAt: (Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days
    };
  }

  /**
   * Get current license data
   */
  getLicense(): LicenseData {
    if (!this.licenseData) {
      throw new Error('License not initialized. Call init() first.');
    }
    return this.licenseData;
  }

  /**
   * Check if feature is enabled
   */
  hasFeature(feature: keyof LicenseData['features']): boolean {
    return this.getLicense().features[feature] === true;
  }

  /**
   * Get feature limit
   */
  getLimit(limit: keyof LicenseData['limits']): number | undefined {
    return this.getLicense().limits[limit];
  }

  /**
   * Check if license is in trial mode
   */
  isTrialMode(): boolean {
    return this.getLicense().trial.isTrialMode;
  }

  /**
   * Check if subscription is active
   */
  isSubscriptionActive(): boolean {
    const status = this.getLicense().subscription.status;
    return status === 'active' || status === 'trialing';
  }

  /**
   * Get days until trial expires (returns null if not in trial)
   */
  getTrialDaysRemaining(): number | null {
    const license = this.getLicense();
    if (!license.trial.isTrialMode || !license.trial.expiresAt) {
      return null;
    }
    
    const daysLeft = Math.ceil(
      (new Date(license.trial.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    );
    
    return Math.max(0, daysLeft);
  }
}
